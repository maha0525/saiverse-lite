import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChatMessage, createDefaultPersona, handyToolRecord, type ChatMessage, type ConversationThread, type FragmentRecord, type PageRecord, type RepositorySnapshot } from "../domain";
import { softDeleteCoreMemory } from "../pageRecords";
import { MemoryRepository } from "../storage/memoryRepository";
import type { LiteRepository } from "../storage/repository";
import { PackArchive } from "./archive";
import { readAttachment } from "./attachments";
import { exportPersonaPack, packFileName, type PackExportResult } from "./exportPack";
import { PackError, decodeValue, encodeValue, epochToIso, parseJson, stringifyJson } from "./format";
import { importPersonaPack } from "./importPack";
import { MemoryPackStore } from "./packStore";
import { savePackFile } from "./savePack";
import { validatePack } from "./validate";

// The return trip: docs/intent/persona_pack.md「Lite から帰るときの合流」.

const fixture = readFileSync(new URL("./__fixtures__/persona_pack_fixture.zip", import.meta.url));
const personaId = (JSON.parse(readFileSync(new URL("./__fixtures__/persona_pack_fixture.expected.json", import.meta.url), "utf-8")) as { persona_id: string }).persona_id;

const MESSAGES = "chatlog/messages.json";
const THREADS = "chatlog/threads.json";
const STELIS = "chatlog/stelis_threads.json";
const PAGES = "knowledge/pages.json";
const FRAGMENTS = "extensions/saiverse/memory_db/memopedia_fragments.json";
const ACTIVE_STATE = "extensions/saiverse/persona_dir/active_state.json";
const PROFILE = "profile/profile.json";
const CHANGES = "extensions/lite/changes.json";
const MANIFEST = "manifest.json";
const INDEX = "attachments/index.json";

type Row = Record<string, unknown>;

async function zipOf(file: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await file.arrayBuffer());
}

async function jsonIn(zip: JSZip, name: string): Promise<unknown> {
  return parseJson(await zip.file(name)!.async("string"));
}

async function rowsIn(zip: JSZip, name: string): Promise<Row[]> {
  return await jsonIn(zip, name) as Row[];
}

function byId(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [String(row.id), row]));
}

function byIdOfUri(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [String(row.uri), row]));
}

const original = () => JSZip.loadAsync(fixture);

async function importFixture(repository: LiteRepository, store: MemoryPackStore): Promise<void> {
  await importPersonaPack(new Blob([fixture]), repository, store, { providerId: "provider_mock", model: "mock-friendly", resolveInitialAnchor: vi.fn(async () => null) });
}

function page(fields: Partial<PageRecord> & Pick<PageRecord, "id" | "category">): PageRecord {
  return {
    personaId, parentId: null, title: "題", summary: "", content: "本文", createdAt: 1_793_449_139, updatedAt: 1_793_449_139, keywords: [], metadata: {},
    isDeleted: false, vividness: "rough", isTrunk: false, isImportant: false, lastReferencedAt: null, shortId: null, source: null, ...fields,
  };
}

function fragment(id: string, entityId: string): FragmentRecord {
  return { id, personaId, content: "新しい断片", entityId, chronicleEntryId: null, vividness: "vivid", sourceDate: "2026-11-01", createdAt: 1_793_500_000, source: null };
}

