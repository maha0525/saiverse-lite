import { describe, expect, it } from "vitest";
import { createDefaultPersona, type ToolCall, type ToolId } from "../domain";
import { MockProvider } from "../llm/mock";
import { CATEGORY_CORE, liveCoreMemories } from "../pageRecords";
import { MemoryRepository } from "../storage/memoryRepository";
import { executeTool } from "../tools";
import { AtlasRefError, parseAtlasRef } from "./atlas";

async function setup() {
  const repository = new MemoryRepository();
  await repository.initialize();
  const persona = createDefaultPersona();
  const provider = new MockProvider((await repository.getProvider("provider_mock"))!);
  const run = (name: ToolId, args: Record<string, unknown>): Promise<string> => {
    const call: ToolCall = { id: "call", name, arguments: args };
    return executeTool(repository, persona, provider, call).then((result) => result.content);
  };
  return { repository, persona, run };
}

describe("parseAtlasRef", () => {
  it("accepts the short forms, the canonical words and a self URI", () => {
    expect(parseAtlasRef("core")).toEqual({ kind: "core_all" });
    expect(parseAtlasRef("c:2")).toEqual({ kind: "core", key: "2" });
    expect(parseAtlasRef("core:2")).toEqual({ kind: "core", key: "2" });
    expect(parseAtlasRef("m:3")).toEqual({ kind: "memopedia", key: "3" });
    expect(parseAtlasRef("chronicle:5")).toEqual({ kind: "chronicle", key: "5" });
    expect(parseAtlasRef("saiverse://self/memopedia/3")).toEqual({ kind: "memopedia", key: "3" });
  });

  it("refuses other personas and what is not a page", () => {
    expect(() => parseAtlasRef("saiverse://city_a/air/memopedia/3")).toThrow(AtlasRefError);
    expect(() => parseAtlasRef("task:2")).toThrow("記憶の地図帳のページではありません");
    expect(() => parseAtlasRef("だいじなこと")).toThrow("認識できない ref 形式です");
  });
});

describe("memory tools", () => {
  it("writes and reads core memories", async () => {
    const { repository, persona, run } = await setup();
    expect(await run("memory_write", { ref: "core", content: "猫の名前はミケ" })).toContain("コア記憶 core:1 に書きました");
    expect(await run("memory_write", { ref: "c:1", content: "猫の名前はタマ" })).toContain("コア記憶 core:1 を上書きしました");
    expect(await run("memory_read", { ref: "core" })).toContain("## core:1\n猫の名前はタマ");
    expect(await run("memory_read", { ref: "c:9" })).toBe("コア記憶が見つかりません: core:9");
    expect(liveCoreMemories(await repository.listPages(persona.id, CATEGORY_CORE))).toHaveLength(1);
  });

  it("refuses to rewrite a scene memory", async () => {
    const { repository, persona, run } = await setup();
    await repository.addCoreMemories(persona.id, [{ content: "写し", kind: "scene" }]);
    expect(await run("memory_write", { ref: "c:1", content: "改変" })).toContain("場面の記憶");
  });

  it("creates, appends to and reads a Memopedia page with its fragments", async () => {
    const { repository, persona, run } = await setup();
    expect(await run("memory_write", { title: "ミケ", category: "people", content: "飼い猫" })).toMatch(/^新しいページを作りました: memopedia:\d+「ミケ」（カテゴリ: people）$/);
    const page = (await repository.listPages(persona.id)).find((candidate) => candidate.title === "ミケ")!;
    expect(page).toMatchObject({ parentId: "root_people", category: "people", vividness: "rough", isTrunk: false });
    expect(await run("memory_write", { title: "ミケ", content: "もう一度" })).toContain("同名のページが既にあります");
    await run("memory_write", { ref: `m:${page.shortId}`, content: "三毛猫" });
    await repository.putFragment({ id: "f1", personaId: persona.id, content: "魚が好き", entityId: page.id, chronicleEntryId: null, vividness: "vivid", sourceDate: "2026-01-02", createdAt: 1, source: null });
    expect(await run("memory_read", { ref: `memopedia:${page.shortId}` })).toBe(`# ミケ (memopedia:${page.shortId})\n\n飼い猫\n\n三毛猫\n\n## 2026-01-02\n- 魚が好き`);
  });

  it("refuses the two-target and empty forms, and Chronicle writes", async () => {
    const { run } = await setup();
    expect(await run("memory_write", { ref: "core", title: "x", content: "y" })).toContain("どちらか一方だけ");
    expect(await run("memory_write", { ref: "core", content: "  " })).toBe("Error: content は空にできません。");
    expect(await run("memory_write", { ref: "ch:1", content: "y" })).toContain("chronicle:1 には書けません");
    expect(await run("memory_read", { ref: "task:1" })).toMatch(/^Error: /);
  });

  it("searches pages and conversation by keyword", async () => {
    const { repository, persona, run } = await setup();
    await run("memory_write", { title: "ミケ", content: "飼い猫" });
    await repository.addCoreMemories(persona.id, [{ content: "猫アレルギーがある" }]);
    const text = await run("memory_recall", { query: "ミケ" });
    expect(text).toMatch(/^「ミケ」の検索結果です（1 件）。\n- \[memopedia:\d+\] ミケ: 飼い猫$/);
    expect(await run("memory_recall", { query: "ひこうき" })).toBe("「ひこうき」に一致する記憶は見つかりませんでした。");
    expect(await run("memory_recall", { query: " " })).toBe("検索語が空です。");
  });
});
