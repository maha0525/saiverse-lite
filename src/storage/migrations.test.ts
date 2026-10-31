import "fake-indexeddb/auto";
import { deleteDB, openDB, type IDBPDatabase } from "idb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultPersona, DEFAULT_SETTINGS, type ConversationThread, type MemoryEntry, type Persona } from "../domain";
import { parseFullBackup } from "../formats";
import { CATEGORY_CORE, liveCoreMemories } from "../pageRecords";
import { IndexedDbRepository } from "./indexedDbRepository";
import type { LegacyChatMessage } from "./legacyData";
import { createV1Stores } from "./migrations";

const NOW = 1_800_000_000_000;
const persona: Persona = { ...createDefaultPersona(1), id: "persona_air" };
const emptyPersona: Persona = { ...createDefaultPersona(1), id: "persona_quiet" };
const oldThread: ConversationThread = { id: "thread_old", personaId: persona.id, title: "古い", createdAt: 1, updatedAt: 100 };
const newThread: ConversationThread = { id: "thread_new", personaId: persona.id, title: "新しい", createdAt: 1, updatedAt: 200 };

function legacyRow(id: string, role: LegacyChatMessage["role"], createdAt: number, fields: Partial<LegacyChatMessage> = {}): LegacyChatMessage {
  return { id, threadId: newThread.id, personaId: persona.id, role, content: id, createdAt, editedAt: null, toolCallId: null, toolName: null, metadata: {}, ...fields };
}

const legacyMessages: LegacyChatMessage[] = [
  legacyRow("m3_tool", "tool", 3_000, { content: "{\"ok\":true}", toolCallId: "call_1", toolName: "image_generate", metadata: { imageDataUrl: "data:image/png;base64,x", prompt: "猫" } }),
  legacyRow("m2_assistant", "assistant", 2_000, { content: "", metadata: { usage: { inputTokens: 3 }, tool_calls: [{ id: "call_1", name: "image_generate", arguments: {} }], lite_provider_state: { openaiResponsesOutput: [] } } }),
  legacyRow("m1_user", "user", 1_000, { editedAt: 1_500 }),
  // Same millisecond: v1 displayed these by id.
  legacyRow("m4_b", "assistant", 4_000),
  legacyRow("m4_a", "user", 4_000),
  legacyRow("other_thread", "user", 500, { threadId: oldThread.id }),
];
const legacyMemories: MemoryEntry[] = [
  { id: "memory_late", personaId: persona.id, threadId: null, kind: "note", content: "新しいメモ", sourceMessageIds: [], createdAt: 9_000, updatedAt: 12_000 },
  { id: "memory_early", personaId: persona.id, threadId: newThread.id, kind: "note", content: "古いメモ", sourceMessageIds: ["m1_user"], createdAt: 5_000, updatedAt: 5_000 },
  { id: "memory_summary", personaId: persona.id, threadId: null, kind: "summary" as "note", content: "廃止された要約", sourceMessageIds: [], createdAt: 1_000, updatedAt: 1_000 },
];

async function seedV1(rows: LegacyChatMessage[] = legacyMessages): Promise<void> {
  const db = await openDB("saiverse-lite", 1, { upgrade: (database) => createV1Stores(database) });
  const tx = db.transaction(["personas", "threads", "messages", "memories", "providers", "settings"], "readwrite");
  for (const item of [persona, emptyPersona]) await tx.objectStore("personas").put(item);
  for (const item of [oldThread, newThread]) await tx.objectStore("threads").put(item);
  for (const item of rows) await tx.objectStore("messages").put(item);
  for (const item of legacyMemories) await tx.objectStore("memories").put(item);
  await tx.objectStore("settings").put({ ...DEFAULT_SETTINGS, userName: "まはー" });
  await tx.done;
  db.close();
}

async function raw<T>(read: (db: IDBPDatabase<unknown>) => Promise<T>): Promise<T> {
  const db = await openDB("saiverse-lite");
  try { return await read(db); } finally { db.close(); }
}

