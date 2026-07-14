import type {
  AppSettings,
  ChatMessage,
  ConversationThread,
  MemoryEntry,
  Persona,
  ProviderConfig,
  RepositorySnapshot,
} from "../domain";

export interface LiteRepository {
  initialize(): Promise<void>;

  listPersonas(): Promise<Persona[]>;
  getPersona(id: string): Promise<Persona | undefined>;
  putPersona(value: Persona): Promise<void>;
  deletePersona(id: string): Promise<void>;

  listThreads(personaId: string): Promise<ConversationThread[]>;
  getThread(id: string): Promise<ConversationThread | undefined>;
  putThread(value: ConversationThread): Promise<void>;
  deleteThread(id: string): Promise<void>;

  listMessages(threadId: string): Promise<ChatMessage[]>;
  putMessage(value: ChatMessage): Promise<void>;
  deleteMessage(id: string): Promise<void>;

  listMemories(personaId: string): Promise<MemoryEntry[]>;
  putMemory(value: MemoryEntry): Promise<void>;
  deleteMemory(id: string): Promise<void>;

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
