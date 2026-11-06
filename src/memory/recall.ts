import type { ChatMessage, PageRecord, PersonaSession, RecallLedgerItem } from "../domain";
import type { LiteRepository } from "../storage/repository";
import { isMemopediaPage } from "./memopedia";
import { isMechanismRow } from "./window";

// The entity trigger of the body's sea/auto_recall.py, the only recall path Lite
// has: a Memopedia page surfaces when its title appears in the user's last message.
// The notice is not stored, so a page keeps being sent while it is in the ledger,
// and leaves STICKY_TURNS turns after its title last appeared.

// body: get_sticky_turns, get_entity_ambient_count, _ENTITY_TITLE_MIN_LEN, _format_line.
const STICKY_TURNS = 3;
const ENTITY_AMBIENT_COUNT = 3;
const ENTITY_TITLE_MIN_LEN = 2;
const LINE_CONTENT_MAX_CHARS = 160;

function countOccurrences(text: string, title: string): number {
  return title ? text.split(title).length - 1 : 0;
}

function isConversationRow(row: ChatMessage): boolean {
  return (row.role === "user" || row.role === "assistant") && !isMechanismRow(row) && row.content.trim() !== "";
}

/** body: `_find_entity_triggers`. */
function triggeredPages(pages: PageRecord[], rows: ChatMessage[]): { userRow: ChatMessage | null; triggered: PageRecord[] } {
  const conversation = rows.filter(isConversationRow);
  const userRow = conversation.filter((row) => row.role === "user").at(-1) ?? null;
  if (!userRow) return { userRow, triggered: [] };
  const ambient = conversation.filter((row) => row !== userRow).map((row) => row.content.trim()).join("\n");
  const triggered = pages.filter(isMemopediaPage).filter((page) => {
    const title = page.title.trim();
    return title.length >= ENTITY_TITLE_MIN_LEN
      && userRow.content.includes(title)
      && countOccurrences(ambient, title) < ENTITY_AMBIENT_COUNT;
  });
  return { userRow, triggered };
}

function formatLine(page: PageRecord): string {
  const reference = page.shortId !== null ? `${page.title} (memopedia:${page.shortId})` : page.title;
  const body = page.summary.trim().replace(/\n/g, " ");
  const clipped = body.length > LINE_CONTENT_MAX_CHARS ? `${body.slice(0, LINE_CONTENT_MAX_CHARS)}…` : body;
  return `- [Memopedia: ${reference}] ${clipped}`;
}

function nextLedger(ledger: RecallLedgerItem[], triggered: PageRecord[], userRow: ChatMessage): RecallLedgerItem[] {
  const triggeredIds = new Set(triggered.map((page) => page.id));
  const kept = ledger.flatMap((item) => {
    if (triggeredIds.has(item.pageId)) return [{ ...item, staleTurns: 0 }];
    return item.staleTurns + 1 > STICKY_TURNS ? [] : [{ ...item, staleTurns: item.staleTurns + 1 }];
  });
  const known = new Set(kept.map((item) => item.pageId));
  const added = triggered
    .filter((page) => !known.has(page.id))
    .map((page): RecallLedgerItem => ({ pageId: page.id, staleTurns: 0, messageId: userRow.id }));
  return [...kept, ...added];
}

/**
 * One turn of auto recall. Returns the notice body, or null. The ledger is the only
 * thing written; the notice itself is never stored.
 */
export async function runAutoRecall(
  repository: LiteRepository,
  session: PersonaSession,
  threadId: string,
  rows: ChatMessage[],
): Promise<string | null> {
  const pages = await repository.listPages(session.personaId);
  const { userRow, triggered } = triggeredPages(pages, rows);
  if (!userRow) return null;
  const previous = session.recallLedger?.[threadId] ?? [];
  const ledger = nextLedger(previous, triggered, userRow);
  await repository.updateSession(session.personaId, (current) => ({
    ...current,
    recallLedger: { ...current.recallLedger, [threadId]: ledger },
  }));
  const byId = new Map(pages.map((page) => [page.id, page]));
  const lines = [...ledger]
    .sort((a, b) => a.staleTurns - b.staleTurns)
    .flatMap((item) => {
      const page = byId.get(item.pageId);
      return page ? [formatLine(page)] : [];
    });
  if (lines.length === 0) return null;
  return ["ふと浮かんだ記憶:", ...lines, "（深掘り用ツール: memory_read）"].join("\n");
}
