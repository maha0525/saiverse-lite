import {
  compareMessagePosition,
  handyToolRecord,
  isRetiredAutomaticSummary,
  type ChatMessage,
  type ConversationThread,
  type MemoryEntry,
  type PageRecord,
  type Persona,
  type PersonaSession,
} from "../domain";
import {
  buildCoreMemoryPages,
  createPersonaSession,
  createTrunkPages,
  epochSeconds,
  type CoreMemoryDraft,
} from "../pageRecords";

/** Message row as database v1 and `saiverse_lite_backup_v1` hold it. */
export interface LegacyChatMessage {
  id: string;
  threadId: string;
  personaId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: number;
  editedAt: number | null;
  toolCallId: string | null;
  toolName: string | null;
  metadata: Record<string, unknown>;
}

export function upgradeLegacyMessage(row: LegacyChatMessage, seq: number): ChatMessage {
  const { tool_calls: _toolCalls, lite_provider_state: _providerState, ...metadata } = row.metadata ?? {};
  const message: ChatMessage = {
    id: row.id,
    threadId: row.threadId,
    personaId: row.personaId,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    // A row outside the createdAt index would stay invisible to every range read.
    createdAt: Number.isFinite(row.createdAt) ? row.createdAt : 0,
    seq,
    editedAt: row.editedAt ?? null,
    scope: "committed",
    lineRole: null,
    pulseId: null,
    pairedActionText: null,
    metadata,
    source: null,
  };
  return row.role === "tool"
    ? { ...message, ...handyToolRecord(row.toolName ?? "tool", row.content, metadata) }
    : message;
}

export function compareLegacyMessages(a: LegacyChatMessage, b: LegacyChatMessage): number {
  return compareMessagePosition({ createdAt: a.createdAt, seq: 0, id: a.id }, { createdAt: b.createdAt, seq: 0, id: b.id });
}

/** Oldest first, so c:1 is the first memo the persona was given. Retired summaries are left out. */
export function coreDraftsFromMemories(memories: MemoryEntry[]): CoreMemoryDraft[] {
  return memories
    .filter((memory) => !isRetiredAutomaticSummary(memory))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((memory) => ({
      id: memory.id,
      content: memory.content,
      createdAt: epochSeconds(memory.createdAt),
      updatedAt: epochSeconds(memory.updatedAt),
      metadata: {
        ...(memory.threadId ? { lite_thread_id: memory.threadId } : {}),
        ...(memory.sourceMessageIds.length > 0 ? { source_message_ids: memory.sourceMessageIds } : {}),
      },
    }));
}

/** Trunk pages, core memories, and the session a v1 persona starts v2 with. */
export function upgradeLegacyPersona(
  personaId: string,
  threads: ConversationThread[],
  memories: MemoryEntry[],
  nowSeconds: number,
): { pages: PageRecord[]; session: PersonaSession } {
  const trunks = createTrunkPages(personaId, nowSeconds);
  const firstShortId = Math.max(...trunks.map((page) => page.shortId ?? 0)) + 1;
  const core = buildCoreMemoryPages(personaId, trunks, firstShortId, coreDraftsFromMemories(memories), nowSeconds);
  const latest = threads.reduce<ConversationThread | null>(
    (best, thread) => (best === null || thread.updatedAt > best.updatedAt ? thread : best),
    null,
  );
  return { pages: [...trunks, ...core], session: createPersonaSession(personaId, latest?.id ?? null) };
}

export interface UpgradedLegacyRecords {
  messages: ChatMessage[];
  pages: PageRecord[];
  sessions: PersonaSession[];
}

/** The same conversion the database migration applies, for records already in memory. */
export function upgradeLegacyRecords(
  personas: Persona[],
  threads: ConversationThread[],
  messages: LegacyChatMessage[],
  memories: MemoryEntry[],
  nowSeconds: number,
): UpgradedLegacyRecords {
  const seqByPersona = new Map<string, number>();
  const upgraded = [...messages].sort(compareLegacyMessages).map((row) => {
    const seq = (seqByPersona.get(row.personaId) ?? 0) + 1;
    seqByPersona.set(row.personaId, seq);
    return upgradeLegacyMessage(row, seq);
  });
  const pages: PageRecord[] = [];
  const sessions: PersonaSession[] = [];
  for (const persona of personas) {
    const record = upgradeLegacyPersona(
      persona.id,
      threads.filter((thread) => thread.personaId === persona.id),
      memories.filter((memory) => memory.personaId === persona.id),
      nowSeconds,
    );
    pages.push(...record.pages);
    sessions.push(record.session);
  }
  return { messages: upgraded, pages, sessions };
}
