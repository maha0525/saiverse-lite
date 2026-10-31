import { HANDY_TOOL_NOTICE, SYSTEM_NOTICE_KEY, type ChatMessage, type MessagePosition } from "./domain";
import { imageEntries } from "./memory/conversation";
import { isPresentedRow } from "./memory/window";
import type { LiteRepository } from "./storage/repository";

/** The rows one read puts on the chat screen. A thread can hold tens of thousands. */
export const MESSAGE_PAGE_ROWS = 100;
const DELETE_BATCH = 500;

export interface ConversationPage {
  /** Oldest first. */
  rows: ChatMessage[];
  hasOlder: boolean;
}

async function readBackward(repository: LiteRepository, threadId: string, limit: number, start?: MessagePosition): Promise<ConversationPage> {
  const rows = await repository.readThreadMessages(threadId, { direction: "backward", limit: limit + 1, ...(start ? { start } : {}) });
  return { rows: rows.slice(0, limit).reverse(), hasOlder: rows.length > limit };
}

export function readLatestRows(repository: LiteRepository, threadId: string, limit = MESSAGE_PAGE_ROWS): Promise<ConversationPage> {
  return readBackward(repository, threadId, limit);
}

export function readOlderRows(repository: LiteRepository, threadId: string, oldest: MessagePosition, limit = MESSAGE_PAGE_ROWS): Promise<ConversationPage> {
  return readBackward(repository, threadId, limit, oldest);
}

export async function hasRowsAfter(repository: LiteRepository, message: ChatMessage): Promise<boolean> {
  const rows = await repository.readThreadMessages(message.threadId, { direction: "forward", limit: 1, start: message });
  return rows.length > 0;
}

/** Deletes every row after `message` in its thread, in pages so a long thread does not load at once. */
export async function deleteRowsAfter(repository: LiteRepository, message: ChatMessage): Promise<number> {
  let deleted = 0;
  for (;;) {
    const batch = await repository.readThreadMessages(message.threadId, { direction: "forward", limit: DELETE_BATCH, start: message });
    for (const row of batch) await repository.deleteMessage(row.id);
    deleted += batch.length;
    if (batch.length < DELETE_BATCH) return deleted;
  }
}

export function hasRowImage(message: ChatMessage): boolean {
  return typeof message.metadata.imageDataUrl === "string" || imageEntries(message.metadata).length > 0;
}

export type RowDisplay = "bubble" | "notice" | "hidden";

/**
 * How the chat screen shows a row. system and host rows are notices. So are the
 * user and assistant rows outside the presented conversation (`lineRole` sub_line
 * and the like), which never were part of the talk. Empty rows show nothing.
 */
export function rowDisplay(message: ChatMessage): RowDisplay {
  const blank = message.content.trim() === "";
  if (blank && message.role !== "user" && !hasRowImage(message)) return "hidden";
  if (message.role === "system" || message.role === "host") return "notice";
  return blank || isPresentedRow(message) ? "bubble" : "notice";
}

const HANDY_TOOL_SUMMARIES: Record<string, string> = {
  memory_recall: "記憶を確認しました",
  memory_read: "記憶を読みました",
  memory_write: "記憶に書きました",
  image_generate: "画像を生成しました",
};

export function noticeSummary(message: ChatMessage): string {
  if (message.role === "user" || message.role === "assistant") return "会話の外の記録";
  if (message.metadata[SYSTEM_NOTICE_KEY] === HANDY_TOOL_NOTICE) {
    const tool = /^\[Handy Tool: ([^\]\n]+)\]/.exec(message.content)?.[1];
    return (tool && HANDY_TOOL_SUMMARIES[tool]) || "ツールを使いました";
  }
  return message.role === "host" ? "通知" : "システムの記録";
}

export function isRegenerable(message: ChatMessage): boolean {
  return message.role === "assistant" && message.content.trim() !== "";
}
