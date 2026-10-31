import type { ChatMessage, FragmentRecord, PageRecord } from "../domain";
import { CATEGORY_CHRONICLE, CATEGORY_CORE, epochSeconds } from "../pageRecords";
import type { LiteRepository } from "../storage/repository";
import { chronicleEntries, formatTimestamp, type ChronicleEntry } from "./entries";
import { coreMemoriesInOrder, coreMemoryId } from "./head";
import { composePageBody, DEFAULT_MEMOPEDIA_CATEGORY, findPageByTitle, isMemopediaCategory, isMemopediaPage, memopediaPage, MEMOPEDIA_CATEGORIES } from "./memopedia";
import { CORE_MEMORY_CHAR_BUDGET } from "./sluice";
import { isChronicleEligible, isMechanismRow } from "./window";

// The Memory Atlas reads and writes of the body's saiverse/memory_atlas.py, with the
// reference grammar of saiverse/references.py. The result texts are the body's.

const URI_PREFIX = "saiverse://";
const REF_EXAMPLES = "memopedia:3 / core / core:2 / chronicle:5";
const KIND_ALIASES: Record<string, string> = { m: "memopedia", c: "core", ch: "chronicle" };
const ATLAS_KINDS = new Set(["memopedia", "core", "chronicle"]);
const NOT_IN_LITE_KINDS = new Set(["clip", "p", "track", "task", "episode", "message", "item", "image", "document", "persona", "building"]);

export class AtlasRefError extends Error {}

type AtlasRef =
  | { kind: "core_all" }
  | { kind: "core" | "memopedia" | "chronicle"; key: string };

/** body: memory_atlas.py `_parse_ref`. */
export function parseAtlasRef(ref: string): AtlasRef {
  const text = ref.trim();
  if (!text) throw new AtlasRefError("ref が空です");
  if (text.toLowerCase() === "core") return { kind: "core_all" };
  let word: string;
  let key: string;
  if (text.startsWith(URI_PREFIX)) {
    const segments = text.slice(URI_PREFIX.length).split("?")[0]!.split("/").filter(Boolean);
    if (segments[0] !== "self") throw new AtlasRefError(`他のペルソナの記憶は読めません: ${JSON.stringify(ref)}`);
    word = segments[1] ?? "";
    key = segments[2] ?? "";
  } else {
    const colon = text.indexOf(":");
    if (colon < 0) throw new AtlasRefError(`認識できない ref 形式です: ${JSON.stringify(ref)} (例: ${REF_EXAMPLES})`);
    word = text.slice(0, colon);
    key = text.slice(colon + 1);
  }
  const kind = KIND_ALIASES[word] ?? word;
  if (NOT_IN_LITE_KINDS.has(kind)) {
    throw new AtlasRefError(`記憶の地図帳のページではありません: ${JSON.stringify(ref)} (種別「${kind}」。例: ${REF_EXAMPLES})`);
  }
  if (!ATLAS_KINDS.has(kind) || !key.trim()) {
    throw new AtlasRefError(`認識できない ref 形式です: ${JSON.stringify(ref)} (例: ${REF_EXAMPLES})`);
  }
  return { kind: kind as "core" | "memopedia" | "chronicle", key: key.trim() };
}

function positiveInt(key: string): number | null {
  return /^[0-9]+$/.test(key) && Number(key) > 0 ? Number(key) : null;
}

function findMemopediaPage(pages: PageRecord[], key: string): PageRecord | undefined {
  const shortId = positiveInt(key);
  return pages.filter(isMemopediaPage).find((page) => (shortId !== null ? page.shortId === shortId : page.id === key));
}

function memopediaRef(page: PageRecord): string {
  return page.shortId !== null ? `memopedia:${page.shortId}` : page.id;
}

function findCorePage(pages: PageRecord[], id: number): PageRecord | undefined {
  return coreMemoriesInOrder(pages).find((page) => coreMemoryId(page) === id);
}

