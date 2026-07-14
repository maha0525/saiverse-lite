import {
  DEFAULT_SETTINGS,
  type ChatMessage,
  type ConversationThread,
  type MemoryEntry,
  type Persona,
  type RepositorySnapshot,
} from "./domain";

export const PERSONA_FORMAT = "saiverse_lite_persona_v1" as const;
export const MEMORY_FORMAT = "saiverse_saimemory_v1" as const;
export const BACKUP_FORMAT = "saiverse_lite_backup_v1" as const;

export interface SaiverseBlueprintPayload {
  name: string;
  description: string;
  system_prompt: string;
  entity_type: "ai";
}

export interface LitePersonaExport {
  format: typeof PERSONA_FORMAT;
  exported_at: string;
  persona: Persona;
  saiverse_blueprint: SaiverseBlueprintPayload;
}

export interface NativeMessage {
  id: string;
  role: string;
  content: string;
  resource_id: string | null;
  created_at: number;
  metadata: Record<string, unknown>;
}

export interface NativeThread {
  thread_id: string;
  resource_id: string;
  overview: string | null;
  overview_updated_at: number | null;
  stelis: null;
  messages: NativeMessage[];
}

export interface SaiverseMemoryExport {
  format: typeof MEMORY_FORMAT;
  exported_at: string;
  persona_id: string;
  threads: NativeThread[];
}

export interface LiteBackup {
  format: typeof BACKUP_FORMAT;
  exported_at: string;
  includes_api_keys: false;
  data: RepositorySnapshot;
}

export interface ImportedNativeData {
  threads: ConversationThread[];
  messages: ChatMessage[];
  memories: MemoryEntry[];
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function epochSeconds(value: number): number {
  return Math.floor(value / 1000);
}

function withTags(metadata: Record<string, unknown>, tags: string[]): Record<string, unknown> {
  const existing = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : [];
  return { ...metadata, tags: [...new Set([...existing, ...tags])] };
}

export function exportPersona(persona: Persona, now = Date.now()): LitePersonaExport {
  return {
    format: PERSONA_FORMAT,
    exported_at: iso(now),
    persona: structuredClone(persona),
    saiverse_blueprint: {
      name: persona.name,
      description: persona.description,
      system_prompt: persona.systemPrompt,
      entity_type: "ai",
    },
  };
}

function exportConversationThread(
  persona: Persona,
  thread: ConversationThread,
  messages: ChatMessage[],
): NativeThread {
  return {
    thread_id: `${persona.id}:${thread.id}`,
    resource_id: persona.id,
    overview: thread.title,
    overview_updated_at: epochSeconds(thread.updatedAt),
    stelis: null,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      resource_id: persona.id,
      created_at: epochSeconds(message.createdAt),
      metadata: withTags(
        {
          ...message.metadata,
          lite_message_id: message.id,
          lite_thread_id: thread.id,
          edited_at: message.editedAt === null ? null : iso(message.editedAt),
          tool_call_id: message.toolCallId,
          tool_name: message.toolName,
        },
        ["conversation", "saiverse_lite"],
      ),
    })),
  };
}

function exportMemoryThread(persona: Persona, memories: MemoryEntry[]): NativeThread {
  const updatedAt = memories.reduce((max, memory) => Math.max(max, memory.updatedAt), persona.updatedAt);
  return {
    thread_id: `${persona.id}:lite-memory`,
    resource_id: persona.id,
    overview: "SAIVerse Lite long-term memory",
    overview_updated_at: epochSeconds(updatedAt),
    stelis: null,
    messages: memories.map((memory) => ({
      id: memory.id,
      role: "assistant",
      content: memory.content,
      resource_id: persona.id,
      created_at: epochSeconds(memory.createdAt),
      metadata: {
        tags: ["memory", memory.kind, "saiverse_lite"],
        lite_memory_id: memory.id,
        lite_thread_id: memory.threadId,
        source_message_ids: memory.sourceMessageIds,
        updated_at: iso(memory.updatedAt),
      },
    })),
  };
}

export function exportSaiverseMemory(
  persona: Persona,
  threads: ConversationThread[],
  messages: ChatMessage[],
  memories: MemoryEntry[],
  now = Date.now(),
): SaiverseMemoryExport {
  const nativeThreads = threads
    .filter((thread) => thread.personaId === persona.id)
    .map((thread) => exportConversationThread(
      persona,
      thread,
      messages.filter((message) => message.threadId === thread.id),
    ));
  if (memories.some((memory) => memory.personaId === persona.id)) {
    nativeThreads.push(exportMemoryThread(persona, memories.filter((memory) => memory.personaId === persona.id)));
  }
  return {
    format: MEMORY_FORMAT,
    exported_at: iso(now),
    persona_id: persona.id,
    threads: nativeThreads,
  };
}

