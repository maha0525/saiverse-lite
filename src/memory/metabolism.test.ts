import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatService, type MetabolismState } from "../chatService";
import { createChatMessage, createDefaultPersona, createDefaultProvider, handyToolRecord, newId, type ChatMessage, type ConversationThread, type Persona } from "../domain";
import { MockProvider } from "../llm/mock";
import type { CompletionRequest, CompletionResult, ProviderRequest } from "../llm/types";
import { CATEGORY_CHRONICLE, CATEGORY_CORE, epochSeconds, liveCoreMemories } from "../pageRecords";
import { MemoryRepository } from "../storage/memoryRepository";
import { retryExtractionBacklog } from "./entities";
import { chronicleEntries, coveredMessageIds } from "./entries";
import { planEviction } from "./eviction";
import { runMetabolism } from "./metabolism";
import { activateThread, prepareSession } from "./session";
import { buildSluicePrompt, parseSluiceResult } from "./sluice";
import { CHRONICLE_UNIT_CHARS, METABOLISM_TARGET_CHARS, readWindow, resolveInitialAnchor } from "./window";

const BASE_MS = new Date(2026, 5, 1, 9, 0, 0).getTime();

interface Fixture {
  repository: MemoryRepository;
  persona: Persona;
  thread: ConversationThread;
}

async function fixture(): Promise<Fixture> {
  const repository = new MemoryRepository();
  await repository.initialize();
  const persona = createDefaultPersona();
  const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "長い会話", createdAt: BASE_MS, updatedAt: BASE_MS };
  await repository.putThread(thread);
  return { repository, persona, thread };
}

function row(thread: ConversationThread, index: number, role: "user" | "assistant", content: string, fields: Partial<ChatMessage> = {}): ChatMessage {
  return createChatMessage({
    id: `row-${String(index).padStart(4, "0")}`,
    threadId: thread.id,
    personaId: thread.personaId,
    role,
    content,
    createdAt: BASE_MS + index * 60_000,
    seq: index + 1,
    pulseId: `pulse-${Math.floor(index / 2)}`,
    ...fields,
  });
}

/** `count` rows of `chars` chars each, the older half of each pair from the user. */
async function seed({ repository, thread }: Fixture, count: number, chars: number): Promise<ChatMessage[]> {
  const rows = Array.from({ length: count }, (_, index) => row(thread, index, index % 2 === 0 ? "user" : "assistant", `発言${index}:${"あ".repeat(chars)}`));
  await repository.writePersonaRecords(thread.personaId, { messages: rows });
  return rows;
}

interface Calls {
  completions: CompletionRequest[];
  streams: ProviderRequest[];
}

function spyProvider(overrides: { complete?: (request: CompletionRequest, calls: Calls) => Promise<CompletionResult> | null } = {}): Calls {
  const calls: Calls = { completions: [], streams: [] };
  const complete = MockProvider.prototype.complete;
  const stream = MockProvider.prototype.stream;
  vi.spyOn(MockProvider.prototype, "complete").mockImplementation(function (this: MockProvider, request) {
    calls.completions.push(request);
    return overrides.complete?.(request, calls) ?? complete.call(this, request);
  });
  vi.spyOn(MockProvider.prototype, "stream").mockImplementation(function (this: MockProvider, request) {
    calls.streams.push(request);
    return stream.call(this, request);
  });
  return calls;
}

const isSluice = (request: CompletionRequest): boolean => request.responseSchema !== undefined;
const isEntity = (request: CompletionRequest): boolean => (request.messages.at(-1)?.content ?? "").includes("固有の対象（エンティティ）");
const reply = (text: string): Promise<CompletionResult> => Promise.resolve({ text, inputTokens: 1, outputTokens: 1, cachedTokens: 0 });

afterEach(() => { vi.restoreAllMocks(); });

