import { describe, expect, it } from "vitest";
import { ChatService } from "./chatService";
import { createDefaultPersona, newId, type ConversationThread, type MemoryEntry } from "./domain";
import { MemoryRepository } from "./storage/memoryRepository";

describe("ChatService with mock provider", () => {
  it("streams, persists, and creates a deterministic automatic summary", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.putSettings({ id: "app", theme: "system", summaryEveryMessages: 2, recentContextMessages: 24, storagePersisted: null });
    const persona = createDefaultPersona();
    const now = Date.now();
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    let streamed = "";
    await new ChatService(repository).send(persona, thread, "こんにちは", { onDelta: (delta) => { streamed += delta; } });
    expect(streamed).toContain("モック応答");
    expect(await repository.listMessages(thread.id)).toHaveLength(2);
    expect((await repository.listMemories(persona.id))[0]?.kind).toBe("summary");
  });

  it("runs the registered memory recall tool and returns its result to the model", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.putSettings({ id: "app", theme: "system", summaryEveryMessages: 50, recentContextMessages: 24, storagePersisted: null });
    const persona = createDefaultPersona();
    const now = Date.now();
    const memory: MemoryEntry = {
      id: newId("memory"), personaId: persona.id, threadId: null, kind: "note", content: "猫の名前はミケ", sourceMessageIds: [], createdAt: now, updatedAt: now,
    };
    await repository.putMemory(memory);
    const thread: ConversationThread = { id: newId("thread"), personaId: persona.id, title: "新しい会話", createdAt: now, updatedAt: now };
    await repository.putThread(thread);
    const result = await new ChatService(repository).send(persona, thread, "猫の名前を思い出して");
    expect(result.content).toContain("ミケ");
    expect((await repository.listMessages(thread.id)).some((message) => message.role === "tool" && message.toolName === "memory_recall")).toBe(true);
  });
});
