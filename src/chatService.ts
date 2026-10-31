import {
  createChatMessage,
  handyToolRecord,
  newId,
  type AppSettings,
  type ChatMessage,
  type ConversationThread,
  type PageRecord,
  type Persona,
  type ToolCall,
  type ToolId,
} from "./domain";
import { ChatOperationError, type ChatOperation } from "./chatErrors";
import { createProvider } from "./llm";
import type { RetryAttempt, RetryNotice } from "./llm/retry";
import type { ProviderMessage } from "./llm/types";
import { CATEGORY_CORE, liveCoreMemories } from "./pageRecords";
import { requiresApiKey } from "./providerDefaults";
import type { LiteRepository } from "./storage/repository";
import { executeTool, toolDefinitionsFor } from "./tools";

/** "warning" marks a status the user should notice but need not act on. */
export type ChatStatusTone = "info" | "warning";

export interface ChatCallbacks {
  onDelta?(text: string): void;
  onStatus?(status: string, tone?: ChatStatusTone): void;
  onUserMessageStored?(message: ChatMessage): void;
}

const TOOL_STATUS: Record<ToolId, string> = {
  memory_recall: "記憶を確認しています…",
  memory_read: "記憶を読んでいます…",
  memory_write: "記憶に書いています…",
  image_generate: "画像を生成しています…",
};

export function systemPromptWithUserIdentity(systemPrompt: string, settings: AppSettings): string {
  const userName = settings.userName.trim();
  return userName ? `${systemPrompt}\n\n会話相手であるユーザーの名前は「${userName}」です。` : systemPrompt;
}

/**
 * The provider is retrying on its own, so the wait is expected rather than a
 * failure. The status says who is busy, how long the pause is, and how many
 * attempts remain, so silence during backoff does not read as a freeze.
 */
function retryStatusText(providerLabel: string, attempt: RetryAttempt): string {
  const seconds = Math.max(1, Math.round(attempt.delayMs / 1000));
  const reason = attempt.status === 429 ? "の利用制限に達しました" : "が混み合っています";
  // A long pause reads as a hang unless the user knows the wait was dictated.
  const wait = attempt.serverRequested
    ? `${providerLabel}の指示どおり約${seconds}秒待って再試行します`
    : `約${seconds}秒後に再試行します`;
  return `${providerLabel}${reason}。${wait}（${attempt.attempt}/${attempt.maxAttempts}回目）`;
}

// Native tool calls live only inside one response; a stored row is plain text.
function toProviderMessage(message: ChatMessage): ProviderMessage {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content,
    toolCallId: null,
    toolName: null,
    toolCalls: [],
  };
}

function memoryContext(memories: PageRecord[]): string {
  let remaining = 6_000;
  const selected: string[] = [];
  for (const memory of memories.slice(0, 16)) {
    const line = `- [${String(memory.metadata.kind)}] ${memory.content.trim()}`;
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
    const pulseId = newId("pulse");
    const userMessage = createChatMessage({
      id: newId("message"),
      threadId: thread.id,
      personaId: persona.id,
      role: "user",
      content: content.trim(),
      createdAt: now,
      seq: await this.repository.nextMessageSeq(persona.id),
      pulseId,
    });
    try {
      await this.repository.putMessage(userMessage);
      await this.repository.putThread({ ...thread, updatedAt: now, title: thread.title === "新しい会話" ? content.trim().slice(0, 36) || thread.title : thread.title });
      callbacks.onUserMessageStored?.(userMessage);
      return await this.continueConversation(persona, thread.id, pulseId, callbacks, signal);
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
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    try {
      if (lastAssistant) await this.repository.deleteMessage(lastAssistant.id);
      return await this.continueConversation(persona, threadId, newId("pulse"), callbacks, signal);
    } catch (error) {
      throw await this.rollbackConversation("regenerate", thread, messages, error);
    }
  }

  private async continueConversation(
    persona: Persona,
    threadId: string,
    pulseId: string,
    callbacks: ChatCallbacks,
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    const store = async (fields: Pick<ChatMessage, "role" | "content" | "metadata">): Promise<ChatMessage> => {
      const message = createChatMessage({
        ...fields,
        id: newId("message"),
        threadId,
        personaId: persona.id,
        createdAt: Date.now(),
        seq: await this.repository.nextMessageSeq(persona.id),
        pulseId,
      });
      await this.repository.putMessage(message);
      return message;
    };
    const config = await this.repository.getProvider(persona.providerId);
    if (!config) throw new Error("選択されたプロバイダ設定がありません");
    if (requiresApiKey(config.kind) && !config.apiKey) throw new Error(`${config.label} のAPIキーを設定してください`);
    const provider = createProvider(config);
    const settings = await this.repository.getSettings();
    const definitions = toolDefinitionsFor(persona, config);
    const memories = liveCoreMemories(await this.repository.listPages(persona.id, CATEGORY_CORE));
    // A v1 row whose only content was a tool call is empty now, and some providers reject empty turns.
    const conversation = (await this.repository.listMessages(threadId))
      .filter((message) => message.role !== "assistant" || message.content.trim() !== "")
      .slice(-settings.recentContextMessages)
      .map(toProviderMessage);
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
      for await (const event of provider.stream({
        model: persona.model || config.defaultModel,
        systemPrompt: systemPromptWithUserIdentity(persona.systemPrompt, settings),
        memoryContext: memoryContext(memories),
        messages: conversation,
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

      const usage = { usage: usageMetadata(inputTokens, outputTokens, cachedTokens) };
      if (calls.length === 0) {
        finalMessage = await store({ role: "assistant", content: text, metadata: usage });
        break;
      }
      // What the persona said before calling a tool is its speech and is kept.
      // The call itself stays in memory for the rest of this response.
      if (text) await store({ role: "assistant", content: text, metadata: usage });
      conversation.push({
        role: "assistant",
        content: text,
        toolCallId: null,
        toolName: null,
        toolCalls: calls,
        ...(providerState ? { providerState } : {}),
      });
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
        await store(handyToolRecord(call.name, resultContent, resultMetadata));
        conversation.push({ role: "tool", content: resultContent, toolCallId: call.id, toolName: call.name, toolCalls: [] });
      }
    }
    if (!finalMessage) throw new Error("ツール呼び出しが上限を超えました");
    callbacks.onStatus?.("");
    return finalMessage;
  }
}
