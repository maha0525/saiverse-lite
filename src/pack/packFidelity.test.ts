import { readFileSync } from "node:fs";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "../storage/memoryRepository";
import { importPersonaPack } from "./importPack";
import { MemoryPackStore } from "./packStore";

// What the return trip stands on: a pack loses nothing by being imported.

const fixture = readFileSync(new URL("./__fixtures__/persona_pack_fixture.zip", import.meta.url));
const personaId = (JSON.parse(readFileSync(new URL("./__fixtures__/persona_pack_fixture.expected.json", import.meta.url), "utf-8")) as { persona_id: string }).persona_id;

type Row = Record<string, unknown>;

async function rowsOf(name: string): Promise<Row[]> {
  const zip = await JSZip.loadAsync(fixture);
  return JSON.parse(await zip.file(name)!.async("string")) as Row[];
}

function byId(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [String(row.id), row]));
}

describe("nothing is lost on import", () => {
  let repository: MemoryRepository;
  let store: MemoryPackStore;

  beforeEach(async () => {
    repository = new MemoryRepository();
    await repository.initialize();
    store = new MemoryPackStore();
    await importPersonaPack(new Blob([fixture]), repository, store, {
      providerId: "provider_mock",
      model: "mock-friendly",
      resolveInitialAnchor: vi.fn(async () => null),
    });
  });

  it("keeps the ZIP byte for byte, so every folder Lite does not read stays", async () => {
    const stored = await store.get(personaId);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(new Uint8Array(fixture));
  });

  it("keeps every message, column by column", async () => {
    const rows = await rowsOf("chatlog/messages.json");
    const stored = await repository.readPersonaMessages(personaId, { direction: "forward", limit: 10_000 });
    expect(stored).toHaveLength(rows.length);
    const expected = byId(rows);
    for (const message of stored) expect(message.source).toEqual(expected.get(message.id));
  });

  it("keeps every page, deleted ones included, column by column", async () => {
    const rows = await rowsOf("knowledge/pages.json");
    const expected = byId(rows);
    const stored = (await repository.listPages(personaId)).filter((page) => expected.has(page.id));
    expect(stored).toHaveLength(rows.length);
    for (const page of stored) expect(page.source).toEqual(expected.get(page.id));
  });

  it("keeps every Fragment, column by column", async () => {
    const rows = await rowsOf("extensions/saiverse/memory_db/memopedia_fragments.json");
    const expected = byId(rows);
    const stored = await repository.listFragments(personaId);
    expect(stored).toHaveLength(rows.length);
    for (const fragment of stored) expect(fragment.source).toEqual(expected.get(fragment.id));
  });

  it("keeps a row's source when Lite edits the message", async () => {
    const [message] = await repository.readPersonaMessages(personaId, { direction: "forward", limit: 1 });
    const before = structuredClone(message!.source);
    await repository.putMessage({ ...message!, content: "編集した本文", editedAt: 1 });
    expect((await repository.getMessage(message!.id))?.source).toEqual(before);
  });
});
