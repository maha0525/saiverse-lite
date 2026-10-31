import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "./chatService";
import { ChatOperationError, PersonaImportingError, presentChatError } from "./chatErrors";
import { createChatMessage, createDefaultPersona, newId, type ChatMessage, type ConversationThread } from "./domain";
import { retryDefaults } from "./llm/retry";
import { CATEGORY_CORE, liveCoreMemories } from "./pageRecords";
import { MemoryRepository } from "./storage/memoryRepository";

const originalRetry = { ...retryDefaults };
beforeEach(() => { retryDefaults.initialDelayMs = 1; retryDefaults.maxDelayMs = 5; });
afterEach(() => { Object.assign(retryDefaults, originalRetry); vi.unstubAllGlobals(); });

describe("ChatService with mock provider", () => {
  it("streams and persists without generating Lite-specific summaries", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    let streamed = "";
    await new ChatService(repository).send(persona, thread, "こんにちは", { onDelta: (delta) => { streamed += delta; } });
    expect(streamed).toContain("モック応答");
    expect(await repository.listMessages(thread.id)).toHaveLength(2);
    expect(liveCoreMemories(await repository.listPages(persona.id, CATEGORY_CORE))).toEqual([]);
  });

  it("runs the registered memory recall tool and returns its result to the model", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    const now = Date.now();
    await repository.addCoreMemories(persona.id, [{ content: "猫の名前はミケ" }]);
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    const result = await new ChatService(repository).send(persona, thread, "猫の名前を思い出して");
    expect(result.content).toContain("ミケ");
    const stored = await repository.listMessages(thread.id);
    expect(stored.map((message) => message.role)).toEqual(["user", "system", "assistant"]);
    expect(stored[1]?.content.startsWith("[Handy Tool: memory_recall]\n")).toBe(true);
    expect(stored[1]?.metadata).toMatchObject({ tags: ["conversation", "handy_tool"], __system_notice__: "handy_tool" });
    expect(stored.every((message) => message.metadata.tool_calls === undefined && message.metadata.lite_provider_state === undefined)).toBe(true);
    expect(new Set(stored.map((message) => message.pulseId)).size).toBe(1);
    expect(stored[0]?.pulseId).not.toBeNull();
    expect(stored[2]!.seq).toBeGreaterThan(stored[1]!.seq);
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
      createChatMessage({ id: newId("message"), threadId: thread.id, personaId: persona.id, role: "user", content: "前の質問", createdAt: now, seq: 1 }),
      createChatMessage({ id: newId("message"), threadId: thread.id, personaId: persona.id, role: "assistant", content: "前の返答", createdAt: now + 1, seq: 2 }),
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

  it("does not send an empty assistant row left by a migrated tool call", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "移行した会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    await repository.putMessage(createChatMessage({ id: newId("message"), threadId: thread.id, personaId: persona.id, role: "assistant", content: "", createdAt: now, seq: 1 }));
    const seen: string[][] = [];
    const { MockProvider } = await import("./llm/mock");
    const stream = MockProvider.prototype.stream;
    vi.spyOn(MockProvider.prototype, "stream").mockImplementation(function (this: InstanceType<typeof MockProvider>, request) {
      seen.push(request.messages.map((message) => message.content));
      return stream.call(this, request);
    });
    await new ChatService(repository).send(persona, thread, "続き");
    vi.restoreAllMocks();
    expect(seen[0]?.at(-1)).toBe("続き");
    expect(seen[0]?.every((content) => content.trim() !== "")).toBe(true);
  });

  it("does not store an empty assistant row and removes the turn when nothing was said", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "続きの会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    const { MockProvider } = await import("./llm/mock");
    vi.spyOn(MockProvider.prototype, "stream").mockImplementation(async function* () { await Promise.resolve(); });
    await expect(new ChatService(repository).send(persona, thread, "もしもし")).rejects.toBeInstanceOf(ChatOperationError);
    vi.restoreAllMocks();
    expect(await repository.listMessages(thread.id)).toEqual([]);
  });

  it("regenerates over the tool rows of the replaced response, keeping the pulse", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    const now = Date.now();
    await repository.addCoreMemories(persona.id, [{ content: "猫の名前はミケ" }]);
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "続きの会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    const service = new ChatService(repository);
    await service.send(persona, thread, "猫の名前を思い出して");
    await service.regenerate(persona, thread.id);
    const stored = await repository.listMessages(thread.id);
    expect(stored.map((message) => message.role)).toEqual(["user", "system", "assistant"]);
    expect(new Set(stored.map((message) => message.pulseId)).size).toBe(1);
  });

  it("refuses a persona whose import has not finished", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "取り込み中", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    await repository.updateSession(persona.id, (session) => ({ ...session, importState: "importing" }));
    await expect(new ChatService(repository).send(persona, thread, "こんにちは")).rejects.toThrow("取り込みの途中");
    expect(await repository.listMessages(thread.id)).toEqual([]);
  });

  it("refuses to regenerate for such a persona, and tells the user what to do", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "取り込み中", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    const answer = createChatMessage({ id: newId("message"), threadId: thread.id, personaId: persona.id, role: "assistant", content: "途中の返答", createdAt: now, seq: 1 });
    await repository.putMessage(answer);
    await repository.updateSession(persona.id, (session) => ({ ...session, importState: "importing" }));
    const failure = await new ChatService(repository).regenerate(persona, thread.id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PersonaImportingError);
    expect(presentChatError(failure, "regenerate").message).toContain("同じ ZIP");
    expect(await repository.listMessages(thread.id)).toEqual([answer]);
  });

  it("replaces the last response the user can see, not a blank tool row after it", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "続きの会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    const rows = [
      createChatMessage({ id: "row-1", threadId: thread.id, personaId: persona.id, role: "user", content: "質問", createdAt: now, seq: 1 }),
      createChatMessage({ id: "row-2", threadId: thread.id, personaId: persona.id, role: "assistant", content: "見えている返答", createdAt: now + 1, seq: 2 }),
      createChatMessage({ id: "row-3", threadId: thread.id, personaId: persona.id, role: "assistant", content: "", createdAt: now + 2, seq: 3 }),
    ];
    await repository.writePersonaRecords(persona.id, { messages: rows });
    await new ChatService(repository).regenerate(persona, thread.id);
    const stored = await repository.listMessages(thread.id);
    expect(stored.some((message) => message.content === "見えている返答")).toBe(false);
    expect(stored.filter((message) => message.role === "assistant" && message.content.includes("モック応答"))).toHaveLength(1);
  });
});