describe("a persona that lived in Lite goes back", () => {
  let repository: MemoryRepository;
  let store: MemoryPackStore;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.initialize();
    store = new MemoryPackStore();
    await importFixture(repository, store);
  });

  const exported = () => exportPersonaPack(personaId, repository, store);

  describe("with nothing changed", () => {
    let result: PackExportResult;
    let zip: JSZip;
    let before: RepositorySnapshot;
    const originalNames = async () => Object.keys((await original()).files);

    beforeEach(async () => {
      before = await repository.exportSnapshot(true);
      result = await exported();
      zip = await zipOf(result.file);
    });

    it("passes the checks a pack has to pass", async () => {
      const check = await validatePack(result.file);
      expect(check.counts).toEqual({ messages: 16, pages: 13, fragments: 2 });
      expect(check.refused).toEqual({ messages: 0, pages: 0 });
    });

    it("keeps every other entry byte for byte", async () => {
      const source = await original();
      const rebuilt = new Set([MANIFEST, PROFILE, MESSAGES, THREADS, PAGES, FRAGMENTS, CHANGES]);
      const kept = (await originalNames()).filter((name) => !rebuilt.has(name));
      expect(kept).toContain("attachments/image/pic.png");
      expect(kept).toContain("items/private_room.json");
      expect(kept).toContain("journal/activities.json");
      expect(kept).toContain("chatgpt_compat/conversations.json");
      for (const name of kept) {
        expect(await zip.file(name)!.async("uint8array"), name).toEqual(await source.file(name)!.async("uint8array"));
      }
      expect(await rowsIn(zip, STELIS)).toEqual(await rowsIn(source, STELIS));
    });

    it("writes every row as the pack had it, wrappers included", async () => {
      const source = await original();
      for (const name of [MESSAGES, PAGES, FRAGMENTS, THREADS]) {
        const expected = byId(await rowsIn(source, name));
        const rows = await rowsIn(zip, name);
        expect(rows, name).toHaveLength(expected.size);
        for (const row of rows) expect(row, `${name} ${String(row.id)}`).toEqual(expected.get(String(row.id)));
      }
    });

    it("says nothing changed", async () => {
      expect(await jsonIn(zip, CHANGES)).toEqual({
        format: "saiverse-lite-changes",
        version: 1,
        messages: { created: [], edited: [], deleted: [] },
        pages: { created: [], edited: [], deleted: [] },
        fragments: { created: [] },
        profile: { edited: [] },
      });
    });

    it("leaves the profile and the manifest's shape as the body wrote them", async () => {
      const source = await original();
      expect(await jsonIn(zip, PROFILE)).toEqual(await jsonIn(source, PROFILE));
      const manifest = await jsonIn(zip, MANIFEST) as Row;
      const before = await jsonIn(source, MANIFEST) as Row;
      expect(manifest).toMatchObject({ format: "persona-pack", version: "1.0", persona_id: personaId, persona_name: before.persona_name });
      expect((manifest.generator as Row).name).toBe("saiverse-lite");
      expect(manifest.contents).toEqual([...before.contents as string[], "extensions/lite"]);
    });

    it("changes no record of the persona", async () => {
      expect(await repository.exportSnapshot(true)).toEqual(before);
    });
  });

  it("carries every change of a life in Lite", async () => {
    const [firstMessage, secondMessage] = await repository.readPersonaMessages(personaId, { direction: "forward", limit: 2 });
    const editedMessage = firstMessage!;
    const deletedMessage = secondMessage!;
    await repository.putMessage({ ...editedMessage, content: "編集した発言", editedAt: 5000 });
    await repository.deleteMessage(deletedMessage.id);

    const newThread: ConversationThread = { id: "thread_lite", personaId, title: "Lite の会話", createdAt: 1_793_000_000_000, updatedAt: 1_793_000_000_000 };
    await repository.putThread(newThread);
    const newMessage = createChatMessage({ id: "message_new", threadId: newThread.id, personaId, role: "assistant", content: "Lite で話した", createdAt: 1_793_000_000_500, seq: await repository.nextMessageSeq(personaId), pulseId: "pulse_1", metadata: { tags: ["conversation"], "__raw_text__": "利用者の値" } });
    await repository.putMessage(newMessage);
    const session = await repository.getSession(personaId);
    await repository.putSession({ ...session!, activeThreadId: newThread.id });

    const pages = await repository.listPages(personaId);
    const memopedia = pages.find((row) => row.category === "people" && !row.isTrunk)!;
    const core = pages.find((row) => row.category === "core" && !row.isTrunk && !row.isDeleted)!;
    await repository.putPage({ ...memopedia, content: "書き換えた本文", updatedAt: 1_793_100_000 });
    await repository.putPage(softDeleteCoreMemory(core, 1_793_100_001));
    const chronicle = pages.find((row) => row.id === "ch-1")!;
    await repository.putPage({ ...chronicle, parentId: "ch-new", metadata: { ...chronicle.metadata, is_consolidated: 1 } });
    await repository.putPage(page({ id: "ch-new", category: "chronicle", parentId: "root_chronicle", title: "chronicle:9", shortId: 40, metadata: { level: 1, source_ids: ["message_new"], start_time: 1, end_time: 2, source_count: 1, message_count: 1, is_consolidated: 0, thread_id: null, short_id: 9 } }));
    await repository.putPage(page({ id: "page-new", category: "people", parentId: "root_people" }));
    await repository.putFragment(fragment("fragment-new", memopedia.id));

    const persona = await repository.getPersona(personaId);
    await repository.putPersona({ ...persona!, systemPrompt: "書き換えた指示" });

    const result = await exported();
    await validatePack(result.file);
    const zip = await zipOf(result.file);
    const source = await original();

    const messages = byId(await rowsIn(zip, MESSAGES));
    const sourceMessages = byId(await rowsIn(source, MESSAGES));
    expect(messages.size).toBe(sourceMessages.size);
    expect(messages.has(deletedMessage.id)).toBe(false);
    expect(messages.get(editedMessage.id)).toEqual({ ...sourceMessages.get(editedMessage.id), content: "編集した発言" });
    for (const [id, row] of sourceMessages) {
      if (id !== editedMessage.id && id !== deletedMessage.id) expect(messages.get(id)).toEqual(row);
    }
    expect(messages.get("message_new")).toEqual({
      id: "message_new", thread_id: `${personaId}:thread_lite`, role: "assistant", content: "Lite で話した", resource_id: personaId,
      created_at: "2026-10-26T07:33:20+00:00", metadata: { tags: ["conversation"], __raw_text__: "利用者の値" },
      origin_track_id: null, line_role: "main_line", line_id: null, scope: "committed", paired_action_text: null, pulse_id: "pulse_1",
      thought_signature: null, spell_origin_id: null, spell_seq: null, origin_episode: null, seq: newMessage.seq,
    });

    const threads = byId(await rowsIn(zip, THREADS));
    expect(threads.get(`${personaId}:thread_lite`)).toEqual({ id: `${personaId}:thread_lite`, resource_id: personaId, overview: null, overview_updated_at: null, title: "Lite の会話" });
    expect(threads.size).toBe(byId(await rowsIn(source, THREADS)).size + 1);

    const written = byId(await rowsIn(zip, PAGES));
    const sourcePages = byId(await rowsIn(source, PAGES));
    expect(written.get(memopedia.id)).toEqual({ ...sourcePages.get(memopedia.id), content: "書き換えた本文", updated_at: "2026-10-27T11:20:00+00:00" });
    expect(written.get(core.id)).toMatchObject({ is_deleted: 1 });
    expect((written.get(core.id)!.metadata as Row).deleted_at).toBe(1_793_100_001);
    expect(written.get("ch-1")).toMatchObject({ parent_id: "ch-new", title: sourcePages.get("ch-1")!.title });
    expect((written.get("ch-1")!.metadata as Row).is_consolidated).toBe(1);
    expect(written.get("ch-new")).toMatchObject({ category: "chronicle", is_deleted: 0, is_trunk: 0, is_important: 0, parent_id: "root_chronicle", short_id: 40, keywords: [] });
    expect((written.get("ch-new")!.metadata as Row).source_ids).toEqual(["message_new"]);
    expect(written.get("ch-2")).toEqual(sourcePages.get("ch-2"));

    const fragments = byId(await rowsIn(zip, FRAGMENTS));
    expect(fragments.get("fragment-new")).toEqual({ id: "fragment-new", content: "新しい断片", entity_id: memopedia.id, chronicle_entry_id: null, vividness: "vivid", source_date: "2026-11-01", created_at: 1_793_500_000 });

    const before = await jsonIn(source, ACTIVE_STATE) as Row;
    expect(await jsonIn(zip, ACTIVE_STATE)).toEqual({ ...before, active_thread_id: "thread_lite" });
    const profile = await jsonIn(zip, PROFILE) as { ai: Row };
    const sourceProfile = await jsonIn(source, PROFILE) as { ai: Row; files: Row };
    expect(profile).toEqual({ ...sourceProfile, ai: { ...sourceProfile.ai, SYSTEMPROMPT: "書き換えた指示" } });

    expect(await jsonIn(zip, CHANGES)).toEqual({
      format: "saiverse-lite-changes",
      version: 1,
      messages: { created: ["message_new"], edited: [{ id: editedMessage.id, changed_at: 5 }], deleted: [deletedMessage.id] },
      pages: { created: ["ch-new", "page-new"], edited: [memopedia.id], deleted: [core.id] },
      fragments: { created: ["fragment-new"] },
      profile: { edited: ["SYSTEMPROMPT"] },
    });
    expect(result.changes.messages.created).toEqual(["message_new"]);
    expect(result.warnings).toEqual([]);

    // The stored ZIP stays what the import put there.
    expect(new Uint8Array(await (await store.get(personaId))!.arrayBuffer())).toEqual(new Uint8Array(fixture));
  });

  it("comes back into Lite as the same records", async () => {
    const [message] = await repository.readPersonaMessages(personaId, { direction: "forward", limit: 1 });
    await repository.putMessage({ ...message!, content: "編集した発言", editedAt: 1 });
    await repository.putThread({ id: "thread_lite", personaId, title: "Lite の会話", createdAt: 1_793_000_000_000, updatedAt: 1_793_000_000_000 });
    await repository.putMessage(createChatMessage({ id: "message_new", threadId: "thread_lite", personaId, role: "user", content: "新しい発言", createdAt: 1_793_000_000_000, seq: 1000 }));
    const { file } = await exported();

    const fresh = new MemoryRepository();
    await fresh.initialize();
    await importPersonaPack(file, fresh, new MemoryPackStore(), { providerId: "provider_mock", model: "mock-friendly", resolveInitialAnchor: vi.fn(async () => null) });
    const contents = (rows: ChatMessage[]) => new Map(rows.map((row) => [row.id, row.content]));
    expect(contents(await fresh.readPersonaMessages(personaId, { direction: "forward", limit: 1000 }))).toEqual(contents(await repository.readPersonaMessages(personaId, { direction: "forward", limit: 1000 })));
    expect((await fresh.getThread(`${personaId}:thread_lite`))?.title).toBe("Lite の会話");
    expect((await fresh.getMessage("message_new"))?.threadId).toBe(`${personaId}:thread_lite`);
  });

  it("takes the passphrase out of everything it writes", async () => {
    const passphrase = "Abc123Def456";
    const session = await repository.getSession(personaId);
    await repository.putSession({ ...session!, passphrase, headText: `pass ${passphrase}` });
    await repository.putPage(page({ id: "page-new", category: "people", content: `合言葉は ${passphrase}` }));
    const zip = await zipOf((await exported()).file);
    for (const entry of Object.values(zip.files)) {
      if (entry.name.endsWith(".json")) expect(await entry.async("string"), entry.name).not.toContain(passphrase);
    }
  });

  it("keeps a row the import refused, and does not call it deleted", async () => {
    const refused = { id: "m-broken", thread_id: `${personaId}:__persona__`, role: "user", content: "x", metadata: { __raw_text__: "{\"images\": []}" } };
    const pack = await original();
    pack.file(MESSAGES, JSON.stringify([...await rowsIn(pack, MESSAGES), refused]));
    const fresh = new MemoryRepository();
    await fresh.initialize();
    const freshStore = new MemoryPackStore();
    await importPersonaPack(await pack.generateAsync({ type: "blob" }), fresh, freshStore, { providerId: "provider_mock", model: "mock-friendly", resolveInitialAnchor: vi.fn(async () => null) });
    expect(await fresh.getMessage("m-broken")).toBeUndefined();

    const result = await exportPersonaPack(personaId, fresh, freshStore);
    expect(byId(await rowsIn(await zipOf(result.file), MESSAGES)).get("m-broken")).toEqual(refused);
    expect(result.changes.messages.deleted).toEqual([]);
  });

  it("writes generated images as attachments the body can read", async () => {
    const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
    await repository.putMessage(createChatMessage({
      id: "message:image", threadId: `${personaId}:__persona__`, personaId, createdAt: 1_793_000_000_000, seq: 1000,
      ...handyToolRecord("image_generate", "{\"ok\":true}", { imageDataUrl: dataUrl, prompt: "猫" }),
    }));
    const { file } = await exported();
    await validatePack(file);
    const zip = await zipOf(file);
    const name = "lite_message_image.png";
    expect(await zip.file(`attachments/image/${name}`)!.async("string")).toBe("png-bytes");
    const row = byId(await rowsIn(zip, MESSAGES)).get("message:image")!;
    expect(row.metadata).toEqual({ prompt: "猫", tags: ["conversation", "handy_tool"], __system_notice__: "handy_tool", images: [{ uri: `saiverse://image/${name}`, mime_type: "image/png" }] });
    const index = await rowsIn(zip, INDEX);
    expect(index).toHaveLength((await rowsIn(await original(), INDEX)).length + 1);
    expect(index.at(-1)).toEqual({ ref: `saiverse://image/${name}`, uri: `saiverse://image/${name}`, original_path: null, mime_type: "image/png", path: `attachments/image/${name}`, summary_path: null, message_ids: ["message:image"], perception_rows: [] });

    const fresh = new MemoryRepository();
    await fresh.initialize();
    const freshStore = new MemoryPackStore();
    await importPersonaPack(file, fresh, freshStore, { providerId: "provider_mock", model: "mock-friendly", resolveInitialAnchor: vi.fn(async () => null) });
    const item = ((await fresh.getMessage("message:image"))!.metadata.images as { uri: string }[])[0]!;
    expect(await (await readAttachment(freshStore, personaId, item))!.text()).toBe("png-bytes");
  });

  it("gives two ids that clean to one name their own files", async () => {
    const image = (id: string, seq: number, text: string) => createChatMessage({
      id, threadId: `${personaId}:__persona__`, personaId, createdAt: 1_793_000_000_000, seq,
      ...handyToolRecord("image_generate", "{\"ok\":true}", { imageDataUrl: `data:image/png;base64,${Buffer.from(text).toString("base64")}` }),
    });
    await repository.putMessage(image("message:image", 1000, "first"));
    await repository.putMessage(image("message_image", 1001, "second"));
    const { file } = await exported();
    await validatePack(file);
    const zip = await zipOf(file);
    const messages = byId(await rowsIn(zip, MESSAGES));
    const uriOf = (id: string) => ((messages.get(id)!.metadata as Row).images as { uri: string }[])[0]!.uri;
    expect(uriOf("message:image")).toBe("saiverse://image/lite_message_image.png");
    expect(uriOf("message_image")).toBe("saiverse://image/lite_message_image_2.png");
    expect(await zip.file("attachments/image/lite_message_image.png")!.async("string")).toBe("first");
    expect(await zip.file("attachments/image/lite_message_image_2.png")!.async("string")).toBe("second");
    const index = byIdOfUri(await rowsIn(zip, INDEX));
    expect(index.get(uriOf("message:image"))!.message_ids).toEqual(["message:image"]);
    expect(index.get(uriOf("message_image"))!.message_ids).toEqual(["message_image"]);
  });

  it("does not take the name of an attachment in the original ZIP", async () => {
    const pack = await original();
    pack.file("attachments/image/lite_message_image.png", "from the body");
    const fresh = new MemoryRepository();
    await fresh.initialize();
    const freshStore = new MemoryPackStore();
    await importPersonaPack(await pack.generateAsync({ type: "blob" }), fresh, freshStore, { providerId: "provider_mock", model: "mock-friendly", resolveInitialAnchor: vi.fn(async () => null) });
    await fresh.putMessage(createChatMessage({
      id: "message_image", threadId: `${personaId}:__persona__`, personaId, createdAt: 1_793_000_000_000, seq: 1000,
      ...handyToolRecord("image_generate", "{\"ok\":true}", { imageDataUrl: `data:image/png;base64,${Buffer.from("made in lite").toString("base64")}` }),
    }));
    const zip = await zipOf((await exportPersonaPack(personaId, fresh, freshStore)).file);
    expect(await zip.file("attachments/image/lite_message_image.png")!.async("string")).toBe("from the body");
    expect(await zip.file("attachments/image/lite_message_image_2.png")!.async("string")).toBe("made in lite");
    expect((byId(await rowsIn(zip, MESSAGES)).get("message_image")!.metadata as Row).images).toEqual([{ uri: "saiverse://image/lite_message_image_2.png", mime_type: "image/png" }]);
  });

  it("tells the person about an image it could not carry", async () => {
    await repository.putMessage(createChatMessage({
      id: "message_url", threadId: `${personaId}:__persona__`, personaId, createdAt: 1_793_000_000_000, seq: 1000,
      ...handyToolRecord("image_generate", "{\"ok\":true}", { imageDataUrl: "https://example.test/image.png" }),
    }));
    const result = await exported();
    expect(result.warnings).toEqual([expect.stringContaining("生成した画像 1件")]);
    expect(Object.keys((await zipOf(result.file)).files).filter((name) => name.includes("lite_"))).toEqual([]);
  });

  it("tells the person when the original ZIP is gone, and still writes what Lite holds", async () => {
    await store.delete(personaId);
    await repository.putMessage(createChatMessage({ id: "message_new", threadId: `${personaId}:__persona__`, personaId, role: "user", content: "新しい発言", createdAt: 1_793_000_000_000, seq: 1000 }));
    const result = await exported();
    await validatePack(result.file);
    expect(result.warnings).toEqual([expect.stringContaining("元の ZIP がこの端末に無い")]);
    expect(result.changes.messages).toEqual({ created: ["message_new"], edited: [], deleted: [] });
    const zip = await zipOf(result.file);
    const stelis = await rowsIn(zip, STELIS);
    expect(stelis.map((row) => row.thread_id)).toEqual([`${personaId}:stelis_1`]);
    expect(zip.file("journal/activities.json")).toBeNull();
  });

  it("drops the work file when writing fails, and keeps the stored ZIP", async () => {
    vi.spyOn(repository, "listPages").mockRejectedValueOnce(new Error("disk"));
    await expect(exported()).rejects.toThrow("disk");
    expect(store.work.size).toBe(0);
    expect((await store.get(personaId))?.size).toBe(fixture.length);
  });

  it("refuses a persona whose import stopped partway", async () => {
    const session = await repository.getSession(personaId);
    await repository.putSession({ ...session!, importState: "importing" });
    await expect(exported()).rejects.toThrow(PackError);
  });
});

