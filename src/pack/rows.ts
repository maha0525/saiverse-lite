import type { ChatMessage, ConversationThread, FragmentRecord, MessageRole, PageRecord } from "../domain";
import { decodeJsonColumn, decodeText, encodeValue, epochToIso, isObject, packTimeToMilliseconds, packTimeToSeconds } from "./format";

type PackRow = Record<string, unknown>;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : decodeText(value);
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** `source` keeps the column as it came. A scalar or an array has no place in a Record, so it stays only there. */
function metadataRecord(value: unknown): Record<string, unknown> {
  const decoded = decodeJsonColumn(value);
  return isObject(decoded) ? decoded : {};
}

/** body: adapter.py _payload_from_message_locked reads role "model" as assistant. */
function messageRole(value: unknown): MessageRole {
  const role = decodeText(value);
  return (role === "model" ? "assistant" : role) as MessageRole;
}

/** `ordinal` is the row's place in messages.json, used for a pack written without `seq`. */
export function messageFromRow(row: PackRow, personaId: string, ordinal: number): ChatMessage {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    personaId,
    role: messageRole(row.role),
    content: decodeText(row.content),
    createdAt: packTimeToMilliseconds(row.created_at) ?? 0,
    seq: integer(row.seq) ?? ordinal,
    editedAt: null,
    scope: text(row.scope),
    lineRole: text(row.line_role),
    pulseId: text(row.pulse_id),
    pairedActionText: text(row.paired_action_text),
    metadata: metadataRecord(row.metadata),
    source: row,
  };
}

function keywords(value: unknown): string[] {
  const decoded = decodeJsonColumn(value);
  return Array.isArray(decoded) ? decoded.filter((item): item is string => typeof item === "string") : [];
}

export function pageFromRow(row: PackRow, personaId: string): PageRecord {
  return {
    id: String(row.id),
    personaId,
    parentId: text(row.parent_id),
    title: decodeText(row.title),
    summary: decodeText(row.summary),
    content: decodeText(row.content),
    category: String(row.category),
    createdAt: packTimeToSeconds(row.created_at) ?? 0,
    updatedAt: packTimeToSeconds(row.updated_at) ?? 0,
    keywords: keywords(row.keywords),
    metadata: metadataRecord(row.metadata),
    isDeleted: Boolean(row.is_deleted),
    vividness: text(row.vividness),
    isTrunk: Boolean(row.is_trunk),
    isImportant: Boolean(row.is_important),
    lastReferencedAt: packTimeToSeconds(row.last_referenced_at),
    shortId: integer(row.short_id),
    source: row,
  };
}

export function fragmentFromRow(row: PackRow, personaId: string): FragmentRecord {
  return {
    id: String(row.id),
    personaId,
    content: decodeText(row.content),
    entityId: String(row.entity_id),
    chronicleEntryId: text(row.chronicle_entry_id),
    vividness: text(row.vividness),
    sourceDate: text(row.source_date),
    createdAt: packTimeToSeconds(row.created_at) ?? 0,
    source: row,
  };
}

/** body: chatgpt_compat.py write_conversation. The stored title, else the part after the persona id. */
function threadTitle(id: string, title: string | null): string {
  return title || (id.includes(":") ? id.slice(id.indexOf(":") + 1) : id);
}

export interface ThreadSpan {
  firstMs: number;
  lastMs: number;
}

// The writing direction. A row with `source` keeps it as it came, so wrappers and columns Lite
// does not read survive; a column is replaced only when the record differs from what the
// reader above makes of `source`. A row without `source` is written whole, in the body's shape.

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((byte, index) => byte === b[index]);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameValue(a[key], b[key]));
}

type Column<Stored> = readonly [field: keyof Stored, column: string, encode?: (value: unknown) => unknown];

const flag = (value: unknown): number => (value ? 1 : 0);
const isoTime = (value: unknown): string | null => (typeof value === "number" ? epochToIso(value) : null);

function changedColumns<Stored>(record: Stored, read: Stored, source: PackRow, columns: readonly Column<Stored>[]): PackRow {
  const row = { ...source };
  for (const [field, column, encode] of columns) {
    if (!sameValue(record[field], read[field])) row[column] = encode ? encode(record[field]) : record[field];
  }
  return row;
}

function allColumns<Stored>(record: Stored, columns: readonly Column<Stored>[]): PackRow {
  return Object.fromEntries(columns.map(([field, column, encode]) => [column, encode ? encode(record[field]) : record[field]]));
}

/** What Lite can change on a message that came from a pack. */
const MESSAGE_COLUMNS: readonly Column<ChatMessage>[] = [
  ["role", "role"],
  ["content", "content"],
  ["metadata", "metadata", encodeValue],
  ["lineRole", "line_role"],
  ["scope", "scope"],
  ["pairedActionText", "paired_action_text"],
  ["pulseId", "pulse_id"],
];

/** The body's recall asks for the conversation tag. Lite saves a spoken row without any tag. */
function metadataWithConversationTag({ role, metadata }: ChatMessage): Record<string, unknown> {
  const spoken = role === "user" || role === "assistant";
  return spoken && !(Array.isArray(metadata.tags) && metadata.tags.length) ? { ...metadata, tags: ["conversation"] } : metadata;
}

