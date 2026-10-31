import { newId, type ChatMessage, type PageRecord } from "../domain";
import type { CompletionRequest, LlmProvider } from "../llm/types";
import type { RetryNotice } from "../llm/retry";
import { CATEGORY_CHRONICLE, epochSeconds, ROOT_CHRONICLE_ID } from "../pageRecords";
import type { LiteRepository } from "../storage/repository";
import { chronicleEntries, coverageChars, coveredMessageIds, formatTimestamp, type ChronicleEntry } from "./entries";
import { planRunChunks } from "./eviction";
import { CHRONICLE_UNIT_CHARS, isChronicleEligible, materialChars, materialText, messageTags, isMechanismRow } from "./window";

// body: sai_memory/arasuji/{context,bands,executor,generator}.py.
const DEFAULT_CHRONICLE_CHAR_BUDGET = 20_000;
const MASS_DIVISOR = 10;
const MIN_ENTRIES_PER_LEVEL = 10;
const MAX_TRAVERSAL_ENTRIES = 10_000;
const MAX_COMPRESSION_ROUNDS = 1000;
const EMPTY_RESPONSE_ATTEMPTS = 3;
const BAND_CHAR_LIMIT = 5_000;
const BAND_CHAR_KEEP = 2_500;
const EST_PARENT_CHARS = 500;
const FOLD_MATERIAL_CHAR_LIMIT = CHRONICLE_UNIT_CHARS / 2;
const MAX_CONSOLIDATIONS_PER_CALL = 3;
const CHRONICLE_INTRO = "以下は、あなたの長期記憶（Chronicle: これまでの出来事）です。";
const RECALL_PROMPT_NOTE = "- 【想起 (過去の再提示)】と印の付いた項目は、過去の出来事の再提示です。この期間に新しく起きた出来事として語らないでください";

export interface AuxiliaryLlm {
  provider: LlmProvider;
  model: string;
  onRetry?: RetryNotice;
}

export function auxiliaryRequest(llm: AuxiliaryLlm, prompt: string): CompletionRequest {
  return {
    model: llm.model,
    systemPrompt: "",
    memoryContext: "",
    messages: [{ role: "user", content: prompt, toolCallId: null, toolName: null, toolCalls: [] }],
    ...(llm.onRetry ? { onRetry: llm.onRetry } : {}),
  };
}

/** body: generator.py `generate_text_with_empty_retry`. Only a blank reply is retried here. */
async function generateTextWithEmptyRetry(llm: AuxiliaryLlm, prompt: string, purpose: string): Promise<string> {
  for (let attempt = 1; attempt <= EMPTY_RESPONSE_ATTEMPTS; attempt += 1) {
    const result = await llm.provider.complete(auxiliaryRequest(llm, prompt));
    const text = result.text.trim();
    if (text) return text;
    if (attempt < EMPTY_RESPONSE_ATTEMPTS) console.warn("[SAIVerse Lite][chronicle] empty response; retrying", { purpose, attempt });
  }
  throw new Error(`${purpose} の応答が空でした`);
}

/** body: context.py `_get_all_arasuji_sorted`, newest end_time first. */
function sortedEntries(pages: PageRecord[]): ChronicleEntry[] {
  return chronicleEntries(pages)
    .filter((entry) => entry.originTrackId === null)
    .sort((a, b) => a.level - b.level || (a.endTime ?? 0) - (b.endTime ?? 0))
    .sort((a, b) => (b.endTime ?? 0) - (a.endTime ?? 0));
}

/**
 * body: context.py `_descend_around_excluded`. An excluded entry's period is in
 * the window, so showing it, an ancestor of it or a descendant of it would present
 * the same experience twice. Ancestors drop out and their other children stay.
 */