async function readCore(repository: LiteRepository, personaId: string, key: string | null): Promise<string> {
  const pages = await repository.listPages(personaId, CATEGORY_CORE);
  if (key === null) {
    const items = coreMemoriesInOrder(pages);
    if (items.length === 0) return "コア記憶はまだありません。";
    return [`# コア記憶 (常時開・全 ${items.length} 件)`, ...items.flatMap((page) => [`\n## core:${coreMemoryId(page)}`, page.content])].join("\n");
  }
  const id = positiveInt(key);
  if (id === null) return `コア記憶の参照が不正です: core:${key}`;
  const page = findCorePage(pages, id);
  return page ? `# core:${id}\n\n${page.content}` : `コア記憶が見つかりません: core:${id}`;
}

async function readMemopedia(repository: LiteRepository, personaId: string, key: string): Promise<string> {
  const page = findMemopediaPage(await repository.listPages(personaId), key);
  if (!page) return `ページが見つかりません: memopedia:${key}`;
  const body = composePageBody(page, await repository.listFragments(personaId, page.id));
  const lines = [`# ${page.title} (${memopediaRef(page)})`];
  if (page.summary) lines.push(`\n*${page.summary}*`);
  lines.push(`\n${body || "(内容なし)"}`);
  return lines.join("\n");
}

async function readChronicle(repository: LiteRepository, personaId: string, key: string): Promise<string> {
  const id = positiveInt(key);
  if (id === null) return `Chronicle の参照が不正です: chronicle:${key}`;
  const entry = chronicleEntries(await repository.listPages(personaId, CATEGORY_CHRONICLE)).find((candidate) => candidate.shortId === id);
  return entry ? `# chronicle:${id} (レベル${entry.level})\n\n${entry.content}` : `Chronicle エントリが見つかりません: chronicle:${id}`;
}

/** body: memory_atlas.py `read_page`. */
export async function readPage(repository: LiteRepository, personaId: string, ref: string): Promise<string> {
  const parsed = parseAtlasRef(ref);
  if (parsed.kind === "core_all") return readCore(repository, personaId, null);
  if (parsed.kind === "core") return readCore(repository, personaId, parsed.key);
  return parsed.kind === "memopedia"
    ? readMemopedia(repository, personaId, parsed.key)
    : readChronicle(repository, personaId, parsed.key);
}

export function coreBudgetNote(pages: PageRecord[]): string {
  const total = coreMemoriesInOrder(pages).reduce((sum, page) => sum + page.content.length, 0);
  const over = total > CORE_MEMORY_CHAR_BUDGET ? "目安を超えています。整理を検討してください。" : "";
  return `現在 ${total.toLocaleString("en-US")} 字 / 目安 ${CORE_MEMORY_CHAR_BUDGET.toLocaleString("en-US")} 字。${over}`;
}

export interface WriteResult {
  text: string;
  /** False when `text` only says why nothing was written. */
  written: boolean;
}

const wrote = (text: string): WriteResult => ({ text, written: true });
const refused = (text: string): WriteResult => ({ text, written: false });

async function writeCoreNew(repository: LiteRepository, personaId: string, text: string): Promise<WriteResult> {
  const [page] = await repository.addCoreMemories(personaId, [{ content: text }]);
  const note = coreBudgetNote(await repository.listPages(personaId, CATEGORY_CORE));
  return wrote(`コア記憶 core:${coreMemoryId(page!)} に書きました（常時開の特殊ページです）。${note}head への反映は次の記憶整理（Metabolism）からです。`);
}

/** A scene is a copy of a real conversation, so it is never rewritten. */
export async function replaceCoreMemory(repository: LiteRepository, personaId: string, id: number, text: string): Promise<"replaced" | "scene" | "missing"> {
  const page = findCorePage(await repository.listPages(personaId, CATEGORY_CORE), id);
  if (!page) return "missing";
  if (page.metadata.kind === "scene") return "scene";
  await repository.putPage({ ...page, content: text, updatedAt: epochSeconds(Date.now()) });
  return "replaced";
}

