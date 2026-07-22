import { describe, expect, it } from "vitest";
import { API_KEY_GUIDES, type GuideProviderId } from "./apiKeyGuideData";
import { DEFAULT_CHAT_MODEL } from "./providerDefaults";

describe("provider defaults", () => {
  it("is the only source the onboarding guide recommends from", () => {
    // The guide once carried its own copy, and it went stale: it kept
    // recommending a model that had become fully unavailable, while the rest of
    // the app said otherwise. Re-introducing a second copy fails here.
    for (const id of Object.keys(API_KEY_GUIDES) as GuideProviderId[]) {
      expect(API_KEY_GUIDES[id].recommendedModel).toBe(DEFAULT_CHAT_MODEL[id]);
    }
  });

  it("names a model for every provider the app can know one for", () => {
    expect(DEFAULT_CHAT_MODEL.gemini).toBeTruthy();
    expect(DEFAULT_CHAT_MODEL.openai).toBeTruthy();
    expect(DEFAULT_CHAT_MODEL.anthropic).toBeTruthy();
    expect(DEFAULT_CHAT_MODEL.mock).toBeTruthy();
  });

  it("leaves a custom endpoint blank, because only the user knows what it serves", () => {
    expect(DEFAULT_CHAT_MODEL["openai-compatible"]).toBe("");
  });

  it("does not recommend the Gemini model that went dark on 2026-07-23", () => {
    expect(DEFAULT_CHAT_MODEL.gemini).not.toBe("gemini-3.5-flash");
  });
});
