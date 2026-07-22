import {
  newId,
  type ChatMessage,
  type ConversationThread,
  type MemoryEntry,
  type Persona,
  type ToolCall,
  type ToolId,
} from "./domain";
import { ChatOperationError, type ChatOperation } from "./chatErrors";
import { createProvider } from "./llm";
import type { RetryAttempt, RetryNotice } from "./llm/retry";
import type { LlmProvider, ProviderMessage } from "./llm/types";
import type { LiteRepository } from "./storage/repository";
import { executeTool, toolDefinitionsFor } from "./tools";

/** "warning" marks a status the user should notice but need not act on. */
export type ChatStatusTone = "info" | "warning";

export interface ChatCallbacks {
  onDelta?(text: string): void;
  onStatus?(status: string, tone?: ChatStatusTone): void;
}

const TOOL_STATUS: Record<ToolId, string> = {
  memory_recall: "記憶を確認しています…",
  image_generate: "画像を生成しています…",
};

/**
 * The provider is retrying on its own, so the wait is expected rather than a
 * failure. The status says who is busy, how long the pause is, and how many
 * attempts remain, so silence during backoff does not read as a freeze.
 */
function retryStatusText(providerLabel: string, attempt: RetryAttempt): string {
  const seconds = Math.max(1, Math.round(attempt.delayMs / 1000));
  const reason = attempt.status === 429 ? "の利用制限に達しました" : "が混み合っています";
  return `${providerLabel}${reason}。約${seconds}秒後に再試行します（${attempt.attempt}/${attempt.maxAttempts}回目）`;
}

function toolCallsFromMetadata(metadata: Record<string, unknown>): ToolCall[] {
  if (!Array.isArray(metadata.tool_calls)) return [];
  return metadata.tool_calls.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.id !== "string" || (item.name !== "memory_recall" && item.name !== "image_generate")) return [];
    return [{
      id: item.id,
      name: item.name,
      arguments: typeof item.arguments === "object" && item.arguments !== null ? item.arguments as Record<string, unknown> : {},
    }];
  });
}

function toProviderMessage(message: ChatMessage): ProviderMessage {
  const providerState = message.metadata.lite_provider_state;
  return {
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    toolCalls: toolCallsFromMetadata(message.metadata),
    ...(typeof providerState === "object" && providerState !== null && !Array.isArray(providerState)
      ? { providerState: providerState as Record<string, unknown> }
      : {}),
  };
}

function memoryContext(memories: MemoryEntry[]): string {
  let remaining = 6_000;
  const selected: string[] = [];
  for (const memory of memories.slice(0, 16)) {
    const line = `- [${memory.kind}] ${memory.content.trim()}`;
    if (!line.trim() || line.length > remaining) continue;
    selected.push(line);
    remaining -= line.length;
  }
  return selected.join("\n");
}

function usageMetadata(inputTokens: number, outputTokens: number, cachedTokens: number): Record<string, unknown> {
  return { inputTokens, outputTokens, cachedTokens };
}

export class ChatService {
  constructor(private readonly repository: LiteRepository) {}

  private async rollbackConversation(
    operation: ChatOperation,
    thread: ConversationThread,
    messagesBefore: ChatMessage[],
    originalError: unknown,
  ): Promise<ChatOperationError> {
    let rollbackError: unknown = null;
    try {
      const previousIds = new Set(messagesBefore.map((message) => message.id));
      const currentMessages = await this.repository.listMessages(thread.id);
      const createdMessages = currentMessages.filter((message) => !previousIds.has(message.id));
      for (const message of createdMessages) await this.repository.deleteMessage(message.id);
      for (const message of messagesBefore) await this.repository.putMessage(message);
      await this.repository.putThread(thread);
      console.info("[SAIVerse Lite][chat] failed operation rolled back", {
        operation,
        threadId: thread.id,
        removedMessages: createdMessages.length,
        restoredMessages: messagesBefore.length,
      });
    } catch (error) {
      rollbackError = error;
      console.error("[SAIVerse Lite][chat] failed to roll back conversation", {
        operation,
        threadId: thread.id,
        error,
      });
    }
    return new ChatOperationError(operation, originalError, rollbackError === null, rollbackError);
  }

