import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatMessage, type ChatMessage } from "../domain";
import { chronicleEntry } from "../memory/entries";
import { messageTags, resolveInitialAnchor } from "../memory/window";
import { IndexedDbRepository } from "../storage/indexedDbRepository";
import { MemoryRepository } from "../storage/memoryRepository";
import type { LiteRepository, PersonaRecordBatch } from "../storage/repository";
import { PackArchive } from "./archive";
import { readAttachment } from "./attachments";
import { MAX_UNCOMPRESSED_BYTES, PackError, PackFormatError, decodeValue, packTimeToMilliseconds, packTimeToSeconds, parseJson } from "./format";
import { importPersonaPack, type PackImportOptions } from "./importPack";
import { iterJsonArray } from "./jsonStream";
import { MemoryPackStore } from "./packStore";
import { checkArchive, readManifest, validatePack } from "./validate";

interface ExpectedRow { [key: string]: unknown }
const fixture = readFileSync(new URL("./__fixtures__/persona_pack_fixture.zip", import.meta.url));
const expected = JSON.parse(readFileSync(new URL("./__fixtures__/persona_pack_fixture.expected.json", import.meta.url), "utf-8")) as {
  persona_id: string;
  ai: { AINAME: string; SYSTEMPROMPT: string; DESCRIPTION: string };
  threads: ExpectedRow[];
  stelis_threads: ExpectedRow[];
  messages: ExpectedRow[];
  pages: ExpectedRow[];
  fragments: ExpectedRow[];
};
const personaId = expected.persona_id;

const packFile = () => new Blob([fixture]);

/** The fixture with its entries changed, written back with no compression. */
async function changedPack(change: (zip: JSZip) => void | Promise<void>): Promise<Blob> {
  const zip = await JSZip.loadAsync(fixture);
  await change(zip);
  return await zip.generateAsync({ type: "blob" });
}

async function jsonOf(zip: JSZip, name: string): Promise<unknown> {
  return JSON.parse(await zip.file(name)!.async("string")) as unknown;
}

const MESSAGES = "chatlog/messages.json";
const FRAGMENTS = "extensions/saiverse/memory_db/memopedia_fragments.json";

async function changeRows(zip: JSZip, name: string, change: (rows: Record<string, unknown>[]) => void): Promise<void> {
  const rows = await jsonOf(zip, name) as Record<string, unknown>[];
  change(rows);
  zip.file(name, JSON.stringify(rows));
}

async function changeManifest(zip: JSZip, change: (manifest: Record<string, unknown>) => void): Promise<void> {
  const manifest = await jsonOf(zip, "manifest.json") as Record<string, unknown>;
  change(manifest);
  zip.file("manifest.json", JSON.stringify(manifest));
}

const withoutFolder = (folder: string) => changedPack((zip) => changeManifest(zip, (manifest) => {
  manifest.contents = (manifest.contents as string[]).filter((item) => item !== folder);
}));

const encoded = (value: unknown): { __bytes_b64__: string } => ({ __bytes_b64__: Buffer.from(JSON.stringify(value)).toString("base64") });

function options(): PackImportOptions {
  return { providerId: "provider_mock", model: "mock-friendly", resolveInitialAnchor: vi.fn(async () => "m-01") };
}