function descendAroundExcluded(entries: ChronicleEntry[], excluded: Set<string>): ChronicleEntry[] {
  if (excluded.size === 0) return entries;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  const link = (parent: string, child: string): void => {
    parentsOf.set(child, [...(parentsOf.get(child) ?? []), parent]);
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), child]);
  };
  for (const entry of entries) {
    for (const child of entry.sourceIds) {
      if (entry.level > 1 || byId.has(child)) link(entry.id, child);
    }
    if (entry.parentId !== null) link(entry.parentId, entry.id);
  }
  const reach = (seeds: Iterable<string>, edges: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>();
    const queue = [...seeds];
    for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
      for (const next of edges.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  };
  const ancestors = reach(excluded, parentsOf);
  const descendants = reach(excluded, childrenOf);
  return entries.filter((entry) => !excluded.has(entry.id) && !ancestors.has(entry.id) && !descendants.has(entry.id));
}

function nextPosition(all: ChronicleEntry[], pick: ChronicleEntry, position: number, read: Set<string>): number {
  let next = (pick.startTime ?? 0) - 1;
  for (const other of all) {
    if (read.has(other.id) || other.endTime === null || other.endTime > position || other.endTime <= next) continue;
    const nested = pick.startTime !== null && pick.endTime !== null && other.startTime !== null && (
      (pick.startTime <= other.startTime && other.endTime <= pick.endTime)
      || (other.startTime <= pick.startTime && pick.endTime <= other.endTime)
    );
    if (!nested) next = other.endTime;
  }
  return next;
}

/** body: context.py `_traverse_episode_mass`. Returns newest first. */
function traverseByMass(all: ChronicleEntry[], startPosition: number): ChronicleEntry[] {
  const result: ChronicleEntry[] = [];
  const read = new Set<string>();
  let cumulativeMass = 0;
  let position = startPosition;
  while (result.length < MAX_TRAVERSAL_ENTRIES) {
    const frontier = all.find((entry) => !read.has(entry.id) && entry.endTime !== null && entry.endTime <= position)?.endTime;
    if (frontier === undefined || frontier === null) break;
    const candidates = all.filter((entry) => !read.has(entry.id) && entry.endTime === frontier);
    const satisfying = candidates.filter((entry) => coverageChars(entry) * MASS_DIVISOR >= cumulativeMass);
    const byMass = (a: ChronicleEntry, b: ChronicleEntry): number => coverageChars(a) - coverageChars(b) || a.level - b.level;
    const pick = satisfying.length > 0 ? [...satisfying].sort(byMass)[0]! : [...candidates].sort(byMass).at(-1)!;
    result.push(pick);
    read.add(pick.id);
    for (const source of pick.sourceIds) read.add(source);
    cumulativeMass += coverageChars(pick);
    position = nextPosition(all, pick, position, read);
    if (position <= 0) break;
  }
  return result;
}

function contentChars(entries: ChronicleEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.content.length, 0);
}

/** body: context.py `_compress_within_budget`. Replacing children with their parent keeps the covered range. */
function compressWithinBudget(initial: ChronicleEntry[], all: ChronicleEntry[], budget: number): ChronicleEntry[] {
  let result = initial;
  const parentOf = new Map<string, ChronicleEntry>();
  for (const candidate of all) {
    for (const child of candidate.sourceIds) parentOf.set(child, candidate);
  }
  for (let round = 0; round < MAX_COMPRESSION_ROUNDS && contentChars(result) > budget; round += 1) {
    let replaced = false;
    let index = result.length - 1;
    while (index >= 0 && !replaced) {
      const parent = parentOf.get(result[index]!.id);
      if (!parent) {
        index -= 1;
        continue;
      }
      let low = index;
      while (low >= 0 && parentOf.get(result[low]!.id) === parent) low -= 1;
      const group = new Set(result.slice(low + 1, index + 1).map((entry) => entry.id));
      if (parent.sourceIds.every((id) => group.has(id))) {
        result = [...result.slice(0, low + 1), parent, ...result.slice(index + 1)];
        replaced = true;
      }
      index = low;
    }
    if (!replaced) break;
  }
  return result;
}

