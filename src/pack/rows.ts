import type { ChatMessage, ConversationThread, FragmentRecord, MessageRole, PageRecord } from "../domain";
import { decodeText, isObject, packTimeToMilliseconds, packTimeToSeconds } from "./format";

type PackRow = Record<string, unknown>;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : decodeText(value);
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** The stored JSON stays wrapped as it came. An array has no place in a Record; `source` keeps it. */
function metadataRecord(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
