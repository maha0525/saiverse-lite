import type { ProviderConfig, ProviderKind } from "./domain";
import { DEFAULT_LITERT_MODEL_ID } from "./llm/litertModels";

/**
 * The one place a model ID is chosen on the user's behalf.
 *
 * This used to be decided in three: the onboarding guide's recommendation, the
 * settings form's blank field, and whatever ended up copied onto a persona.
 * A stale Gemini entry there is how a persona came to hold a model that had
 * gone fully unavailable, while the settings screen showed something else
 * entirely. One table, one answer.
 *
 * Empty means "the app cannot know" - a custom endpoint serves whatever it
 * serves, so the persona screen is where that gets typed.
 */
export const DEFAULT_CHAT_MODEL: Record<ProviderKind, string> = {
  mock: "mock-friendly",
  // Verified live 2026-07-23. The previous default, gemini-3.5-flash, answered
  // 0 of 10 requests that day; 3.6 Flash is its cheaper successor.
  gemini: "gemini-3.6-flash",
  openai: "gpt-5.6-terra",
  anthropic: "claude-sonnet-5",
  "openai-compatible": "",
  // src/llm/litertModels.ts がモデル ID の唯一の正典。ここでは値を直書きしない。
  "litert-local": DEFAULT_LITERT_MODEL_ID,
};

/**
 * The model for the Metabolism steps other than the sluice. Each entry repeats a
 * model ID this file or apiKeyGuideData.ts already names; those files give no
 * cheaper ID for any provider, only display names.
 */
export const DEFAULT_LIGHT_MODEL: Record<ProviderKind, string> = {
  mock: DEFAULT_CHAT_MODEL.mock,
  gemini: DEFAULT_CHAT_MODEL.gemini,
  openai: DEFAULT_CHAT_MODEL.openai,
  anthropic: DEFAULT_CHAT_MODEL.anthropic,
  "openai-compatible": "",
  "litert-local": DEFAULT_CHAT_MODEL["litert-local"],
};

/** A blank lightModel means the model the persona talks with, which is what the settings screen promises. */
export function resolveLightModel(config: ProviderConfig, personaModel: string): string {
  return config.lightModel?.trim() || personaModel || config.defaultModel;
}

/** Image models have no per-persona override, so a blank one disables the tool. */
export const DEFAULT_IMAGE_MODEL: Record<ProviderKind, string> = {
  mock: "mock-image",
  gemini: "gemini-2.5-flash-image",
  openai: "gpt-image-1",
  anthropic: "",
  "openai-compatible": "",
  // Gemma 4 は画像を生成できない (理解専用モデル)。空欄は image_generate ツールを
  // 無効化する既存の仕組みに乗せるためで、persona 側で上書きもできない (§7 参照)。
  "litert-local": "",
};

export const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  mock: "mock://local",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  "openai-compatible": "http://127.0.0.1:1234/v1",
  // litert-local provider は HTTP API を一切叩かない (WASM + 端末内 Engine のみ)。
  // ProviderConfig.baseUrl は必須フィールドなので、mock の "mock://local" と同じ要領で
  // 「実在しないエンドポイント」だと分かる値を置くだけの飾り。
  "litert-local": "local://litert-lm",
};

export const DEFAULT_LABEL: Record<ProviderKind, string> = {
  mock: "モック（APIキー不要）",
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI互換",
  "litert-local": "端末内モデル（Gemma 4）",
};

/**
 * API キー (＝外部への通信) を必要とする provider の種類かどうか。ここに集約することで、
 * provider が増えるたびに chatService 側の条件式を書き足さずに済む。
 */
export const PROVIDER_REQUIRES_API_KEY: Record<ProviderKind, boolean> = {
  mock: false,
  "litert-local": false,
  gemini: true,
  openai: true,
  anthropic: true,
  "openai-compatible": true,
};

export function requiresApiKey(kind: ProviderKind): boolean {
  return PROVIDER_REQUIRES_API_KEY[kind];
}
