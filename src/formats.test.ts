import { describe, expect, it } from "vitest";
import {
  createChatMessage,
  createDefaultPersona,
  DEFAULT_SETTINGS,
  type ChatMessage,
  type ConversationThread,
  type MemoryEntry,
  type RepositorySnapshot,
} from "./domain";
import { exportFullBackup, exportSaiverseMemory, importSaiverseMemory, parseFullBackup } from "./formats";
import { buildCoreMemoryPages, CATEGORY_CORE, createPersonaSession, createTrunkPages, liveCoreMemories } from "./pageRecords";
import { MemoryRepository } from "./storage/memoryRepository";

const persona = { ...createDefaultPersona(1_700_000_000_000), id: "persona_air", name: "エア" };
const thread: ConversationThread = {
  id: "thread_one",
  personaId: persona.id,
  title: "最初の会話",
  createdAt: 1_700_000_001_000,
  updatedAt: 1_700_000_003_000,
};
const messages: ChatMessage[] = [
  createChatMessage({
    id: "message_user",
    threadId: thread.id,
    personaId: persona.id,
    role: "user",
    content: "覚えていてね",
    createdAt: 1_700_000_001_000,
    seq: 1,
  }),
  createChatMessage({
    id: "message_assistant",
    threadId: thread.id,
    personaId: persona.id,
    role: "assistant",
    content: "うん、覚えているよ。",
    createdAt: 1_700_000_002_000,
    seq: 2,
  }),
];
const memory: MemoryEntry = {
  id: "memory_one",
  personaId: persona.id,
  threadId: thread.id,
  kind: "note",
  content: "猫の名前はミケ。",
  sourceMessageIds: messages.map((message) => message.id),
  createdAt: 1_700_000_003_000,
  updatedAt: 1_700_000_003_000,
};
const trunks = createTrunkPages(persona.id, 1_700_000_000);
const corePages = buildCoreMemoryPages(persona.id, trunks, 3, [{
  id: memory.id,
  content: memory.content,
  createdAt: 1_700_000_003,
  metadata: { lite_thread_id: thread.id, source_message_ids: memory.sourceMessageIds },
}], 1_700_000_003);
const pages = [...trunks, ...corePages];

const legacyMessages = [
  {
    id: "legacy_user", threadId: thread.id, personaId: persona.id, role: "user", content: "思い出して",
    createdAt: 1_700_000_001_000, editedAt: null, toolCallId: null, toolName: null, metadata: {},
  },
  {
    id: "legacy_assistant", threadId: thread.id, personaId: persona.id, role: "assistant", content: "",
    createdAt: 1_700_000_002_000, editedAt: null, toolCallId: null, toolName: null,
    metadata: { usage: { inputTokens: 1 }, tool_calls: [{ id: "call_1", name: "memory_recall", arguments: {} }], lite_provider_state: { x: 1 } },
  },
  {
    id: "legacy_tool", threadId: thread.id, personaId: persona.id, role: "tool", content: "{\"memories\":[]}",
    createdAt: 1_700_000_003_000, editedAt: null, toolCallId: "call_1", toolName: "memory_recall", metadata: { hitCount: 0 },
  },
];

describe("SAIVerse native memory format", () => {
  it("round-trips conversation and core memories without losing Lite IDs", () => {
    const exported = exportSaiverseMemory(persona, [thread], messages, pages, 1_700_000_004_000);
    expect(exported.format).toBe("saiverse_saimemory_v1");
    expect(exported.threads).toHaveLength(2);
    const restored = importSaiverseMemory(exported, persona.id);
    expect(restored.threads).toEqual([thread]);
    expect(restored.messages.map((message) => ({ id: message.id, role: message.role, content: message.content }))).toEqual(
      messages.map((message) => ({ id: message.id, role: message.role, content: message.content })),
    );
    expect(restored.memories[0]).toMatchObject({
      id: memory.id,
      kind: "note",
      content: memory.content,
      threadId: thread.id,
      sourceMessageIds: memory.sourceMessageIds,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    });
  });

  it("leaves soft-deleted core memories out of the export", () => {
    const deleted = pages.map((page) => (page.id === memory.id ? { ...page, isDeleted: true } : page));
    expect(exportSaiverseMemory(persona, [thread], messages, deleted, 1).threads).toHaveLength(1);
  });

  it("does not revive automatic summaries from older native exports", () => {
    const exported = exportSaiverseMemory(persona, [thread], messages, pages, 1_700_000_004_000);
    const memoryThread = exported.threads.find((item) => item.thread_id.endsWith(":lite-memory"));
    if (!memoryThread?.messages[0]) throw new Error("memory fixture was not exported");
    memoryThread.messages[0].metadata.tags = ["memory", "summary", "saiverse_lite"];
    expect(importSaiverseMemory(exported, persona.id).memories).toEqual([]);
  });

  it("reads tool rows of older exports in the stored form", () => {
    const restored = importSaiverseMemory({
      format: "saiverse_saimemory_v1",
      threads: [{
        thread_id: `${persona.id}:${thread.id}`,
        messages: [{
          id: "old_tool", role: "tool", content: "結果", created_at: 1_700_000_000,
          metadata: { tool_call_id: "call_1", tool_name: "memory_recall", lite_thread_id: thread.id, tool_calls: [] },
        }],
      }],
    }, persona.id);
    expect(restored.messages[0]).toMatchObject({ role: "system", content: "[Handy Tool: memory_recall]\n結果", seq: 1 });
    expect(restored.messages[0]?.metadata).toMatchObject({ tags: ["conversation", "handy_tool"], __system_notice__: "handy_tool" });
    expect(restored.messages[0]?.metadata).not.toHaveProperty("tool_call_id");
    expect(restored.messages[0]?.metadata).not.toHaveProperty("tool_name");
    expect(restored.messages[0]?.metadata).not.toHaveProperty("tool_calls");
  });
});

