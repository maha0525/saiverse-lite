import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  DEFAULT_SETTINGS,
  createDefaultPersona,
  createDefaultProvider,
  type AppSettings,
  type ChatMessage,
  type ConversationThread,
  type MemoryEntry,
  type Persona,
  type ProviderConfig,
  type RepositorySnapshot,
} from "../domain";
import type { LiteRepository } from "./repository";

interface LiteDatabase extends DBSchema {
  personas: { key: string; value: Persona; indexes: { "by-updated": number } };
  threads: { key: string; value: ConversationThread; indexes: { "by-persona": string; "by-updated": number } };
  messages: { key: string; value: ChatMessage; indexes: { "by-thread": string; "by-created": number } };
  memories: { key: string; value: MemoryEntry; indexes: { "by-persona": string; "by-updated": number } };
  providers: { key: string; value: ProviderConfig };
  settings: { key: string; value: AppSettings };
}

const DB_NAME = "saiverse-lite";
const DB_VERSION = 1;

function byUpdatedDesc<T extends { updatedAt: number }>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt;
}

export class IndexedDbRepository implements LiteRepository {
  private db: IDBPDatabase<LiteDatabase> | null = null;

  private async database(): Promise<IDBPDatabase<LiteDatabase>> {
    if (this.db) return this.db;
    this.db = await openDB<LiteDatabase>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const personas = db.createObjectStore("personas", { keyPath: "id" });
        personas.createIndex("by-updated", "updatedAt");
        const threads = db.createObjectStore("threads", { keyPath: "id" });
        threads.createIndex("by-persona", "personaId");
        threads.createIndex("by-updated", "updatedAt");
        const messages = db.createObjectStore("messages", { keyPath: "id" });
        messages.createIndex("by-thread", "threadId");
        messages.createIndex("by-created", "createdAt");
        const memories = db.createObjectStore("memories", { keyPath: "id" });
        memories.createIndex("by-persona", "personaId");
        memories.createIndex("by-updated", "updatedAt");
        db.createObjectStore("providers", { keyPath: "id" });
        db.createObjectStore("settings", { keyPath: "id" });
      },
    });
    return this.db;
  }

  async initialize(): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(["personas", "providers", "settings"], "readwrite");
    if ((await tx.objectStore("providers").count()) === 0) await tx.objectStore("providers").put(createDefaultProvider());
    if ((await tx.objectStore("personas").count()) === 0) await tx.objectStore("personas").put(createDefaultPersona());
    if (!(await tx.objectStore("settings").get("app"))) await tx.objectStore("settings").put({ ...DEFAULT_SETTINGS });
    await tx.done;
    console.log("[SAIVerse Lite][storage] IndexedDB initialized", { name: DB_NAME, version: DB_VERSION });
  }

  async listPersonas(): Promise<Persona[]> { return (await (await this.database()).getAll("personas")).sort(byUpdatedDesc); }
  async getPersona(id: string): Promise<Persona | undefined> { return (await this.database()).get("personas", id); }
  async putPersona(value: Persona): Promise<void> { await (await this.database()).put("personas", value); }
  async deletePersona(id: string): Promise<void> {
    const db = await this.database();
    const threads = await this.listThreads(id);
    for (const thread of threads) await this.deleteThread(thread.id);
    const memories = await this.listMemories(id);
    const tx = db.transaction(["personas", "memories"], "readwrite");
    await tx.objectStore("personas").delete(id);
    for (const memory of memories) await tx.objectStore("memories").delete(memory.id);
    await tx.done;
  }

  async listThreads(personaId: string): Promise<ConversationThread[]> {
    return (await (await this.database()).getAllFromIndex("threads", "by-persona", personaId)).sort(byUpdatedDesc);
  }
  async getThread(id: string): Promise<ConversationThread | undefined> { return (await this.database()).get("threads", id); }
  async putThread(value: ConversationThread): Promise<void> { await (await this.database()).put("threads", value); }
  async deleteThread(id: string): Promise<void> {
    const db = await this.database();
    const messages = await this.listMessages(id);
    const tx = db.transaction(["threads", "messages"], "readwrite");
    await tx.objectStore("threads").delete(id);
    for (const message of messages) await tx.objectStore("messages").delete(message.id);
    await tx.done;
  }

  async listMessages(threadId: string): Promise<ChatMessage[]> {
    return (await (await this.database()).getAllFromIndex("messages", "by-thread", threadId)).sort((a, b) => a.createdAt - b.createdAt);
  }
  async putMessage(value: ChatMessage): Promise<void> { await (await this.database()).put("messages", value); }
  async deleteMessage(id: string): Promise<void> { await (await this.database()).delete("messages", id); }

  async listMemories(personaId: string): Promise<MemoryEntry[]> {
    return (await (await this.database()).getAllFromIndex("memories", "by-persona", personaId)).sort(byUpdatedDesc);
  }
  async putMemory(value: MemoryEntry): Promise<void> { await (await this.database()).put("memories", value); }
  async deleteMemory(id: string): Promise<void> { await (await this.database()).delete("memories", id); }

  async listProviders(): Promise<ProviderConfig[]> { return (await (await this.database()).getAll("providers")).sort((a, b) => a.label.localeCompare(b.label)); }
  async getProvider(id: string): Promise<ProviderConfig | undefined> { return (await this.database()).get("providers", id); }
  async putProvider(value: ProviderConfig): Promise<void> { await (await this.database()).put("providers", value); }
  async deleteProvider(id: string): Promise<void> { if (id !== "provider_mock") await (await this.database()).delete("providers", id); }

  async getSettings(): Promise<AppSettings> { return (await (await this.database()).get("settings", "app")) ?? { ...DEFAULT_SETTINGS }; }
  async putSettings(value: AppSettings): Promise<void> { await (await this.database()).put("settings", value); }

  async exportSnapshot(includeSecrets = false): Promise<RepositorySnapshot> {
    const db = await this.database();
    const [personas, threads, messages, memories, rawProviders, settings] = await Promise.all([
      db.getAll("personas"), db.getAll("threads"), db.getAll("messages"), db.getAll("memories"), db.getAll("providers"), this.getSettings(),
    ]);
    const providers = rawProviders.map((provider) => ({ ...provider, apiKey: includeSecrets ? provider.apiKey : "" }));
    return { personas, threads, messages, memories, providers, settings };
  }

  async replaceSnapshot(snapshot: RepositorySnapshot): Promise<void> {
    const db = await this.database();
    const stores = ["personas", "threads", "messages", "memories", "providers", "settings"] as const;
    const tx = db.transaction(stores, "readwrite");
    await Promise.all(stores.map((store) => tx.objectStore(store).clear()));
    for (const item of snapshot.personas) await tx.objectStore("personas").put(item);
    for (const item of snapshot.threads) await tx.objectStore("threads").put(item);
    for (const item of snapshot.messages) await tx.objectStore("messages").put(item);
    for (const item of snapshot.memories) await tx.objectStore("memories").put(item);
    for (const item of snapshot.providers) await tx.objectStore("providers").put(item);
    await tx.objectStore("settings").put(snapshot.settings);
    await tx.done;
    console.log("[SAIVerse Lite][storage] backup restored", {
      personas: snapshot.personas.length,
      threads: snapshot.threads.length,
      messages: snapshot.messages.length,
      memories: snapshot.memories.length,
    });
  }
}