async function writeCoreUpdate(repository: LiteRepository, personaId: string, key: string, text: string): Promise<WriteResult> {
  const id = positiveInt(key);
  if (id === null) return refused(`コア記憶の参照が不正です: core:${key}`);
  const result = await replaceCoreMemory(repository, personaId, id, text);
  if (result === "scene") return refused(`コア記憶 core:${id} は場面の記憶 (実会話の写し) なので書き換えの対象外です。`);
  if (result === "missing") return refused(`コア記憶が見つかりません: core:${id}`);
  const note = coreBudgetNote(await repository.listPages(personaId, CATEGORY_CORE));
  return wrote(`コア記憶 core:${id} を上書きしました。${note}head への反映は次の記憶整理（Metabolism）からです。`);
}

async function appendToPage(repository: LiteRepository, personaId: string, key: string, text: string): Promise<WriteResult> {
  const page = findMemopediaPage(await repository.listPages(personaId), key);
  if (!page) return refused(`ページが見つかりません: memopedia:${key}`);
  const content = page.content ? `${page.content}\n\n${text}` : text;
  await repository.putPage({ ...page, content, updatedAt: epochSeconds(Date.now()) });
  return wrote(`${memopediaRef(page)}「${page.title}」に追記しました。`);
}

async function createPage(repository: LiteRepository, personaId: string, title: string, category: string | undefined, text: string): Promise<WriteResult> {
  const cat = (category || DEFAULT_MEMOPEDIA_CATEGORY).toLowerCase().trim();
  if (!isMemopediaCategory(cat)) {
    return refused(`Error: category が不正です: ${JSON.stringify(category)}（有効: ${[...MEMOPEDIA_CATEGORIES].sort().join(", ")}）`);
  }
  const existing = findPageByTitle(await repository.listPages(personaId), title);
  if (existing) {
    const ref = memopediaRef(existing);
    return refused(`同名のページが既にあります: ${ref}「${existing.title}」。追記するには memory_write の ref に ${ref} を指定してください。`);
  }
  const page = memopediaPage(personaId, {
    parentId: `root_${cat}`,
    title,
    summary: "",
    content: text,
    category: cat,
    shortId: await repository.nextPageShortId(personaId),
  });
  await repository.putPage(page);
  return wrote(`新しいページを作りました: ${memopediaRef(page)}「${title}」（カテゴリ: ${cat}）`);
}

export interface WriteRequest {
  ref?: string;
  title?: string;
  category?: string;
  content: string;
}

/** body: memory_atlas.py `write_page`. */
export async function writePage(repository: LiteRepository, personaId: string, request: WriteRequest): Promise<WriteResult> {
  const text = request.content.trim();
  if (!text) return refused("Error: content は空にできません。");
  const ref = request.ref?.trim() ?? "";
  const title = request.title?.trim() ?? "";
  if (Boolean(ref) === Boolean(title)) return refused("Error: ref（既存ページに書く）と title（新規ページを作る）のどちらか一方だけを指定してください。");
  if (title) return createPage(repository, personaId, title, request.category, text);
  const parsed = parseAtlasRef(ref);
  if (parsed.kind === "core_all") return writeCoreNew(repository, personaId, text);
  if (parsed.kind === "core") return writeCoreUpdate(repository, personaId, parsed.key, text);
  if (parsed.kind === "memopedia") return appendToPage(repository, personaId, parsed.key, text);
  return refused(`chronicle:${parsed.key} には書けません。時間の地図（Chronicle）の編纂はシステムが行います。`);
}

export function searchTerms(value: string): string[] {
  const normalized = value.toLocaleLowerCase("ja").trim();
  const words = normalized.split(/[\s、。,.!?！？]+/).filter(Boolean);
  const result = [...words];
  for (const word of words) {
    if (/^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(word) && word.length >= 2) {
      for (let index = 0; index < word.length - 1; index += 1) result.push(word.slice(index, index + 2));
    }
  }
  return [...new Set(result)];
}

// The scan stops here so a long history cannot stall a response.
const MESSAGE_SCAN_ROWS = 20_000;
const MESSAGE_BATCH = 500;
const HITS_PER_SOURCE = 5;
const LINE_MAX_CHARS = 200;

interface SearchHit {
  score: number;
  line: string;
}

