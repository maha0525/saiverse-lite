import { randomId, type PageRecord, type PersonaSession } from "./domain";

export const ROOT_CORE_ID = "root_core";
export const ROOT_CHRONICLE_ID = "root_chronicle";
export const CATEGORY_CORE = "core";
export const CATEGORY_CHRONICLE = "chronicle";

export function epochSeconds(milliseconds: number): number {
  return Math.floor(milliseconds / 1000);
}

// body: sai_memory/memopedia/storage.py INITIAL_ROOTS.
const MEMOPEDIA_ROOTS = [
  { id: "root_people", title: "人物", category: "people", summary: "関わりのある人物についての記録" },
  { id: "root_terms", title: "用語", category: "terms", summary: "対話の中で特別な意味を持つ言葉や概念" },
  { id: "root_plans", title: "計画", category: "plans", summary: "進行中や計画中のプロジェクト・予定" },
  { id: "root_events", title: "出来事", category: "events", summary: "出来事、体験、時事的な話題" },
] as const;

function trunkPage(personaId: string, nowSeconds: number, fields: Pick<PageRecord, "id" | "title" | "category"> & Partial<PageRecord>): PageRecord {
  return {
    personaId,
    parentId: null,
    summary: "",
    content: "",
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
    keywords: [],
    metadata: {},
    isDeleted: false,
    vividness: "rough",
    isTrunk: true,
    isImportant: false,
    lastReferencedAt: null,
    shortId: null,
    source: null,
    ...fields,
  };
}

/**
 * The trunk pages a new persona's memory.db has in the body. `_seed_root_pages`
 * inserts the Memopedia roots without a short_id; `create_page` numbers
 * root_chronicle and then root_core, in the order the adapter initialises them.
 */
export function createTrunkPages(personaId: string, nowSeconds: number): PageRecord[] {
  return [
    ...MEMOPEDIA_ROOTS.map((root) => trunkPage(personaId, nowSeconds, { ...root })),
    trunkPage(personaId, nowSeconds, {
      id: ROOT_CHRONICLE_ID,
      title: "時間の地図",
      category: CATEGORY_CHRONICLE,
      lastReferencedAt: nowSeconds,
      shortId: 1,
    }),
    trunkPage(personaId, nowSeconds, {
      id: ROOT_CORE_ID,
      title: "コア記憶",
      category: CATEGORY_CORE,
      isImportant: true,
      lastReferencedAt: nowSeconds,
      shortId: 2,
    }),
  ];
}

export function createPersonaSession(personaId: string, activeThreadId: string | null = null): PersonaSession {
  return {
    personaId,
    activeThreadId,
    anchorMessageId: null,
    headText: null,
    chronicleText: null,
    passphrase: null,
    headUpdatedAt: null,
    metabolismError: null,
    importState: "ready",
  };
}

export interface CoreMemoryDraft {
  /** Given when the caller needs a re-run to find the same page again. */
  id?: string;
  content: string;
  kind?: string;
  confirmed?: number;
  /** Merged flat into the page metadata, beside the core memory keys. */
  metadata?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

function coreId(page: PageRecord): number {
  const value = page.metadata.core_id;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function isCoreMemoryPage(page: PageRecord): boolean {
  return page.parentId === ROOT_CORE_ID && page.category === CATEGORY_CORE && !page.isTrunk;
}

/**
 * Pages to write for `drafts`, shaped as `add_core_memory` / `_build_page_metadata`
 * in the body's sai_memory/core_memory.py. `existing` is every page of the core
 * category including soft-deleted ones: core_id is never reused, and a draft whose
 * id the persona has deleted stays deleted.
 */
export function buildCoreMemoryPages(
  personaId: string,
  existing: PageRecord[],
  firstShortId: number,
  drafts: CoreMemoryDraft[],
  nowSeconds: number,
): PageRecord[] {
  const byId = new Map(existing.filter(isCoreMemoryPage).map((page) => [page.id, page]));
  let nextCoreId = Math.max(0, ...[...byId.values()].map(coreId)) + 1;
  let nextShortId = firstShortId;
  const written: PageRecord[] = [];
  for (const draft of drafts) {
    const current = draft.id === undefined ? undefined : byId.get(draft.id);
    if (current) {
      if (current.isDeleted || current.content === draft.content) continue;
      const updated = { ...current, content: draft.content, updatedAt: draft.updatedAt ?? nowSeconds };
      byId.set(current.id, updated);
      written.push(updated);
      continue;
    }
    const core = nextCoreId;
    nextCoreId += 1;
    const createdAt = draft.createdAt ?? nowSeconds;
    const page: PageRecord = {
      id: draft.id ?? randomId(),
      personaId,
      parentId: ROOT_CORE_ID,
      title: `コア記憶 c:${core}`,
      summary: "",
      content: draft.content,
      category: CATEGORY_CORE,
      createdAt,
      updatedAt: draft.updatedAt ?? createdAt,
      keywords: [],
      metadata: {
        ...draft.metadata,
        core_id: core,
        kind: draft.kind ?? "note",
        confirmed: draft.confirmed ?? 1,
        deleted_at: null,
      },
      isDeleted: false,
      vividness: "rough",
      isTrunk: false,
      isImportant: true,
      lastReferencedAt: nowSeconds,
      shortId: nextShortId,
      source: null,
    };
    nextShortId += 1;
    byId.set(page.id, page);
    written.push(page);
  }
  return written;
}

/** Core memories not in the trash, most recently updated first. */
export function liveCoreMemories(pages: PageRecord[]): PageRecord[] {
  return pages
    .filter((page) => isCoreMemoryPage(page) && !page.isDeleted)
    .sort((a, b) => b.updatedAt - a.updatedAt || coreId(b) - coreId(a));
}

/** body: `remove_core_memory` sets both is_deleted and metadata.deleted_at. */
export function softDeleteCoreMemory(page: PageRecord, nowSeconds: number): PageRecord {
  return { ...page, isDeleted: true, metadata: { ...page.metadata, deleted_at: nowSeconds } };
}
