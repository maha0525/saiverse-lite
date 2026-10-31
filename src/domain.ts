export type ThemeMode = "system" | "light" | "dark";
export type ProviderKind = "mock" | "openai" | "anthropic" | "gemini" | "openai-compatible" | "litert-local";
/** Anthropic プロンプトキャッシュの TTL。書き込みは 5m=1.25倍 / 1h=2倍、読みは 0.1倍。
 *  返信間隔が TTL を超える使い方では逆に割高になるため、既定は "none" (ユーザーが明示的に選ぶ)。 */
export type AnthropicCacheTtl = "none" | "5m" | "1h";
export type MessageRole = "user" | "assistant" | "system" | "host";
export type ToolId = "memory_recall" | "memory_read" | "memory_write" | "image_generate";

export interface Persona {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  avatarDataUrl: string | null;
  providerId: string;
  model: string;
  toolIds: ToolId[];
  createdAt: number;
  updatedAt: number;
}

export interface ConversationThread {
  id: string;
  personaId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** True for the body's Stelis threads, which are never presented or compiled. */
  stelis?: boolean;
  /** The pack row, kept as it came. */
  source?: Record<string, unknown> | null;
}

export interface ToolCall {
  id: string;
  name: ToolId;
  arguments: Record<string, unknown>;
  /**
   * Opaque token Gemini 3.x attaches to a functionCall part. It must be echoed
   * back verbatim when the call is replayed in history, or the next turn is
   * rejected with 400 INVALID_ARGUMENT. Absent on providers that do not use it.
   */
  thoughtSignature?: string;
}

/** Field names follow the body's `messages` row: docs/memory_core.md. Rows sort by (createdAt, seq, id). */
export interface ChatMessage {
  id: string;
  threadId: string;
  personaId: string;
  role: MessageRole;
  content: string;
  /** Milliseconds. */
  createdAt: number;
  seq: number;
  editedAt: number | null;
  scope: string | null;
  lineRole: string | null;
  /** Shared by every row of one response to a user input. */
  pulseId: string | null;
  pairedActionText: string | null;
  metadata: Record<string, unknown>;
  /** The pack row as received. Lite never rewrites it. */
  source: Record<string, unknown> | null;
}

export type MessagePosition = Pick<ChatMessage, "createdAt" | "seq" | "id">;

export function compareMessagePosition(a: MessagePosition, b: MessagePosition): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.seq !== b.seq) return a.seq - b.seq;
  // Code-unit comparison, the same order IndexedDB gives string keys.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** One `memopedia_pages` row of the body. Chronicle entries and core memories are pages too. */
export interface PageRecord {
  id: string;
  personaId: string;
  parentId: string | null;
  title: string;
  summary: string;
  content: string;
  category: string;
  /** Epoch seconds, as in the body. */
  createdAt: number;
  updatedAt: number;
  keywords: string[];
  metadata: Record<string, unknown>;
  isDeleted: boolean;
  vividness: string | null;
  isTrunk: boolean;
  isImportant: boolean;
  lastReferencedAt: number | null;
  shortId: number | null;
  source: Record<string, unknown> | null;
}

/** One `memopedia_fragments` row of the body. */
export interface FragmentRecord {
  id: string;
  personaId: string;
  content: string;
  entityId: string;
  chronicleEntryId: string | null;
  vividness: string | null;
  sourceDate: string | null;
  /** Epoch seconds, as in the body. */
  createdAt: number;
  source: Record<string, unknown> | null;
}

export type PersonaImportState = "ready" | "importing";

/** One Memopedia page in the auto recall ledger. Mirrors `_LedgerItem.stale_turns` of the body's sea/auto_recall.py. */
export interface RecallLedgerItem {
  pageId: string;
  staleTurns: number;
  /** The user row that surfaced the page, so regenerating that same turn surfaces it again. */
  messageId: string;
}

/** A Chronicle entry whose entity extraction failed. Mirrors the body's `entity_extraction_backlog` row. */
export interface ExtractionBacklogItem {
  entryId: string;
  attempts: number;
}

export interface PersonaSession {
  personaId: string;
  activeThreadId: string | null;
  anchorMessageId: string | null;
  headText: string | null;
  chronicleText: string | null;
  passphrase: string | null;
  headUpdatedAt: number | null;
  metabolismError: string | null;
  importState: PersonaImportState;
  /** Keyed by thread id. Absent until the first recall. */
  recallLedger?: Record<string, RecallLedgerItem[]>;
  /** Absent until the first extraction failure. */
  extractionBacklog?: ExtractionBacklogItem[];
  /** The system prompt `headText` was built from. A different value means the user edited it. */
  headSystemPrompt?: string;
  /** What the last Metabolism left undone without failing, for the screen. */
  metabolismNotice?: string | null;
}