describe("planEviction boundaries", () => {
  it("keeps the kept amount, cuts whole units and leaves the short tail for the next run", async () => {
    const f = await fixture();
    const rows = await seed(f, 100, 1000);
    const plan = planEviction(rows, { targetChars: METABOLISM_TARGET_CHARS, unitChars: CHRONICLE_UNIT_CHARS });
    const evicted = plan.folds.flat();
    expect(plan.folds.length).toBeGreaterThan(0);
    expect(evicted.map((message) => message.id)).toEqual(rows.slice(0, evicted.length).map((message) => message.id));
    const kept = rows.slice(plan.protectedFrom).reduce((sum, message) => sum + message.content.length, 0);
    expect(kept).toBeGreaterThanOrEqual(METABOLISM_TARGET_CHARS);
    expect(plan.folds.every((fold) => fold.reduce((sum, message) => sum + message.content.length, 0) >= CHRONICLE_UNIT_CHARS)).toBe(true);
  });

  it("does not separate a tool result from the utterance it answered", async () => {
    const f = await fixture();
    const rows = await seed(f, 100, 1000);
    const pulse = rows[80]!.pulseId;
    const tool = createChatMessage({
      ...handyToolRecord("memory_recall", "結果".repeat(500)),
      id: "row-tool", threadId: f.thread.id, personaId: f.persona.id, createdAt: rows[80]!.createdAt, seq: 500, pulseId: pulse,
    });
    const withTool = [...rows.slice(0, 81), tool, ...rows.slice(81)];
    const plan = planEviction(withTool, { targetChars: METABOLISM_TARGET_CHARS, unitChars: 1000 });
    const boundary = withTool[plan.protectedFrom]!;
    expect(withTool[plan.protectedFrom - 1]!.pulseId).not.toBe(boundary.pulseId);
  });
});

describe("resolveInitialAnchor", () => {
  it("starts at the oldest row no level 1 entry covers, floored to the kept amount", async () => {
    const f = await fixture();
    const rows = await seed(f, 60, 1000);
    const chronicle = await f.repository.listPages(f.persona.id, CATEGORY_CHRONICLE);
    await f.repository.putPage({
      ...chronicle[0]!, id: "entry-1", isTrunk: false, parentId: "root_chronicle", shortId: 50,
      metadata: { level: 1, source_ids: rows.slice(0, 50).map((message) => message.id), start_time: 1, end_time: 2 },
    });
    await f.repository.updateSession(f.persona.id, (session) => ({ ...session, activeThreadId: f.thread.id }));
    const anchor = await resolveInitialAnchor(f.repository, f.persona.id);
    expect(Number(anchor!.slice(4))).toBeLessThan(50);
    const window = await readWindow(f.repository, f.thread.id, anchor!);
    expect(window.reduce((sum, message) => sum + message.content.length, 0)).toBeGreaterThanOrEqual(METABOLISM_TARGET_CHARS);
  });
});