/** body: context.py `format_episode_context` with include_level_info=True, given oldest first. */
function formatEpisodeContext(context: ChronicleEntry[]): string {
  const parts: string[] = [];
  let previousLevel = -1;
  for (const entry of context) {
    if (entry.level !== previousLevel) {
      parts.push(`\n### ${entry.level === 1 ? "あらすじ" : `あらすじ${"のあらすじ".repeat(entry.level - 1)}`}`);
      previousLevel = entry.level;
    }
    parts.push(`【${formatTimestamp(entry.startTime)} ~ ${formatTimestamp(entry.endTime)}】`, entry.content, "");
  }
  return parts.join("\n");
}

/** The Chronicle message of a session. body: builtin_data/tools/get_memory_weave_context.py. */
export function buildChronicleText(pages: PageRecord[], excludeEntryIds: Set<string>): string {
  const all = descendAroundExcluded(sortedEntries(pages), excludeEntryIds);
  const start = all[0]?.endTime;
  if (start === undefined || start === null) return "";
  const walked = traverseByMass(all, start);
  const compressed = compressWithinBudget(walked, all, DEFAULT_CHRONICLE_CHAR_BUDGET);
  if (contentChars(compressed) > DEFAULT_CHRONICLE_CHAR_BUDGET) {
    console.warn("[SAIVerse Lite][chronicle] over budget; nothing is dropped", { chars: contentChars(compressed), entries: compressed.length });
  }
  const text = formatEpisodeContext([...compressed].reverse());
  return text ? `${CHRONICLE_INTRO}\n\n${text}` : "";
}

/** The level 1 entries that cover any of the rows, for `buildChronicleText`. */
export function entriesCoveringRows(pages: PageRecord[], rowIds: Set<string>): Set<string> {
  return new Set(chronicleEntries(pages)
    .filter((entry) => entry.level === 1 && entry.sourceIds.some((id) => rowIds.has(id)))
    .map((entry) => entry.id));
}

/** body: context.py `_find_arasuji_at_position`. */
function findAtPosition(all: ChronicleEntry[], position: number, maxLevel: number, read: Set<string>): ChronicleEntry | null {
  const frontier = all.find((entry) => !read.has(entry.id) && entry.endTime !== null && entry.endTime <= position)?.endTime;
  if (frontier === undefined || frontier === null) return null;
  let best: ChronicleEntry | null = null;
  let fallback: ChronicleEntry | null = null;
  for (const entry of all) {
    if (read.has(entry.id) || entry.endTime !== frontier) continue;
    if (entry.level > maxLevel) {
      if (!fallback || entry.level < fallback.level) fallback = entry;
    } else if (!best || entry.level > best.level) {
      best = entry;
    }
  }
  return best ?? fallback;
}

/** body: context.py `get_episode_context_for_timerange`. */
export function episodeContextForTimerange(pages: PageRecord[], startTime: number, maxEntries: number): string {
  const all = sortedEntries(pages);
  const result: ChronicleEntry[] = [];
  const read = new Set<string>();
  const levelCounts = new Map<number, number>();
  let currentLevel = 0;
  let position = startTime - 1;
  while (result.length < maxEntries) {
    const found = findAtPosition(all, position, currentLevel + 1, read);
    if (!found) break;
    result.push(found);
    read.add(found.id);
    for (const source of found.sourceIds) read.add(source);
    const count = (levelCounts.get(found.level) ?? 0) + 1;
    levelCounts.set(found.level, count);
    if (count >= MIN_ENTRIES_PER_LEVEL) currentLevel = found.level;
    position = (found.startTime ?? 0) - 1;
    if (position <= 0) break;
  }
  return result.reverse().flatMap((entry) => {
    const levelName = entry.level === 1 ? "あらすじ" : `あらすじ${"のあらすじ".repeat(entry.level - 1)}`;
    return [`【${levelName}: ${formatTimestamp(entry.startTime)} ~ ${formatTimestamp(entry.endTime)}】`, entry.content, ""];
  }).join("\n");
}