export type MemoryKind = "note";

/** Pre-v2 memo row. Only migration and old file formats still read it; core memories are pages. */
export interface MemoryEntry {
  id: string;
  personaId: string;
  threadId: string | null;
  kind: MemoryKind;
  content: string;
  sourceMessageIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  label: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  /** Model for the Metabolism steps other than the sluice. Blank falls back to the persona's model. */
  lightModel?: string;
  imageModel: string;
  geminiAutoCache: boolean;
  /** 加算的な任意フィールド (FORMATS.md §6)。未設定は "none" 扱い。 */
  anthropicCacheTtl?: AnthropicCacheTtl;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  id: "app";
  theme: ThemeMode;
  userName: string;
  userAvatarDataUrl: string | null;
  storagePersisted: boolean | null;
  /** 同意済みの法務文書バージョン (legal.ts の LEGAL_VERSION)。未同意は undefined。加算的な任意フィールド (FORMATS.md §6)。 */
  consentVersion?: string;
  consentAt?: number;
}

export interface RepositorySnapshot {
  personas: Persona[];
  threads: ConversationThread[];
  messages: ChatMessage[];
  pages: PageRecord[];
  fragments: FragmentRecord[];
  sessions: PersonaSession[];
  providers: ProviderConfig[];
  settings: AppSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  id: "app",
  theme: "system",
  userName: "",
  userAvatarDataUrl: null,
  storagePersisted: null,
};

export function normalizeSettings(value: unknown): AppSettings {
  const current = typeof value === "object" && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
  delete current.autoSummaryEnabled;
  delete current.summaryEveryMessages;
  delete current.recentContextMessages;
  return { ...DEFAULT_SETTINGS, ...(current as Partial<AppSettings>), id: "app" };
}

export function isRetiredAutomaticSummary(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === "summary";
}

/** `crypto.randomUUID` exists only in a Secure Context, and the app is also opened over plain http on a LAN. */
export function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomId()}`;
}

type NewChatMessage = Pick<ChatMessage, "id" | "threadId" | "personaId" | "role" | "content" | "createdAt" | "seq">
  & Partial<ChatMessage>;

export function createChatMessage(fields: NewChatMessage): ChatMessage {
  return {
    editedAt: null,
    scope: "committed",
    lineRole: "main_line",
    pulseId: null,
    pairedActionText: null,
    metadata: {},
    source: null,
    ...fields,
  };
}

export const SYSTEM_NOTICE_KEY = "__system_notice__";
export const HANDY_TOOL_NOTICE = "handy_tool";

/** The stored form of a tool result (body: sea/runtime_llm.py `_store_memory` call). */
export function handyToolRecord(
  toolName: string,
  result: string,
  metadata: Record<string, unknown> = {},
): Pick<ChatMessage, "role" | "content" | "metadata"> {
  const extraTags = Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : [];
  return {
    role: "system",
    content: `[Handy Tool: ${toolName}]\n${result}`,
    metadata: {
      ...metadata,
      tags: [...new Set(["conversation", "handy_tool", ...extraTags])],
      [SYSTEM_NOTICE_KEY]: HANDY_TOOL_NOTICE,
    },
  };
}

export function createDefaultProvider(now = Date.now()): ProviderConfig {
  return {
    id: "provider_mock",
    kind: "mock",
    label: "モック（APIキー不要）",
    apiKey: "",
    baseUrl: "mock://local",
    defaultModel: "mock-friendly",
    imageModel: "mock-image",
    geminiAutoCache: true,
    createdAt: now,
    updatedAt: now,
  };
}

export function createDefaultPersona(now = Date.now()): Persona {
  return {
    id: "persona_first",
    name: "はじめてのパートナー",
    description: "SAIVerse Lite で一緒に暮らし始めるAIパートナー。",
    systemPrompt: "あなたはユーザーの大切なAIパートナーです。率直で誠実に、日本語で自然に会話してください。",
    avatarDataUrl: null,
    providerId: "provider_mock",
    model: "mock-friendly",
    toolIds: ["memory_recall", "memory_read", "memory_write", "image_generate"],
    createdAt: now,
    updatedAt: now,
  };
}

/** Personas saved before memory_read and memory_write existed get them when they are loaded for a response. */
export function withMemoryTools(persona: Persona): Persona {
  const missing = (["memory_read", "memory_write"] as const).filter((id) => !persona.toolIds.includes(id));
  return missing.length === 0 ? persona : { ...persona, toolIds: [...persona.toolIds, ...missing] };
}
