import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, newId, type ChatMessage, type ConversationThread, type MemoryEntry } from "../domain";
import { IndexedDbRepository } from "./indexedDbRepository";
import { MemoryRepository } from "./memoryRepository";
import type { LiteRepository } from "./repository";

async function exercise(repository: LiteRepository): Promise<void> {
  await repository.initialize();
  expect(await repository.getSettings()).toMatchObject({ userName: "", userAvatarDataUrl: null });
  await repository.putSettings({ ...DEFAULT_SETTINGS, userName: "まはー", userAvatarDataUrl: "data:image/png;base64,test" });
  expect(await repository.getSettings()).toMatchObject({ userName: "まはー", userAvatarDataUrl: "data:image/png;base64,test" });
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
  const personaMemory: MemoryEntry = {
    id: newId("memory"), personaId: persona.id, threadId: null, kind: "note", content: "keep across threads",
    sourceMessageIds: [], createdAt: now, updatedAt: now,
  };
  const secondThread: ConversationThread = { ...thread, id: newId("thread"), title: "second" };
  const secondMessage: ChatMessage = { ...message, id: newId("message"), threadId: secondThread.id, content: "second hello" };
  const secondMemory: MemoryEntry = { ...memory, id: newId("memory"), threadId: secondThread.id, content: "second remember", sourceMessageIds: [secondMessage.id] };
  await repository.putThread(thread);
  await repository.putThread(secondThread);
  await repository.putMessage(message);
  await repository.putMessage(secondMessage);
  await repository.putMemory(memory);
  await repository.putMemory(secondMemory);
  await repository.putMemory(personaMemory);
  expect(await repository.listThreads(persona.id)).toContainEqual(thread);
  expect(await repository.listMessages(thread.id)).toContainEqual(message);
  expect(await repository.listMemories(persona.id)).toContainEqual(memory);
  const snapshot = await repository.exportSnapshot();
  expect(snapshot.providers.every((provider) => provider.apiKey === "")).toBe(true);
  await repository.deleteThreads([thread.id, secondThread.id]);
  expect(await repository.listThreads(persona.id)).not.toContainEqual(thread);
  expect(await repository.listThreads(persona.id)).not.toContainEqual(secondThread);
  expect(await repository.listMessages(thread.id)).toEqual([]);
  expect(await repository.listMessages(secondThread.id)).toEqual([]);
  expect(await repository.listMemories(persona.id)).not.toContainEqual(memory);
  expect(await repository.listMemories(persona.id)).not.toContainEqual(secondMemory);
  expect(await repository.listMemories(persona.id)).toContainEqual(personaMemory);
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