describe("a persona born in Lite", () => {
  it("gets a pack from its rows alone, with only the folders it has", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const store = new MemoryPackStore();
    const persona = { ...createDefaultPersona(1), id: "persona_born", name: "生まれた子", avatarDataUrl: `data:image/jpeg;base64,${Buffer.from("jpeg").toString("base64")}` };
    await repository.putPersona(persona);
    await repository.putThread({ id: "thread_born", personaId: persona.id, title: "最初の会話", createdAt: 1_793_000_000_000, updatedAt: 1_793_000_000_000 });
    await repository.putMessage(createChatMessage({ id: "message_born", threadId: "thread_born", personaId: persona.id, role: "user", content: "はじめまして", createdAt: 1_793_000_000_000, seq: 1 }));
    await repository.putSession({ ...(await repository.getSession(persona.id))!, activeThreadId: "thread_born" });

    const result = await exportPersonaPack(persona.id, repository, store);
    const check = await validatePack(result.file);
    expect(check.counts).toMatchObject({ messages: 1, fragments: 0 });
    const zip = await zipOf(result.file);
    const manifest = await jsonIn(zip, MANIFEST) as Row;
    expect(manifest).toMatchObject({ format: "persona-pack", persona_id: "persona_born", persona_name: "生まれた子" });
    expect(manifest.contents).toEqual(["profile", "chatlog", "knowledge", "extensions/saiverse", "extensions/lite"]);
    expect(await jsonIn(zip, ACTIVE_STATE)).toEqual({ active_thread_id: "thread_born" });
    expect((await rowsIn(zip, THREADS))[0]!.id).toBe("persona_born:thread_born");
    expect((await rowsIn(zip, MESSAGES))[0]).toMatchObject({ thread_id: "persona_born:thread_born", metadata: { tags: ["conversation"] } });
    expect(await zip.file("profile/icon/avatar.jpg")!.async("string")).toBe("jpeg");
    expect(await jsonIn(zip, PROFILE)).toEqual({
      ai: { AIID: "persona_born", AINAME: "生まれた子", SYSTEMPROMPT: persona.systemPrompt, DESCRIPTION: persona.description, AVATAR_IMAGE: "avatar.jpg" },
      files: { AVATAR_IMAGE: "profile/icon/avatar.jpg" },
    });
    const pages = await rowsIn(zip, PAGES);
    expect(pages.map((row) => row.id).sort()).toEqual(["root_chronicle", "root_core", "root_events", "root_people", "root_plans", "root_terms"]);
    expect(pages.find((row) => row.id === "root_core")).toMatchObject({ is_trunk: 1, is_deleted: 0, is_important: 1, parent_id: null });
    expect(result.changes.messages.created).toEqual(["message_born"]);
    expect(result.warnings).toEqual([]);
  });
});

