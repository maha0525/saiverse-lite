import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createChatMessage,
  createDefaultPersona,
  DEFAULT_SETTINGS,
  newId,
  type ChatMessage,
  type ConversationThread,
  type FragmentRecord,
  type Persona,
} from "../domain";
import { buildCoreMemoryPages, CATEGORY_CHRONICLE, CATEGORY_CORE, liveCoreMemories, softDeleteCoreMemory } from "../pageRecords";
import { IndexedDbRepository } from "./indexedDbRepository";
import { MemoryRepository } from "./memoryRepository";
import { RowOwnerError, type LiteRepository } from "./repository";

const TRUNK_IDS = ["root_chronicle", "root_core", "root_events", "root_people", "root_plans", "root_terms"];

function threadOf(personaId: string, title = "test"): ConversationThread {
  return { id: newId("thread"), personaId, title, createdAt: 1, updatedAt: 1 };
}

function messageOf(thread: ConversationThread, createdAt: number, seq: number, id = newId("message")): ChatMessage {
  return createChatMessage({ id, threadId: thread.id, personaId: thread.personaId, role: "user", content: `${createdAt}/${seq}`, createdAt, seq });
}

async function initialized(repository: LiteRepository): Promise<Persona> {
  await repository.initialize();
  const persona = (await repository.listPersonas())[0];
  if (!persona) throw new Error("no default persona");
  return persona;
}

