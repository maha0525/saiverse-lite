import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatService, systemPromptWithUserIdentity } from "./chatService";
import { ChatOperationError } from "./chatErrors";
import { createDefaultPersona, DEFAULT_SETTINGS, newId, type ChatMessage, type ConversationThread, type MemoryEntry } from "./domain";
import { retryDefaults } from "./llm/retry";
import { MemoryRepository } from "./storage/memoryRepository";

const originalRetry = { ...retryDefaults };
beforeEach(() => { retryDefaults.initialDelayMs = 1; retryDefaults.maxDelayMs = 5; });
afterEach(() => { Object.assign(retryDefaults, originalRetry); vi.unstubAllGlobals(); });

describe("ChatService with mock provider", () => {
  it("streams, persists, and creates a deterministic automatic summary", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.putSettings({ ...DEFAULT_SETTINGS, summaryEveryMessages: 2 });
    const persona = createDefaultPersona();
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    let streamed = "";
    await new ChatService(repository).send(persona, thread, "こんにちは", { onDelta: (delta) => { streamed += delta; } });
    expect(streamed).toContain("モック応答");
    expect(await repository.listMessages(thread.id)).toHaveLength(2);
    expect((await repository.listMemories(persona.id))[0]?.kind).toBe("summary");
  });

  it("runs the registered memory recall tool and returns its result to the model", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.putSettings({ ...DEFAULT_SETTINGS, summaryEveryMessages: 50 });
    const persona = createDefaultPersona();
    const now = Date.now();
    const memory: MemoryEntry = {
      id: newId("memory"), personaId: persona.id, threadId: null, kind: "note", content: "猫の名前はミケ", sourceMessageIds: [], createdAt: now, updatedAt: now,
    };
    await repository.putMemory(memory);
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    const result = await new ChatService(repository).send(persona, thread, "猫の名前を思い出して");
    expect(result.content).toContain("ミケ");
    expect((await repository.listMessages(thread.id)).some((message) => message.role === "tool" && message.toolName === "memory_recall")).toBe(true);
  });

  it("reports the stored user message before the response pipeline finishes", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "取り込んだ長い会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    let stored: ChatMessage | null = null;
    const events: string[] = [];
    await new ChatService(repository).send(persona, thread, "今の発言", {
      onUserMessageStored: (message) => { stored = message; events.push("user-stored"); },
      onDelta: () => events.push("response-delta"),
    });
    expect(stored).toMatchObject({ role: "user", content: "今の発言", threadId: thread.id });
    expect((await repository.listMessages(thread.id)).some((message) => message.id === stored?.id)).toBe(true);
    expect(events[0]).toBe("user-stored");
    expect(events).toContain("response-delta");
  });

  it("removes the failed user turn and restores the thread after a provider error", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const now = Date.now();
    const provider = {
      id: "provider_gemini",
      kind: "gemini" as const,
      label: "Google Gemini",
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-test",
      imageModel: "gemini-image-test",
      geminiAutoCache: true,
      createdAt: now,
      updatedAt: now,
    };
    await repository.putProvider(provider);
    const persona = { ...createDefaultPersona(now), providerId: provider.id, model: provider.defaultModel };
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    )));

    let caught: unknown;
    try {
      await new ChatService(repository).send(persona, thread, "あとでもう一度送る内容");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChatOperationError);
    expect((caught as ChatOperationError).rollbackSucceeded).toBe(true);
    expect(await repository.listMessages(thread.id)).toEqual([]);
    expect(await repository.getThread(thread.id)).toEqual(thread);
  });

  it("tells the user a retry is under way, then clears the notice once the stream arrives", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.putSettings({ ...DEFAULT_SETTINGS, summaryEveryMessages: 50 });
    const now = Date.now();
    const provider = {
      id: "provider_gemini_retry",
      kind: "gemini" as const,
      label: "Google Gemini",
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-test",
      imageModel: "gemini-image-test",
      geminiAutoCache: false,
      createdAt: now,
      updatedAt: now,
    };
    await repository.putProvider(provider);
    const persona = { ...createDefaultPersona(now), providerId: provider.id, model: provider.defaultModel };
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);

    let streamAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (!String(input).includes(":streamGenerateContent")) return new Response("unexpected", { status: 500 });
      streamAttempts += 1;
      if (streamAttempts === 1) {
        return new Response(
          JSON.stringify({ error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        `data: {"candidates":[{"content":{"parts":[{"text":"待たせたね"}]}}]}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }));

    const statuses: Array<{ text: string; tone: string }> = [];
    const result = await new ChatService(repository).send(persona, thread, "混んでいる時間の質問", {
      onStatus: (text, tone) => statuses.push({ text, tone: tone ?? "info" }),
    });

    expect(streamAttempts).toBe(2);
    expect(result.content).toBe("待たせたね");
    const retryNotice = statuses.find((status) => status.tone === "warning");
    expect(retryNotice?.text).toContain("Google Geminiが混み合っています");
    expect(retryNotice?.text).toContain(`1/${retryDefaults.maxAttempts}回目`);
    // The notice must not outlive the wait it explains.
    expect(statuses.at(-1)?.text).toBe("");
    const noticeIndex = statuses.findIndex((status) => status.tone === "warning");
    expect(statuses.slice(noticeIndex + 1).some((status) => status.text === "応答を待っています…")).toBe(true);
  });

  it("keeps the previous assistant response when regeneration fails", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const now = Date.now();
    const provider = {
      id: "provider_gemini_regenerate",
      kind: "gemini" as const,
      label: "Google Gemini",
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-test",
      imageModel: "gemini-image-test",
      geminiAutoCache: true,
      createdAt: now,
      updatedAt: now,
    };
    await repository.putProvider(provider);
    const persona = { ...createDefaultPersona(now), providerId: provider.id, model: provider.defaultModel };
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "既存の会話", createdAt: now, updatedAt: now };
    const previousMessages: ChatMessage[] = [
      { id: newId("message"), threadId: thread.id, personaId: persona.id, role: "user", content: "前の質問", createdAt: now, editedAt: null, toolCallId: null, toolName: null, metadata: {} },
      { id: newId("message"), threadId: thread.id, personaId: persona.id, role: "assistant", content: "前の返答", createdAt: now + 1, editedAt: null, toolCallId: null, toolName: null, metadata: {} },
    ];
    await repository.putThread(thread);
    for (const message of previousMessages) await repository.putMessage(message);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 503, message: "Service unavailable", status: "UNAVAILABLE" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    )));

    let caught: unknown;
    try {
      await new ChatService(repository).regenerate(persona, thread.id);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChatOperationError);
    expect((caught as ChatOperationError).operation).toBe("regenerate");
    expect((caught as ChatOperationError).rollbackSucceeded).toBe(true);
    expect(await repository.listMessages(thread.id)).toEqual(previousMessages);
  });

  it("adds the configured user name to the system prompt", () => {
    expect(systemPromptWithUserIdentity("基本の人格", { ...DEFAULT_SETTINGS, userName: "まはー" }))
      .toBe("基本の人格\n\n会話相手であるユーザーの名前は「まはー」です。");
    expect(systemPromptWithUserIdentity("基本の人格", DEFAULT_SETTINGS)).toBe("基本の人格");
  });
});