describe("the writing direction of the value encoding", () => {
  it("writes what the reader reads, a dict shaped like a marker included", () => {
    const value = { plain: 1, bytes: new Uint8Array([1, 2]), marker: { __raw_text__: "x" }, nested: [{ __bytes_b64__: "AA==" }], escaped: { __escaped__: { a: 1 } }, ok: { __bytes_b64__: "AA==", more: 1 } };
    expect(encodeValue(value)).toMatchObject({ marker: { __escaped__: { __raw_text__: "x" } } });
    expect(decodeValue(JSON.parse(stringifyJson(encodeValue(value))))).toEqual(value);
  });

  it("writes times as format.py epoch_to_iso does", () => {
    expect(epochToIso(1_793_449_139)).toBe("2026-10-31T12:18:59+00:00");
    expect(epochToIso(1_793_449_139.25)).toBe("2026-10-31T12:18:59.250000+00:00");
  });

  it("keeps NaN and the infinities as the body writes them", () => {
    const text = stringifyJson({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: [Number.NEGATIVE_INFINITY] });
    expect(text).toBe('{"a":NaN,"b":Infinity,"c":[-Infinity]}');
    expect(parseJson(text)).toEqual({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: [Number.NEGATIVE_INFINITY] });
  });
});

describe("saving the ZIP", () => {
  const share = vi.fn(async () => undefined);
  const click = vi.fn();

  beforeEach(() => {
    share.mockClear();
    click.mockClear();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
    vi.stubGlobal("document", { createElement: () => ({ click }) });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uses the share sheet on a touch device that takes the ZIP", async () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 5, canShare: () => true, share });
    await savePackFile(new Blob(["z"]), "p.zip");
    expect(share).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });

  it("downloads where the browser refuses to share a ZIP", async () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 5, canShare: () => false, share });
    await savePackFile(new Blob(["z"]), "p.zip");
    expect(share).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledOnce();
  });

  it("does nothing more when the person closes the share sheet", async () => {
    share.mockRejectedValueOnce(new DOMException("closed", "AbortError"));
    vi.stubGlobal("navigator", { maxTouchPoints: 5, canShare: () => true, share });
    await savePackFile(new Blob(["z"]), "p.zip");
    expect(click).not.toHaveBeenCalled();
  });
});

