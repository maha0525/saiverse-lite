import type { ChatMessage, MessagePosition } from "../domain";
import { CATEGORY_CHRONICLE } from "../pageRecords";
import type { LiteRepository } from "../storage/repository";
import { composeMessages } from "./conversation";
import { chronicleEntries, coveredMessageIds } from "./entries";
import { PASSPHRASE_LENGTH } from "./notices";

// body: saiverse/model_configs.py BUILTIN_METABOLISM_*_CHARS and sai_memory/arasuji/alignment.py DEFAULT_TARGET_CHARS.
export const METABOLISM_HIGH_CHARS = 60_000;
export const METABOLISM_TARGET_CHARS = 20_000;
export const CHRONICLE_UNIT_CHARS = 10_000;

const READ_BATCH = 500;

// body: sai_memory/memory/storage.py MECHANISM_TAGS, CHRONICLE_EXCLUDED_LINE_ROLES.
const MECHANISM_TAGS = new Set(["handy_tool", "spell", "event_message"]);
const CHRONICLE_EXCLUDED_LINE_ROLES = new Set(["sub_line", "meta_judgment", "nested"]);

// body: sai_memory/arasuji/generator.py.
const MECHANISM_TEXT_MAX_CHARS = 500;
const CONDENSE_HEAD_CHARS = 40;

/** Only its length shows in a count: the tag holds it, and redacting keeps the length of a text. */
const MEASURING_PASSPHRASE = "*".repeat(PASSPHRASE_LENGTH);

export function messageTags(message: ChatMessage): string[] {
  const tags = message.metadata.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}

/** body: sea/eviction_plan.py `is_mechanism_row`. */
export function isMechanismRow(message: ChatMessage): boolean {
  return messageTags(message).some((tag) => MECHANISM_TAGS.has(tag));
}

/**
 * body: saiverse_memory/adapter.py `_payload_passes_context_filter` with
 * required_line_roles=["main_line"], required_scopes=["committed"]. Blank
 * assistant rows are dropped on top of that: some providers reject empty turns.
 */
export function isPresentedRow(message: ChatMessage): boolean {
  const role = message.lineRole ?? "main_line";
  const scope = message.scope ?? "committed";
  if (scope !== "committed" || (role !== "main_line" && role !== "meta_judgment")) return false;
  return message.role !== "assistant" || message.content.trim() !== "";
}

/** body: sai_memory/memory/storage.py `chronicle_eligibility_filter`, minus the Stelis check the caller makes. */
export function isChronicleEligible(message: ChatMessage): boolean {
  const scope = message.scope ?? "committed";
  return scope === "committed" && !(message.lineRole !== null && CHRONICLE_EXCLUDED_LINE_ROLES.has(message.lineRole));
}

/**
 * The quantity the kept amount is compared with. Mechanism rows are sent but are not
 * conversation, and neither is a row's pairedActionText, which goes out as its own notice.
 */
export function conversationLength(message: ChatMessage): number {
  return isMechanismRow(message) ? 0 : message.content.length;
}

/**
 * What `composeMessages` sends for these rows, the quantity the limit is compared with. The
 * time and auto recall at the end change every turn and are not rows, so they do not count.
 */
export function totalChars(rows: ChatMessage[]): number {
  return composeMessages(rows, MEASURING_PASSPHRASE, []).reduce((sum, message) => sum + message.content.length, 0);
}

export function conversationChars(rows: ChatMessage[]): number {
  return rows.reduce((sum, row) => sum + conversationLength(row), 0);
}

/** body: sai_memory/memory/storage.py `is_author_unsettled`. */
export function isAuthorUnsettled(message: ChatMessage): boolean {
  return (message.metadata.__system_notice_review__ ?? null) !== null
    || message.metadata.__system_notice_reviewed__ === "keep";
}

function condenseMechanismText(text: string): string {
  const firstLine = text.trim().split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  const total = text.length.toLocaleString("en-US");
  const named = /^\[([^[\]\n]{1,120})\]/.exec(firstLine);
  if (named) return `[${named[1]}] を受け取った (${total} 字)`;
  const head = firstLine.slice(0, CONDENSE_HEAD_CHARS);
  return `${head}${firstLine.length > CONDENSE_HEAD_CHARS ? "…" : ""} (${total} 字)`;
}

/** body: sai_memory/arasuji/generator.py `material_text_for`. */
export function materialText(message: ChatMessage): string {
  if (isAuthorUnsettled(message)) return "";
  return isMechanismRow(message) && message.content.length > MECHANISM_TEXT_MAX_CHARS
    ? condenseMechanismText(message.content)
    : message.content;
}

