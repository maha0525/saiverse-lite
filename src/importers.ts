import JSZip from "jszip";
import {
  newId,
  type ChatMessage,
  type ConversationThread,
  type Persona,
} from "./domain";
import type { LiteRepository } from "./storage/repository";

export type ImportSource = "chatgpt" | "claude";

export interface ImportedMessage {
  sourceId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: number | null;
  metadata: Record<string, unknown>;
}

export interface ImportedConversation {
  source: ImportSource;
  id: string;
  title: string;
  createdAt: number | null;
  updatedAt: number | null;
  messages: ImportedMessage[];
}

export interface OfficialExportAdapter {
  readonly source: ImportSource;
  parse(file: File): Promise<ImportedConversation[]>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function epochMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    let seconds = value;
    while (seconds >= 32_503_680_000) seconds /= 1000;
    return seconds < 32_503_680_000 ? Math.floor(seconds * 1000) : null;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function textFromParts(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const itemRecord = record(item);
    return itemRecord && typeof itemRecord.text === "string" ? [itemRecord.text] : [];
  }).join("\n").trim();
}

function messageText(message: Record<string, unknown>): string {
  const content = record(message.content) ?? {};
  const contentType = content.content_type;
  if (contentType === "code") return textFromParts(content.text);
  if (contentType === "tool_result" && Array.isArray(content.tool_outputs)) {
    return content.tool_outputs.flatMap((item) => {
      const output = record(item);
      return output && typeof output.content === "string" ? [output.content] : [];
    }).join("\n").trim();
  }
  return textFromParts(content.parts);
}

function hidden(message: Record<string, unknown>): boolean {
  return record(message.metadata)?.is_visually_hidden_from_conversation === true;
}

function conversationPath(mapping: Record<string, unknown>, currentNode: unknown): string[] {
  if (typeof currentNode === "string" && record(mapping[currentNode])) {
    const ordered: string[] = [];
    const seen = new Set<string>();
    let nodeId: string | null = currentNode;
    while (nodeId && !seen.has(nodeId)) {
      seen.add(nodeId);
      ordered.push(nodeId);
      const node: Record<string, unknown> | null = record(mapping[nodeId]);
      nodeId = typeof node?.parent === "string" ? node.parent : null;
      if (nodeId !== null && !record(mapping[nodeId])) break;
    }
    return ordered.reverse();
  }
  return Object.entries(mapping)
    .flatMap(([id, value]) => {
      const message = record(record(value)?.message);
      return message ? [{ id, at: epochMillis(message.create_time) ?? Number.MIN_SAFE_INTEGER }] : [];
    })
    .sort((a, b) => a.at - b.at)
    .map((item) => item.id);
}

function buildConversation(raw: Record<string, unknown>): ImportedConversation {
  const title = typeof raw.title === "string" && raw.title ? raw.title : "(untitled)";
  const idValue = raw.id ?? raw.conversation_id ?? title;
  const mapping = record(raw.mapping) ?? {};
  const messages: ImportedMessage[] = [];
  for (const nodeId of conversationPath(mapping, raw.current_node)) {
    const message = record(record(mapping[nodeId])?.message);
    if (!message || hidden(message)) continue;
    const author = record(message.author);
    const roleValue = author?.role;
    const role = roleValue === "user" || roleValue === "assistant" || roleValue === "tool" ? roleValue : "system";
    const content = messageText(message);
    if (!content && role !== "system") continue;
    messages.push({
      sourceId: nodeId,
      role,
      content,
      createdAt: epochMillis(message.create_time),
      metadata: record(message.metadata) ?? {},
    });
  }
  return {
    source: "chatgpt",
    id: String(idValue),
    title,
    createdAt: epochMillis(raw.create_time),
    updatedAt: epochMillis(raw.update_time),
    messages,
  };
}

