import type { ProviderKind } from "./domain";

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
};

/** Image models have no per-persona override, so a blank one disables the tool. */
export const DEFAULT_IMAGE_MODEL: Record<ProviderKind, string> = {
  mock: "mock-image",
  gemini: "gemini-2.5-flash-image",
  openai: "gpt-image-1",
  anthropic: "",
  "openai-compatible": "",
};

export const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  mock: "mock://local",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  "openai-compatible": "http://127.0.0.1:1234/v1",
};

export const DEFAULT_LABEL: Record<ProviderKind, string> = {
  mock: "モック（APIキー不要）",
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI互換",
};
