import { describe, expect, it } from "vitest";
import { deleteRowsAfter, hasRowsAfter, isRegenerable, MESSAGE_PAGE_ROWS, noticeSummary, readLatestRows, readOlderRows, rowDisplay } from "./conversationPage";
import { createChatMessage, createDefaultPersona, handyToolRecord, type ChatMessage, type ConversationThread } from "./domain";
import { MemoryRepository } from "./storage/memoryRepository";

const BASE_MS = new Date(2026, 5, 1, 9, 0, 0).getTime();

function row(index: number, fields: Partial<ChatMessage> = {}): ChatMessage {
  return createChatMessage({
    id: `row-${String(index).padStart(5, "0")}`,
    threadId: "thread",
    personaId: "persona_first",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `発言${index}`,
    createdAt: BASE_MS + index * 1000,
    seq: index + 1,
    ...fields,
  });
}

async function seeded(count: number): Promise<MemoryRepository> {
  const repository = new MemoryRepository();
  await repository.initialize();
  const persona = createDefaultPersona();
  await repository.putPersona(persona);
  const thread: ConversationThread = { id: "thread", personaId: persona.id, title: "長い会話", createdAt: BASE_MS, updatedAt: BASE_MS };
  await repository.writePersonaRecords(persona.id, { threads: [thread], messages: Array.from({ length: count }, (_, index) => row(index)) });
  return repository;
}

describe("reading a long thread", () => {
  it("shows the newest rows oldest first and says older ones remain", async () => {
    const repository = await seeded(MESSAGE_PAGE_ROWS + 5);
    const page = await readLatestRows(repository, "thread");
    expect(page.rows).toHaveLength(MESSAGE_PAGE_ROWS);
    expect(page.rows.at(-1)?.id).toBe(row(MESSAGE_PAGE_ROWS + 4).id);
    expect(page.rows[0]?.id).toBe(row(5).id);
    expect(page.hasOlder).toBe(true);
  });

  it("reads back to the first row without a gap or a repeat", async () => {
    const repository = await seeded(MESSAGE_PAGE_ROWS + 5);
    const latest = await readLatestRows(repository, "thread");
    const older = await readOlderRows(repository, "thread", latest.rows[0]!);
    expect([...older.rows, ...latest.rows].map((message) => message.id)).toEqual(Array.from({ length: MESSAGE_PAGE_ROWS + 5 }, (_, index) => row(index).id));
    expect(older.hasOlder).toBe(false);
  });

  it("does not claim older rows when exactly one page exists", async () => {
    const repository = await seeded(MESSAGE_PAGE_ROWS);
    expect((await readLatestRows(repository, "thread")).hasOlder).toBe(false);
  });
});

describe("cutting a thread after an edited row", () => {
  it("deletes only what follows, across batch boundaries", async () => {
    const repository = await seeded(1205);
    const edited = row(2);
    expect(await hasRowsAfter(repository, edited)).toBe(true);
    expect(await deleteRowsAfter(repository, edited)).toBe(1202);
    expect((await repository.listMessages("thread")).map((message) => message.id)).toEqual([row(0).id, row(1).id, row(2).id]);
    expect(await hasRowsAfter(repository, edited)).toBe(false);
  });
});

describe("rowDisplay", () => {
  it("keeps the talk in bubbles", () => {
    expect(rowDisplay(row(0))).toBe("bubble");
    expect(rowDisplay(row(1))).toBe("bubble");
  });

  it("makes system, handy tool and host rows notices", () => {
    expect(rowDisplay(row(1, { role: "system" }))).toBe("notice");
    expect(rowDisplay(row(1, { role: "host" }))).toBe("notice");
    expect(rowDisplay(row(1, handyToolRecord("memory_read", "本文")))).toBe("notice");
  });

  it("hides an empty assistant row, unless it carries an image", () => {
    expect(rowDisplay(row(1, { content: "  " }))).toBe("hidden");
    expect(rowDisplay(row(1, { content: "", metadata: { images: [{ uri: "saiverse://image/a.png" }] } }))).toBe("bubble");
  });

  it("does not put rows outside the presented talk among the bubbles", () => {
    expect(rowDisplay(row(1, { lineRole: "sub_line" }))).toBe("notice");
    expect(rowDisplay(row(1, { scope: "discardable" }))).toBe("notice");
  });
});

describe("isRegenerable", () => {
  it("offers a turn that stopped at the user row or a tool result, with no response yet", () => {
    const rows = [row(0), row(1, handyToolRecord("memory_write", "書きました"))];
    expect(rows.some(isRegenerable)).toBe(true);
  });

  it("offers a response, and not a blank row or a notice alone", () => {
    expect(isRegenerable(row(1))).toBe(true);
    expect(isRegenerable(row(1, { content: " " }))).toBe(false);
    expect(isRegenerable(row(1, { role: "system" }))).toBe(false);
  });
});

describe("noticeSummary", () => {
  it("names what each tool did", () => {
    expect(noticeSummary(row(1, handyToolRecord("image_generate", "x")))).toBe("画像を生成しました");
    expect(noticeSummary(row(1, handyToolRecord("memory_recall", "x")))).toBe("記憶を確認しました");
    expect(noticeSummary(row(1, handyToolRecord("memory_write", "x")))).toBe("記憶に書きました");
    expect(noticeSummary(row(1, handyToolRecord("web_search", "x")))).toBe("ツールを使いました");
  });

  it("tells a host row from a system row", () => {
    expect(noticeSummary(row(1, { role: "host" }))).toBe("通知");
    expect(noticeSummary(row(1, { role: "system" }))).toBe("システムの記録");
  });
});