export function materialChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => sum + materialText(message).length, 0);
}

export async function* walkThread(
  repository: LiteRepository,
  threadId: string,
  direction: "forward" | "backward",
  start?: MessagePosition,
  includeStart = false,
): AsyncGenerator<ChatMessage> {
  let cursor = start;
  let inclusive = includeStart;
  for (;;) {
    const batch = await repository.readThreadMessages(threadId, {
      direction,
      limit: READ_BATCH,
      includeStart: inclusive,
      ...(cursor ? { start: cursor } : {}),
    });
    yield* batch;
    const last = batch.at(-1);
    if (!last || batch.length < READ_BATCH) return;
    cursor = last;
    inclusive = false;
  }
}

/** The presented rows from the anchor on, oldest first. Empty when the anchor row is gone or in another thread. */
export async function readWindow(repository: LiteRepository, threadId: string, anchorMessageId: string): Promise<ChatMessage[]> {
  const anchor = await repository.getMessage(anchorMessageId);
  if (!anchor || anchor.threadId !== threadId) return [];
  const rows: ChatMessage[] = [];
  for await (const row of walkThread(repository, threadId, "forward", anchor, true)) {
    if (isPresentedRow(row)) rows.push(row);
  }
  return rows;
}

/**
 * Walks older rows until the conversation reaches `needed` chars, finishing the
 * pulse it stopped in so a tool result is never left without its utterance.
 * body: sea/session_lifecycle.py `_apply_window_floor_once` reading through
 * `get_history_before_anchor`.
 */
async function olderRowReaching(
  repository: LiteRepository,
  threadId: string,
  start: MessagePosition | undefined,
  needed: number,
): Promise<ChatMessage | null> {
  let reached: ChatMessage | null = null;
  let chars = 0;
  for await (const row of walkThread(repository, threadId, "backward", start)) {
    if (!isPresentedRow(row)) continue;
    if (chars >= needed && (reached?.pulseId === null || row.pulseId !== reached?.pulseId)) break;
    reached = row;
    chars += conversationLength(row);
  }
  return reached;
}

/**
 * The anchor a window should use so its conversation rows are not below the kept
 * amount (arasuji_levels.md §15-5). Returns `anchorMessageId` when nothing older
 * is needed or available.
 */
export async function windowFloorAnchor(
  repository: LiteRepository,
  threadId: string,
  anchorMessageId: string,
  rows: ChatMessage[],
): Promise<string> {
  const missing = METABOLISM_TARGET_CHARS - conversationChars(rows);
  if (missing <= 0) return anchorMessageId;
  const anchor = await repository.getMessage(anchorMessageId);
  if (!anchor) return anchorMessageId;
  const older = await olderRowReaching(repository, threadId, anchor, missing);
  return older?.id ?? anchorMessageId;
}

/**
 * Where the conversation starts when the session has no anchor: right after
 * import, or after the active thread changed (docs/memory_core.md). The oldest
 * presented row of the active thread that no level 1 entry covers, or, when all
 * are covered, the row where the kept amount is reached from the newest side;
 * then the same floor every window gets.
 */
export async function resolveInitialAnchor(repository: LiteRepository, personaId: string): Promise<string | null> {
  const session = await repository.getSession(personaId);
  const threadId = session?.activeThreadId;
  if (!threadId) return null;
  const covered = coveredMessageIds(chronicleEntries(await repository.listPages(personaId, CATEGORY_CHRONICLE)));

  // Only the uncompiled tail. Rows left uncompiled before a covered row were
  // already outside the window on the body, and starting there resends everything
  // compiled after them.
  let firstUncovered: ChatMessage | null = null;
  for await (const row of walkThread(repository, threadId, "backward")) {
    if (!isPresentedRow(row) || !isChronicleEligible(row)) continue;
    if (covered.has(row.id)) break;
    firstUncovered = row;
  }
  if (!firstUncovered) {
    const fromNewest = await olderRowReaching(repository, threadId, undefined, METABOLISM_TARGET_CHARS);
    return fromNewest?.id ?? null;
  }
  const rows = await readWindow(repository, threadId, firstUncovered.id);
  return windowFloorAnchor(repository, threadId, firstUncovered.id, rows);
}

/** body: sea/session_lifecycle.py `maybe_run_metabolism`. */
export function windowNeedsMetabolism(rows: ChatMessage[]): boolean {
  return totalChars(rows) > METABOLISM_HIGH_CHARS && conversationChars(rows) > METABOLISM_TARGET_CHARS;
}