async function conversationsPayloads(file: File): Promise<Record<string, unknown>[]> {
  let payloads: unknown[] = [];
  if (file.name.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const candidates = Object.values(zip.files)
      .filter((entry) => !entry.dir && /(^|\/)conversations(?:-\d+)?\.json$/.test(entry.name))
      .sort((a, b) => a.name.split("/").length - b.name.split("/").length || a.name.localeCompare(b.name));
    if (candidates.length === 0) throw new Error("ZIP 内に conversations.json がありません");
    for (const candidate of candidates) {
      const value: unknown = JSON.parse(await candidate.async("string"));
      if (Array.isArray(value)) payloads.push(...value);
    }
  } else {
    const value: unknown = JSON.parse(await file.text());
    if (!Array.isArray(value)) throw new Error("conversations.json の最上位は配列である必要があります");
    payloads = value;
  }
  const result = payloads.map(record).filter((item): item is Record<string, unknown> => item !== null);
  if (result.length === 0) throw new Error("会話データがありません");
  return result;
}

export class ChatGptExportAdapter implements OfficialExportAdapter {
  readonly source = "chatgpt" as const;
  async parse(file: File): Promise<ImportedConversation[]> {
    const payloads = await conversationsPayloads(file);
    const conversations = payloads.map(buildConversation);
    console.log("[SAIVerse Lite][import] ChatGPT export parsed", {
      files: file.name,
      conversations: conversations.length,
      messages: conversations.reduce((sum, item) => sum + item.messages.length, 0),
    });
    return conversations;
  }
}

// Claude 公式エクスポートの実スキーマ (2026-07-15 実データで検証):
// 最上位は会話の配列 { uuid, name, summary, created_at(ISO+Z), updated_at, account, chat_messages }。
// chat_messages は時系列のフラット配列 { uuid, sender: "human"|"assistant", text,
// content: [{ type: "text"|"tool_use"|"tool_result"|"thinking"|"flag", ... }],
// created_at, updated_at, parent_message_uuid, attachments, files }。
// 可視テキストの完全形は `text` フィールド (ツール使用ターンでは content の text 部品より広い)。
function claudeMessageText(message: Record<string, unknown>): string {
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  const parts = Array.isArray(message.content) ? message.content : [];
  return parts.flatMap((part) => {
    const partRecord = record(part);
    return partRecord?.type === "text" && typeof partRecord.text === "string" ? [partRecord.text] : [];
  }).join("\n").trim();
}

function buildClaudeConversation(raw: Record<string, unknown>): ImportedConversation {
  const title = typeof raw.name === "string" && raw.name ? raw.name : "(untitled)";
  const messages: ImportedMessage[] = [];
  const chat = Array.isArray(raw.chat_messages) ? raw.chat_messages : [];
  let attachmentsSkipped = 0;
  for (const value of chat) {
    const message = record(value);
    if (!message) continue;
    const role = message.sender === "human" ? "user" : message.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    const content = claudeMessageText(message);
    if (!content) continue;
    if (Array.isArray(message.attachments) && message.attachments.length) attachmentsSkipped += message.attachments.length;
    if (Array.isArray(message.files) && message.files.length) attachmentsSkipped += message.files.length;
    messages.push({
      sourceId: typeof message.uuid === "string" ? message.uuid : `${title}_${messages.length}`,
      role,
      content,
      createdAt: epochMillis(message.created_at),
      metadata: {},
    });
  }
  if (attachmentsSkipped > 0) console.log("[SAIVerse Lite][import] Claude attachments/files are not imported", { conversation: title, skipped: attachmentsSkipped });
  return {
    source: "claude",
    id: typeof raw.uuid === "string" ? raw.uuid : title,
    title,
    createdAt: epochMillis(raw.created_at),
    updatedAt: epochMillis(raw.updated_at),
    messages,
  };
}

export class ClaudeExportAdapter implements OfficialExportAdapter {
  readonly source = "claude" as const;
  async parse(file: File): Promise<ImportedConversation[]> {
    const payloads = await conversationsPayloads(file);
    const conversations = payloads.map(buildClaudeConversation);
    console.log("[SAIVerse Lite][import] Claude export parsed", {
      files: file.name,
      conversations: conversations.length,
      messages: conversations.reduce((sum, item) => sum + item.messages.length, 0),
    });
    return conversations;
  }
}

export interface ClaudeMemoryText {
  id: string;
  text: string;
}

