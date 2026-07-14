import { describe, expect, it } from "vitest";
import { createDefaultPersona, type ChatMessage, type ConversationThread, type MemoryEntry, type RepositorySnapshot } from "./domain";
import { exportFullBackup, exportSaiverseMemory, importSaiverseMemory, parseFullBackup } from "./formats";

const persona = { ...createDefaultPersona(1_700_000_000_000), id: "persona_air", name: "エア" };
const thread: ConversationThread = {
  id: "thread_one",
  personaId: persona.id,
  title: "最初の会話",
  createdAt: 1_700_000_001_000,
  updatedAt: 1_700_000_003_000,
};
const messages: ChatMessage[] = [
  {
    id: "message_user",
    threadId: thread.id,
    personaId: persona.id,
    role: "user",
    content: "覚えていてね",
    createdAt: 1_700_000_001_000,
    editedAt: null,
    toolCallId: null,
    toolName: null,
    metadata: {},
  },
  {
    id: "message_assistant",
    threadId: thread.id,
    personaId: persona.id,
    role: "assistant",
    content: "うん、覚えているよ。",
    createdAt: 1_700_000_002_000,
    editedAt: null,
    toolCallId: null,
    toolName: null,
    metadata: {},
  },
];
const memory: MemoryEntry = {
  id: "memory_one",
  personaId: persona.id,
  threadId: thread.id,
  kind: "summary",
  content: "ユーザーは覚えていることを大切にしている。",
  sourceMessageIds: messages.map((message) => message.id),
  createdAt: 1_700_000_003_000,
  updatedAt: 1_700_000_003_000,
};

describe("SAIVerse native memory format", () => {
  it("round-trips conversation and long-term memory without losing Lite IDs", () => {
    const exported = exportSaiverseMemory(persona, [thread], messages, [memory], 1_700_000_004_000);
    expect(exported.format).toBe("saiverse_saimemory_v1");
    expect(exported.threads).toHaveLength(2);
    const restored = importSaiverseMemory(exported, persona.id);
    expect(restored.threads).toEqual([thread]);
    expect(restored.messages.map((message) => ({ id: message.id, role: message.role, content: message.content }))).toEqual(
      messages.map((message) => ({ id: message.id, role: message.role, content: message.content })),
    );
    expect(restored.memories[0]).toMatchObject({ id: memory.id, kind: "summary", content: memory.content });
  });
});

describe("full backup", () => {
  it("always strips API keys and restores the rest", () => {
    const snapshot: RepositorySnapshot = {
      personas: [persona],
      threads: [thread],
      messages,
      memories: [memory],
      providers: [{
        id: "openai",
        kind: "openai",
        label: "OpenAI",
        apiKey: "secret",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
        imageModel: "gpt-image-1",
        geminiAutoCache: true,
        createdAt: 1,
        updatedAt: 1,
      }],
      settings: { id: "app", theme: "dark", summaryEveryMessages: 12, recentContextMessages: 24, storagePersisted: true },
    };
    const backup = exportFullBackup(snapshot, 2);
    expect(backup.data.providers[0]?.apiKey).toBe("");
    const restored = parseFullBackup(JSON.parse(JSON.stringify(backup)));
    expect(restored.personas[0]?.name).toBe("エア");
    expect(restored.providers[0]?.apiKey).toBe("");
  });
});