function isRecallText(text: string): boolean {
  return text.trim().startsWith("[想起:");
}

/** body: generator.py `_message_kind_label`. Lite's tool results carry their own label. */
function messageKindLabel(message: ChatMessage): string {
  const tags = messageTags(message);
  if (tags.includes("session_digest")) return " [作業のまとめ]";
  if (isRecallText(message.content)) return " 【想起 (過去の再提示)】";
  if (tags.includes("handy_tool")) return " 【ツール結果】";
  if (tags.includes("spell")) return " 【スペル結果】";
  if (tags.includes("event_message")) return " 【通知】";
  return "";
}

/** body: generator.py `_format_messages_for_prompt`. */
function formatMessagesForPrompt(messages: ChatMessage[]): string {
  return messages.flatMap((message) => {
    const content = materialText(message).trim();
    if (!content) return [];
    const time = formatTimestamp(epochSeconds(message.createdAt));
    return [`[${time}] [${message.role}]${messageKindLabel(message)}: ${content}`];
  }).join("\n\n");
}

/** body: executor.py `_build_batch_prompt`. */
function buildBatchPrompt(messages: ChatMessage[], pages: PageRecord[]): string {
  const startTime = Math.min(...messages.map((message) => epochSeconds(message.createdAt)));
  const context = episodeContextForTimerange(pages, startTime, 20);
  const parts = ["あなたは記憶の記録者です。以下の会話から、出来事のあらすじを書いてください。", ""];
  if (context) parts.push("## これまでの流れ（参考）", context, "");
  parts.push(
    "## 今回記録する会話",
    formatMessagesForPrompt(messages),
    "",
    "## 指示",
    "- 3〜5文程度で、何が起きたか、誰と何を話したかを要約",
    "- 時系列の流れがわかるように書く",
    "- 固有名詞や重要な詳細は保持する",
    "- 感情や雰囲気も含める",
    "- 「〜について話した」のような抽象的な記述は避け、具体的に書く",
    "- [作業のまとめ] と印の付いた項目は、既に要約された作業の記録です。発言として引用せず、出来事の流れの一部として織り込む",
  );
  if (messages.some((message) => isRecallText(message.content))) parts.push(RECALL_PROMPT_NOTE);
  parts.push(
    "- **日時情報（【2025-01-07 23:56 ~】など）は書かないでください**（自動で付与されます）",
    "- **「あらすじ」などの見出しは書かないでください**（本文のみ出力）",
    "",
    "あらすじを日本語で書いてください。",
  );
  return parts.join("\n");
}

function nextChronicleShortId(pages: PageRecord[]): number {
  return Math.max(0, ...chronicleEntries(pages).map((entry) => entry.shortId ?? 0)) + 1;
}

interface EntryDraft {
  level: number;
  content: string;
  sourceIds: string[];
  startTime: number | null;
  endTime: number | null;
  sourceCount: number;
  messageCount: number;
  extraMetadata: Record<string, unknown>;
}

/** The page of body: storage.py `create_entry`. Standard keys win over extra metadata, as there. */
async function draftEntryPage(repository: LiteRepository, personaId: string, pages: PageRecord[], draft: EntryDraft): Promise<PageRecord> {
  const now = epochSeconds(Date.now());
  const shortId = nextChronicleShortId(pages);
  return {
    id: crypto.randomUUID(),
    personaId,
    parentId: ROOT_CHRONICLE_ID,
    title: `chronicle:${shortId}`,
    summary: "",
    content: draft.content,
    category: CATEGORY_CHRONICLE,
    createdAt: now,
    updatedAt: now,
    keywords: [],
    metadata: {
      ...draft.extraMetadata,
      level: draft.level,
      source_ids: draft.sourceIds,
      start_time: draft.startTime,
      end_time: draft.endTime,
      source_count: draft.sourceCount,
      message_count: draft.messageCount,
      is_consolidated: 0,
      thread_id: null,
      short_id: shortId,
    },
    isDeleted: false,
    vividness: "rough",
    isTrunk: false,
    isImportant: false,
    lastReferencedAt: now,
    shortId: await repository.nextPageShortId(personaId),
    source: null,
  };
}