describe("Metabolism end to end with the mock provider", () => {
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });

  it("runs every step before the first response of an oversized window and sends the moved window", async () => {
    const f = await fixture();
    await seed(f, 100, 1000);
    const calls = spyProvider();
    const states: MetabolismState[] = [];
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "こんにちは", { onMetabolism: (state) => states.push(state) });
    await service.whenSettled(f.persona.id);

    expect(calls.completions.some(isSluice)).toBe(true);
    expect(calls.completions.some(isEntity)).toBe(true);
    const sluice = calls.completions.find(isSluice)!;
    expect(sluice.systemPrompt).toContain("## システム通知");
    expect(sluice.messages.at(-1)?.content).toContain("記憶整理の節目 — スルース");
    expect("tools" in sluice).toBe(false);
    expect(calls.completions.indexOf(sluice)).toBeGreaterThan(calls.completions.findIndex(isEntity));

    const session = (await f.repository.getSession(f.persona.id))!;
    expect(session.anchorMessageId).not.toBe("row-0000");
    expect(session.metabolismError).toBeNull();
    const entries = chronicleEntries(await f.repository.listPages(f.persona.id, CATEGORY_CHRONICLE));
    const covered = coveredMessageIds(entries);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.level === 1 && entry.sourceIds.length > 0)).toBe(true);

    const sent = calls.streams.at(-1)!;
    const sentText = sent.messages.map((message) => message.content).join("\n");
    expect(sentText).not.toContain("発言0:");
    expect(sentText).toContain("発言99:");
    expect(sent.memoryContext).toContain("モックのあらすじ。");
    expect(covered.has(session.anchorMessageId!)).toBe(false);
    expect(states.at(0)).toMatchObject({ running: true });
    expect(states.at(-1)).toMatchObject({ running: false, error: null });
    // The persona's own voice stays clean: the record is a system row.
    const stored = await f.repository.listMessages(f.thread.id);
    expect(stored.filter((message) => message.metadata.__system_notice__ === "sluice_capture").every((message) => message.role === "system")).toBe(true);
  });

  it("does not move the anchor when a step fails, shows why, and retries after the next response without doubling entries", async () => {
    const f = await fixture();
    await seed(f, 100, 1000);
    let failing = true;
    const calls = spyProvider({ complete: (request) => (isSluice(request) && failing ? Promise.reject(new Error("sluice is down")) : null) });
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "一通目");
    await service.whenSettled(f.persona.id);

    const failed = (await f.repository.getSession(f.persona.id))!;
    expect(failed.metabolismError).toContain("sluice is down");
    const entriesAfterFailure = chronicleEntries(await f.repository.listPages(f.persona.id, CATEGORY_CHRONICLE));
    expect(entriesAfterFailure.length).toBeGreaterThan(0);
    const anchorAfterFailure = failed.anchorMessageId;
    // A response right after a failure does not wait on another attempt; the attempt runs behind it.
    expect(calls.completions.filter(isSluice)).toHaveLength(1);

    failing = false;
    const before = calls.completions.filter((request) => !isSluice(request) && !isEntity(request)).length;
    await service.send(f.persona, f.thread, "二通目");
    await service.whenSettled(f.persona.id);

    const recovered = (await f.repository.getSession(f.persona.id))!;
    expect(recovered.metabolismError).toBeNull();
    expect(recovered.anchorMessageId).not.toBe(anchorAfterFailure);
    expect(calls.completions.filter(isSluice)).toHaveLength(2);
    const entries = chronicleEntries(await f.repository.listPages(f.persona.id, CATEGORY_CHRONICLE));
    const sources = entries.filter((entry) => entry.level === 1).flatMap((entry) => entry.sourceIds);
    expect(new Set(sources).size).toBe(sources.length);
    expect(entries.length).toBe(entriesAfterFailure.length);
    expect(calls.completions.filter((request) => !isSluice(request) && !isEntity(request)).length).toBe(before);
  });

  it("holds the anchor when a Chronicle entry fails, keeping the entries already written", async () => {
    const f = await fixture();
    await seed(f, 100, 1000);
    let primaries = 0;
    spyProvider({
      complete: (request) => {
        if (isSluice(request) || isEntity(request)) return null;
        primaries += 1;
        return primaries === 2 ? Promise.reject(new Error("chronicle is down")) : null;
      },
    });
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "こんにちは");
    await service.whenSettled(f.persona.id);
    const session = (await f.repository.getSession(f.persona.id))!;
    expect(session.metabolismError).toContain("chronicle is down");
    expect(Number(session.anchorMessageId!.slice(4))).toBeLessThan(10);
    const entries = chronicleEntries(await f.repository.listPages(f.persona.id, CATEGORY_CHRONICLE));
    expect(entries).toHaveLength(1);
  });

  it("writes Chronicle rows in the shape the body's plan_chronicle_merge reads, with level 2 above level 1", async () => {
    const f = await fixture();
    await seed(f, 100, 1000);
    spyProvider({ complete: (request) => (isSluice(request) || isEntity(request) ? null : reply("あらすじ".repeat(400))) });
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "こんにちは");
    await service.whenSettled(f.persona.id);
    const pages = (await f.repository.listPages(f.persona.id, CATEGORY_CHRONICLE)).filter((page) => !page.isTrunk);
    const entries = chronicleEntries(pages);
    const primary = entries.filter((entry) => entry.level === 1);
    const parents = entries.filter((entry) => entry.level === 2);
    expect(parents.length).toBeGreaterThan(0);
    const ids = new Set(pages.map((page) => page.id));
    expect(parents.every((parent) => parent.sourceIds.every((id) => ids.has(id)))).toBe(true);
    for (const parent of parents) {
      for (const child of primary.filter((entry) => parent.sourceIds.includes(entry.id))) {
        expect(child.page.parentId).toBe(parent.id);
        expect(child.page.metadata.is_consolidated).toBe(1);
      }
    }
    for (const page of pages) {
      expect(page).toMatchObject({ category: "chronicle", isDeleted: false, isTrunk: false });
      expect(page.metadata).toMatchObject({ is_consolidated: expect.any(Number), level: expect.any(Number), source_ids: expect.any(Array), thread_id: null });
    }
    const covered = primary.flatMap((entry) => entry.sourceIds);
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("skips the sluice when structured output is unavailable and says so", async () => {
    const f = await fixture();
    await seed(f, 100, 1000);
    const calls = spyProvider();
    await prepareSession(f.repository, f.persona, f.thread.id);
    const provider = Object.assign(new MockProvider((await f.repository.getProvider("provider_mock"))!), { supportsStructuredOutput: false });
    const outcome = await runMetabolism({ repository: f.repository, persona: f.persona, provider, chatModel: "mock", lightModel: "mock" });
    expect(outcome).toBe("ok");
    expect(calls.completions.some(isSluice)).toBe(false);
    const session = (await f.repository.getSession(f.persona.id))!;
    expect(session.metabolismNotice).toContain("スルース");
    expect(session.anchorMessageId).not.toBe("row-0000");
  });

  it("applies the sluice as core memories and records it as a system row", async () => {
    const f = await fixture();
    await seed(f, 100, 1000);
    await f.repository.addCoreMemories(f.persona.id, [{ content: "古い事実" }, { content: "消す事実" }]);
    spyProvider({
      complete: (request) => (isSluice(request) ? reply(JSON.stringify({
        reflection: "残します。",
        core_adds: [{ content: "新しい事実" }],
        core_updates: [{ memory_ref: "core:1", content: "直した事実" }],
        core_removes: [{ memory_ref: "core:2" }, { memory_ref: "core:99" }],
      })) : null),
    });
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "こんにちは");
    await service.whenSettled(f.persona.id);
    const live = liveCoreMemories(await f.repository.listPages(f.persona.id, CATEGORY_CORE));
    expect(live.map((page) => page.content).sort()).toEqual(["新しい事実", "直した事実"].sort());
    const session = (await f.repository.getSession(f.persona.id))!;
    expect(session.headText).toContain("新しい事実");
    const record = (await f.repository.listMessages(f.thread.id)).find((message) => message.metadata.__system_notice__ === "sluice_capture")!;
    expect(record).toMatchObject({ role: "system", scope: "committed", lineRole: "main_line" });
    expect(record.content).toContain("はじめてのパートナーの判断: 残します。");
    expect(record.content).toContain("remove 失敗: core:99 のスナップショット情報が無いため適用しませんでした。");
    expect(record.pairedActionText).toContain("記憶整理の節目 — スルース");
  });

  it("writes Memopedia pages and Fragments, and never doubles them on a backlog retry", async () => {
    const f = await fixture();
    await seed(f, 100, 1000);
    let down = true;
    spyProvider({
      complete: (request) => {
        if (!isEntity(request)) return null;
        if (down) return Promise.reject(new Error("extraction is down"));
        return reply(JSON.stringify({ entities: [{ name: "ミケ", category: "people", summary: "飼い猫", notes: ["三毛猫である"] }], involved_entities: [] }));
      },
    });
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "こんにちは");
    await service.whenSettled(f.persona.id);
    const session = (await f.repository.getSession(f.persona.id))!;
    expect(session.metabolismError).toBeNull();
    expect(session.extractionBacklog?.length).toBeGreaterThan(0);

    down = false;
    const llm = { provider: new MockProvider((await f.repository.getProvider("provider_mock"))!), model: "mock" };
    await retryExtractionBacklog(f.repository, f.persona.id, llm);
    await retryExtractionBacklog(f.repository, f.persona.id, llm);
    expect((await f.repository.getSession(f.persona.id))!.extractionBacklog).toEqual([]);
    const pages = (await f.repository.listPages(f.persona.id)).filter((page) => page.title === "ミケ");
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ parentId: "root_people", summary: "飼い猫", category: "people" });
    const fragments = await f.repository.listFragments(f.persona.id, pages[0]!.id);
    expect(new Set(fragments.map((fragment) => fragment.chronicleEntryId)).size).toBe(fragments.length);
    expect(fragments.every((fragment) => fragment.vividness === "vivid" && fragment.content === "三毛猫である")).toBe(true);
  });

  it("runs behind the response without making the send wait", async () => {
    const f = await fixture();
    await seed(f, 57, 1000);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    spyProvider({ complete: async (request) => { await gate; return reply(isSluice(request) ? JSON.stringify({ reflection: "", core_adds: [], core_updates: [], core_removes: [] }) : isEntity(request) ? JSON.stringify({ entities: [] }) : "あらすじ"); } });
    const service = new ChatService(f.repository);
    // The window is under the limit before the send and over it after the reply is stored.
    await service.send(f.persona, f.thread, "い".repeat(2000));
    const during = (await f.repository.getSession(f.persona.id))!.anchorMessageId;
    release();
    await service.whenSettled(f.persona.id);
    expect((await f.repository.getSession(f.persona.id))!.anchorMessageId).not.toBe(during);
  });
});