async function* chunksOf(bytes: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

async function readArray(text: string | Uint8Array, size = 1, maxElementChars = 1024): Promise<unknown[]> {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const items: unknown[] = [];
  for await (const item of iterJsonArray(chunksOf(bytes, size), "t.json", { maxElementChars })) items.push(item);
  return items;
}

async function allMessages(repository: LiteRepository): Promise<ChatMessage[]> {
  return repository.readPersonaMessages(personaId, { direction: "forward", limit: 10_000 });
}

let repository: MemoryRepository;
let store: MemoryPackStore;

beforeEach(async () => {
  repository = new MemoryRepository();
  await repository.initialize();
  store = new MemoryPackStore();
});

describe("iterJsonArray", () => {
  const value = [{ a: "]}\"\\", b: [1, 2, { c: null }] }, "文字🌸\n", 12.5e3, true, null, [], {}];

  it.each([
    ["one line", JSON.stringify(value)],
    ["pretty", JSON.stringify(value, null, 3)],
    ["crlf and tabs", ` \r\n\t[\r\n${value.map((item) => JSON.stringify(item)).join("\t,\r\n ")}\n]\r\n `],
  ])("reads %s across every chunk boundary", async (_name, text) => {
    for (const size of [1, 2, 3, 7, 4096]) expect(await readArray(text, size)).toEqual(value);
  });

  it("reads an empty array and hands out one element at a time", async () => {
    expect(await readArray(" [ ] ")).toEqual([]);
    const seen: unknown[] = [];
    const reader = iterJsonArray(chunksOf(new TextEncoder().encode("[1,2,oops"), 1), "t.json", { maxElementChars: 10 });
    await expect((async () => { for await (const item of reader) seen.push(item); })()).rejects.toBeInstanceOf(PackError);
    expect(seen).toEqual([1, 2]);
  });

  it.each([
    ["no array", '{"a":1}'],
    ["a scalar document", "1"],
    ["empty input", ""],
    ["only spaces", "  "],
    ["unterminated array", "[1,"],
    ["unterminated string", '["a'],
    ["unterminated object", '[{"a":1'],
    ["trailing comma", "[1,]"],
    ["missing comma", "[1 2]"],
    ["extra data", "[1] 2"],
    ["broken element", "[{a:1}]"],
    ["control character in a string", '["a\nb"]'],
    ["mismatched bracket", '[{"a":1]]'],
    ["BOM", "\ufeff[]"],
    ["NaN with a sign", "[-NaN]"],
    ["a number glued to NaN", "[1NaN]"],
  ])("refuses %s", async (_name, text) => {
    await expect(readArray(text)).rejects.toBeInstanceOf(PackError);
  });

  it("reads what json.dumps writes for values JSON has no number for, and leaves strings alone", async () => {
    expect(await readArray('[NaN,{"a":[Infinity,-Infinity]},"NaN and Infinity"]')).toEqual([Number.NaN, { a: [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] }, "NaN and Infinity"]);
    expect(parseJson('{"NaN":"\\"NaN\\"","v":NaN}')).toEqual({ NaN: '"NaN"', v: Number.NaN });
  });

  it("refuses bytes that are not UTF-8, also when cut inside a character", async () => {
    await expect(readArray(new Uint8Array([0x5b, 0xff, 0x5d]))).rejects.toThrow("UTF-8");
    await expect(readArray(new Uint8Array([0x5b, 0x22, 0xe3, 0x81]))).rejects.toThrow("UTF-8");
  });

  it("holds the element limit, on one chunk and across chunks", async () => {
    const element = JSON.stringify("x".repeat(20));
    expect(await readArray(`[${element}]`, 4096, element.length)).toEqual(["x".repeat(20)]);
    await expect(readArray(`[${element}]`, 4096, element.length - 1)).rejects.toThrow("上限");
    await expect(readArray(`[${element}]`, 1, element.length - 1)).rejects.toThrow("上限");
    await expect(readArray(`[1,${"2".repeat(30)}]`, 1, 10)).rejects.toThrow("2 番目");
  });
});

describe("pack times", () => {
  it("reads the forms epoch_to_iso writes", () => {
    expect(packTimeToMilliseconds("2025-10-09T08:53:20+00:00")).toBe(1_760_000_000_000);
    expect(packTimeToMilliseconds("2025-10-09T17:53:20+09:00")).toBe(1_760_000_000_000);
    expect(packTimeToMilliseconds("2025-10-09T08:53:20")).toBe(1_760_000_000_000);
    expect(packTimeToSeconds("2025-10-09T08:53:20.500000+00:00")).toBe(1_760_000_000.5);
    expect(packTimeToSeconds(1_760_000_000)).toBe(1_760_000_000);
    expect(packTimeToMilliseconds("昨日")).toBeNull();
    expect(packTimeToMilliseconds(null)).toBeNull();
  });
});

/** What the database's text of messages.metadata reads as, in the shape decodeValue gives it. */
function metadataValue(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : text;
  } catch {
    return text;
  }
}