export function exportFullBackup(snapshot: RepositorySnapshot, now = Date.now()): LiteBackup {
  return {
    format: BACKUP_FORMAT,
    exported_at: iso(now),
    includes_api_keys: false,
    data: {
      ...structuredClone(snapshot),
      providers: snapshot.providers.map((provider) => ({ ...provider, apiKey: "" })),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function parseFullBackup(value: unknown): RepositorySnapshot {
  if (!isRecord(value) || value.format !== BACKUP_FORMAT || !isRecord(value.data)) {
    throw new Error(`Unsupported backup format (expected ${BACKUP_FORMAT})`);
  }
  const data = value.data;
  const settings = isRecord(data.settings)
    ? { ...DEFAULT_SETTINGS, ...data.settings, id: "app" as const }
    : { ...DEFAULT_SETTINGS };
  return {
    personas: requireArray(data.personas, "data.personas") as Persona[],
    threads: requireArray(data.threads, "data.threads") as ConversationThread[],
    messages: requireArray(data.messages, "data.messages") as ChatMessage[],
    memories: requireArray(data.memories, "data.memories") as MemoryEntry[],
    providers: requireArray(data.providers, "data.providers").map((item) => ({ ...(item as object), apiKey: "" })) as RepositorySnapshot["providers"],
    settings,
  };
}

function fromEpoch(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  return value * 1000;
}

function metadataOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function importSaiverseMemory(value: unknown, targetPersonaId: string): ImportedNativeData {
  if (!isRecord(value) || value.format !== MEMORY_FORMAT) {
    throw new Error(`Unsupported memory format (expected ${MEMORY_FORMAT})`);
  }
  const rawThreads = requireArray(value.threads, "threads");
  const threads: ConversationThread[] = [];
  const messages: ChatMessage[] = [];
  const memories: MemoryEntry[] = [];

  for (const rawThread of rawThreads) {
    if (!isRecord(rawThread) || typeof rawThread.thread_id !== "string") throw new Error("thread_id is required");
    const rawMessages = requireArray(rawThread.messages, `threads[${rawThread.thread_id}].messages`);
    const isMemoryThread = rawThread.thread_id.endsWith(":lite-memory");
    if (isMemoryThread) {
      for (const rawMessage of rawMessages) {
        if (!isRecord(rawMessage)) continue;
        const metadata = metadataOf(rawMessage.metadata);
        const id = stringOrNull(metadata.lite_memory_id) ?? stringOrNull(rawMessage.id) ?? `memory_${crypto.randomUUID()}`;
        const createdAt = fromEpoch(rawMessage.created_at);
        const updatedAt = typeof metadata.updated_at === "string" ? Date.parse(metadata.updated_at) : createdAt;
        memories.push({
          id,
          personaId: targetPersonaId,
          threadId: stringOrNull(metadata.lite_thread_id),
          kind: Array.isArray(metadata.tags) && metadata.tags.includes("summary") ? "summary" : "note",
          content: typeof rawMessage.content === "string" ? rawMessage.content : "",
          sourceMessageIds: Array.isArray(metadata.source_message_ids)
            ? metadata.source_message_ids.filter((item): item is string => typeof item === "string")
            : [],
          createdAt,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : createdAt,
        });
      }
      continue;
    }

    const firstMetadata = rawMessages.length > 0 && isRecord(rawMessages[0]) ? metadataOf(rawMessages[0].metadata) : {};
    const suffix = rawThread.thread_id.includes(":") ? rawThread.thread_id.slice(rawThread.thread_id.indexOf(":") + 1) : rawThread.thread_id;
    const threadId = stringOrNull(firstMetadata.lite_thread_id) ?? suffix;
    const createdValues = rawMessages.filter(isRecord).map((item) => fromEpoch(item.created_at));
    const createdAt = createdValues.length ? Math.min(...createdValues) : Date.now();
    const overviewUpdatedAt = typeof rawThread.overview_updated_at === "number"
      ? fromEpoch(rawThread.overview_updated_at)
      : createdAt;
    const updatedAt = Math.max(overviewUpdatedAt, ...(createdValues.length ? createdValues : [createdAt]));
    threads.push({
      id: threadId,
      personaId: targetPersonaId,
      title: typeof rawThread.overview === "string" && rawThread.overview ? rawThread.overview : "インポートした会話",
      createdAt,
      updatedAt,
    });
    for (const rawMessage of rawMessages) {
      if (!isRecord(rawMessage)) continue;
      const metadata = metadataOf(rawMessage.metadata);
      const role = rawMessage.role === "assistant" || rawMessage.role === "tool" ? rawMessage.role : "user";
      const created = fromEpoch(rawMessage.created_at);
      const editedAt = typeof metadata.edited_at === "string" ? Date.parse(metadata.edited_at) : null;
      messages.push({
        id: stringOrNull(metadata.lite_message_id) ?? stringOrNull(rawMessage.id) ?? `message_${crypto.randomUUID()}`,
        threadId,
        personaId: targetPersonaId,
        role,
        content: typeof rawMessage.content === "string" ? rawMessage.content : "",
        createdAt: created,
        editedAt: editedAt !== null && Number.isFinite(editedAt) ? editedAt : null,
        toolCallId: stringOrNull(metadata.tool_call_id),
        toolName: metadata.tool_name === "memory_recall" || metadata.tool_name === "image_generate" ? metadata.tool_name : null,
        metadata,
      });
    }
  }
  return { threads, messages, memories };
}

export function stringifyExport(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