describe("full backup", () => {
  const snapshot: RepositorySnapshot = {
    personas: [persona],
    threads: [thread],
    messages,
    pages,
    fragments: [{
      id: "fragment_one", personaId: persona.id, content: "猫が好き", entityId: "page_x",
      chronicleEntryId: null, vividness: "vivid", sourceDate: null, createdAt: 1, source: { id: "fragment_one" },
    }],
    sessions: [{ ...createPersonaSession(persona.id, thread.id), anchorMessageId: "message_user", headText: "head", passphrase: "abc" }],
    providers: [{
      id: "openai",
      kind: "openai",
      label: "OpenAI",
      apiKey: "secret",
      baseUrl: "https://api.openai.com/v1",
      defaultModel: "gpt-4.1-mini",
      lightModel: "gpt-4.1-nano",
      imageModel: "gpt-image-1",
      geminiAutoCache: true,
      createdAt: 1,
      updatedAt: 1,
    }],
    settings: { ...DEFAULT_SETTINGS, theme: "dark", storagePersisted: true },
  };

  it("always strips API keys and restores every store", () => {
    const backup = exportFullBackup(snapshot, 2);
    expect(backup.format).toBe("saiverse_lite_backup_v2");
    expect(backup.data.providers[0]?.apiKey).toBe("");
    const restored = parseFullBackup(JSON.parse(JSON.stringify(backup)));
    expect(restored).toEqual({ ...snapshot, providers: [{ ...snapshot.providers[0], apiKey: "" }] });
  });

  it("round-trips through a repository", async () => {
    const source = new MemoryRepository();
    await source.replaceSnapshot(parseFullBackup(JSON.parse(JSON.stringify(exportFullBackup(snapshot, 2)))));
    const copy = new MemoryRepository();
    await copy.replaceSnapshot(parseFullBackup(JSON.parse(JSON.stringify(exportFullBackup(await source.exportSnapshot(), 3)))));
    expect(await copy.getSession(persona.id)).toEqual(snapshot.sessions[0]);
    expect(await copy.getPage(persona.id, memory.id)).toEqual(corePages[0]);
    expect(await copy.listFragments(persona.id)).toEqual(snapshot.fragments);
    expect(await copy.listMessages(thread.id)).toEqual(messages);
  });

  it("restores a v1 backup through the migration's conversion", async () => {
    const oldBackup = {
      format: "saiverse_lite_backup_v1",
      data: {
        personas: [persona], threads: [thread], messages: legacyMessages, providers: [],
        memories: [{ ...memory, id: "retired_summary", kind: "summary" }, memory],
        settings: { id: "app", theme: "system", autoSummaryEnabled: true, summaryEveryMessages: 12, recentContextMessages: 24, storagePersisted: null },
      },
    };
    const restored = parseFullBackup(oldBackup, 1_700_000_009_000);
    expect(restored.settings).toMatchObject({ userName: "", userAvatarDataUrl: null, recentContextMessages: 24 });
    expect(restored.settings).not.toHaveProperty("autoSummaryEnabled");
    expect(restored.settings).not.toHaveProperty("summaryEveryMessages");

    expect(restored.messages.map((message) => [message.id, message.role, message.seq])).toEqual([
      ["legacy_user", "user", 1],
      ["legacy_assistant", "assistant", 2],
      ["legacy_tool", "system", 3],
    ]);
    expect(restored.messages[1]?.metadata).toEqual({ usage: { inputTokens: 1 } });
    expect(restored.messages[2]?.content).toBe("[Handy Tool: memory_recall]\n{\"memories\":[]}");
    expect(restored.messages[2]).not.toHaveProperty("toolCallId");
    expect(restored.sessions).toEqual([createPersonaSession(persona.id, thread.id)]);
    expect(restored.fragments).toEqual([]);
    const memories = liveCoreMemories(restored.pages.filter((page) => page.category === CATEGORY_CORE));
    expect(memories.map((page) => page.id)).toEqual([memory.id]);
    expect(restored.pages.filter((page) => page.isTrunk).map((page) => page.id).sort()).toEqual(
      ["root_chronicle", "root_core", "root_events", "root_people", "root_plans", "root_terms"],
    );

    const repository = new MemoryRepository();
    await repository.replaceSnapshot(restored);
    expect(await repository.getPage(persona.id, "root_core")).toMatchObject({ isTrunk: true, isImportant: true });
  });
});