/** `threadId` is the row's thread as `threadRowId` writes it. */
export function messageToRow(message: ChatMessage, threadId: string): PackRow {
  if (message.source) return changedColumns(message, messageFromRow(message.source, message.personaId, 0), message.source, MESSAGE_COLUMNS);
  return {
    id: message.id,
    thread_id: threadId,
    role: message.role,
    content: message.content,
    resource_id: message.personaId,
    // messages.created_at is whole seconds in the body; `seq` keeps the order inside one second.
    created_at: epochToIso(Math.floor(message.createdAt / 1000)),
    metadata: encodeValue(metadataWithConversationTag(message)),
    origin_track_id: null,
    line_role: message.lineRole,
    line_id: null,
    // messages.scope is NOT NULL.
    scope: message.scope ?? "committed",
    paired_action_text: message.pairedActionText,
    pulse_id: message.pulseId,
    thought_signature: null,
    spell_origin_id: null,
    spell_seq: null,
    origin_episode: null,
    seq: message.seq,
  };
}

const PAGE_COLUMNS: readonly Column<PageRecord>[] = [
  ["id", "id"],
  ["parentId", "parent_id"],
  ["title", "title"],
  ["summary", "summary"],
  ["content", "content"],
  ["category", "category"],
  ["createdAt", "created_at", isoTime],
  ["updatedAt", "updated_at", isoTime],
  ["keywords", "keywords", encodeValue],
  ["metadata", "metadata", encodeValue],
  ["isDeleted", "is_deleted", flag],
  ["vividness", "vividness"],
  ["isTrunk", "is_trunk", flag],
  ["isImportant", "is_important", flag],
  ["lastReferencedAt", "last_referenced_at", isoTime],
  ["shortId", "short_id"],
];

export function pageToRow(page: PageRecord): PackRow {
  return page.source ? changedColumns(page, pageFromRow(page.source, page.personaId), page.source, PAGE_COLUMNS) : allColumns(page, PAGE_COLUMNS);
}

/** extensions/saiverse/ holds the database values as they are, so created_at stays epoch seconds. */
const FRAGMENT_COLUMNS: readonly Column<FragmentRecord>[] = [
  ["id", "id"],
  ["content", "content"],
  ["entityId", "entity_id"],
  ["chronicleEntryId", "chronicle_entry_id"],
  ["vividness", "vividness"],
  ["sourceDate", "source_date"],
  ["createdAt", "created_at"],
];

export function fragmentToRow(fragment: FragmentRecord): PackRow {
  return fragment.source ? changedColumns(fragment, fragmentFromRow(fragment.source, fragment.personaId), fragment.source, FRAGMENT_COLUMNS) : allColumns(fragment, FRAGMENT_COLUMNS);
}

/** body: threads are `<persona_id>:<suffix>`. A thread Lite made has a bare id until it is written. */
export function threadRowId(threadId: string, personaId: string): string {
  return threadId.includes(":") ? threadId : `${personaId}:${threadId}`;
}

/** body: active_state.json holds the part after the persona id (adapter.py set_active_thread). */
export function threadSuffix(threadId: string): string {
  return threadId.includes(":") ? threadId.slice(threadId.indexOf(":") + 1) : threadId;
}

/** The chatlog/threads.json row of a thread. Null for a Stelis thread that has none. */
export function threadToRow(thread: ConversationThread): PackRow | null {
  const { source } = thread;
  if (!source) return { id: threadRowId(thread.id, thread.personaId), resource_id: thread.personaId, overview: null, overview_updated_at: null, title: thread.title };
  if (source.id === undefined) return null;
  // A Stelis thread's title can come from its other row, and Lite never renames one.
  if (thread.stelis || thread.title === threadTitle(thread.id, text(source.title))) return source;
  return { ...source, title: thread.title };
}

/** The chatlog/stelis_threads.json row of a thread, for a pack made without the original ZIP. */
export function stelisThreadToRow(thread: ConversationThread): PackRow {
  if (thread.source?.thread_id !== undefined) return thread.source;
  return { thread_id: thread.id, parent_thread_id: null, depth: 0, window_ratio: 0.8, status: "completed", chronicle_prompt: null, chronicle_summary: null, created_at: epochToIso(Math.floor(thread.createdAt / 1000)), completed_at: null, label: thread.title };
}

export function threadFromRows(
  id: string,
  personaId: string,
  threadRow: PackRow | undefined,
  stelisRow: PackRow | undefined,
  span: ThreadSpan | undefined,
  fallbackMs: number,
): ConversationThread {
  const createdAt = span?.firstMs ?? packTimeToMilliseconds(stelisRow?.created_at) ?? packTimeToMilliseconds(threadRow?.overview_updated_at) ?? fallbackMs;
  const thread: ConversationThread = {
    id,
    personaId,
    title: threadTitle(id, text(threadRow?.title) ?? text(stelisRow?.label)),
    createdAt,
    updatedAt: span?.lastMs ?? createdAt,
    source: threadRow ?? stelisRow ?? null,
  };
  if (stelisRow) thread.stelis = true;
  return thread;
}
