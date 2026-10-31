import { describe, expect, it } from "vitest";
import { createDefaultPersona, type PageRecord } from "../domain";
import { CATEGORY_CORE, liveCoreMemories } from "../pageRecords";
import { MemoryRepository } from "../storage/memoryRepository";
import { readPage, replaceCoreMemory, writePage } from "./atlas";
import { categoryTitle, matchesQuery, memopediaCategories, memopediaTree, searchMemopedia, updateMemopediaPage } from "./browse";
import { coreMemoryId } from "./head";
import { memopediaPage } from "./memopedia";

function page(id: string, category: string, parentId: string | null, title: string, content = ""): PageRecord {
  return { ...memopediaPage("persona_first", { parentId, title, summary: "", content, category, shortId: null }), id };
}

describe("the Memopedia list", () => {
  const pages = [
    page("root_terms", "terms", null, "用語"),
    page("b", "terms", "root_terms", "ねこ"),
    page("a", "terms", "root_terms", "いぬ"),
    page("a1", "terms", "a", "柴犬"),
    page("orphan", "terms", "gone", "親のないページ"),
    page("people", "people", "root_people", "まはー"),
  ].map((item) => (item.id === "root_terms" ? { ...item, isTrunk: true } : item));

  it("puts each child under its parent and leaves trunks out", () => {
    expect(memopediaTree(pages, "terms").map(({ page: item, depth }) => [item.id, depth])).toEqual([["a", 0], ["a1", 1], ["b", 0], ["orphan", 0]]);
  });

  it("still lists pages whose parents form a loop", () => {
    const loop = [page("x", "terms", "y", "x"), page("y", "terms", "x", "y")];
    expect(memopediaTree(loop, "terms").map(({ page: item }) => item.id).sort()).toEqual(["x", "y"]);
  });

  it("names a category by its trunk page and keeps categories a pack brought", () => {
    expect(categoryTitle(pages, "terms")).toBe("用語");
    expect(categoryTitle(pages, "unknown")).toBe("unknown");
    expect(memopediaCategories([...pages, page("v", "vocation", null, "職能")])).toEqual(["people", "terms", "plans", "events", "vocation"]);
  });

  it("searches every category, title hits first", () => {
    const hits = searchMemopedia([page("c", "terms", null, "別の話", "ねこの話"), page("d", "people", null, "ねこ屋")], "ねこ");
    expect(hits.map(({ page: item }) => item.id)).toEqual(["d", "c"]);
  });

  it("needs every word of the query", () => {
    expect(matchesQuery("Sora と 猫", "sora 猫")).toBe(true);
    expect(matchesQuery("Sora と 猫", "sora 犬")).toBe(false);
  });
});

describe("editing from the memory screen", () => {
  async function setup() {
    const repository = new MemoryRepository();
    await repository.initialize();
    const persona = createDefaultPersona();
    await repository.putPersona(persona);
    await writePage(repository, persona.id, { title: "猫", category: "terms", content: "ミケ" });
    await writePage(repository, persona.id, { title: "犬", category: "terms", content: "ポチ" });
    const stored = await repository.listPages(persona.id);
    return { repository, persona, cat: stored.find((item) => item.title === "猫")! };
  }

  it("rewrites a page and keeps what the screen does not edit", async () => {
    const { repository, persona, cat } = await setup();
    await repository.putPage({ ...cat, keywords: ["pet"], source: { kept: true } });
    expect(await updateMemopediaPage(repository, persona.id, cat.id, { title: "ねこ", summary: "飼い猫", content: "ミケとタマ" })).toBe("updated");
    expect(await repository.getPage(persona.id, cat.id)).toMatchObject({ title: "ねこ", summary: "飼い猫", content: "ミケとタマ", keywords: ["pet"], source: { kept: true } });
  });

  it("refuses a title another page has, as memory_write does", async () => {
    const { repository, persona, cat } = await setup();
    expect(await updateMemopediaPage(repository, persona.id, cat.id, { title: "犬", summary: "", content: "x" })).toBe("title-taken");
    expect(await repository.getPage(persona.id, cat.id)).toMatchObject({ title: "猫", content: "ミケ" });
  });

  it("does not write to a page that is not Memopedia", async () => {
    const { repository, persona } = await setup();
    expect(await updateMemopediaPage(repository, persona.id, "root_terms", { title: "x", summary: "", content: "" })).toBe("missing");
  });

  it("rewrites a core memory through the same write memory_write uses, and leaves a scene alone", async () => {
    const { repository, persona } = await setup();
    await repository.addCoreMemories(persona.id, [{ content: "猫が好き" }, { content: "実際の会話", kind: "scene" }]);
    const memories = liveCoreMemories(await repository.listPages(persona.id, CATEGORY_CORE));
    const note = memories.find((item) => item.metadata.kind === "note")!;
    const scene = memories.find((item) => item.metadata.kind === "scene")!;
    expect(await replaceCoreMemory(repository, persona.id, coreMemoryId(note), "犬も好き")).toBe("replaced");
    expect(await readPage(repository, persona.id, `core:${coreMemoryId(note)}`)).toContain("犬も好き");
    expect(await replaceCoreMemory(repository, persona.id, coreMemoryId(scene), "書き換え")).toBe("scene");
    expect(await readPage(repository, persona.id, `core:${coreMemoryId(scene)}`)).toContain("実際の会話");
    expect(await replaceCoreMemory(repository, persona.id, 999, "x")).toBe("missing");
  });
});
