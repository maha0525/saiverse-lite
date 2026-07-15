export type ThemeMode = "system" | "light" | "dark";
export type ProviderKind = "mock" | "openai" | "anthropic" | "gemini" | "openai-compatible";
/** Anthropic プロンプトキャッシュの TTL。書き込みは 5m=1.25倍 / 1h=2倍、読みは 0.1倍。
 *  返信間隔が TTL を超える使い方では逆に割高になるため、既定は "none" (ユーザーが明示的に選ぶ)。 */
export type AnthropicCacheTtl = "none" | "5m" | "1h";
export type MessageRole = "user" | "assistant" | "tool";
export type ToolId = "memory_recall" | "image_generate";

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
}

export interface ToolCall {
  id: string;
  name: ToolId;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  threadId: string;
  personaId: string;
  role: MessageRole;
  content: string;
  createdAt: number;
  editedAt: number | null;
  toolCallId: string | null;
  toolName: ToolId | null;
  metadata: Record<string, unknown>;
}

export type MemoryKind = "summary" | "note";

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
  summaryEveryMessages: number;
  recentContextMessages: number;
  storagePersisted: boolean | null;
  /** 同意済みの法務文書バージョン (legal.ts の LEGAL_VERSION)。未同意は undefined。加算的な任意フィールド (FORMATS.md §6)。 */
  consentVersion?: string;
  consentAt?: number;
}

export interface RepositorySnapshot {
  personas: Persona[];
  threads: ConversationThread[];
  messages: ChatMessage[];
  memories: MemoryEntry[];
  providers: ProviderConfig[];
  settings: AppSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  id: "app",
  theme: "system",
  summaryEveryMessages: 12,
  recentContextMessages: 24,
  storagePersisted: null,
};

export function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
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
    toolIds: ["memory_recall", "image_generate"],
    createdAt: now,
    updatedAt: now,
  };
}