export interface PrimaryEntryResult {
  entryId: string;
  messages: ChatMessage[];
}

/**
 * Compiles one fold into level 1 entries. Rows an entry already covers are skipped,
 * so a retry after a failure never compiles them twice. body: alignment.py
 * `plan_alignment` narrowed to one fold, and executor.py `execute_plan`.
 */
export async function compileFold(
  repository: LiteRepository,
  personaId: string,
  llm: AuxiliaryLlm,
  fold: ChatMessage[],
  onEntry: (entry: PrimaryEntryResult) => Promise<void>,
): Promise<void> {
  const stelis = new Set((await repository.listThreads(personaId)).filter((thread) => thread.stelis).map((thread) => thread.id));
  const covered = coveredMessageIds(chronicleEntries(await repository.listPages(personaId, CATEGORY_CHRONICLE)));
  const runs: ChatMessage[][] = [];
  let run: ChatMessage[] = [];
  for (const message of fold) {
    if (!isChronicleEligible(message) || stelis.has(message.threadId)) continue;
    if (covered.has(message.id)) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push(message);
  }
  if (run.length > 0) runs.push(run);

  for (const chunk of runs.flatMap((messages) => planRunChunks(messages, CHRONICLE_UNIT_CHARS))) {
    const pages = await repository.listPages(personaId, CATEGORY_CHRONICLE);
    const content = await generateTextWithEmptyRetry(llm, buildBatchPrompt(chunk, pages), "あらすじの生成");
    const times = chunk.map((message) => epochSeconds(message.createdAt));
    const page = await draftEntryPage(repository, personaId, pages, {
      level: 1,
      content,
      sourceIds: chunk.map((message) => message.id),
      startTime: Math.min(...times),
      endTime: Math.max(...times),
      sourceCount: chunk.length,
      messageCount: chunk.length,
      extraMetadata: { digest_origin: "batch", coverage_chars: materialChars(chunk), episode_refs: [] },
    });
    await repository.putPage(page);
    await onEntry({ entryId: page.id, messages: chunk });
  }
}

interface RowItem {
  entry: ChronicleEntry;
  chars: number;
  gapBefore: boolean;
}

/** body: bands.py `_is_orphan`. */
function isOrphan(entry: ChronicleEntry, all: ChronicleEntry[]): boolean {
  if (entry.startTime === null || entry.endTime === null) return false;
  return all.some((other) => {
    if (other.id === entry.id || other.startTime === null || other.endTime === null || other.level <= entry.level) return false;
    const contains = other.startTime <= entry.startTime! && entry.endTime! <= other.endTime;
    return contains && (other.startTime < entry.startTime! || entry.endTime! < other.endTime);
  });
}

/** body: bands.py `_load_rows` and `_mark_uncompiled_gaps`. */
function loadRows(entries: ChronicleEntry[]): Map<number, RowItem[]> {
  const live = entries.filter((entry) => entry.originTrackId === null && !entry.isIncomplete);
  const open = live
    .filter((entry) => !entry.isConsolidated && !isOrphan(entry, live))
    .sort((a, b) => (a.endTime ?? 0) - (b.endTime ?? 0) || (a.startTime ?? 0) - (b.startTime ?? 0) || a.createdAt - b.createdAt);
  const rows = new Map<number, RowItem[]>();
  for (const entry of open) {
    rows.set(entry.level, [...(rows.get(entry.level) ?? []), { entry, chars: entry.content.length, gapBefore: false }]);
  }
  for (const [level, row] of rows) {
    if (level <= 1) continue;
    for (let index = 1; index < row.length; index += 1) {
      const previous = row[index - 1]!.entry;
      const next = row[index]!;
      if (previous.endTime === null || next.entry.startTime === null || next.entry.startTime < previous.endTime) continue;
      next.gapBefore = open.some((entry) => entry.level < level
        && (entry.endTime ?? -Infinity) >= previous.endTime!
        && (entry.startTime ?? Infinity) <= next.entry.startTime!);
    }
  }
  return rows;
}

