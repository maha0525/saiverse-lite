import type { PageRecord } from "../domain";
import { epochSeconds } from "../pageRecords";
import type { LiteRepository } from "../storage/repository";
import { findPageByTitle, isMemopediaPage, MEMOPEDIA_CATEGORIES } from "./memopedia";

// What the memory screen reads and writes beyond src/memory/atlas.ts.

export interface PageTreeRow {
  page: PageRecord;
  depth: number;
}

function byTitle(a: PageRecord, b: PageRecord): number {
  return a.title.localeCompare(b.title, "ja");
}

/** The fixed categories first, so a new page has somewhere to go, then any other a pack brought. */
export function memopediaCategories(pages: PageRecord[]): string[] {
  const found = pages.filter(isMemopediaPage).map((page) => page.category);
  return [...new Set<string>([...MEMOPEDIA_CATEGORIES, ...found])];
}

/** The category's name is the title of its trunk page. */
export function categoryTitle(pages: PageRecord[], category: string): string {
  return pages.find((page) => page.id === `root_${category}`)?.title ?? category;
}

export function memopediaCount(pages: PageRecord[], category: string): number {
  return pages.filter((page) => isMemopediaPage(page) && page.category === category).length;
}

/** Pages of a category, each child right under its parent. A page whose parent is not listed starts a branch. */
export function memopediaTree(pages: PageRecord[], category: string): PageTreeRow[] {
  const live = pages.filter((page) => isMemopediaPage(page) && page.category === category);
  const liveIds = new Set(live.map((page) => page.id));
  const children = new Map<string, PageRecord[]>();
  for (const page of live) {
    if (page.parentId === null || !liveIds.has(page.parentId)) continue;
    children.set(page.parentId, [...(children.get(page.parentId) ?? []), page]);
  }
  const rows: PageTreeRow[] = [];
  const seen = new Set<string>();
  const walk = (page: PageRecord, depth: number): void => {
    if (seen.has(page.id)) return;
    seen.add(page.id);
    rows.push({ page, depth });
    for (const child of (children.get(page.id) ?? []).sort(byTitle)) walk(child, depth + 1);
  };
  for (const page of live.filter((item) => item.parentId === null || !liveIds.has(item.parentId)).sort(byTitle)) walk(page, 0);
  // A parent loop has no way in from the top; those pages still have to be listed.
  for (const page of live.sort(byTitle)) walk(page, 0);
  return rows;
}

function queryWords(query: string): string[] {
  return query.toLocaleLowerCase("ja").split(/\s+/).filter(Boolean);
}

/** True when every word of `query` is in `text`. */
export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLocaleLowerCase("ja");
  return queryWords(query).every((word) => haystack.includes(word));
}

/** Across every category, pages with the words in the title first. */
export function searchMemopedia(pages: PageRecord[], query: string): PageTreeRow[] {
  const hits = pages.filter((page) => isMemopediaPage(page) && matchesQuery(`${page.title}\n${page.summary}\n${page.content}`, query));
  const inTitle = (page: PageRecord): number => (matchesQuery(page.title, query) ? 0 : 1);
  return hits.sort((a, b) => inTitle(a) - inTitle(b) || byTitle(a, b)).map((page) => ({ page, depth: 0 }));
}

export interface PageEdit {
  title: string;
  summary: string;
  content: string;
}

/** Applied to the stored row, not the one on the screen: Metabolism may have written to it since. */
export function updateMemopediaPage(
  repository: LiteRepository,
  personaId: string,
  pageId: string,
  edit: PageEdit,
): Promise<"updated" | "missing" | "title-taken"> {
  return repository.updatePersonaRecords<"updated" | "missing" | "title-taken">(personaId, ({ pages }) => {
    const page = pages.find((item) => item.id === pageId);
    if (!page || !isMemopediaPage(page)) return { write: {}, result: "missing" };
    const sameTitle = findPageByTitle(pages, edit.title);
    if (sameTitle && sameTitle.id !== pageId) return { write: {}, result: "title-taken" };
    return { write: { pages: [{ ...page, ...edit, updatedAt: epochSeconds(Date.now()) }] }, result: "updated" };
  });
}