describe("database migration v1 to v2", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await deleteDB("saiverse-lite");
  });

  it("converts messages to the stored form", async () => {
    await seedV1();
    const repository = new IndexedDbRepository();
    await repository.initialize();

    const rows = await repository.listMessages(newThread.id);
    expect(rows.map((row) => row.id)).toEqual(["m1_user", "m2_assistant", "m3_tool", "m4_a", "m4_b"]);
    expect(rows.map((row) => row.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(rows.every((row) => row.scope === "committed" && row.lineRole === null && row.pulseId === null && row.pairedActionText === null && row.source === null)).toBe(true);
    expect(rows[0]).toMatchObject({ role: "user", editedAt: 1_500 });

    expect(rows[1]).toMatchObject({ role: "assistant", content: "" });
    expect(rows[1]?.metadata).toEqual({ usage: { inputTokens: 3 } });

    expect(rows[2]).toMatchObject({ role: "system", content: "[Handy Tool: image_generate]\n{\"ok\":true}" });
    expect(rows[2]?.metadata).toEqual({
      imageDataUrl: "data:image/png;base64,x",
      prompt: "猫",
      tags: ["conversation", "handy_tool"],
      __system_notice__: "handy_tool",
    });
    for (const row of rows) {
      expect(row).not.toHaveProperty("toolCallId");
      expect(row).not.toHaveProperty("toolName");
    }
    expect(await repository.nextMessageSeq(persona.id)).toBe(7);
    expect((await repository.readThreadMessages(newThread.id, { direction: "backward", limit: 1 }))[0]?.id).toBe("m4_b");
  });

  it("moves memos into core memories and leaves the old rows unread", async () => {
    await seedV1();
    const repository = new IndexedDbRepository();
    await repository.initialize();

    const core = (await repository.listPages(persona.id, CATEGORY_CORE)).filter((page) => !page.isTrunk);
    expect(core.map((page) => [page.id, page.title, page.shortId, page.metadata.core_id])).toEqual([
      ["memory_early", "コア記憶 c:1", 3, 1],
      ["memory_late", "コア記憶 c:2", 4, 2],
    ]);
    expect(core[0]).toMatchObject({
      personaId: persona.id, parentId: "root_core", category: "core", content: "古いメモ", summary: "",
      createdAt: 5, updatedAt: 5, keywords: [], isDeleted: false, isTrunk: false, isImportant: true, vividness: "rough", source: null,
    });
    expect(core[0]?.metadata).toEqual({
      lite_thread_id: newThread.id, source_message_ids: ["m1_user"], core_id: 1, kind: "note", confirmed: 1, deleted_at: null,
    });
    expect(core[1]?.updatedAt).toBe(12);
    expect(await raw((db) => db.count("memories"))).toBe(legacyMemories.length);
  });

  it("creates trunks and a session for every persona, active on the latest thread", async () => {
    await seedV1();
    const repository = new IndexedDbRepository();
    await repository.initialize();

    expect(await repository.getSession(persona.id)).toEqual({
      personaId: persona.id, activeThreadId: newThread.id, anchorMessageId: null, headText: null, chronicleText: null,
      passphrase: null, headUpdatedAt: null, metabolismError: null, importState: "ready",
    });
    expect(await repository.getSession(emptyPersona.id)).toMatchObject({ activeThreadId: null });
    expect((await repository.listPages(emptyPersona.id)).filter((page) => page.isTrunk)).toHaveLength(6);
    expect(liveCoreMemories(await repository.listPages(emptyPersona.id, CATEGORY_CORE))).toEqual([]);
  });

  it("keeps everything else and removes the replaced indexes", async () => {
    await seedV1();
    const repository = new IndexedDbRepository();
    await repository.initialize();
    expect(await repository.getSettings()).toMatchObject({ userName: "まはー" });
    expect(await repository.getThread(oldThread.id)).toEqual(oldThread);
    expect(await repository.listMessages(oldThread.id)).toHaveLength(1);
    expect(await raw(async (db) => [...db.transaction("messages").store.indexNames].sort())).toEqual(["by-persona-order", "by-persona-seq", "by-thread-order"]);
  });

  it("does not lose a row without a usable createdAt", async () => {
    await seedV1([legacyRow("broken", "user", Number.NaN), legacyRow("fine", "user", 10)]);
    const repository = new IndexedDbRepository();
    await repository.initialize();
    expect((await repository.listMessages(newThread.id)).map((row) => [row.id, row.createdAt])).toEqual([["broken", 0], ["fine", 10]]);
  });

  it("gives the same records as restoring the same data from a v1 backup", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    await seedV1();
    const repository = new IndexedDbRepository();
    await repository.initialize();
    const migrated = await repository.exportSnapshot();
    const restored = parseFullBackup({
      format: "saiverse_lite_backup_v1",
      data: { personas: [persona, emptyPersona], threads: [oldThread, newThread], messages: legacyMessages, memories: legacyMemories, providers: [], settings: {} },
    }, NOW);
    const byKey = <T extends { personaId: string; id: string }>(rows: T[]) => [...rows].sort((a, b) => `${a.personaId}/${a.id}`.localeCompare(`${b.personaId}/${b.id}`));
    expect(byKey(migrated.pages)).toEqual(byKey(restored.pages));
    expect([...migrated.messages].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...restored.messages].sort((a, b) => a.id.localeCompare(b.id)));
    expect([...migrated.sessions].sort((a, b) => a.personaId.localeCompare(b.personaId))).toEqual(restored.sessions);
  });

  it("creates the v2 schema on a fresh device", async () => {
    const repository = new IndexedDbRepository();
    await repository.initialize();
    const defaultPersona = (await repository.listPersonas())[0]!;
    expect((await repository.listPages(defaultPersona.id)).filter((page) => page.isTrunk)).toHaveLength(6);
    expect(await raw(async (db) => db.version)).toBe(2);
  });

  it("leaves the v1 database untouched when the migration fails, and succeeds on the next start", async () => {
    await seedV1();
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    let puts = 0;
    const realPut = put.getMockImplementation() ?? IDBObjectStore.prototype.put;
    put.mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      puts += 1;
      if (this.name === "pages" && puts > 8) throw new Error("disk full");
      return realPut.apply(this, args);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(new IndexedDbRepository().initialize()).rejects.toThrow("disk full");
    put.mockRestore();

    const stored = await raw(async (db) => ({
      version: db.version,
      stores: [...db.objectStoreNames].sort(),
      messages: await db.getAll("messages"),
      memories: await db.count("memories"),
    }));
    expect(stored.version).toBe(1);
    expect(stored.stores).toEqual(["memories", "messages", "personas", "providers", "settings", "threads"]);
    expect(stored.memories).toBe(legacyMemories.length);
    expect(stored.messages.find((row: LegacyChatMessage) => row.id === "m3_tool")).toMatchObject({ role: "tool", toolName: "image_generate" });
    expect(stored.messages).not.toContainEqual(expect.objectContaining({ seq: expect.anything() }));

    const repository = new IndexedDbRepository();
    await repository.initialize();
    expect(await repository.listMessages(newThread.id)).toHaveLength(5);
  });

  it("says so when another tab holds the old version open", async () => {
    await seedV1();
    const holder = await openDB("saiverse-lite", 1);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(new IndexedDbRepository().initialize()).rejects.toThrow("別のタブ");
    holder.close();
    await vi.waitFor(async () => expect(await raw(async (db) => db.version)).toBe(2));
  });

  it("releases its connection when a newer version asks for the database", async () => {
    const repository = new IndexedDbRepository();
    await repository.initialize();
    const newer = await openDB("saiverse-lite", 3);
    expect(newer.version).toBe(3);
    newer.close();
  });
});