// memories.json: [{ conversations_memory: string, project_memories: { <uuid>: string }, account_uuid }]
// Claude 本体が保持していた「関係の記憶」。取り込み ID は決定論 (再インポートで重複しない)。
export async function extractClaudeMemories(file: File): Promise<ClaudeMemoryText[]> {
  let payload: unknown = null;
  if (file.name.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = Object.values(zip.files).find((item) => !item.dir && /(^|\/)memories\.json$/.test(item.name));
    if (!entry) return [];
    payload = JSON.parse(await entry.async("string"));
  } else if (/(^|\/)memories\.json$/.test(file.name.toLowerCase())) {
    payload = JSON.parse(await file.text());
  } else {
    return [];
  }
  if (!Array.isArray(payload)) return [];
  const texts: ClaudeMemoryText[] = [];
  payload.forEach((value, accountIndex) => {
    const account = record(value);
    if (!account) return;
    if (typeof account.conversations_memory === "string" && account.conversations_memory.trim()) {
      texts.push({ id: `memory_import_claude_conv_${accountIndex}`, text: account.conversations_memory.trim() });
    }
    const projects = record(account.project_memories);
    if (projects) {
      for (const [projectId, text] of Object.entries(projects)) {
        if (typeof text === "string" && text.trim()) {
          texts.push({ id: `memory_import_claude_proj_${projectId.replace(/[^a-zA-Z0-9_-]/g, "_")}`, text: text.trim() });
        }
      }
    }
  });
  return texts;
}

export interface OfficialImportResult {
  threads: number;
  messages: number;
  memories: number;
}

// App と初回ウィザードの両方から使う、ファイル一枚ぶんの取り込み処理。
export async function importChatGptFile(repository: LiteRepository, persona: Persona, file: File): Promise<OfficialImportResult> {
  const conversations = await new ChatGptExportAdapter().parse(file);
  const result = await saveImportedConversations(repository, persona, conversations);
  return { ...result, memories: 0 };
}

export async function importClaudeFile(repository: LiteRepository, persona: Persona, file: File): Promise<OfficialImportResult> {
  const conversations = await new ClaudeExportAdapter().parse(file);
  const result = await saveImportedConversations(repository, persona, conversations);
  const memoryTexts = await extractClaudeMemories(file);
  const now = Date.now();
  for (const memory of memoryTexts) {
    await repository.putMemory({
      id: memory.id,
      personaId: persona.id,
      threadId: null,
      kind: "note",
      content: memory.text,
      sourceMessageIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }
  return { ...result, memories: memoryTexts.length };
}

export async function saveImportedConversations(
  repository: LiteRepository,
  persona: Persona,
  conversations: ImportedConversation[],
): Promise<{ threads: number; messages: number }> {
  let messageCount = 0;
  for (const conversation of conversations) {
    const now = Date.now();
    const threadId = `thread_import_${conversation.source}_${conversation.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    const timestamps = conversation.messages.map((message) => message.createdAt).filter((value): value is number => value !== null);
    const createdAt = conversation.createdAt ?? (timestamps.length ? Math.min(...timestamps) : now);
    const updatedAt = conversation.updatedAt ?? (timestamps.length ? Math.max(...timestamps) : createdAt);
    const thread: ConversationThread = {
      id: threadId,
      personaId: persona.id,
      title: conversation.title,
      createdAt,
      updatedAt,
    };
    await repository.putThread(thread);
    for (let index = 0; index < conversation.messages.length; index += 1) {
      const imported = conversation.messages[index];
      if (!imported || (imported.role !== "user" && imported.role !== "assistant")) continue;
      const message: ChatMessage = {
        id: imported.sourceId
          ? `message_import_${conversation.source}_${imported.sourceId.replace(/[^a-zA-Z0-9_-]/g, "_")}`
          : newId("message"),
        threadId,
        personaId: persona.id,
        role: imported.role,
        content: imported.content,
        createdAt: imported.createdAt ?? createdAt + index,
        editedAt: null,
        toolCallId: null,
        toolName: null,
        metadata: {
          ...imported.metadata,
          tags: ["conversation", "imported", conversation.source],
          import_source_id: imported.sourceId,
          import_conversation_id: conversation.id,
        },
      };
      await repository.putMessage(message);
      messageCount += 1;
    }
  }
  return { threads: conversations.length, messages: messageCount };
}
