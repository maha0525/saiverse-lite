import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { newId, type ChatMessage, type ConversationThread, type MemoryEntry } from "../domain";
import { IndexedDbRepository } from "./indexedDbRepository";
import { MemoryRepository } from "./memoryRepository";
import type { LiteRepository } from "./repository";

async function exercise(repository: LiteRepository): Promise<void> {
  await repository.initialize();
  const persona = (await repository.listPersonas())[0];
  expect(persona).toBeDefined();
  if (!persona) return;
  const now = Date.now();
  const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "test", createdAt: now, updatedAt: now };
  const message: ChatMessage = {
    id: newId("message"), threadId: thread.id, personaId: persona.id, role: "user", content: "hello", createdAt: now,
    editedAt: null, toolCallId: null, toolName: null, metadata: {},
  };
  const memory: MemoryEntry = {
    id: newId("memory"), personaId: persona.id, threadId: thread.id, kind: "note", content: "remember",
    sourceMessageIds: [message.id], createdAt: now, updatedAt: now,
  };
  await repository.putThread(thread);
  await repository.putMessage(message);
  await repository.putMemory(memory);
  expect(await repository.listThreads(persona.id)).toContainEqual(thread);
  expect(await repository.listMessages(thread.id)).toContainEqual(message);
  expect(await repository.listMemories(persona.id)).toContainEqual(memory);
  const snapshot = await repository.exportSnapshot();
  expect(snapshot.providers.every((provider) => provider.apiKey === "")).toBe(true);
}

describe("storage abstraction", () => {
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("saiverse-lite");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  });

  it("supports the contract in memory", async () => exercise(new MemoryRepository()));
  it("supports the contract in IndexedDB", async () => exercise(new IndexedDbRepository()));
});