describe("the head", () => {
  it("stays byte for byte the same between runs, even when a core memory is written mid-conversation", async () => {
    const f = await fixture();
    const calls = spyProvider();
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "一通目");
    await f.repository.addCoreMemories(f.persona.id, [{ content: "会話中に書いた事実" }]);
    await service.send(f.persona, f.thread, "二通目");
    expect(calls.streams).toHaveLength(2);
    expect(calls.streams[1]!.systemPrompt).toBe(calls.streams[0]!.systemPrompt);
    expect(calls.streams[1]!.systemPrompt).not.toContain("会話中に書いた事実");
  });

  it("is rebuilt when the system prompt is edited", async () => {
    const f = await fixture();
    const calls = spyProvider();
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "一通目");
    await service.send({ ...f.persona, systemPrompt: "新しい人格" }, f.thread, "二通目");
    expect(calls.streams[1]!.systemPrompt).toContain("## あなたについて\n新しい人格");
  });

  it("resets the anchor when the active thread changes", async () => {
    const f = await fixture();
    await seed(f, 4, 10);
    const other: ConversationThread = { ...f.thread, id: newId("thread"), title: "別の会話" };
    await f.repository.putThread(other);
    const calls = spyProvider();
    const service = new ChatService(f.repository);
    await service.send(f.persona, other, "別の話");
    const session = (await f.repository.getSession(f.persona.id))!;
    expect(session.activeThreadId).toBe(other.id);
    expect(calls.streams[0]!.messages.map((message) => message.content).join("\n")).not.toContain("発言0");
  });
});