/** body: bands.py `_plan_fold_for_level`. */
function planFoldForLevel(row: RowItem[]): RowItem[] | null {
  if (row.reduce((sum, item) => sum + item.chars, 0) <= BAND_CHAR_LIMIT) return null;
  let keep = 0;
  let cut = row.length;
  for (let index = row.length - 1; index >= 0; index -= 1) {
    if (keep + row[index]!.chars > BAND_CHAR_KEEP) break;
    keep += row[index]!.chars;
    cut = index;
  }
  const segments: RowItem[][] = [];
  let current: RowItem[] = [];
  for (const item of row.slice(0, cut)) {
    if (item.gapBefore && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) segments.push(current);
  const segment = segments.find((candidate) => candidate.length >= 2);
  if (!segment) return null;
  const trimmed: RowItem[] = [];
  let total = 0;
  for (const item of segment) {
    if (trimmed.length >= 2 && total + item.chars > FOLD_MATERIAL_CHAR_LIMIT) break;
    trimmed.push(item);
    total += item.chars;
  }
  return trimmed;
}

/** The lowest level's first fold. The caller re-reads after each one, so a parent's real length decides the next. */
function firstFold(rows: Map<number, RowItem[]>): { level: number; items: RowItem[] } | null {
  for (const level of [...rows.keys()].sort((a, b) => a - b)) {
    const items = planFoldForLevel(rows.get(level) ?? []);
    if (items) return { level, items };
  }
  return null;
}

/** body: bands.py `_hole_between`, in closed seconds: rows on either edge are covered and drop out anyway. */
async function holeBetween(
  repository: LiteRepository,
  personaId: string,
  covered: Set<string>,
  stelis: Set<string>,
  previous: ChronicleEntry,
  next: ChronicleEntry,
): Promise<{ count: number; first: number; last: number } | null> {
  if (previous.endTime === null || next.startTime === null || next.startTime < previous.endTime) return null;
  const endMs = (next.startTime + 1) * 1000;
  let cursor = { createdAt: previous.endTime * 1000, seq: -1, id: "" };
  let hole: { count: number; first: number; last: number } | null = null;
  for (;;) {
    const batch = await repository.readPersonaMessages(personaId, { direction: "forward", limit: 500, start: cursor });
    for (const message of batch) {
      if (message.createdAt >= endMs) return hole;
      if (covered.has(message.id) || !isChronicleEligible(message) || stelis.has(message.threadId)) continue;
      const seconds = epochSeconds(message.createdAt);
      hole = { count: (hole?.count ?? 0) + 1, first: hole?.first ?? seconds, last: seconds };
    }
    const last = batch.at(-1);
    if (!last || batch.length < 500) return hole;
    cursor = last;
  }
}

/** body: bands.py `_build_consolidation_prompt`. */
async function buildConsolidationPrompt(repository: LiteRepository, personaId: string, entries: ChronicleEntry[], pages: PageRecord[]): Promise<string> {
  const starts = entries.flatMap((entry) => entry.startTime ?? []);
  const context = starts.length > 0 ? episodeContextForTimerange(pages, Math.min(...starts), 10) : "";
  const covered = coveredMessageIds(chronicleEntries(pages));
  const stelis = new Set((await repository.listThreads(personaId)).filter((thread) => thread.stelis).map((thread) => thread.id));

  let hasFragment = false;
  let hasHole = false;
  const lines: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const previous = entries[index - 1];
    const hole = previous ? await holeBetween(repository, personaId, covered, stelis, previous, entry) : null;
    if (hole) {
      hasHole = true;
      lines.push(`(この間に、まだあらすじになっていない記録が ${hole.count} 件ある: 期間 ${formatTimestamp(hole.first)}〜${formatTimestamp(hole.last)})`, "");
    }
    const span = `(${formatTimestamp(entry.startTime)} ~ ${formatTimestamp(entry.endTime)})`;
    const isFragment = entry.page.metadata.digest_origin === "identity";
    hasFragment ||= isFragment;
    lines.push(`### 材料 ${index + 1} ${isFragment ? "【生ログ断片】" : "【あらすじ】"} ${span}`, entry.content, "");
  }

  const parts = [`以下の${entries.length}個の材料を統合し、一段粗い視点の「まとめのあらすじ」を書いてください。`, ""];
  if (context) parts.push("## さらに前の出来事（参考）", context, "");
  parts.push(
    "## 統合対象の材料",
    lines.join("\n"),
    "",
    "## 指示",
    "- 5〜8文程度で、全体の流れを俯瞰できるようにまとめる",
    "- 重要な転換点や印象的なエピソードを保持する",
    "- 個々の詳細より「どんな時期だったか」を重視する",
    "- 時系列順に書く",
  );
  if (hasFragment) parts.push("- 【生ログ断片】は要約前の会話の断片です。前後のあらすじの流れに自然に織り込んでください（無視しない・そのまま引用しない）");
  if (hasHole) parts.push("- 材料の間に、記録されていない期間があります。その前後を地続きの出来事として繋げないでください");
  parts.push(
    "- **前置き（「以下にまとめます」等）や見出し（「【あらすじ】」等）は書かないでください**（本文のみ出力）",
    "",
    "統合されたあらすじを日本語で書いてください。",
  );
  return parts.join("\n");
}

