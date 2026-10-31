import {
  createChatMessage,
  handyToolRecord,
  newId,
  withMemoryTools,
  type ChatMessage,
  type ConversationThread,
  type Persona,
  type ProviderConfig,
  type ToolCall,
  type ToolId,
} from "./domain";
import { ChatOperationError, PersonaImportingError, type ChatOperation } from "./chatErrors";
import { createProvider } from "./llm";
import type { RetryAttempt, RetryNotice } from "./llm/retry";
import type { LlmProvider, ProviderMessage } from "./llm/types";
import { composeMessages, realtimeText } from "./memory/conversation";
import { runMetabolism, type MetabolismOutcome } from "./memory/metabolism";
import { presentHead, redactPassphrase, redactProviderMessage } from "./memory/notices";
import { runAutoRecall } from "./memory/recall";
import { prepareSession } from "./memory/session";
import { windowNeedsMetabolism } from "./memory/window";
import { requiresApiKey, resolveLightModel } from "./providerDefaults";
import type { LiteRepository } from "./storage/repository";
import { executeTool, toolDefinitionsFor } from "./tools";

/** "warning" marks a status the user should notice but need not act on. */
export type ChatStatusTone = "info" | "warning";

export interface MetabolismState {
  running: boolean;
  /** What the run is doing now. Empty once it stopped. */
  text: string;
  error: string | null;
  notice: string | null;
}

export interface ChatCallbacks {
  onDelta?(text: string): void;
  onStatus?(status: string, tone?: ChatStatusTone): void;
  onUserMessageStored?(message: ChatMessage): void;
  /** Also fires after the response is done: Metabolism runs on behind it. */
  onMetabolism?(state: MetabolismState): void;
}

const TOOL_STATUS: Record<ToolId, string> = {
  memory_recall: "記憶を確認しています…",
  memory_read: "記憶を読んでいます…",
  memory_write: "記憶に書いています…",
  image_generate: "画像を生成しています…",
};

const MAX_TOOL_ROUNDS = 4;
/** The rows regenerating looks at to find the last response. */
const REGENERATE_LOOKBACK = 200;

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

function usageMetadata(inputTokens: number, outputTokens: number, cachedTokens: number): Record<string, unknown> {
  return { inputTokens, outputTokens, cachedTokens };
}

interface MetabolismRun {
  persona: Persona;
  config: ProviderConfig;
  provider: LlmProvider;
  callbacks: ChatCallbacks;
  closeUndersizedTail: boolean;
  /** Mirrors the stages to `onStatus`, for the run a response is waiting on. */
  blocksResponse: boolean;
  signal?: AbortSignal;
}

export class ChatService {
  private readonly background = new Map<string, Promise<void>>();

  constructor(private readonly repository: LiteRepository) {}

  /** Resolves when the Metabolism left running behind the last response has finished. */
  async whenSettled(personaId: string): Promise<void> {
    await this.background.get(personaId);
  }