describe("importing the fixture", () => {
  it("has the kinds of records the import must carry", () => {
    const levels = expected.pages.flatMap((row) => {
      if (row.category !== "chronicle" || row.is_trunk === 1) return [];
      return [(JSON.parse(String(row.metadata)) as { level: number }).level];
    });
    expect(levels.sort()).toEqual([1, 1, 2]);
    expect(expected.pages.filter((row) => row.category === "core" && row.is_trunk === 0).length).toBeGreaterThan(0);
    expect(expected.pages.filter((row) => row.category === "people" && row.is_trunk === 0).length).toBeGreaterThan(0);
    expect(expected.fragments.length).toBeGreaterThan(0);
    expect(expected.threads.length).toBeGreaterThan(1);
    expect(expected.stelis_threads.length).toBeGreaterThan(0);
    expect(new Set(expected.messages.map((row) => row.role))).toEqual(new Set(["user", "assistant", "model", "system", "host"]));
  });

  it("keeps thought_signature to the byte", async () => {
    await importPersonaPack(packFile(), repository, store, options());
    const decoded = async (id: string) => decodeValue((await repository.getMessage(id))?.source?.thought_signature);
    expect(await decoded("m-02")).toEqual(Uint8Array.from({ length: 256 }, (_, index) => index));
    expect(await decoded("m-03")).toEqual(new Uint8Array([0x00, 0x01, 0xff]));
  });

  it("stores the same rows in IndexedDB as in memory", async () => {
    const indexedDb = new IndexedDbRepository();
    await indexedDb.initialize();
    const inMemory = await importPersonaPack(packFile(), repository, store, options());
    expect(await importPersonaPack(packFile(), indexedDb, new MemoryPackStore(), options())).toEqual(inMemory);
    expect(await allMessages(indexedDb)).toEqual(await allMessages(repository));
    expect(await indexedDb.listPages(personaId)).toEqual(await repository.listPages(personaId));
    expect(await indexedDb.listFragments(personaId)).toEqual(await repository.listFragments(personaId));
    expect(await indexedDb.listThreads(personaId)).toEqual(await repository.listThreads(personaId));
    expect(await indexedDb.getSession(personaId)).toEqual(await repository.getSession(personaId));
  });

  it("stores every row with the values of the database it was written from", async () => {
    const result = await importPersonaPack(packFile(), repository, store, options());
    expect(result).toMatchObject({
      personaId, personaName: expected.ai.AINAME, activeThreadId: `${personaId}:room_a`,
      threads: expected.threads.length, messages: expected.messages.length, pages: expected.pages.length, fragments: expected.fragments.length, warnings: [],
    });

    const persona = await repository.getPersona(personaId);
    expect(persona).toMatchObject({ name: expected.ai.AINAME, systemPrompt: expected.ai.SYSTEMPROMPT, description: expected.ai.DESCRIPTION, providerId: "provider_mock", model: "mock-friendly" });
    expect(persona?.avatarDataUrl).toMatch(/^data:image\/png;base64,iVBOR/);

    const threads = await repository.listThreads(personaId);
    expect(threads.map((thread) => thread.id).sort()).toEqual(expected.threads.map((row) => row.id).sort());
    for (const row of expected.threads) {
      const thread = threads.find((item) => item.id === row.id)!;
      const suffix = String(row.id).split(":")[1];
      expect(thread.title).toBe(row.title ?? (suffix === "stelis_1" ? "試料の Stelis" : suffix));
      expect(thread.stelis === true).toBe(expected.stelis_threads.some((stelis) => stelis.thread_id === row.id));
      expect(thread.source?.id).toBe(row.id);
    }

    const messages = await allMessages(repository);
    expect(messages).toHaveLength(expected.messages.length);
    for (const row of expected.messages) {
      const message = messages.find((item) => item.id === row.id)!;
      expect(message).toMatchObject({
        threadId: row.thread_id, personaId, content: row.content, createdAt: Number(row.created_at) * 1000, seq: row.seq,
        editedAt: null, scope: row.scope, lineRole: row.line_role, pulseId: row.pulse_id, pairedActionText: row.paired_action_text,
      });
      expect(message.role).toBe(row.role === "model" ? "assistant" : row.role);
      expect(message.source?.role).toBe(row.role);
      expect(message.source?.seq).toBe(row.seq);
      expect(decodeValue(message.source?.metadata)).toEqual(metadataValue(row.metadata));
    }

    const pages = await repository.listPages(personaId);
    expect(pages).toHaveLength(expected.pages.length);
    for (const row of expected.pages) {
      const page = pages.find((item) => item.id === row.id)!;
      expect(page).toMatchObject({
        parentId: row.parent_id, title: row.title, summary: row.summary, content: row.content, category: row.category,
        createdAt: row.created_at, updatedAt: row.updated_at, keywords: JSON.parse(String(row.keywords)) as unknown,
        metadata: row.metadata === null ? {} : JSON.parse(String(row.metadata)) as unknown,
        isDeleted: row.is_deleted === 1, vividness: row.vividness, isTrunk: row.is_trunk === 1, isImportant: row.is_important === 1,
        lastReferencedAt: row.last_referenced_at, shortId: row.short_id,
      });
      expect(page.source?.id).toBe(row.id);
    }

    const fragments = await repository.listFragments(personaId);
    expect(fragments).toHaveLength(expected.fragments.length);
    for (const row of expected.fragments) {
      expect(fragments.find((item) => item.id === row.id)).toMatchObject({
        content: row.content, entityId: row.entity_id, chronicleEntryId: row.chronicle_entry_id,
        vividness: row.vividness, sourceDate: row.source_date, createdAt: row.created_at,
      });
    }
  });

  it("keeps the order of one second, the pack row in source, and metadata unwrapped", async () => {
    await importPersonaPack(packFile(), repository, store, options());
    const messages = await allMessages(repository);
    const byId = new Map(messages.map((message) => [message.id, message]));
    expect(messages.slice(0, 3).map((message) => message.id)).toEqual(["m-01", "m-02", "m-03"]);

    expect(byId.get("m-11")?.metadata).toEqual({});
    expect(byId.get("m-11")?.source?.metadata).toEqual({ __raw_text__: "null" });
    expect(byId.get("m-12")?.metadata).toEqual({});
    expect(byId.get("m-12")?.source?.metadata).toEqual({ __raw_text__: "{not json" });
    // The user's own dict that looks like a wrapper is the value, not a wrapper.
    expect(byId.get("m-13")?.metadata).toEqual({ __raw_text__: "利用者の文字列" });
    expect(byId.get("m-13")?.source?.metadata).toEqual({ __escaped__: { __raw_text__: "利用者の文字列" } });
    expect(byId.get("m-14")?.metadata).toEqual({});
    expect(byId.get("m-05")?.metadata).toMatchObject({ __system_notice__: "handy_tool" });
    expect(byId.get("m-02")?.source?.thought_signature).toEqual({ __bytes_b64__: expect.any(String) as string });
    expect(byId.get("m-03")?.content).toBe("  前後の空白も本文  ");
  });

  it("gives the readers of tags, attachments, Chronicle and keywords the unwrapped value", async () => {
    const pack = await changedPack(async (zip) => {
      await changeRows(zip, MESSAGES, (rows) => {
        for (const row of rows.filter((item) => item.id === "m-01" || item.id === "m-05")) row.metadata = encoded(row.metadata);
      });
      await changeRows(zip, "knowledge/pages.json", (rows) => {
        const entry = rows.find((row) => row.id === "ch-1")!;
        entry.metadata = encoded(entry.metadata);
        entry.keywords = encoded(["猫"]);
      });
    });
    await importPersonaPack(pack, repository, store, options());

    const tool = await repository.getMessage("m-05");
    expect(messageTags(tool!)).toContain("handy_tool");
    expect(tool?.source?.metadata).toEqual({ __bytes_b64__: expect.any(String) as string });
    const [image] = (await repository.getMessage("m-01"))?.metadata.images as { uri: string }[];
    expect((await readAttachment(store, personaId, image!))?.type).toBe("image/png");
    const page = (await repository.getPage(personaId, "ch-1"))!;
    expect(chronicleEntry(page)?.level).toBe(1);
    expect(page.keywords).toEqual(["猫"]);
  });

  it("settles the session, with the active thread in place when the anchor is resolved", async () => {
    const seen: unknown[] = [];
    const resolveInitialAnchor = vi.fn(async (repo: LiteRepository, id: string) => {
      seen.push(await repo.getSession(id));
      return "m-02";
    });
    await importPersonaPack(packFile(), repository, store, { ...options(), resolveInitialAnchor });
    expect(resolveInitialAnchor).toHaveBeenCalledOnce();
    expect(seen).toEqual([expect.objectContaining({ activeThreadId: `${personaId}:room_a`, importState: "importing" })]);
    expect(await repository.getSession(personaId)).toMatchObject({ activeThreadId: `${personaId}:room_a`, anchorMessageId: "m-02", importState: "ready" });
    expect((await store.get(personaId))?.size).toBe(fixture.length);
  });

  it("starts the active thread at the oldest row no first-level Chronicle covers, with src/memory/window.ts", async () => {
    // m-02 is covered by ch-2. Past it the thread has enough to keep, so no older row is added.
    const pack = await changedPack((zip) => changeRows(zip, MESSAGES, (rows) => { rows.find((row) => row.id === "m-14")!.content = "長".repeat(25_000); }));
    await importPersonaPack(pack, repository, store, { ...options(), resolveInitialAnchor });
    expect(await repository.getSession(personaId)).toMatchObject({ activeThreadId: `${personaId}:room_a`, anchorMessageId: "m-11", importState: "ready" });
  });

  it("adds older rows up to the kept amount, with src/memory/window.ts", async () => {
    await importPersonaPack(packFile(), repository, store, { ...options(), resolveInitialAnchor });
    expect(await repository.getSession(personaId)).toMatchObject({ anchorMessageId: "m-02", importState: "ready" });
  });

  it("reports the stages with their totals", async () => {
    const stages: string[] = [];
    let messages = 0;
    await importPersonaPack(packFile(), repository, store, options(), (progress) => {
      stages.push(progress.stage);
      if (progress.stage === "messages") { messages = progress.done; expect(progress.total).toBe(expected.messages.length); }
    });
    expect([...new Set(stages)]).toEqual(["checking", "saving", "messages", "threads", "pages", "fragments", "finishing"]);
    expect(messages).toBe(expected.messages.length);
  });
});