describe("activateThread", () => {
  it("settles the anchor of the opened thread, so the next run sees it", async () => {
    const f = await fixture();
    const rows = await seed(f, 4, 10);
    await prepareSession(f.repository, f.persona, f.thread.id);
    const other: ConversationThread = { ...f.thread, id: newId("thread"), title: "別の会話" };
    await f.repository.putThread(other);
    const otherRow = row(other, 900, "user", "別の話");
    await f.repository.writePersonaRecords(f.persona.id, { messages: [otherRow] });

    const opened = await activateThread(f.repository, f.persona, other.id);
    expect(opened).toMatchObject({ activeThreadId: other.id, anchorMessageId: otherRow.id });

    const back = await activateThread(f.repository, f.persona, f.thread.id);
    expect(back).toMatchObject({ activeThreadId: f.thread.id, anchorMessageId: rows[0]!.id });
  });

  it("leaves a new empty thread without an anchor until its first message", async () => {
    const f = await fixture();
    await seed(f, 4, 10);
    await prepareSession(f.repository, f.persona, f.thread.id);
    const fresh: ConversationThread = { ...f.thread, id: newId("thread"), title: "新しい会話" };
    await f.repository.putThread(fresh);
    expect(await activateThread(f.repository, f.persona, fresh.id)).toMatchObject({ activeThreadId: fresh.id, anchorMessageId: null });
    spyProvider();
    await new ChatService(f.repository).send(f.persona, fresh, "はじめまして");
    const session = (await f.repository.getSession(f.persona.id))!;
    expect((await f.repository.getMessage(session.anchorMessageId!))?.threadId).toBe(fresh.id);
  });

  it("keeps the head when the thread is the one already open", async () => {
    const f = await fixture();
    await seed(f, 4, 10);
    const { session } = await prepareSession(f.repository, f.persona, f.thread.id);
    expect((await activateThread(f.repository, f.persona, f.thread.id)).passphrase).toBe(session.passphrase);
  });

  it("does not touch the session of a persona still importing", async () => {
    const f = await fixture();
    await seed(f, 4, 10);
    await f.repository.updateSession(f.persona.id, (session) => ({ ...session, importState: "importing" }));
    const opened = await activateThread(f.repository, f.persona, f.thread.id);
    expect(opened).toMatchObject({ activeThreadId: null, anchorMessageId: null, headText: null });
  });

  it("does not carry an anchor to another thread when the thread changes during a run", async () => {
    const f = await fixture();
    await seed(f, 100, 1000);
    await prepareSession(f.repository, f.persona, f.thread.id);
    const other: ConversationThread = { ...f.thread, id: newId("thread"), title: "別の会話" };
    await f.repository.putThread(other);
    const otherRow = row(other, 900, "user", "別の話");
    await f.repository.writePersonaRecords(f.persona.id, { messages: [otherRow] });
    spyProvider();
    const provider = new MockProvider(createDefaultProvider());
    let switched = false;
    const outcome = await runMetabolism({
      repository: f.repository,
      persona: f.persona,
      provider,
      chatModel: "mock-friendly",
      lightModel: "mock-friendly",
      onStage: () => {
        if (switched) return;
        switched = true;
        void activateThread(f.repository, f.persona, other.id);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome).toBe("ok");
    const session = (await f.repository.getSession(f.persona.id))!;
    expect(session.activeThreadId).toBe(other.id);
    expect(session.anchorMessageId).toBe(otherRow.id);
    expect(chronicleEntries(await f.repository.listPages(f.persona.id, CATEGORY_CHRONICLE)).length).toBeGreaterThan(0);
  });
});

describe("the passphrase", () => {
  it("is sent, and is never stored in a message row", async () => {
    const f = await fixture();
    await seed(f, 100, 1000);
    const calls = spyProvider({
      complete: (request) => (isSluice(request) ? reply(JSON.stringify({ reflection: "残す", core_adds: [{ content: "事実" }], core_updates: [], core_removes: [] })) : null),
    });
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "こんにちは");
    await service.whenSettled(f.persona.id);
    await service.send(f.persona, f.thread, "続き");
    await service.whenSettled(f.persona.id);
    const { passphrase, headText } = (await f.repository.getSession(f.persona.id))!;
    expect(passphrase).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(headText).not.toContain(passphrase!);
    const sent = calls.streams.at(-1)!;
    expect(sent.systemPrompt).toContain(`pass="${passphrase}"`);
    expect(sent.messages.some((message) => message.content.startsWith(`<system pass="${passphrase}">`))).toBe(true);
    const stored = await f.repository.listMessages(f.thread.id);
    expect(stored.some((message) => `${message.content}${message.pairedActionText ?? ""}`.includes(passphrase!))).toBe(false);
  });

  it("is redacted out of what the model repeats", async () => {
    const f = await fixture();
    const service = new ChatService(f.repository);
    await service.send(f.persona, f.thread, "はじめまして");
    const { passphrase } = (await f.repository.getSession(f.persona.id))!;
    vi.spyOn(MockProvider.prototype, "stream").mockImplementation(async function* () {
      await Promise.resolve();
      yield { type: "text", text: `合言葉は ${passphrase} です` };
    });
    await service.send(f.persona, f.thread, "合言葉は？");
    const stored = await f.repository.listMessages(f.thread.id);
    expect(stored.some((message) => message.content.includes(passphrase!))).toBe(false);
  });
});

describe("auto recall", () => {
  it("keeps a page for three turns after its title last appeared, as the body does", async () => {
    const f = await fixture();
    await f.repository.putPage({
      ...(await f.repository.listPages(f.persona.id)).find((page) => page.id === "root_people")!,
      id: "page-mike", title: "ミケ", summary: "飼い猫の名前", isTrunk: false, parentId: "root_people", shortId: 7,
    });
    const calls = spyProvider();
    const service = new ChatService(f.repository);
    const recalled = (request: ProviderRequest): boolean => request.messages.some((message) => message.content.includes("ふと浮かんだ記憶:"));
    await service.send(f.persona, f.thread, "ミケは元気？");
    expect(recalled(calls.streams.at(-1)!)).toBe(true);
    const notice = calls.streams.at(-1)!.messages.find((message) => message.content.includes("ふと浮かんだ記憶:"))!;
    expect(notice.content).toContain("- [Memopedia: ミケ (memopedia:7)] 飼い猫の名前");
    await service.regenerate(f.persona, f.thread.id);
    expect(recalled(calls.streams.at(-1)!)).toBe(true);
    for (const text of ["今日は晴れ", "散歩に行った", "公園が混んでいた"]) {
      await service.send(f.persona, f.thread, text);
      expect(recalled(calls.streams.at(-1)!)).toBe(true);
    }
    await service.send(f.persona, f.thread, "帰ってきた");
    expect(recalled(calls.streams.at(-1)!)).toBe(false);
    const stored = await f.repository.listMessages(f.thread.id);
    expect(stored.some((message) => message.content.includes("ふと浮かんだ記憶"))).toBe(false);
  });
});

describe("the sluice contract", () => {
  it("rejects a broken shape and drops only a broken element", () => {
    expect(() => parseSluiceResult("not json")).toThrow("JSON");
    expect(() => parseSluiceResult(JSON.stringify({ reflection: "x", core_adds: [] }))).toThrow("core_updates");
    const result = parseSluiceResult(JSON.stringify({ reflection: "x", core_adds: [{ content: 1 }], core_updates: [], core_removes: [{}] }));
    expect(result.fields.core_adds).toEqual([]);
    expect(result.rejections).toEqual([
      "コア記憶の追加の1件目を棄却: content が文字列ではありません (1)。",
      "コア記憶の削除の1件目を棄却: 必須欄 memory_ref がありません。",
    ]);
  });

  it("does not ask about the notebook", async () => {
    const prompt = buildSluicePrompt([]);
    expect(prompt).not.toMatch(/手帳|約束|want_memos|promise_/);
    expect(prompt).toContain("応答には全ての欄 (reflection / core_adds / core_updates / core_removes) を含めてください。");
    expect(prompt).toContain("（まだコア記憶はありません）");
  });
});

describe("the send body", () => {
  it("reads as the body sends it", async () => {
    const f = await fixture();
    await f.repository.putSettings({ ...(await f.repository.getSettings()), userName: "まはー" });
    await f.repository.addCoreMemories(f.persona.id, [{ content: "猫の名前はミケ" }]);
    const chronicle = (await f.repository.listPages(f.persona.id, CATEGORY_CHRONICLE))[0]!;
    await f.repository.putPage({
      ...chronicle, id: "entry-old", isTrunk: false, parentId: "root_chronicle", shortId: 40, content: "前の日に猫の話をした。",
      metadata: { level: 1, source_ids: ["gone"], start_time: epochSeconds(BASE_MS - 86_400_000), end_time: epochSeconds(BASE_MS - 86_000_000), short_id: 1 },
    });
    const rows = [
      row(f.thread, 0, "user", "おはよう"),
      row(f.thread, 1, "assistant", "おはよう、まはー"),
      createChatMessage({
        ...handyToolRecord("memory_recall", "「猫」の検索結果です（1 件）。\n- [core:1] 猫の名前はミケ"),
        id: "row-tool", threadId: f.thread.id, personaId: f.persona.id, createdAt: BASE_MS + 120_000, seq: 3, pulseId: "pulse-1",
      }),
    ];
    await f.repository.writePersonaRecords(f.persona.id, { messages: rows });
    await f.repository.updateSession(f.persona.id, (session) => ({ ...session, activeThreadId: f.thread.id }));
    vi.spyOn(crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      (array as unknown as Uint8Array).fill(0);
      return array;
    });
    vi.useFakeTimers({ now: BASE_MS + 180_000, toFake: ["Date"] });
    try {
      const calls = spyProvider();
      await new ChatService(f.repository).send(f.persona, f.thread, "猫の話の続き");
      const sent = calls.streams[0]!;
      const body = [
        `=== system ===\n${sent.systemPrompt}`,
        `=== chronicle ===\n${sent.memoryContext}`,
        ...sent.messages.map((message) => `=== ${message.role} ===\n${message.content}`),
      ].join("\n\n");
      await expect(body).toMatchFileSnapshot("./__snapshots__/send_body.txt");
    } finally {
      vi.useRealTimers();
    }
  });
});