  private async rollbackConversation(
    operation: ChatOperation,
    thread: ConversationThread,
    createdIds: string[],
    removedMessages: ChatMessage[],
    originalError: unknown,
  ): Promise<ChatOperationError> {
    let rollbackError: unknown = null;
    try {
      for (const id of createdIds) await this.repository.deleteMessage(id);
      for (const message of removedMessages) await this.repository.putMessage(message);
      await this.repository.putThread(thread);
      // A page surfaced for a turn that never happened has to surface again when the user resends.
      const created = new Set(createdIds);
      if (await this.repository.getSession(thread.personaId)) {
        await this.repository.updateSession(thread.personaId, (session) => {
          const ledger = session.recallLedger?.[thread.id];
          if (!ledger) return session;
          return { ...session, recallLedger: { ...session.recallLedger, [thread.id]: ledger.filter((item) => !created.has(item.messageId)) } };
        });
      }
      console.info("[SAIVerse Lite][chat] failed operation rolled back", {
        operation,
        threadId: thread.id,
        removedMessages: createdIds.length,
        restoredMessages: removedMessages.length,
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
    await this.assertNotImporting(persona.id);
    const now = Date.now();
    const pulseId = newId("pulse");
    const created: string[] = [];
    try {
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
      await this.repository.putMessage(userMessage);
      created.push(userMessage.id);
      await this.repository.putThread({ ...thread, updatedAt: now, title: thread.title === "新しい会話" ? content.trim().slice(0, 36) || thread.title : thread.title });
      callbacks.onUserMessageStored?.(userMessage);
      return await this.continueConversation(persona, thread.id, pulseId, callbacks, created, signal);
    } catch (error) {
      throw await this.rollbackConversation("send", thread, created, [], error);
    }
  }

  async regenerate(
    persona: Persona,
    threadId: string,
    callbacks: ChatCallbacks = {},
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    await this.assertNotImporting(persona.id);
    const thread = await this.repository.getThread(threadId);
    if (!thread) throw new Error("会話スレッドが見つかりません");
    const created: string[] = [];
    const removed: ChatMessage[] = [];
    try {
      const recent = await this.repository.readThreadMessages(threadId, { direction: "backward", limit: REGENERATE_LOOKBACK });
      // A blank row is a tool turn the screen does not show; it is not the response the user is replacing.
      const last = recent.find((message) => message.role === "assistant" && message.content.trim() !== "");
      // The tool rows belong to the response being replaced.
      if (last) removed.push(...(last.pulseId ? recent.filter((message) => message.pulseId === last.pulseId && message.role !== "user") : [last]));
      for (const message of removed) await this.repository.deleteMessage(message.id);
      return await this.continueConversation(persona, threadId, last?.pulseId ?? newId("pulse"), callbacks, created, signal);
    } catch (error) {
      throw await this.rollbackConversation("regenerate", thread, created, removed, error);
    }
  }

  private async assertNotImporting(personaId: string): Promise<void> {
    if ((await this.repository.getSession(personaId))?.importState === "importing") throw new PersonaImportingError();
  }

  private async runMetabolismFor(run: MetabolismRun): Promise<MetabolismOutcome> {
    const { persona, config, provider, callbacks } = run;
    let started = false;
    const onStage = (text: string): void => {
      started = true;
      callbacks.onMetabolism?.({ running: true, text, error: null, notice: null });
      if (run.blocksResponse) callbacks.onStatus?.(text);
    };
    const outcome = await runMetabolism({
      repository: this.repository,
      persona,
      provider,
      chatModel: persona.model || config.defaultModel,
      lightModel: resolveLightModel(config, persona.model),
      closeUndersizedTail: run.closeUndersizedTail,
      onRetry: (attempt) => {
        const text = retryStatusText(config.label, attempt);
        callbacks.onMetabolism?.({ running: true, text, error: null, notice: null });
        if (run.blocksResponse) callbacks.onStatus?.(text, "warning");
      },
      onStage,
      ...(run.signal ? { signal: run.signal } : {}),
    });
    if (started || outcome === "failed") {
      const session = await this.repository.getSession(persona.id);
      callbacks.onMetabolism?.({ running: false, text: "", error: session?.metabolismError ?? null, notice: session?.metabolismNotice ?? null });
    }
    return outcome;
  }

  /** Runs behind the finished response. A run for the same persona already under way goes first. */
  private scheduleMetabolism(run: Omit<MetabolismRun, "closeUndersizedTail" | "blocksResponse">): void {
    const personaId = run.persona.id;
    const task = (this.background.get(personaId) ?? Promise.resolve())
      .then(() => this.runMetabolismFor({ ...run, closeUndersizedTail: false, blocksResponse: false }))
      .then(() => undefined, (error: unknown) => {
        console.error("[SAIVerse Lite][metabolism] background run failed", { personaId, error });
      })
      .finally(() => {
        if (this.background.get(personaId) === task) this.background.delete(personaId);
      });
    this.background.set(personaId, task);
  }

  private async continueConversation(
    personaInput: Persona,
    threadId: string,
    pulseId: string,
    callbacks: ChatCallbacks,
    created: string[],
    signal?: AbortSignal,
  ): Promise<ChatMessage> {
    const persona = withMemoryTools(personaInput);
    const config = await this.repository.getProvider(persona.providerId);
    if (!config) throw new Error("選択されたプロバイダ設定がありません");
    if (requiresApiKey(config.kind) && !config.apiKey) throw new Error(`${config.label} のAPIキーを設定してください`);
    const provider = createProvider(config);

    let { session, rows } = await prepareSession(this.repository, persona, threadId);
    // A run that failed before retries after the response, so a broken provider does not delay every message.
    let retryAfterResponse = true;
    if (windowNeedsMetabolism(rows) && !session.metabolismError) {
      const outcome = await this.runMetabolismFor({
        persona, config, provider, callbacks, closeUndersizedTail: true, blocksResponse: true, ...(signal ? { signal } : {}),
      });
      if (outcome === "ok") ({ session, rows } = await prepareSession(this.repository, persona, threadId));
      if (outcome === "failed") retryAfterResponse = false;
    }

    const passphrase = session.passphrase ?? "";
    const recall = await runAutoRecall(this.repository, session, threadId, rows);
    const conversation: ProviderMessage[] = composeMessages(rows, passphrase, [realtimeText(new Date()), ...(recall ? [recall] : [])]);
    const definitions = toolDefinitionsFor(persona, config);
    const systemPrompt = presentHead(session.headText ?? "", passphrase);

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
      created.push(message.id);
      return message;
    };

    let lastStored: ChatMessage | null = null;
    let finalMessage: ChatMessage | null = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
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
        systemPrompt,
        memoryContext: session.chronicleText ?? "",
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

      const metadata = { usage: usageMetadata(inputTokens, outputTokens, cachedTokens) };
      // An empty assistant row is never kept: some providers reject empty turns.
      if (text) lastStored = await store({ role: "assistant", content: redactPassphrase(text, passphrase), metadata });
      if (calls.length === 0) {
        finalMessage = lastStored;
        if (!finalMessage) throw new Error("モデルの応答が空でした");
        break;
      }
      // The call itself stays in memory for the rest of this response.
      conversation.push(redactProviderMessage({
        role: "assistant",
        content: text,
        toolCallId: null,
        toolName: null,
        toolCalls: calls,
        ...(providerState ? { providerState } : {}),
      }, passphrase));
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
        lastStored = await store(handyToolRecord(call.name, resultContent, resultMetadata));
        conversation.push(redactProviderMessage({ role: "tool", content: resultContent, toolCallId: call.id, toolName: call.name, toolCalls: [] }, passphrase));
      }
    }
    if (!finalMessage) throw new Error("ツール呼び出しが上限を超えました");
    callbacks.onStatus?.("");
    if (retryAfterResponse) this.scheduleMetabolism({ persona, config, provider, callbacks });
    return finalMessage;
  }
}