describe("the active thread", () => {
  it("is <persona_id>:__persona__ when active_state.json is gone", async () => {
    const pack = await changedPack((zip) => { zip.remove("extensions/saiverse/persona_dir/active_state.json"); });
    expect((await importPersonaPack(pack, repository, store, options())).activeThreadId).toBe(`${personaId}:__persona__`);
  });

  it("is the latest non-Stelis thread when the named one does not exist", async () => {
    const pack = await changedPack((zip) => { zip.file("extensions/saiverse/persona_dir/active_state.json", '{"active_thread_id":"gone"}'); });
    expect((await importPersonaPack(pack, repository, store, options())).activeThreadId).toBe(`${personaId}:__persona__`);
  });

  it("is not read from a folder the manifest does not list", async () => {
    const result = await importPersonaPack(await withoutFolder("extensions/saiverse"), repository, store, options());
    expect(result.activeThreadId).toBe(`${personaId}:__persona__`);
    expect(result.fragments).toBe(0);
  });

  it("is never a Stelis thread", async () => {
    const pack = await changedPack((zip) => { zip.file("extensions/saiverse/persona_dir/active_state.json", '{"active_thread_id":"stelis_1"}'); });
    expect((await importPersonaPack(pack, repository, store, options())).activeThreadId).toBe(`${personaId}:__persona__`);
  });
});

