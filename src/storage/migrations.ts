import type { IDBPDatabase, IDBPTransaction } from "idb";
import type { ChatMessage, ConversationThread, MemoryEntry, Persona } from "../domain";
import { epochSeconds } from "../pageRecords";
import { upgradeLegacyMessage, upgradeLegacyPersona, type LegacyChatMessage } from "./legacyData";

// Stores are named by string here because this code must keep describing past
// schemas after LiteDatabase has moved on.
type UntypedDatabase = IDBPDatabase<unknown>;
type UpgradeTransaction = IDBPTransaction<unknown, string[], "versionchange">;

export function createV1Stores(db: UntypedDatabase): void {
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
}

function createV2Stores(db: UntypedDatabase, tx: UpgradeTransaction): void {
  const messages = tx.objectStore("messages");
  messages.createIndex("by-thread-order", ["threadId", "createdAt", "seq", "id"]);
  messages.createIndex("by-persona-order", ["personaId", "createdAt", "seq", "id"]);
  messages.createIndex("by-persona-seq", ["personaId", "seq"]);
  // Page ids are only unique per persona: every persona has a root_core.
  const pages = db.createObjectStore("pages", { keyPath: ["personaId", "id"] });
  pages.createIndex("by-persona-category", ["personaId", "category"]);
  pages.createIndex("by-persona-short-id", ["personaId", "shortId"]);
  const fragments = db.createObjectStore("fragments", { keyPath: ["personaId", "id"] });
  fragments.createIndex("by-persona-entity", ["personaId", "entityId"]);
  db.createObjectStore("sessions", { keyPath: "personaId" });
}

async function upgradeMessages(tx: UpgradeTransaction): Promise<number> {
  const store = tx.objectStore("messages");
  const total = await store.count();
  const seqByPersona = new Map<string, number>();
  let upgraded = 0;
  const upgrade = (row: LegacyChatMessage): ChatMessage => {
    const seq = (seqByPersona.get(row.personaId) ?? 0) + 1;
    seqByPersona.set(row.personaId, seq);
    upgraded += 1;
    return upgradeLegacyMessage(row, seq);
  };
  // by-created yields (createdAt, id), the order v1 displayed. Reading it as a
  // cursor keeps a long history out of memory.
  let cursor = await store.index("by-created").openCursor();
  while (cursor) {
    await cursor.update(upgrade(cursor.value as LegacyChatMessage));
    cursor = await cursor.continue();
  }
  // A row without a usable createdAt is not in that index.
  if (upgraded < total) {
    let rest = await store.openCursor();
    while (rest) {
      if (typeof (rest.value as { seq?: unknown }).seq !== "number") {
        await rest.update(upgrade(rest.value as LegacyChatMessage));
      }
      rest = await rest.continue();
    }
  }
  return upgraded;
}

async function upgradePersonas(tx: UpgradeTransaction, nowSeconds: number): Promise<number> {
  const personas = (await tx.objectStore("personas").getAll()) as Persona[];
  const pagesStore = tx.objectStore("pages");
  const sessionsStore = tx.objectStore("sessions");
  let pageCount = 0;
  for (const persona of personas) {
    const threads = (await tx.objectStore("threads").index("by-persona").getAll(persona.id)) as ConversationThread[];
    const memories = (await tx.objectStore("memories").index("by-persona").getAll(persona.id)) as MemoryEntry[];
    const { pages, session } = upgradeLegacyPersona(persona.id, threads, memories, nowSeconds);
    for (const page of pages) await pagesStore.put(page);
    await sessionsStore.put(session);
    pageCount += pages.length;
  }
  return pageCount;
}

/**
 * v1 to v2. Runs inside the versionchange transaction, so only IndexedDB work may
 * be awaited here. The memories rows stay in their store, unread.
 */
export async function upgradeToV2(db: UntypedDatabase, tx: UpgradeTransaction, now: number): Promise<void> {
  createV2Stores(db, tx);
  const messages = await upgradeMessages(tx);
  const pages = await upgradePersonas(tx, epochSeconds(now));
  const store = tx.objectStore("messages");
  store.deleteIndex("by-thread");
  store.deleteIndex("by-created");
  console.log("[SAIVerse Lite][storage] database upgraded to v2", { messages, pages });
}