const contract: Array<[string, (repository: LiteRepository) => Promise<void>]> = [
  ["keeps settings and threads, and strips keys from snapshots", async (repository) => {
    expect(await repository.getSettings()).toMatchObject({ userName: "", userAvatarDataUrl: null });
    await repository.putSettings({ ...DEFAULT_SETTINGS, userName: "まはー", userAvatarDataUrl: "data:image/png;base64,test" });
    expect(await repository.getSettings()).toMatchObject({ userName: "まはー", userAvatarDataUrl: "data:image/png;base64,test" });
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    await repository.putThread(thread);
    expect(await repository.listThreads(persona.id)).toContainEqual(thread);
    const snapshot = await repository.exportSnapshot();
    expect(snapshot.providers.every((provider) => provider.apiKey === "")).toBe(true);
    await repository.replaceSnapshot({
      ...snapshot,
      settings: { ...snapshot.settings, autoSummaryEnabled: true, summaryEveryMessages: 2 } as typeof snapshot.settings,
    });
    expect(await repository.getSettings()).not.toHaveProperty("autoSummaryEnabled");
    expect(await repository.getSettings()).not.toHaveProperty("summaryEveryMessages");
  }],

  ["orders messages by (createdAt, seq, id) whatever order they were written", async (repository) => {
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    await repository.putThread(thread);
    const rows = [messageOf(thread, 20, 1), messageOf(thread, 10, 2, "b"), messageOf(thread, 10, 2, "a"), messageOf(thread, 10, 1)];
    for (const row of rows) await repository.putMessage(row);
    expect((await repository.listMessages(thread.id)).map((row) => [row.createdAt, row.seq, row.id])).toEqual([
      [10, 1, rows[3]!.id],
      [10, 2, "a"],
      [10, 2, "b"],
      [20, 1, rows[0]!.id],
    ]);
  }],

  ["reads a thread in ranges from either end and pages without gaps", async (repository) => {
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    const other = threadOf(persona.id, "other");
    await repository.putThread(thread);
    await repository.putThread(other);
    const rows = Array.from({ length: 7 }, (_, index) => messageOf(thread, 100, index + 1, `m${index}`));
    await repository.writePersonaRecords(persona.id, { messages: [...rows, messageOf(other, 100, 50)] });

    const ids = (values: ChatMessage[]) => values.map((row) => row.id);
    expect(ids(await repository.readThreadMessages(thread.id, { direction: "backward", limit: 3 }))).toEqual(["m6", "m5", "m4"]);
    expect(ids(await repository.readThreadMessages(thread.id, { direction: "forward", limit: 2 }))).toEqual(["m0", "m1"]);
    expect(await repository.readThreadMessages(thread.id, { direction: "forward", limit: 0 })).toEqual([]);
    expect(await repository.readThreadMessages(thread.id, { direction: "backward", limit: 0 })).toEqual([]);

    const start = rows[3]!;
    expect(ids(await repository.readThreadMessages(thread.id, { direction: "forward", limit: 9, start }))).toEqual(["m4", "m5", "m6"]);
    expect(ids(await repository.readThreadMessages(thread.id, { direction: "forward", limit: 9, start, includeStart: true }))).toEqual(["m3", "m4", "m5", "m6"]);
    expect(ids(await repository.readThreadMessages(thread.id, { direction: "backward", limit: 9, start }))).toEqual(["m2", "m1", "m0"]);
    expect(ids(await repository.readThreadMessages(thread.id, { direction: "backward", limit: 2, start, includeStart: true }))).toEqual(["m3", "m2"]);

    const walked: string[] = [];
    let page = await repository.readThreadMessages(thread.id, { direction: "forward", limit: 3 });
    while (page.length > 0) {
      walked.push(...ids(page));
      page = await repository.readThreadMessages(thread.id, { direction: "forward", limit: 3, start: page.at(-1)! });
    }
    expect(walked).toEqual(rows.map((row) => row.id));
  }],

  ["reads all threads of one persona, and no other persona's rows", async (repository) => {
    const persona = await initialized(repository);
    const second = { ...createDefaultPersona(1), id: "persona_second" };
    await repository.putPersona(second);
    const first = threadOf(persona.id, "first");
    const other = threadOf(persona.id, "other");
    const foreign = threadOf(second.id);
    await repository.writePersonaRecords(persona.id, { threads: [first, other], messages: [messageOf(first, 30, 1, "c"), messageOf(other, 10, 2, "a")] });
    await repository.writePersonaRecords(second.id, { threads: [foreign], messages: [messageOf(foreign, 20, 3, "x")] });
    await repository.putMessage(messageOf(first, 20, 4, "b"));

    const rows = await repository.readPersonaMessages(persona.id, { direction: "forward", limit: 10 });
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect((await repository.readPersonaMessages(persona.id, { direction: "forward", limit: 10, start: rows[0]! })).map((row) => row.id)).toEqual(["b", "c"]);
    expect((await repository.readPersonaMessages(persona.id, { direction: "backward", limit: 1 })).map((row) => row.id)).toEqual(["c"]);
    expect(await repository.getMessage("b")).toMatchObject({ threadId: first.id });
    expect(await repository.getMessage("missing")).toBeUndefined();
  }],

  ["hands out seq above everything the persona has", async (repository) => {
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    await repository.putThread(thread);
    expect(await repository.nextMessageSeq(persona.id)).toBe(1);
    await repository.putMessage(messageOf(thread, 10, 41));
    await repository.putMessage(messageOf(thread, 20, 7));
    expect(await repository.nextMessageSeq(persona.id)).toBe(42);
    expect(await repository.nextMessageSeq("persona_nobody")).toBe(1);
  }],

  ["gives a new persona the body's trunk pages and a session, once", async (repository) => {
    const defaultPersona = await initialized(repository);
    expect((await repository.listPages(defaultPersona.id)).map((page) => page.id).sort()).toEqual(TRUNK_IDS);
    expect(await repository.getSession(defaultPersona.id)).toMatchObject({ importState: "ready", activeThreadId: null, anchorMessageId: null });

    const persona = { ...createDefaultPersona(1), id: "persona_new" };
    await repository.putPersona(persona);
    const pages = await repository.listPages(persona.id);
    expect(pages.map((page) => page.id).sort()).toEqual(TRUNK_IDS);
    expect(pages.find((page) => page.id === "root_core")).toMatchObject({ title: "コア記憶", category: "core", isTrunk: true, isImportant: true, parentId: null, vividness: "rough", shortId: 2 });
    expect(pages.find((page) => page.id === "root_chronicle")).toMatchObject({ title: "時間の地図", category: "chronicle", isTrunk: true, isImportant: false, shortId: 1 });
    expect(pages.find((page) => page.id === "root_plans")).toMatchObject({ title: "計画", category: "plans", summary: "進行中や計画中のプロジェクト・予定", isTrunk: true, shortId: null });

    await repository.putSession({ ...(await repository.getSession(persona.id))!, headText: "kept" });
    await repository.putPersona({ ...persona, name: "別の名前" });
    expect(await repository.getSession(persona.id)).toMatchObject({ headText: "kept" });
    expect(await repository.getPersona(persona.id)).toMatchObject({ name: "別の名前" });
  }],

  ["keeps pages of two personas apart under the same id", async (repository) => {
    const persona = await initialized(repository);
    const second = { ...createDefaultPersona(1), id: "persona_second" };
    await repository.putPersona(second);
    const core = await repository.getPage(second.id, "root_core");
    await repository.putPage({ ...core!, title: "変更" });
    expect(await repository.getPage(persona.id, "root_core")).toMatchObject({ title: "コア記憶" });
    expect(await repository.getPage(second.id, "root_core")).toMatchObject({ title: "変更" });
  }],

  ["reads pages by category and short id, and deletes one", async (repository) => {
    const persona = await initialized(repository);
    const trunk = (await repository.getPage(persona.id, "root_chronicle"))!;
    const entry = { ...trunk, id: "entry_one", parentId: "root_chronicle", isTrunk: false, title: "chronicle:1", shortId: await repository.nextPageShortId(persona.id), metadata: { level: 1, source_ids: ["m1"], short_id: 1 }, createdAt: 5 };
    await repository.putPage(entry);
    expect(entry.shortId).toBe(3);
    expect((await repository.listPages(persona.id, CATEGORY_CHRONICLE)).map((page) => page.id)).toEqual(["entry_one", "root_chronicle"]);
    expect(await repository.getPageByShortId(persona.id, 3)).toEqual(entry);
    expect(await repository.getPageByShortId(persona.id, 99)).toBeUndefined();
    await repository.deletePage(persona.id, "entry_one");
    expect(await repository.getPage(persona.id, "entry_one")).toBeUndefined();
  }],

  ["numbers core memories and never reuses a number", async (repository) => {
    const persona = await initialized(repository);
    const [first, second] = await repository.addCoreMemories(persona.id, [{ content: "一", metadata: { origin: "test" } }, { content: "二" }]);
    expect(first).toMatchObject({ title: "コア記憶 c:1", parentId: "root_core", category: "core", isImportant: true, isTrunk: false, shortId: 3 });
    expect(first?.metadata).toEqual({ origin: "test", core_id: 1, kind: "note", confirmed: 1, deleted_at: null });
    expect(second).toMatchObject({ title: "コア記憶 c:2", shortId: 4 });

    await repository.putPage(softDeleteCoreMemory(second!, 100));
    expect(await repository.getPage(persona.id, second!.id)).toMatchObject({ isDeleted: true, metadata: { deleted_at: 100 } });
    const [third] = await repository.addCoreMemories(persona.id, [{ content: "三" }]);
    expect(third?.metadata.core_id).toBe(3);
    expect(liveCoreMemories(await repository.listPages(persona.id, CATEGORY_CORE)).map((page) => page.content).sort()).toEqual(["一", "三"]);
  }],

  ["updates a core memory found by id and leaves a deleted one deleted", async (repository) => {
    const persona = await initialized(repository);
    const [page] = await repository.addCoreMemories(persona.id, [{ id: "fixed", content: "前" }]);
    expect(await repository.addCoreMemories(persona.id, [{ id: "fixed", content: "前" }])).toEqual([]);
    const [updated] = await repository.addCoreMemories(persona.id, [{ id: "fixed", content: "後", updatedAt: 9 }]);
    expect(updated).toMatchObject({ content: "後", updatedAt: 9, shortId: page!.shortId, metadata: { core_id: 1 } });
    await repository.putPage(softDeleteCoreMemory(updated!, 10));
    expect(await repository.addCoreMemories(persona.id, [{ id: "fixed", content: "蘇らない" }])).toEqual([]);
    expect(await repository.getPage(persona.id, "fixed")).toMatchObject({ content: "後", isDeleted: true });
  }],

  ["stores fragments per persona and entity", async (repository) => {
    const persona = await initialized(repository);
    const fragment: FragmentRecord = { id: "f1", personaId: persona.id, content: "猫", entityId: "page_a", chronicleEntryId: "entry_one", vividness: "vivid", sourceDate: "2026-10-31", createdAt: 1, source: null };
    await repository.putFragment(fragment);
    await repository.putFragment({ ...fragment, id: "f2", entityId: "page_b", createdAt: 2 });
    expect((await repository.listFragments(persona.id)).map((item) => item.id)).toEqual(["f1", "f2"]);
    expect(await repository.listFragments(persona.id, "page_a")).toEqual([fragment]);
    await repository.deleteFragment(persona.id, "f1");
    expect((await repository.listFragments(persona.id)).map((item) => item.id)).toEqual(["f2"]);
  }],

  ["writes a batch whole, replaces by key, and refuses a stray row before writing", async (repository) => {
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    const message = messageOf(thread, 1, 1, "same");
    const page = { ...(await repository.getPage(persona.id, "root_core"))!, id: "batch_page", parentId: "root_core", isTrunk: false };
    const fragment: FragmentRecord = { id: "f1", personaId: persona.id, content: "猫", entityId: "batch_page", chronicleEntryId: null, vividness: "vivid", sourceDate: null, createdAt: 1, source: null };
    await repository.writePersonaRecords(persona.id, { threads: [thread], messages: [message], pages: [page], fragments: [fragment] });
    await repository.writePersonaRecords(persona.id, { messages: [{ ...message, content: "再実行" }] });
    expect(await repository.listMessages(thread.id)).toEqual([{ ...message, content: "再実行" }]);
    expect(await repository.getPage(persona.id, "batch_page")).toEqual(page);
    expect(await repository.listFragments(persona.id)).toEqual([fragment]);

    const stray = threadOf("persona_other");
    await expect(repository.writePersonaRecords(persona.id, { threads: [threadOf(persona.id, "ok"), stray] })).rejects.toThrow("persona_other");
    expect((await repository.listThreads(persona.id)).map((item) => item.id)).toEqual([thread.id]);
  }],

  ["clears the session's thread with its thread, and leaves a lost anchor to prepareSession", async (repository) => {
    const persona = await initialized(repository);
    const kept = threadOf(persona.id, "kept");
    const gone = threadOf(persona.id, "gone");
    const keptRow = messageOf(kept, 1, 1, "kept_row");
    const goneRow = messageOf(gone, 2, 2, "gone_row");
    await repository.writePersonaRecords(persona.id, { threads: [kept, gone], messages: [keptRow, goneRow] });
    const session = (await repository.getSession(persona.id))!;

    await repository.putSession({ ...session, activeThreadId: kept.id, anchorMessageId: goneRow.id, headText: "head" });
    await repository.deleteThreads([gone.id]);
    expect(await repository.getSession(persona.id)).toMatchObject({ activeThreadId: kept.id, anchorMessageId: goneRow.id, headText: "head" });
    expect(await repository.listMessages(gone.id)).toEqual([]);
    expect(await repository.listMessages(kept.id)).toEqual([keptRow]);

    await repository.putSession({ ...session, activeThreadId: kept.id, anchorMessageId: keptRow.id });
    await repository.deleteMessage(keptRow.id);
    expect(await repository.getSession(persona.id)).toMatchObject({ activeThreadId: kept.id, anchorMessageId: keptRow.id });

    await repository.putMessage(keptRow);
    await repository.putSession({ ...session, activeThreadId: kept.id, anchorMessageId: keptRow.id });
    await repository.deleteThread(kept.id);
    expect(await repository.getSession(persona.id)).toMatchObject({ activeThreadId: null, anchorMessageId: null });
  }],

  ["refuses a thread or message another persona owns, and writes nothing of the batch", async (repository) => {
    const persona = await initialized(repository);
    const other = { ...createDefaultPersona(1), id: "persona_other" };
    await repository.putPersona(other);
    const theirs = threadOf(other.id);
    const theirRow = messageOf(theirs, 1, 1);
    await repository.writePersonaRecords(other.id, { threads: [theirs], messages: [theirRow] });

    const mine = threadOf(persona.id);
    const mineRow = messageOf(mine, 2, 2);
    const failure = await repository.writePersonaRecords(persona.id, { threads: [mine], messages: [mineRow, { ...theirRow, personaId: persona.id, threadId: mine.id }] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RowOwnerError);
    expect((failure as RowOwnerError).ownerPersonaId).toBe(other.id);
    await expect(repository.writePersonaRecords(persona.id, { threads: [{ ...theirs, personaId: persona.id }] })).rejects.toBeInstanceOf(RowOwnerError);
    expect(await repository.getThread(mine.id)).toBeUndefined();
    expect(await repository.getMessage(mineRow.id)).toBeUndefined();
    expect(await repository.getMessage(theirRow.id)).toEqual(theirRow);
    expect((await repository.getThread(theirs.id))?.personaId).toBe(other.id);
  }],

  ["applies a batch's session update with its rows, or neither", async (repository) => {
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    await repository.writePersonaRecords(persona.id, { threads: [thread], session: (session) => ({ ...session, extractionBacklog: [{ entryId: "entry", attempts: 0 }] }) });
    expect(await repository.getThread(thread.id)).toEqual(thread);
    expect((await repository.getSession(persona.id))?.extractionBacklog).toEqual([{ entryId: "entry", attempts: 0 }]);

    const orphan = threadOf("persona_without_a_session");
    await expect(repository.writePersonaRecords(orphan.personaId, { threads: [orphan], session: (session) => session })).rejects.toThrow("Session not found");
    expect(await repository.getThread(orphan.id)).toBeUndefined();
  }],

  ["applies session updates one after another", async (repository) => {
    const persona = { ...createDefaultPersona(1), id: "persona_session_update" };
    await repository.putPersona(persona);
    await Promise.all([
      repository.updateSession(persona.id, (session) => ({ ...session, headText: "head" })),
      repository.updateSession(persona.id, (session) => ({ ...session, metabolismError: "failed" })),
    ]);
    expect(await repository.getSession(persona.id)).toMatchObject({ headText: "head", metabolismError: "failed" });
    await expect(repository.updateSession("persona_missing", (session) => session)).rejects.toThrow("Session not found");
  }],

  ["shows a plan the rows as they stand and hands back its result", async (repository) => {
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    await repository.writePersonaRecords(persona.id, { threads: [thread], messages: [messageOf(thread, 1, 41)] });
    await repository.addCoreMemories(persona.id, [{ content: "一" }]);
    await repository.updateSession(persona.id, (session) => ({ ...session, passphrase: "secret" }));
    const seen = await repository.updatePersonaRecords(persona.id, (state) => ({
      write: { messages: [messageOf(thread, 2, state.nextMessageSeq, "planned")] },
      result: state,
    }));
    expect(seen).toMatchObject({ nextShortId: 4, nextMessageSeq: 42, passphrase: "secret" });
    expect(seen.pages.map((page) => page.id)).toEqual(expect.arrayContaining([...TRUNK_IDS]));
    expect(await repository.getMessage("planned")).toMatchObject({ seq: 42 });
    expect((await repository.updatePersonaRecords("persona_nobody", (state) => ({ write: {}, result: state })))).toEqual({ pages: [], nextShortId: 1, nextMessageSeq: 1, passphrase: "" });
  }],

  ["lets no write in between a plan's read and its write", async (repository) => {
    const persona = await initialized(repository);
    const planned = (content: string) => repository.updatePersonaRecords(persona.id, ({ pages, nextShortId }) => ({
      write: { pages: buildCoreMemoryPages(persona.id, pages, nextShortId, [{ content }], 1) },
      result: undefined,
    }));
    await Promise.all([planned("一"), repository.addCoreMemories(persona.id, [{ content: "二" }]), planned("三"), repository.addCoreMemories(persona.id, [{ content: "四" }])]);
    const memories = liveCoreMemories(await repository.listPages(persona.id, CATEGORY_CORE));
    expect(memories.map((page) => page.metadata.core_id).sort()).toEqual([1, 2, 3, 4]);
    expect(new Set(memories.map((page) => page.shortId)).size).toBe(4);
  }],

  ["writes nothing when a plan throws or holds a row it may not write", async (repository) => {
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    await expect(repository.updatePersonaRecords(persona.id, () => { throw new Error("考え直した"); })).rejects.toThrow("考え直した");
    await expect(repository.updatePersonaRecords(persona.id, () => ({ write: { threads: [thread, threadOf("persona_other")] }, result: undefined }))).rejects.toThrow("persona_other");
    expect(await repository.getThread(thread.id)).toBeUndefined();
    await repository.updatePersonaRecords(persona.id, () => ({ write: { threads: [thread] }, result: undefined }));
    expect(await repository.getThread(thread.id)).toEqual(thread);
  }],

  ["keeps core memories when a thread is deleted", async (repository) => {
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    await repository.putThread(thread);
    await repository.addCoreMemories(persona.id, [{ content: "残る", metadata: { lite_thread_id: thread.id } }]);
    await repository.deleteThreads([thread.id]);
    expect(liveCoreMemories(await repository.listPages(persona.id, CATEGORY_CORE)).map((page) => page.content)).toEqual(["残る"]);
  }],

  ["deletes everything of a persona and nothing of another", async (repository) => {
    const kept = await initialized(repository);
    const persona = { ...createDefaultPersona(1), id: "persona_gone" };
    await repository.putPersona(persona);
    const goneThread = threadOf(persona.id);
    const keptThread = threadOf(kept.id);
    const fragment: FragmentRecord = { id: "f1", personaId: persona.id, content: "猫", entityId: "e", chronicleEntryId: null, vividness: "vivid", sourceDate: null, createdAt: 1, source: null };
    await repository.writePersonaRecords(persona.id, { threads: [goneThread], messages: [messageOf(goneThread, 1, 1)], fragments: [fragment] });
    await repository.writePersonaRecords(kept.id, { threads: [keptThread], messages: [messageOf(keptThread, 1, 1)], fragments: [{ ...fragment, personaId: kept.id }] });
    await repository.addCoreMemories(persona.id, [{ content: "消える" }]);

    await repository.deletePersona(persona.id);

    expect(await repository.getPersona(persona.id)).toBeUndefined();
    expect(await repository.listThreads(persona.id)).toEqual([]);
    expect(await repository.readPersonaMessages(persona.id, { direction: "forward", limit: 5 })).toEqual([]);
    expect(await repository.listPages(persona.id)).toEqual([]);
    expect(await repository.listFragments(persona.id)).toEqual([]);
    expect(await repository.getSession(persona.id)).toBeUndefined();
    expect((await repository.listPages(kept.id)).map((page) => page.id).sort()).toEqual(TRUNK_IDS);
    expect(await repository.listMessages(keptThread.id)).toHaveLength(1);
    expect(await repository.listFragments(kept.id)).toHaveLength(1);
  }],

  ["replaces all stores from a snapshot and seeds a persona the snapshot has no records for", async (repository) => {
    const persona = await initialized(repository);
    const thread = threadOf(persona.id);
    const message = messageOf(thread, 1, 1);
    await repository.writePersonaRecords(persona.id, { threads: [thread], messages: [message] });
    await repository.addCoreMemories(persona.id, [{ content: "残す" }]);
    const snapshot = await repository.exportSnapshot();
    const extra = { ...createDefaultPersona(1), id: "persona_extra" };

    await repository.addCoreMemories(persona.id, [{ content: "消える" }]);
    await repository.replaceSnapshot({ ...snapshot, personas: [...snapshot.personas, extra] });

    expect(liveCoreMemories(await repository.listPages(persona.id, CATEGORY_CORE)).map((page) => page.content)).toEqual(["残す"]);
    expect(await repository.listMessages(thread.id)).toEqual([message]);
    expect((await repository.listPages(extra.id)).map((page) => page.id).sort()).toEqual(TRUNK_IDS);
    expect(await repository.getSession(extra.id)).toMatchObject({ importState: "ready" });
  }],
];

describe("storage contract", () => {
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("saiverse-lite");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });

  describe.each<[string, () => LiteRepository]>([
    ["in memory", () => new MemoryRepository()],
    ["in IndexedDB", () => new IndexedDbRepository()],
  ])("%s", (_name, create) => {
    it.each(contract)("%s", async (_title, exercise) => exercise(create()));
  });
});
