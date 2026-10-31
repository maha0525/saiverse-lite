import type {
  AppSettings,
  ChatMessage,
  ConversationThread,
  FragmentRecord,
  MessagePosition,
  PageRecord,
  Persona,
  PersonaSession,
  ProviderConfig,
  RepositorySnapshot,
} from "../domain";
import type { CoreMemoryDraft } from "../pageRecords";

/** A walk over messages in (createdAt, seq, id) order. Rows come back in walking order. */
export interface MessageRange {
  direction: "forward" | "backward";
  limit: number;
  /** Omitted: the oldest row (forward) or the newest row (backward). */
  start?: MessagePosition;
  /** Off by default, so the last row of one page can start the next page. */
  includeStart?: boolean;
}

/** Rows written to one persona in one transaction. */
export interface PersonaRecordBatch {
  threads?: ConversationThread[];
  messages?: ChatMessage[];
  pages?: PageRecord[];
  fragments?: FragmentRecord[];
  /** Applied to the persona's session in the same transaction. Runs synchronously. */
  session?: (session: PersonaSession) => PersonaSession;
}

export function assertBatchOwner(personaId: string, batch: PersonaRecordBatch): void {
  const rows = [...(batch.threads ?? []), ...(batch.messages ?? []), ...(batch.pages ?? []), ...(batch.fragments ?? [])];
  const stray = rows.find((row) => row.personaId !== personaId);
  if (stray) throw new Error(`Batch for ${personaId} holds a row of ${stray.personaId}: ${stray.id}`);
}

/** Threads and messages are keyed by id alone, so a batch can name a row another persona already has. */
export class RowOwnerError extends Error {
  constructor(readonly ownerPersonaId: string) {
    super("この中の会話は、すでに別のパートナーの会話と重なっているため書き込めません。");
    this.name = "RowOwnerError";
  }
}

export interface LiteRepository {
  initialize(): Promise<void>;

  listPersonas(): Promise<Persona[]>;
  getPersona(id: string): Promise<Persona | undefined>;
  /** A persona seen for the first time also gets its trunk pages and session. */
  putPersona(value: Persona): Promise<void>;
  deletePersona(id: string): Promise<void>;

  listThreads(personaId: string): Promise<ConversationThread[]>;
  getThread(id: string): Promise<ConversationThread | undefined>;
  putThread(value: ConversationThread): Promise<void>;
  deleteThread(id: string): Promise<void>;
  deleteThreads(ids: string[]): Promise<void>;

  /** Every row of a thread. Use the range reads where a thread can be long. */
  listMessages(threadId: string): Promise<ChatMessage[]>;
  getMessage(id: string): Promise<ChatMessage | undefined>;
  readThreadMessages(threadId: string, range: MessageRange): Promise<ChatMessage[]>;
  /** Across all threads of the persona, for Chronicle: its material is not limited to the active thread. */
  readPersonaMessages(personaId: string, range: MessageRange): Promise<ChatMessage[]>;
  putMessage(value: ChatMessage): Promise<void>;
  deleteMessage(id: string): Promise<void>;
  /** One above the highest seq the persona has. */
  nextMessageSeq(personaId: string): Promise<number>;

  /** All pages of the category, or of the persona, oldest first. Includes trunks and soft-deleted pages. */
  listPages(personaId: string, category?: string): Promise<PageRecord[]>;
  getPage(personaId: string, id: string): Promise<PageRecord | undefined>;
  getPageByShortId(personaId: string, shortId: number): Promise<PageRecord | undefined>;
  putPage(value: PageRecord): Promise<void>;
  deletePage(personaId: string, id: string): Promise<void>;
  nextPageShortId(personaId: string): Promise<number>;
  /** Numbers core_id and short_id in the same transaction as the write. Returns the pages written. */
  addCoreMemories(personaId: string, drafts: CoreMemoryDraft[]): Promise<PageRecord[]>;

  listFragments(personaId: string, entityId?: string): Promise<FragmentRecord[]>;
  putFragment(value: FragmentRecord): Promise<void>;
  deleteFragment(personaId: string, id: string): Promise<void>;

  getSession(personaId: string): Promise<PersonaSession | undefined>;
  putSession(value: PersonaSession): Promise<void>;
  /** Reads and writes in one step, so a response and a background Metabolism cannot overwrite each other. `update` runs synchronously. */
  updateSession(personaId: string, update: (session: PersonaSession) => PersonaSession): Promise<PersonaSession>;

  /**
   * All or nothing. Rows with an existing key are replaced, so a stopped import can run again.
   * A thread or message that belongs to another persona throws RowOwnerError and nothing is written.
   */
  writePersonaRecords(personaId: string, batch: PersonaRecordBatch): Promise<void>;

  listProviders(): Promise<ProviderConfig[]>;
  getProvider(id: string): Promise<ProviderConfig | undefined>;
  putProvider(value: ProviderConfig): Promise<void>;
  deleteProvider(id: string): Promise<void>;

  getSettings(): Promise<AppSettings>;
  putSettings(value: AppSettings): Promise<void>;

  exportSnapshot(includeSecrets?: boolean): Promise<RepositorySnapshot>;
  replaceSnapshot(snapshot: RepositorySnapshot): Promise<void>;
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (!navigator.storage?.persist) {
    console.log("[SAIVerse Lite][storage] navigator.storage.persist is unavailable");
    return null;
  }
  try {
    const granted = await navigator.storage.persist();
    console.log("[SAIVerse Lite][storage] persistent storage:", granted);
    return granted;
  } catch (error) {
    console.warn("[SAIVerse Lite][storage] persistent storage request failed", error);
    return null;
  }
}
