import { describe, expect, it } from "vitest";
import { newId, type Persona } from "./domain";
import { ChatGptExportAdapter, ClaudeExportAdapter, extractClaudeMemories, saveImportedConversations } from "./importers";
import { MemoryRepository } from "./storage/memoryRepository";

// 実データ (2026-07-15 検証) と同形の匿名フィクスチャ。値はすべて合成。
const CLAUDE_CONVERSATIONS = [{
  uuid: "11111111-1111-4111-8111-111111111111",
  name: "テスト会話",
  summary: "",
  created_at: "2025-02-14T04:28:20.689054Z",
  updated_at: "2025-02-14T05:00:00.000000Z",
  account: { uuid: "22222222-2222-4222-8222-222222222222" },
  chat_messages: [
    {
      uuid: "aaaaaaaa-0000-4000-8000-000000000001",
      sender: "human",
      text: "こんにちは",
      content: [{ type: "text", text: "こんにちは" }],
      attachments: [],
      files: [],
      parent_message_uuid: "00000000-0000-4000-8000-000000000000",
      created_at: "2025-02-14T04:28:21.957590Z",
      updated_at: "2025-02-14T04:28:21.957590Z",
    },
    {
      uuid: "aaaaaaaa-0000-4000-8000-000000000002",
      sender: "assistant",
      text: "調べてから答えますね。答えは A です。",
      content: [
        { type: "thinking", thinking: "(internal)" },
        { type: "text", text: "調べ" },
        { type: "tool_use", name: "web_search", input: { q: "A" } },
        { type: "tool_result", content: [{ type: "text", text: "result" }] },
      ],
      attachments: [],
      files: [],
      parent_message_uuid: "aaaaaaaa-0000-4000-8000-000000000001",
      created_at: "2025-02-14T04:28:30.000000Z",
      updated_at: "2025-02-14T04:28:30.000000Z",
    },
  ],
}];

const CLAUDE_MEMORIES = [{
  conversations_memory: "ユーザーは猫を飼っている。",
  project_memories: { "01999a51-fe7b-761a-a011-241a73173a77": "プロジェクトの記憶。" },
  account_uuid: "22222222-2222-4222-8222-222222222222",
}];

function testPersona(): Persona {
  const now = Date.now();
  return { id: newId("persona"), name: "テスト", description: "", systemPrompt: "test", avatarDataUrl: null, providerId: "provider_mock", model: "mock-friendly", toolIds: [], createdAt: now, updatedAt: now };
}

describe("official export adapters", () => {
  it("uses the active ChatGPT branch and skips hidden messages", async () => {
    const payload = [{
      id: "conv",
      title: "branch",
      current_node: "assistant_b",
      mapping: {
        root: { parent: null, message: null },
        user: { parent: "root", message: { author: { role: "user" }, content: { content_type: "text", parts: ["hello"] }, create_time: 10 } },
        assistant_a: { parent: "user", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["unused"] }, create_time: 11 } },
        assistant_b: { parent: "user", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["chosen"] }, create_time: 12 } },
        hidden: { parent: "assistant_b", message: { author: { role: "assistant" }, content: { content_type: "text", parts: ["hidden"] }, metadata: { is_visually_hidden_from_conversation: true }, create_time: 13 } },
      },
    }];
    const file = new File([JSON.stringify(payload)], "conversations.json", { type: "application/json" });
    const conversations = await new ChatGptExportAdapter().parse(file);
    expect(conversations[0]?.messages.map((message) => message.content)).toEqual(["hello", "chosen"]);
  });

  it("parses the verified Claude schema, preferring the full text field", async () => {
    const file = new File([JSON.stringify(CLAUDE_CONVERSATIONS)], "conversations.json", { type: "application/json" });
    const conversations = await new ClaudeExportAdapter().parse(file);
    expect(conversations).toHaveLength(1);
    const conversation = conversations[0]!;
    expect(conversation.title).toBe("テスト会話");
    expect(conversation.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    // ツール使用ターンは content の断片でなく text フィールドの完全形を使う
    expect(conversation.messages[1]?.content).toBe("調べてから答えますね。答えは A です。");
    // ISO+Z の時刻が epoch ミリ秒になる
    expect(conversation.messages[0]?.createdAt).toBe(Date.parse("2025-02-14T04:28:21.957590Z"));
  });

  it("extracts Claude memories with deterministic ids", async () => {
    const file = new File([JSON.stringify(CLAUDE_MEMORIES)], "memories.json", { type: "application/json" });
    const memories = await extractClaudeMemories(file);
    expect(memories.map((memory) => memory.id)).toEqual([
      "memory_import_claude_conv_0",
      "memory_import_claude_proj_01999a51-fe7b-761a-a011-241a73173a77",
    ]);
    expect(memories[0]?.text).toBe("ユーザーは猫を飼っている。");
  });

  it("re-imports the same export without duplicating messages", async () => {
    const repository = new MemoryRepository();
    const persona = testPersona();
    await repository.putPersona(persona);
    const file = new File([JSON.stringify(CLAUDE_CONVERSATIONS)], "conversations.json", { type: "application/json" });
    const conversations = await new ClaudeExportAdapter().parse(file);
    await saveImportedConversations(repository, persona, conversations);
    await saveImportedConversations(repository, persona, conversations);
    const threads = await repository.listThreads(persona.id);
    expect(threads).toHaveLength(1);
    const messages = await repository.listMessages(threads[0]!.id);
    expect(messages).toHaveLength(2);
  });
});
