import { randomId, type FragmentRecord, type PageRecord } from "../domain";
import { CATEGORY_CHRONICLE, CATEGORY_CORE, epochSeconds } from "../pageRecords";

// The Memopedia part of body: sai_memory/memopedia/{storage,core}.py.

/** body: storage.py CATEGORY_DEFS, the `extractable` and `writable` keys in order. */
export const MEMOPEDIA_CATEGORIES = ["people", "terms", "plans", "events"] as const;
export const DEFAULT_MEMOPEDIA_CATEGORY = "terms";

export function isMemopediaCategory(value: string): boolean {
  return (MEMOPEDIA_CATEGORIES as readonly string[]).includes(value);
}

/** A live page of the Memopedia itself: neither a trunk, nor a Chronicle entry, nor a core memory. */
export function isMemopediaPage(page: PageRecord): boolean {
  return !page.isDeleted && !page.isTrunk && page.category !== CATEGORY_CHRONICLE && page.category !== CATEGORY_CORE;
}

/** body: storage.py `find_page_by_title`, across every category. */
export function findPageByTitle(pages: PageRecord[], title: string): PageRecord | undefined {
  return pages.find((page) => page.title === title && !page.isDeleted);
}

/** body: storage.py `create_page`, with the fields it leaves at their column defaults. */
export function memopediaPage(
  personaId: string,
  fields: Pick<PageRecord, "parentId" | "title" | "summary" | "content" | "category" | "shortId">,
  nowMs = Date.now(),
): PageRecord {
  const now = epochSeconds(nowMs);
  return {
    ...fields,
    id: randomId(),
    personaId,
    createdAt: now,
    updatedAt: now,
    keywords: [],
    metadata: {},
    isDeleted: false,
    vividness: "rough",
    isTrunk: false,
    isImportant: false,
    lastReferencedAt: now,
    source: null,
  };
}

/** body: storage.py `create_fragment`. */
export function fragmentRecord(
  personaId: string,
  fields: Pick<FragmentRecord, "content" | "entityId" | "chronicleEntryId" | "sourceDate">,
  nowMs = Date.now(),
): FragmentRecord {
  return { ...fields, id: randomId(), personaId, vividness: "vivid", createdAt: epochSeconds(nowMs), source: null };
}

/** body: core.py `_compose_page_body`. */
export function composePageBody(page: PageRecord, fragments: FragmentRecord[]): string {
  const parts: string[] = [];
  if (page.content.trim()) parts.push(page.content);
  if (fragments.length > 0) {
    const grouped = new Map<string, string[]>();
    for (const fragment of fragments) {
      const key = fragment.sourceDate ?? "unknown";
      grouped.set(key, [...(grouped.get(key) ?? []), fragment.content]);
    }
    parts.push([...grouped].flatMap(([date, notes]) => [`## ${date}`, ...notes.map((note) => `- ${note}`)]).join("\n"));
  }
  return parts.join("\n\n");
}

/** body: entity_extractor.py `_format_page_list` over `build_tree`. Children sit under their parent, one level deep. */
export function formatPageList(pages: PageRecord[]): string {
  const live = pages.filter(isMemopediaPage);
  const lines: string[] = [];
  for (const category of MEMOPEDIA_CATEGORIES) {
    const rootId = `root_${category}`;
    const top = live.filter((page) => page.parentId === rootId);
    if (top.length === 0) continue;
    lines.push(`[${category}]`);
    for (const page of top) {
      lines.push(`  - ${page.title}`);
      for (const child of live.filter((candidate) => candidate.parentId === page.id)) lines.push(`    - ${child.title}`);
    }
  }
  return lines.join("\n");
}
