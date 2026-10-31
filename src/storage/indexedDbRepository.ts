import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from "idb";
import {
  createDefaultPersona,
  createDefaultProvider,
  normalizeSettings,
  type AppSettings,
  type ChatMessage,
  type ConversationThread,
  type FragmentRecord,
  type MemoryEntry,
  type PageRecord,
  type Persona,
  type PersonaSession,
  type ProviderConfig,
  type RepositorySnapshot,
} from "../domain";
import {
  buildCoreMemoryPages,
  CATEGORY_CORE,
  createPersonaSession,
  createTrunkPages,
  epochSeconds,
  type CoreMemoryDraft,
} from "../pageRecords";
import { createV1Stores, upgradeToV2 } from "./migrations";
import { assertBatchOwner, type LiteRepository, type MessageRange, type PersonaRecordBatch } from "./repository";

type OwnedKey = [personaId: string, id: string];

interface LiteDatabase extends DBSchema {
  personas: { key: string; value: Persona; indexes: { "by-updated": number } };
  threads: { key: string; value: ConversationThread; indexes: { "by-persona": string; "by-updated": number } };
  messages: {
    key: string;
    value: ChatMessage;
    indexes: {
      "by-thread-order": [string, number, number, string];
      "by-persona-order": [string, number, number, string];
      "by-persona-seq": [string, number];
    };
  };
  /** Kept with their v1 rows and no longer read. Cleared with the persona or by a restore. */
  memories: { key: string; value: MemoryEntry; indexes: { "by-persona": string; "by-updated": number } };
  pages: {
    key: OwnedKey;
    value: PageRecord;
    indexes: { "by-persona-category": [string, string]; "by-persona-short-id": [string, number] };
  };
  fragments: { key: OwnedKey; value: FragmentRecord; indexes: { "by-persona-entity": [string, string] } };
  sessions: { key: string; value: PersonaSession };
  providers: { key: string; value: ProviderConfig };
  settings: { key: string; value: AppSettings };
}

const DB_NAME = "saiverse-lite";
const DB_VERSION = 2;

const SNAPSHOT_STORES = ["personas", "threads", "messages", "memories", "pages", "fragments", "sessions", "providers", "settings"] as const;

function byUpdatedDesc<T extends { updatedAt: number }>(a: T, b: T): number {
  return b.updatedAt - a.updatedAt;
}

function byCreatedThenId<T extends { createdAt: number; id: string }>(a: T, b: T): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Arrays sort above strings and numbers, so `[owner, []]` is past every key that starts with owner. */
function ownerKeys(owner: string): IDBKeyRange {
  return IDBKeyRange.bound([owner], [owner, []]);
}

function orderRange(owner: string, range: MessageRange): IDBKeyRange {
  if (!range.start) return ownerKeys(owner);
  const { createdAt, seq, id } = range.start;
  const start = [owner, createdAt, seq, id];
  const excludeStart = !range.includeStart;
  return range.direction === "forward"
    ? IDBKeyRange.bound(start, [owner, []], excludeStart, true)
    : IDBKeyRange.bound([owner], start, false, excludeStart);
}

type WriteTransaction<Stores extends ArrayLike<StoreNames<LiteDatabase>>> = IDBPTransaction<LiteDatabase, Stores, "readwrite">;

async function ensurePersonaRecords(
  tx: WriteTransaction<("pages" | "sessions")[]>,
  personaId: string,
  nowSeconds: number,
): Promise<void> {
  const sessions = tx.objectStore("sessions");
  if (await sessions.get(personaId)) return;
  for (const page of createTrunkPages(personaId, nowSeconds)) await tx.objectStore("pages").put(page);
  await sessions.put(createPersonaSession(personaId));
}

export class IndexedDbRepository implements LiteRepository {
  private db: Promise<IDBPDatabase<LiteDatabase>> | null = null;

  private async open(): Promise<IDBPDatabase<LiteDatabase>> {
    let migrationError: unknown = null;
    let rejectBlocked: (error: Error) => void = () => undefined;
    const blocked = new Promise<never>((_, reject) => { rejectBlocked = reject; });
    const opening = openDB<LiteDatabase>(DB_NAME, DB_VERSION, {
      upgrade: (db, oldVersion, _newVersion, tx) => {
        // idb does not watch this callback's promise. Without the abort, a failed
        // migration would commit whatever it had finished so far.
        void (async () => {
          const untyped = db as unknown as IDBPDatabase<unknown>;
          const untypedTx = tx as unknown as IDBPTransaction<unknown, string[], "versionchange">;
          if (oldVersion < 1) createV1Stores(untyped);
          if (oldVersion < 2) await upgradeToV2(untyped, untypedTx, Date.now());
        })().catch((error: unknown) => {
          migrationError = error;
          console.error("[SAIVerse Lite][storage] migration failed; the database stays at its old version", error);
          tx.done.catch(() => undefined);
          // A failed request has usually aborted the transaction already, and abort() then throws.
          try { tx.abort(); } catch { /* already aborted */ }
        });
      },
      blocked: () => {
        console.warn("[SAIVerse Lite][storage] upgrade is waiting for another open connection");
        rejectBlocked(new Error("別のタブで SAIVerse Lite が開いたままです。ほかのタブを閉じてから開き直してください。"));
      },
      // Ours to release: a newer version in another tab is waiting on this connection.
      blocking: () => {
        void this.db?.then((db) => db.close()).catch(() => undefined);
        this.db = null;
      },
    });
    try {
      return await Promise.race([opening, blocked]);
    } catch (error) {
      // The blocked upgrade still finishes once the other tab closes; nothing here uses that connection.
      void opening.then((db) => db.close()).catch(() => undefined);
      throw migrationError ?? error;
    }
  }