  async send(
    persona: Persona,
    thread: ConversationThread,
    content: string,
    callbacks: ChatCallbacks = {},
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    const messagesBefore = await this.repository.listMessages(thread.id);
    const now = Date.now();
    const userMessage: ChatMessage = {
      id: newId("message"),
      threadId: thread.id,
      personaId: persona.id,
      role: "user",
      content: content.trim(),
      createdAt: now,
      editedAt: null,
      toolCallId: null,
      toolName: null,
      metadata: {},
    };
    try {
      await this.repository.putMessage(userMessage);
      await this.repository.putThread({ ...thread, updatedAt: now, title: thread.title === "新しい会話" ? content.trim().slice(0, 36) || thread.title : thread.title });
      return await this.continueConversation(persona, thread.id, callbacks, signal);
    } catch (error) {
      throw await this.rollbackConversation("send", thread, messagesBefore, error);
    }
  }

  async regenerate(
    persona: Persona,
    threadId: string,
    callbacks: ChatCallbacks = {},
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    const thread = await this.repository.getThread(threadId);
    if (!thread) throw new Error("会話スレッドが見つかりません");
    const messages = await this.repository.listMessages(threadId);
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant" && toolCallsFromMetadata(message.metadata).length === 0);
    try {
      if (lastAssistant) await this.repository.deleteMessage(lastAssistant.id);
      return await this.continueConversation(persona, threadId, callbacks, signal);
    } catch (error) {
      throw await this.rollbackConversation("regenerate", thread, messages, error);
    }
  }

  private async continueConversation(
    persona: Persona,
    threadId: string,
    callbacks: ChatCallbacks,
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    const config = await this.repository.getProvider(persona.providerId);
    if (!config) throw new Error("選択されたプロバイダ設定がありません");
    if (config.kind !== "mock" && !config.apiKey) throw new Error(`${config.label} のAPIキーを設定してください`);
    const provider = createProvider(config);
    const settings = await this.repository.getSettings();
    const definitions = toolDefinitionsFor(persona);
    const memories = await this.repository.listMemories(persona.id);
    let messages = await this.repository.listMessages(threadId);
    let finalMessage: ChatMessage | null = null;

    for (let round = 0; round < 4; round += 1) {
      const baseStatus = round === 0 ? "応答を待っています…" : "ツールの結果を渡しています…";
      callbacks.onStatus?.(baseStatus);
      let retrying = false;
      const onRetry: RetryNotice = (attempt) => {
        retrying = true;
        callbacks.onStatus?.(retryStatusText(config.label, attempt), "warning");
      };
      let text = "";
      const calls: ToolCall[] = [];
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let providerState: Record<string, unknown> | null = null;
      const recent = messages.slice(-settings.recentContextMessages).map(toProviderMessage);
      for await (const event of provider.stream({
        model: persona.model || config.defaultModel,
        systemPrompt: persona.systemPrompt,
        memoryContext: memoryContext(memories),
        messages: recent,
        tools: definitions,
        toolChoice: "auto",
        onRetry,
        ...(signal ? { signal } : {}),
      })) {
        // Reaching the stream means the provider answered; drop any stale retry notice.
        if (retrying) {
          retrying = false;
          callbacks.onStatus?.(baseStatus);
        }
        if (event.type === "text") {
          text += event.text;
          callbacks.onDelta?.(event.text);
        } else if (event.type === "tool-call") {
          calls.push(event.call);
        } else if (event.type === "provider-state") {
          providerState = event.state;
        } else if (event.type === "usage") {
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          cachedTokens = event.cachedTokens;
        }
      }

      const assistant: ChatMessage = {
        id: newId("message"),
        threadId,
        personaId: persona.id,
        role: "assistant",
        content: text,
        createdAt: Date.now(),
        editedAt: null,
        toolCallId: null,
        toolName: null,
        metadata: {
          usage: usageMetadata(inputTokens, outputTokens, cachedTokens),
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(providerState ? { lite_provider_state: providerState } : {}),
        },
      };
      await this.repository.putMessage(assistant);
      messages.push(assistant);
      if (calls.length === 0) {
        finalMessage = assistant;
        break;
      }
      for (const call of calls) {
        callbacks.onStatus?.(TOOL_STATUS[call.name]);
        let resultContent: string;
        let resultMetadata: Record<string, unknown>;
        try {
          const result = await executeTool(this.repository, persona, provider, call, signal, (attempt) => {
            callbacks.onStatus?.(retryStatusText(config.label, attempt), "warning");
          });
          resultContent = result.content;
          resultMetadata = result.metadata;
        } catch (error) {
          resultContent = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
          resultMetadata = { error: true };
          console.error("[SAIVerse Lite][tool] execution failed", { tool: call.name, error });
        }
        const toolMessage: ChatMessage = {
          id: newId("message"),
          threadId,
          personaId: persona.id,
          role: "tool",
          content: resultContent,
          createdAt: Date.now(),
          editedAt: null,
          toolCallId: call.id,
          toolName: call.name,
          metadata: resultMetadata,
        };
        await this.repository.putMessage(toolMessage);
        messages.push(toolMessage);
      }
    }
    if (!finalMessage) throw new Error("ツール呼び出しが上限を超えました");
    callbacks.onStatus?.("");
    await this.maybeSummarize(persona, provider, threadId, definitions, signal);
    return finalMessage;
  }