describe("the work file", () => {
  it("holds the finished ZIP until the next one", async () => {
    const store = new MemoryPackStore();
    const work = await store.openWork("p");
    const writer = work.writable.getWriter();
    await writer.write(new Uint8Array([1]));
    await writer.close();
    expect((await work.file()).size).toBe(1);
    expect(store.work.size).toBe(1);
    await store.clearWork();
    expect(store.work.size).toBe(0);
  });
});

describe("PackArchive", () => {
  it("is what the checks read the written ZIP with", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const store = new MemoryPackStore();
    await importFixture(repository, store);
    const archive = await PackArchive.open((await exportPersonaPack(personaId, repository, store)).file);
    expect(archive.has(CHANGES)).toBe(true);
    expect(await archive.fingerprint()).toMatch(/^[0-9a-f]{64}$/);
    await archive.close();
  });
});

describe("packFileName", () => {
  it("names the ZIP like the body's export: the persona's name and the date", () => {
    expect(packFileName("ソフィー", new Date(2026, 10, 1))).toBe("ソフィー_persona_pack_20261101.zip");
  });

  it("replaces what a file name cannot hold and never comes back empty", () => {
    expect(packFileName(' a/b:c?". ', new Date(2026, 0, 9))).toBe("a_b_c___persona_pack_20260109.zip");
    expect(packFileName("...", new Date(2026, 0, 9))).toBe("persona_persona_pack_20260109.zip");
  });
});