  private async database(): Promise<IDBPDatabase<LiteDatabase>> {
    if (!this.db) {
      this.db = this.open();
      this.db.catch(() => { this.db = null; });
    }
    return this.db;
  }

  async initialize(): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(["personas", "pages", "sessions", "providers", "settings"], "readwrite");
    if ((await tx.objectStore("providers").count()) === 0) await tx.objectStore("providers").put(createDefaultProvider());
    if ((await tx.objectStore("personas").count()) === 0) await tx.objectStore("personas").put(createDefaultPersona());
    const nowSeconds = epochSeconds(Date.now());
    for (const id of await tx.objectStore("personas").getAllKeys()) {
      await ensurePersonaRecords(tx as unknown as WriteTransaction<("pages" | "sessions")[]>, id, nowSeconds);
    }
    const storedSettings = await tx.objectStore("settings").get("app");
    await tx.objectStore("settings").put(normalizeSettings(storedSettings));
    await tx.done;
    console.log("[SAIVerse Lite][storage] IndexedDB initialized", { name: DB_NAME, version: DB_VERSION });
  }

  async listPersonas(): Promise<Persona[]> { return (await (await this.database()).getAll("personas")).sort(byUpdatedDesc); }
  async getPersona(id: string): Promise<Persona | undefined> { return (await this.database()).get("personas", id); }
  async putPersona(value: Persona): Promise<void> {
    const tx = (await this.database()).transaction(["personas", "pages", "sessions"], "readwrite");
    await tx.objectStore("personas").put(value);
    await ensurePersonaRecords(tx as unknown as WriteTransaction<("pages" | "sessions")[]>, value.id, epochSeconds(Date.now()));
    await tx.done;
  }
  async deletePersona(id: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(["personas", "threads", "messages", "memories", "pages", "fragments", "sessions"], "readwrite");
    await tx.objectStore("personas").delete(id);
    for (const key of await tx.objectStore("threads").index("by-persona").getAllKeys(id)) await tx.objectStore("threads").delete(key);
    for (const key of await tx.objectStore("messages").index("by-persona-order").getAllKeys(ownerKeys(id))) await tx.objectStore("messages").delete(key);
    for (const key of await tx.objectStore("memories").index("by-persona").getAllKeys(id)) await tx.objectStore("memories").delete(key);
    await tx.objectStore("pages").delete(ownerKeys(id));
    await tx.objectStore("fragments").delete(ownerKeys(id));
    await tx.objectStore("sessions").delete(id);
    await tx.done;
  }

  async listThreads(personaId: string): Promise<ConversationThread[]> {
    return (await (await this.database()).getAllFromIndex("threads", "by-persona", personaId)).sort(byUpdatedDesc);
  }
  async getThread(id: string): Promise<ConversationThread | undefined> { return (await this.database()).get("threads", id); }
  async putThread(value: ConversationThread): Promise<void> { await (await this.database()).put("threads", value); }
  async deleteThread(id: string): Promise<void> { await this.deleteThreads([id]); }
  async deleteThreads(ids: string[]): Promise<void> {
    const requestedIds = new Set(ids);
    if (requestedIds.size === 0) return;
    const db = await this.database();
    const tx = db.transaction(["threads", "messages", "sessions"], "readwrite");
    const threads = tx.objectStore("threads");
    const messages = tx.objectStore("messages");
    const sessions = tx.objectStore("sessions");
    const targetIds = new Set<string>();
    const personaIds = new Set<string>();
    const deletedMessageIds = new Set<string>();
    for (const id of requestedIds) {
      const thread = await threads.get(id);
      if (!thread) continue;
      targetIds.add(id);
      personaIds.add(thread.personaId);
      await threads.delete(id);
      for (const key of await messages.index("by-thread-order").getAllKeys(ownerKeys(id))) {
        await messages.delete(key);
        deletedMessageIds.add(key);
      }
    }
    for (const personaId of personaIds) {
      const session = await sessions.get(personaId);
      if (!session) continue;
      const threadGone = session.activeThreadId !== null && targetIds.has(session.activeThreadId);
      const anchorGone = session.anchorMessageId !== null && deletedMessageIds.has(session.anchorMessageId);
      if (!threadGone && !anchorGone) continue;
      await sessions.put({
        ...session,
        activeThreadId: threadGone ? null : session.activeThreadId,
        anchorMessageId: threadGone || anchorGone ? null : session.anchorMessageId,
      });
    }
    await tx.done;
    if (targetIds.size > 0) {
      console.info("[SAIVerse Lite][storage] Threads deleted", { deletedThreads: targetIds.size, deletedMessages: deletedMessageIds.size });
    }
  }

  async listMessages(threadId: string): Promise<ChatMessage[]> {
    return (await this.database()).getAllFromIndex("messages", "by-thread-order", ownerKeys(threadId));
  }
  async getMessage(id: string): Promise<ChatMessage | undefined> { return (await this.database()).get("messages", id); }
  async readThreadMessages(threadId: string, range: MessageRange): Promise<ChatMessage[]> {
    return this.readOrdered("by-thread-order", threadId, range);
  }
  async readPersonaMessages(personaId: string, range: MessageRange): Promise<ChatMessage[]> {
    return this.readOrdered("by-persona-order", personaId, range);
  }
  private async readOrdered(
    index: "by-thread-order" | "by-persona-order",
    owner: string,
    range: MessageRange,
  ): Promise<ChatMessage[]> {
    // getAll treats a count of 0 as "no limit".
    if (range.limit <= 0) return [];
    const db = await this.database();
    const keys = orderRange(owner, range);
    if (range.direction === "forward") return db.getAllFromIndex("messages", index, keys, range.limit);
    const rows: ChatMessage[] = [];
    let cursor = await db.transaction("messages").store.index(index).openCursor(keys, "prev");
    while (cursor) {
      rows.push(cursor.value);
      if (rows.length >= range.limit) break;
      cursor = await cursor.continue();
    }
    return rows;
  }
  async putMessage(value: ChatMessage): Promise<void> { await (await this.database()).put("messages", value); }
  async deleteMessage(id: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(["messages", "sessions"], "readwrite");
    const message = await tx.objectStore("messages").get(id);
    await tx.objectStore("messages").delete(id);
    const session = message ? await tx.objectStore("sessions").get(message.personaId) : undefined;
    if (session?.anchorMessageId === id) await tx.objectStore("sessions").put({ ...session, anchorMessageId: null });
    await tx.done;
    console.info("[SAIVerse Lite][storage] Message deleted", { messageId: id, deleted: Boolean(message) });
  }
  async nextMessageSeq(personaId: string): Promise<number> {
    const db = await this.database();
    const cursor = await db.transaction("messages").store.index("by-persona-seq").openKeyCursor(ownerKeys(personaId), "prev");
    return cursor ? cursor.key[1] + 1 : 1;
  }

  async listPages(personaId: string, category?: string): Promise<PageRecord[]> {
    const db = await this.database();
    const pages = category === undefined
      ? await db.getAll("pages", ownerKeys(personaId))
      : await db.getAllFromIndex("pages", "by-persona-category", [personaId, category]);
    return pages.sort(byCreatedThenId);
  }
  async getPage(personaId: string, id: string): Promise<PageRecord | undefined> { return (await this.database()).get("pages", [personaId, id]); }
  async getPageByShortId(personaId: string, shortId: number): Promise<PageRecord | undefined> {
    return (await this.database()).getFromIndex("pages", "by-persona-short-id", [personaId, shortId]);
  }
  async putPage(value: PageRecord): Promise<void> { await (await this.database()).put("pages", value); }
  async deletePage(personaId: string, id: string): Promise<void> { await (await this.database()).delete("pages", [personaId, id]); }
  async nextPageShortId(personaId: string): Promise<number> {
    const db = await this.database();
    const cursor = await db.transaction("pages").store.index("by-persona-short-id").openKeyCursor(ownerKeys(personaId), "prev");
    return cursor ? cursor.key[1] + 1 : 1;
  }
  async addCoreMemories(personaId: string, drafts: CoreMemoryDraft[]): Promise<PageRecord[]> {
    const tx = (await this.database()).transaction("pages", "readwrite");
    const existing = await tx.store.index("by-persona-category").getAll([personaId, CATEGORY_CORE]);
    const highest = await tx.store.index("by-persona-short-id").openKeyCursor(ownerKeys(personaId), "prev");
    const written = buildCoreMemoryPages(personaId, existing, highest ? highest.key[1] + 1 : 1, drafts, epochSeconds(Date.now()));
    for (const page of written) await tx.store.put(page);
    await tx.done;
    return written;
  }

  async listFragments(personaId: string, entityId?: string): Promise<FragmentRecord[]> {
    const db = await this.database();
    const fragments = entityId === undefined
      ? await db.getAll("fragments", ownerKeys(personaId))
      : await db.getAllFromIndex("fragments", "by-persona-entity", [personaId, entityId]);
    return fragments.sort(byCreatedThenId);
  }
  async putFragment(value: FragmentRecord): Promise<void> { await (await this.database()).put("fragments", value); }
  async deleteFragment(personaId: string, id: string): Promise<void> { await (await this.database()).delete("fragments", [personaId, id]); }

  async getSession(personaId: string): Promise<PersonaSession | undefined> { return (await this.database()).get("sessions", personaId); }
  async putSession(value: PersonaSession): Promise<void> { await (await this.database()).put("sessions", value); }
  async updateSession(personaId: string, update: (session: PersonaSession) => PersonaSession): Promise<PersonaSession> {
    const tx = (await this.database()).transaction("sessions", "readwrite");
    const current = await tx.store.get(personaId);
    if (!current) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new Error(`Session not found: ${personaId}`);
    }
    const next = update(current);
    await tx.store.put(next);
    await tx.done;
    return next;
  }

  async writePersonaRecords(personaId: string, batch: PersonaRecordBatch): Promise<void> {
    assertBatchOwner(personaId, batch);
    const tx = (await this.database()).transaction(["threads", "messages", "pages", "fragments"], "readwrite");
    for (const thread of batch.threads ?? []) await tx.objectStore("threads").put(thread);
    for (const message of batch.messages ?? []) await tx.objectStore("messages").put(message);
    for (const page of batch.pages ?? []) await tx.objectStore("pages").put(page);
    for (const fragment of batch.fragments ?? []) await tx.objectStore("fragments").put(fragment);
    await tx.done;
  }

  async listProviders(): Promise<ProviderConfig[]> { return (await (await this.database()).getAll("providers")).sort((a, b) => a.label.localeCompare(b.label)); }
  async getProvider(id: string): Promise<ProviderConfig | undefined> { return (await this.database()).get("providers", id); }
  async putProvider(value: ProviderConfig): Promise<void> { await (await this.database()).put("providers", value); }
  async deleteProvider(id: string): Promise<void> { if (id !== "provider_mock") await (await this.database()).delete("providers", id); }

  async getSettings(): Promise<AppSettings> {
    const stored = await (await this.database()).get("settings", "app");
    return normalizeSettings(stored);
  }
  async putSettings(value: AppSettings): Promise<void> { await (await this.database()).put("settings", normalizeSettings(value)); }

  async exportSnapshot(includeSecrets = false): Promise<RepositorySnapshot> {
    const db = await this.database();
    const [personas, threads, messages, pages, fragments, sessions, rawProviders, settings] = await Promise.all([
      db.getAll("personas"), db.getAll("threads"), db.getAll("messages"), db.getAll("pages"), db.getAll("fragments"),
      db.getAll("sessions"), db.getAll("providers"), this.getSettings(),
    ]);
    const providers = rawProviders.map((provider) => ({ ...provider, apiKey: includeSecrets ? provider.apiKey : "" }));
    return { personas, threads, messages, pages, fragments, sessions, providers, settings };
  }

  async replaceSnapshot(snapshot: RepositorySnapshot): Promise<void> {
    const db = await this.database();
    const tx = db.transaction(SNAPSHOT_STORES, "readwrite");
    await Promise.all(SNAPSHOT_STORES.map((store) => tx.objectStore(store).clear()));
    for (const item of snapshot.personas) await tx.objectStore("personas").put(item);
    for (const item of snapshot.threads) await tx.objectStore("threads").put(item);
    for (const item of snapshot.messages) await tx.objectStore("messages").put(item);
    for (const item of snapshot.pages) await tx.objectStore("pages").put(item);
    for (const item of snapshot.fragments) await tx.objectStore("fragments").put(item);
    for (const item of snapshot.sessions) await tx.objectStore("sessions").put(item);
    for (const item of snapshot.providers) await tx.objectStore("providers").put(item);
    await tx.objectStore("settings").put(normalizeSettings(snapshot.settings));
    const nowSeconds = epochSeconds(Date.now());
    for (const item of snapshot.personas) {
      await ensurePersonaRecords(tx as unknown as WriteTransaction<("pages" | "sessions")[]>, item.id, nowSeconds);
    }
    await tx.done;
    console.log("[SAIVerse Lite][storage] backup restored", {
      personas: snapshot.personas.length,
      threads: snapshot.threads.length,
      messages: snapshot.messages.length,
      pages: snapshot.pages.length,
      fragments: snapshot.fragments.length,
    });
  }
}