/**
 * body: bands.py `run_band_overflow`. A failed consolidation loses nothing (the
 * level 1 entries stand) and does not fail the Metabolism; the next run plans it
 * again. Returns how many parents were written, and whether one failed.
 */
export async function runBandOverflow(repository: LiteRepository, personaId: string, llm: AuxiliaryLlm): Promise<{ created: number; failed: boolean }> {
  let created = 0;
  while (created < MAX_CONSOLIDATIONS_PER_CALL) {
    const pages = await repository.listPages(personaId, CATEGORY_CHRONICLE);
    const fold = firstFold(loadRows(chronicleEntries(pages)));
    if (!fold) return { created, failed: false };
    const entries = fold.items.map((item) => item.entry);
    let content: string;
    try {
      const prompt = await buildConsolidationPrompt(repository, personaId, entries, pages);
      content = await generateTextWithEmptyRetry(llm, prompt, "上位のあらすじの生成");
    } catch (error) {
      console.error("[SAIVerse Lite][chronicle] consolidation failed", { level: fold.level, entries: entries.length, error });
      return { created, failed: true };
    }
    const starts = entries.flatMap((entry) => entry.startTime ?? []);
    const ends = entries.flatMap((entry) => entry.endTime ?? []);
    const parent = await draftEntryPage(repository, personaId, pages, {
      level: fold.level + 1,
      content,
      sourceIds: entries.map((entry) => entry.id),
      startTime: starts.length > 0 ? Math.min(...starts) : null,
      endTime: ends.length > 0 ? Math.max(...ends) : null,
      sourceCount: entries.length,
      messageCount: entries.reduce((sum, entry) => sum + entry.messageCount, 0),
      extraMetadata: { digest_origin: "band", coverage_chars: entries.reduce((sum, entry) => sum + coverageChars(entry), 0) },
    });
    const children = entries.map((entry): PageRecord => ({
      ...entry.page,
      parentId: parent.id,
      metadata: { ...entry.page.metadata, is_consolidated: 1 },
    }));
    await repository.writePersonaRecords(personaId, { pages: [parent, ...children] });
    created += 1;
  }
  return { created, failed: false };
}

// `newId` stays the id source for rows; Chronicle pages use bare UUIDs as the body does.
export type { ChronicleEntry };
export { isMechanismRow, newId };