function scoreOf(text: string, terms: string[]): number {
  const haystack = text.toLocaleLowerCase("ja");
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function clip(text: string): string {
  const flat = text.trim().replace(/\s*\n\s*/g, " ");
  return flat.length > LINE_MAX_CHARS ? `${flat.slice(0, LINE_MAX_CHARS)}…` : flat;
}

function topHits(hits: SearchHit[]): string[] {
  return hits.filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score).slice(0, HITS_PER_SOURCE).map((hit) => hit.line);
}

function pageHits(pages: PageRecord[], fragments: FragmentRecord[], entries: ChronicleEntry[], terms: string[]): string[][] {
  const memopedia = pages.filter(isMemopediaPage);
  const byId = new Map(memopedia.map((page) => [page.id, page]));
  return [
    topHits(coreMemoriesInOrder(pages).map((page) => ({
      score: scoreOf(page.content, terms),
      line: `- [core:${coreMemoryId(page)}] ${clip(page.content)}`,
    }))),
    topHits(memopedia.map((page) => ({
      score: scoreOf(`${page.title}\n${page.summary}\n${page.content}`, terms),
      line: `- [${memopediaRef(page)}] ${page.title}: ${clip(page.summary || page.content)}`,
    }))),
    topHits(fragments.map((fragment) => {
      const page = byId.get(fragment.entityId);
      return {
        score: scoreOf(fragment.content, terms),
        line: `- [${page ? `${memopediaRef(page)} ${page.title}` : "記憶の断片"}] ${clip(fragment.content)}`,
      };
    })),
    topHits(entries.map((entry) => ({
      score: scoreOf(entry.content, terms),
      line: `- [chronicle:${entry.shortId ?? "?"}] ${formatTimestamp(entry.startTime)} ~ ${formatTimestamp(entry.endTime)}: ${clip(entry.content)}`,
    }))),
  ];
}

/** Newest first. Tool results and notices are not conversation, and Stelis threads are not the persona's own line. */
async function messageHits(repository: LiteRepository, personaId: string, terms: string[]): Promise<{ lines: string[]; truncated: boolean }> {
  const stelis = new Set((await repository.listThreads(personaId)).filter((thread) => thread.stelis).map((thread) => thread.id));
  const hits: SearchHit[] = [];
  let scanned = 0;
  let cursor: ChatMessage | undefined;
  for (;;) {
    const batch = await repository.readPersonaMessages(personaId, { direction: "backward", limit: MESSAGE_BATCH, ...(cursor ? { start: cursor } : {}) });
    for (const row of batch) {
      if (isMechanismRow(row) || !isChronicleEligible(row) || stelis.has(row.threadId)) continue;
      if (row.role !== "user" && row.role !== "assistant") continue;
      hits.push({
        score: scoreOf(row.content, terms),
        line: `- [過去の会話 ${formatTimestamp(epochSeconds(row.createdAt))}] ${row.role}: ${row.content.trim()}`,
      });
    }
    scanned += batch.length;
    cursor = batch.at(-1);
    if (!cursor || batch.length < MESSAGE_BATCH) return { lines: topHits(hits), truncated: false };
    if (scanned >= MESSAGE_SCAN_ROWS) return { lines: topHits(hits), truncated: true };
  }
}

export async function searchMemory(repository: LiteRepository, personaId: string, query: string): Promise<{ text: string; hitCount: number }> {
  const terms = searchTerms(query);
  if (terms.length === 0) return { text: "検索語が空です。", hitCount: 0 };
  const pages = await repository.listPages(personaId);
  const entries = chronicleEntries(pages.filter((page) => page.category === CATEGORY_CHRONICLE));
  const fragments = await repository.listFragments(personaId);
  const messages = await messageHits(repository, personaId, terms);
  const lines = [...pageHits(pages, fragments, entries, terms), messages.lines].flat();
  const note = messages.truncated ? `\n（会話は新しい順に ${MESSAGE_SCAN_ROWS.toLocaleString("en-US")} 件までを検索しました。）` : "";
  if (lines.length === 0) return { text: `「${query}」に一致する記憶は見つかりませんでした。${note}`, hitCount: 0 };
  return { text: `「${query}」の検索結果です（${lines.length} 件）。\n${lines.join("\n")}${note}`, hitCount: lines.length };
}