  private async maybeSummarize(
    persona: Persona,
    provider: LlmProvider,
    threadId: string,
    definitions: ReturnType<typeof toolDefinitionsFor>,
    signal?: AbortSignal,
  ): Promise<void> {
    const settings = await this.repository.getSettings();
    const messages = (await this.repository.listMessages(threadId)).filter((message) =>
      (message.role === "user" || message.role === "assistant") && toolCallsFromMetadata(message.metadata).length === 0,
    );
    const summaries = (await this.repository.listMemories(persona.id)).filter((memory) => memory.kind === "summary" && memory.threadId === threadId);
    const latest = summaries[0];
    let startIndex = 0;
    if (latest) {
      startIndex = Math.max(-1, ...latest.sourceMessageIds.map((id) => messages.findIndex((message) => message.id === id))) + 1;
    }
    const candidates = messages.slice(startIndex);
    if (candidates.length < settings.summaryEveryMessages) return;
    const transcript = candidates.map((message) => `${message.role === "user" ? "ユーザー" : persona.name}: ${message.content}`).join("\n");
    const providerConfig = provider.config;
    let summary = "";
    const promptMessage: ProviderMessage = {
      role: "user",
      content: `以下の会話から、今後の対話で役立つ事実・好み・約束・継続中の話題だけを日本語で簡潔に要約してください。推測を足さず、ツールは使わないでください。\n\n${transcript}`,
      toolCallId: null,
      toolName: null,
      toolCalls: [],
    };
    try {
      for await (const event of provider.stream({
        model: persona.model || providerConfig.defaultModel,
        systemPrompt: persona.systemPrompt,
        memoryContext: "",
        messages: [promptMessage],
        tools: definitions,
        toolChoice: "none",
        ...(signal ? { signal } : {}),
      })) {
        if (event.type === "text") summary += event.text;
      }
      if (!summary.trim()) return;
      const now = Date.now();
      const memory: MemoryEntry = {
        id: newId("memory"),
        personaId: persona.id,
        threadId,
        kind: "summary",
        content: summary.trim(),
        sourceMessageIds: candidates.map((message) => message.id),
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.putMemory(memory);
      console.log("[SAIVerse Lite][memory] automatic summary stored", { personaId: persona.id, threadId, sourceMessages: candidates.length });
    } catch (error) {
      if (signal?.aborted) throw error;
      console.warn("[SAIVerse Lite][memory] automatic summary failed; conversation remains saved", error);
    }
  }
}
