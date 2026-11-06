import type { PageRecord } from "../domain";
import { CATEGORY_CHRONICLE } from "../pageRecords";

/** One row of the body's `arasuji_entries` view (sai_memory/arasuji/storage.py `_COMPAT_VIEW_SQL`). */
export interface ChronicleEntry {
  id: string;
  level: number;
  content: string;
  /** Message ids at level 1, child entry ids above it. */
  sourceIds: string[];
  startTime: number | null;
  endTime: number | null;
  sourceCount: number;
  messageCount: number;
  parentId: string | null;
  isConsolidated: boolean;
  createdAt: number;
  originTrackId: string | null;
  isIncomplete: boolean;
  shortId: number | null;
  page: PageRecord;
}

function intOf(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? Math.trunc(number) : null;
}

export function chronicleEntry(page: PageRecord): ChronicleEntry | null {
  if (page.category !== CATEGORY_CHRONICLE || page.isTrunk || page.isDeleted) return null;
  const level = intOf(page.metadata.level);
  if (level === null) return null;
  const sources = page.metadata.source_ids;
  const origin = page.metadata.origin_track_id;
  return {
    id: page.id,
    level,
    content: page.content,
    sourceIds: Array.isArray(sources) ? sources.map(String) : [],
    startTime: intOf(page.metadata.start_time),
    endTime: intOf(page.metadata.end_time),
    sourceCount: intOf(page.metadata.source_count) ?? 0,
    messageCount: intOf(page.metadata.message_count) ?? 0,
    parentId: page.parentId === "root_chronicle" ? null : page.parentId,
    isConsolidated: Boolean(intOf(page.metadata.is_consolidated)),
    createdAt: page.createdAt,
    originTrackId: typeof origin === "string" && origin ? origin : null,
    isIncomplete: Boolean(intOf(page.metadata.is_incomplete)),
    shortId: intOf(page.metadata.short_id),
    page,
  };
}

export function chronicleEntries(pages: PageRecord[]): ChronicleEntry[] {
  return pages.flatMap((page) => chronicleEntry(page) ?? []);
}

/** body: `SELECT json_each.value FROM arasuji_entries ... WHERE level = 1`. */
export function coveredMessageIds(entries: ChronicleEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.level === 1).flatMap((entry) => entry.sourceIds));
}

/** body: sai_memory/arasuji/bands.py `_coverage_index`. */
export function coverageChars(entry: ChronicleEntry): number {
  return intOf(entry.page.metadata.coverage_chars) ?? entry.content.length * 10;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local date, as the body's `datetime.fromtimestamp(ts).strftime("%Y-%m-%d")`. */
export function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** body: `_format_timestamp`, "%Y-%m-%d %H:%M" in local time, "?" when absent. */
export function formatTimestamp(seconds: number | null): string {
  if (seconds === null) return "?";
  const date = new Date(seconds * 1000);
  return `${formatDate(seconds)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatTimestampSeconds(seconds: number): string {
  return `${formatTimestamp(seconds)}:${pad(new Date(seconds * 1000).getSeconds())}`;
}