describe("attachments", () => {
  it("reads the file a metadata item points to out of the stored ZIP", async () => {
    await importPersonaPack(packFile(), repository, store, options());
    const message = await repository.getMessage("m-01");
    const [image] = message?.metadata.images as { uri: string }[];
    const blob = await readAttachment(store, personaId, image!);
    expect(blob?.type).toBe("image/png");
    expect(new Uint8Array(await blob!.arrayBuffer()).subarray(0, 4)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it("gives null when the manifest does not list attachments", async () => {
    await importPersonaPack(await withoutFolder("attachments"), repository, store, options());
    expect(await readAttachment(store, personaId, { uri: "saiverse://image/pic.png" })).toBeNull();
  });

  it("gives null for a file the export could not carry and for an unknown pack", async () => {
    await importPersonaPack(packFile(), repository, store, options());
    expect(await readAttachment(store, personaId, { uri: "saiverse://audio/gone.ogg" })).toBeNull();
    expect(await readAttachment(store, personaId, {})).toBeNull();
    expect(await readAttachment(store, "nobody", { uri: "saiverse://image/pic.png" })).toBeNull();
  });
});

describe("refusing a pack", () => {
  async function expectNothingWritten(): Promise<void> {
    expect(await repository.getPersona(personaId)).toBeUndefined();
    expect(await repository.getSession(personaId)).toBeUndefined();
    expect(await store.get(personaId)).toBeNull();
  }

  const refused: [string, (zip: JSZip) => void | Promise<void>, string][] = [
    ["a missing manifest", (zip) => { zip.remove("manifest.json"); }, "manifest.json"],
    ["another format", async (zip) => { zip.file("manifest.json", JSON.stringify({ ...(await jsonOf(zip, "manifest.json") as object), format: "other" })); }, "パックではありません"],
    ["an unknown major version", async (zip) => { zip.file("manifest.json", JSON.stringify({ ...(await jsonOf(zip, "manifest.json") as object), version: "2.0" })); }, "版"],
    ["no persona_id", async (zip) => { zip.file("manifest.json", JSON.stringify({ ...(await jsonOf(zip, "manifest.json") as object), persona_id: "" })); }, "persona_id"],
    ["contents that is not a list", async (zip) => { zip.file("manifest.json", JSON.stringify({ ...(await jsonOf(zip, "manifest.json") as object), contents: "chatlog" })); }, "contents"],
    ["a broken manifest", (zip) => { zip.file("manifest.json", "{"); }, "manifest.json"],
    ["a path that climbs out", (zip) => { zip.file("journal/day_reports/..\\escape.md", "x"); }, "安全でないパス"],
    ["a path with a drive", (zip) => { zip.file("journal/c:/x.md", "x"); }, "安全でないパス"],
    ["an unexpected extensions file", (zip) => { zip.file("extensions/saiverse/memory_db/sub/table.json", "[]"); }, "想定外"],
    ["a message row without thread_id", async (zip) => {
      const rows = await jsonOf(zip, "chatlog/messages.json") as Record<string, unknown>[];
      delete rows[0]!.thread_id;
      zip.file("chatlog/messages.json", JSON.stringify(rows));
    }, "thread_id"],
    ["a message row that is no object", (zip) => { zip.file("chatlog/messages.json", "[1]"); }, "オブジェクト"],
    ["a page without category", async (zip) => {
      const rows = await jsonOf(zip, "knowledge/pages.json") as Record<string, unknown>[];
      rows[0]!.category = "";
      zip.file("knowledge/pages.json", JSON.stringify(rows));
    }, "category"],
    ["broken messages JSON", (zip) => { zip.file("chatlog/messages.json", "[{"); }, "壊れています"],
    ["a fragment without entity_id", async (zip) => {
      const name = "extensions/saiverse/memory_db/memopedia_fragments.json";
      const rows = await jsonOf(zip, name) as Record<string, unknown>[];
      delete rows[0]!.entity_id;
      zip.file(name, JSON.stringify(rows));
    }, "entity_id"],
    ["an attachment that points to nothing", (zip) => { zip.file("attachments/index.json", '[{"ref":"a","path":"attachments/image/gone.png"}]'); }, "無いファイル"],
    ["an attachment path of another shape", (zip) => {
      zip.file("attachments/x.png", "x");
      zip.file("attachments/index.json", '[{"ref":"a","path":"attachments/x.png"}]');
    }, "添付のパス"],
    ["a profile without ai", (zip) => { zip.file("profile/profile.json", "{}"); }, "ai"],
    ["a journal row without its key", (zip) => { zip.file("journal/memos.json", '[{"id":1}]'); }, "activity_id"],
    ["a task_book row without its key", (zip) => { zip.file("journal/task_book.json", "[{}]"); }, "TASK_ID"],
    ["broken journal JSON", (zip) => { zip.file("journal/activities.json", "[{"); }, "壊れています"],
    ["an extensions table that is not rows", (zip) => { zip.file("extensions/saiverse/saiverse_db/persona_task.json", "[1]"); }, "オブジェクト"],
    ["broken extensions JSON", (zip) => { zip.file("extensions/saiverse/memory_db/pulse_logs.json", "[{"); }, "壊れています"],
    ["a private room without building", (zip) => { zip.file("items/private_room.json", "{}"); }, "building"],
    ["a private room with fixtures of the wrong shape", async (zip) => {
      zip.file("items/private_room.json", JSON.stringify({ ...(await jsonOf(zip, "items/private_room.json") as object), fixtures: null }));
    }, "fixtures"],
    ["a fixture without FIXTURE_ID", async (zip) => {
      zip.file("items/private_room.json", JSON.stringify({ ...(await jsonOf(zip, "items/private_room.json") as object), fixtures: [{}] }));
    }, "FIXTURE_ID"],
    ["a private room pointing to no file", async (zip) => {
      zip.file("items/private_room.json", JSON.stringify({ ...(await jsonOf(zip, "items/private_room.json") as object), files: { IMAGE_PATH: "items/gone.png" } }));
    }, "無いファイル"],
    ["items without locations", (zip) => { zip.file("items/items.json", '{"items":[]}'); }, "locations"],
    ["an item without ITEM_ID", (zip) => { zip.file("items/items.json", '{"items":[{}],"locations":[]}'); }, "ITEM_ID"],
    ["a location without its owner", (zip) => { zip.file("items/items.json", '{"items":[],"locations":[{"ITEM_ID":"a"}]}'); }, "locations"],
  ];

  it.each(refused)("refuses %s before writing anything", async (_name, change, message) => {
    const pack = await changedPack(change);
    await expect(importPersonaPack(pack, repository, store, options())).rejects.toThrow(message);
    await expect(validatePack(pack)).rejects.toBeInstanceOf(PackError);
    await expectNothingWritten();
  });

  it("tells a broken file from a version this app can be updated for", async () => {
    await expect(importPersonaPack(await changedPack((zip) => { zip.remove("manifest.json"); }), repository, store, options())).rejects.toBeInstanceOf(PackFormatError);
    const newer = await changedPack((zip) => changeManifest(zip, (manifest) => { manifest.version = "2.0"; }));
    const failure = await importPersonaPack(newer, repository, store, options()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PackError);
    expect(failure).not.toBeInstanceOf(PackFormatError);
  });

  it("refuses a file that is not a ZIP, and a cut one", async () => {
    await expect(importPersonaPack(new Blob(["not a zip"]), repository, store, options())).rejects.toThrow("ZIP");
    await expect(importPersonaPack(new Blob([fixture.subarray(0, fixture.length - 40)]), repository, store, options())).rejects.toThrow("ZIP");
    await expectNothingWritten();
  });

  it("refuses an entry whose bytes do not match its CRC, even when the JSON still parses", async () => {
    const bytes = new Uint8Array(await (await changedPack(() => undefined)).arrayBuffer());
    const key = Buffer.from(bytes).indexOf("paired_action_text");
    expect(key).toBeGreaterThan(0);
    bytes[key] = "q".charCodeAt(0);
    await expect(importPersonaPack(new Blob([bytes]), repository, store, options())).rejects.toThrow("読み出せません");
    await expectNothingWritten();
  });

  it("refuses a ZIP that expands past the limit", async () => {
    const archive = await PackArchive.open(packFile());
    Object.defineProperty(archive, "uncompressedBytes", { value: MAX_UNCOMPRESSED_BYTES + 1 });
    await expect(checkArchive(archive, await readManifest(archive))).rejects.toThrow("上限");
    await archive.close();
  });

  it("says why when the pack cannot be kept, before reading it", async () => {
    await expect(importPersonaPack(new Blob(["not a zip"]), repository, new MemoryPackStore("保存できません"), options())).rejects.toThrow("保存できません");
    await expectNothingWritten();
  });

  it("refuses when the device has too little room", async () => {
    await expect(importPersonaPack(packFile(), repository, new MemoryPackStore(null, 1024), options())).rejects.toThrow("空き容量");
    await expectNothingWritten();
  });

  it("leaves out a row whose JSON column breaks the export's contract, and says so", async () => {
    const pack = await changedPack((zip) => changeRows(zip, MESSAGES, (rows) => {
      rows[0]!.metadata = { __raw_text__: '{"images":[]}' };
      rows[1]!.metadata = { __bytes_b64__: "/////w==" };
      rows[2]!.metadata = { __bytes_b64__: btoa('{"tags":[]}') };
    }));
    const result = await importPersonaPack(pack, repository, store, options());
    expect(result.messages).toBe(expected.messages.length - 2);
    expect(result.warnings).toEqual([expect.stringContaining("発言 2件")]);
    expect(await repository.getMessage("m-01")).toBeUndefined();
    expect((await repository.getMessage("m-03"))?.metadata).toEqual({ tags: [] });
    expect((await repository.getMessage("m-03"))?.source?.metadata).toEqual({ __bytes_b64__: btoa('{"tags":[]}') });
  });

  it("takes a fragment with no text, as the body does", async () => {
    const pack = await changedPack((zip) => changeRows(zip, FRAGMENTS, (rows) => { rows[0]!.content = ""; }));
    expect((await importPersonaPack(pack, repository, store, options())).fragments).toBe(expected.fragments.length);
  });

  it("takes a row with a value only json.dumps can write", async () => {
    const pack = await changedPack(async (zip) => {
      const text = await zip.file(MESSAGES)!.async("string");
      zip.file(MESSAGES, text.replace('"tags": ["internal"]', '"tags": ["internal"], "score": NaN'));
    });
    await importPersonaPack(pack, repository, store, options());
    expect((await repository.getMessage("m-07"))?.metadata.score).toBeNaN();
  });

  it("does not read a profile the manifest does not list", async () => {
    const persona = await importPersonaPack(await withoutFolder("profile"), repository, store, options());
    expect(persona.personaName).toBe(expected.ai.AINAME);
    expect(await repository.getPersona(personaId)).toMatchObject({ systemPrompt: "", avatarDataUrl: null });
  });

  it("does not take the rows of a persona already here under another persona_id", async () => {
    await importPersonaPack(packFile(), repository, store, options());
    const otherId = "pack_fixture_city_b";
    const moved = await changedPack(async (zip) => {
      await changeManifest(zip, (manifest) => { manifest.persona_id = otherId; });
      for (const name of ["chatlog/threads.json", "chatlog/stelis_threads.json", MESSAGES]) {
        zip.file(name, (await zip.file(name)!.async("string")).replaceAll(`${personaId}:`, `${otherId}:`));
      }
    });
    await expect(importPersonaPack(moved, repository, store, options())).rejects.toThrow(`${expected.ai.AINAME}を削除`);
    expect(await repository.getPersona(otherId)).toBeUndefined();
    expect(await repository.getSession(otherId)).toBeUndefined();
    expect(await store.get(otherId)).toBeNull();
    expect(await allMessages(repository)).toHaveLength(expected.messages.length);
  });

  it.each([
    ["threads.json", "chatlog/threads.json", { id: "shared_thread" }],
    ["stelis_threads.json", "chatlog/stelis_threads.json", { thread_id: "shared_thread" }],
  ])("does not take a thread of another persona named only in %s", async (_name, file, row) => {
    await repository.putThread({ id: "shared_thread", personaId: "persona_first", title: "ここの会話", createdAt: 1, updatedAt: 1 });
    const pack = await changedPack((zip) => changeRows(zip, file, (rows) => { rows.push(row); }));
    await expect(importPersonaPack(pack, repository, store, options())).rejects.toThrow("を削除");
    await expectNothingWritten();
    expect((await repository.getThread("shared_thread"))?.personaId).toBe("persona_first");
  });

  it("holds the same rule in the write, for a row that appeared after the check", async () => {
    const owned = createChatMessage({ id: "m-03", threadId: "elsewhere", personaId: "persona_first", role: "user", content: "ここの発言", createdAt: 1, seq: 1 });
    const putPersona = repository.putPersona.bind(repository);
    vi.spyOn(repository, "putPersona").mockImplementation(async (persona) => {
      await putPersona(persona);
      await repository.putMessage(owned);
    });
    await expect(importPersonaPack(packFile(), repository, store, options())).rejects.toBeInstanceOf(PackError);
    expect(await repository.getMessage("m-03")).toEqual(owned);
    expect(await repository.getMessage("m-01")).toBeUndefined();
  });
});

describe("one import at a time", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("refuses a second import while one runs, and takes one again afterwards", async () => {
    const results = await Promise.allSettled([
      importPersonaPack(packFile(), repository, store, options()),
      importPersonaPack(packFile(), new MemoryRepository(), new MemoryPackStore(), options()),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(PackError);
    await expect(importPersonaPack(packFile(), repository, store, options())).rejects.toThrow("すでにこの端末");
  });

  it("refuses while another tab holds the lock", async () => {
    vi.stubGlobal("navigator", { locks: { request: (_name: string, _options: unknown, run: (lock: null) => unknown) => Promise.resolve(run(null)) } });
    await expect(importPersonaPack(packFile(), repository, store, options())).rejects.toThrow("別の画面");
    expect(await repository.getPersona(personaId)).toBeUndefined();
  });
});

describe("the icon", () => {
  const withIcon = (name: string, size: number) => changedPack(async (zip) => {
    const profile = await jsonOf(zip, "profile/profile.json") as { files: Record<string, unknown> };
    zip.file(name, new Uint8Array(size));
    zip.file("profile/profile.json", JSON.stringify({ ...profile, files: { ...profile.files, AVATAR_IMAGE: name } }));
  });

  it("is left out when it is too large, and the persona still comes", async () => {
    const result = await importPersonaPack(await withIcon("profile/icon/big.png", 2 * 1024 * 1024 + 1), repository, store, options());
    expect(result.warnings).toEqual([expect.stringContaining("2MB")]);
    expect((await repository.getPersona(personaId))?.avatarDataUrl).toBeNull();
  });

  it("is read up to the limit", async () => {
    await importPersonaPack(await withIcon("profile/icon/edge.webp", 2 * 1024 * 1024), repository, store, options());
    expect((await repository.getPersona(personaId))?.avatarDataUrl).toMatch(/^data:image\/webp;base64,/);
  });

  it("is left out when its type is unknown", async () => {
    const result = await importPersonaPack(await withIcon("profile/icon/face.tiff", 10), repository, store, options());
    expect(result.warnings).toEqual([expect.stringContaining("形式")]);
  });
});

describe("trunk pages", () => {
  it("gives a pack without them the body's trunks, on numbers the pack does not use", async () => {
    const pack = await changedPack(async (zip) => {
      const rows = await jsonOf(zip, "knowledge/pages.json") as Record<string, unknown>[];
      zip.file("knowledge/pages.json", JSON.stringify(rows.filter((row) => row.id !== "root_core" && row.id !== "root_chronicle")));
    });
    await importPersonaPack(pack, repository, store, options());
    const pages = await repository.listPages(personaId);
    const numbers = pages.flatMap((page) => (page.shortId === null ? [] : [page.shortId]));
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(pages.find((page) => page.id === "root_core")).toMatchObject({ isTrunk: true, category: "core" });
    expect(pages.find((page) => page.id === "root_chronicle")).toMatchObject({ isTrunk: true, category: "chronicle" });
  });
});

describe("running again", () => {
  /** Fails the write number `failAt`; the row batches before it stay written. */
  function failingRepository(failAt: number): LiteRepository {
    let writes = 0;
    const write = repository.writePersonaRecords.bind(repository);
    return new Proxy(repository, {
      get(target, property, receiver) {
        if (property !== "writePersonaRecords") {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) as unknown : value;
        }
        return async (id: string, batch: PersonaRecordBatch) => {
          writes += 1;
          if (writes === failAt) throw new Error("端末が止まった");
          await write(id, batch);
        };
      },
    });
  }

  it.each([[1], [2], [3], [4]])("finishes from a stop at write %i with the same rows and no doubles", async (failAt) => {
    await expect(importPersonaPack(packFile(), failingRepository(failAt), store, options())).rejects.toThrow("端末が止まった");
    expect(await repository.getSession(personaId)).toMatchObject({ importState: "importing" });
    expect(await repository.getPersona(personaId)).toBeDefined();

    const result = await importPersonaPack(packFile(), repository, store, options());
    expect(result).toMatchObject({ messages: expected.messages.length, pages: expected.pages.length, fragments: expected.fragments.length });
    expect(await repository.getSession(personaId)).toMatchObject({ importState: "ready", anchorMessageId: "m-01" });
    expect(await allMessages(repository)).toHaveLength(expected.messages.length);
    expect(await repository.listPages(personaId)).toHaveLength(expected.pages.length);
    expect(await repository.listFragments(personaId)).toHaveLength(expected.fragments.length);
    expect(await repository.listThreads(personaId)).toHaveLength(expected.threads.length);
  });

  it("does not take a different ZIP into a stopped import", async () => {
    await expect(importPersonaPack(packFile(), failingRepository(1), store, options())).rejects.toThrow();
    const other = await changedPack((zip) => { zip.file("note.txt", "別の書き出し"); });
    await expect(importPersonaPack(other, repository, store, options())).rejects.toThrow("別の ZIP");
    expect(await repository.getSession(personaId)).toMatchObject({ importState: "importing" });
    expect((await store.get(personaId))?.size).toBe(fixture.length);
  });

  it("tells two ZIPs of the same size and creation time apart by their entries", async () => {
    const rewritten = (change: (text: string) => string) => changedPack(async (zip) => {
      zip.file(MESSAGES, change(await zip.file(MESSAGES)!.async("string")));
    });
    const first = await rewritten((text) => text);
    const other = await rewritten((text) => text.replace("paired_action_text", "paired_action_texu"));
    expect(other.size).toBe(first.size);
    await expect(importPersonaPack(first, failingRepository(1), store, options())).rejects.toThrow();
    await expect(importPersonaPack(other, repository, store, options())).rejects.toThrow("別の ZIP");
    expect(await repository.getSession(personaId)).toMatchObject({ importState: "importing" });
  });

  it("takes the same files zipped again as the same pack", async () => {
    await expect(importPersonaPack(packFile(), failingRepository(1), store, options())).rejects.toThrow();
    const rezipped = await changedPack(() => undefined);
    await importPersonaPack(rezipped, repository, store, options());
    expect(await repository.getSession(personaId)).toMatchObject({ importState: "ready" });
  });

  it("stops without writing when the persona has finished importing", async () => {
    await importPersonaPack(packFile(), repository, store, options());
    await repository.putMessage({ ...(await repository.getMessage("m-01"))!, content: "Lite で書き換えた" });
    const writes = [
      vi.spyOn(repository, "writePersonaRecords"), vi.spyOn(repository, "putPersona"), vi.spyOn(repository, "putSession"), vi.spyOn(store, "put"),
    ];
    await expect(importPersonaPack(packFile(), repository, store, options())).rejects.toThrow("すでにこの端末");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect((await repository.getMessage("m-01"))?.content).toBe("Lite で書き換えた");
  });
});
