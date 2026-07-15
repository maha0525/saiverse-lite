import { describe, expect, it } from "vitest";
import { buildPersonaPrompt, completeOnboarding, EMPTY_ONBOARDING, loadDraft, loadOnboarding, PERSONA_TEMPLATES, saveDraft, saveOnboarding } from "./onboarding";

function fakeStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

describe("onboarding persistence", () => {
  it("saves and restores mid-wizard progress including drafts", () => {
    const storage = fakeStorage();
    const state = structuredClone(EMPTY_ONBOARDING);
    state.step = "path";
    state.drafts.fork = "new";
    state.drafts.personaName = "ソラ";
    state.drafts.personaPrompt = "書きかけのプロンプト";
    saveOnboarding(state, storage);
    const restored = loadOnboarding(storage);
    expect(restored.step).toBe("path");
    expect(restored.drafts.personaName).toBe("ソラ");
    expect(restored.drafts.personaPrompt).toBe("書きかけのプロンプト");
    expect(restored.completed).toBe(false);
  });

  it("clears drafts (including api key) on completion but keeps the flag", () => {
    const storage = fakeStorage();
    const state = structuredClone(EMPTY_ONBOARDING);
    state.drafts.apiKey = "sk-secret";
    saveOnboarding(state, storage);
    completeOnboarding(storage);
    const restored = loadOnboarding(storage);
    expect(restored.completed).toBe(true);
    expect(restored.drafts.apiKey).toBe("");
  });

  it("returns the empty state for corrupted storage", () => {
    const storage = fakeStorage();
    storage.setItem("saiverse-lite.onboarding.v1", "{broken");
    expect(loadOnboarding(storage).step).toBe("welcome");
  });

  it("keeps generic drafts per key and removes them when emptied", () => {
    const storage = fakeStorage();
    saveDraft("composer.thread_1", "打ちかけの言葉", storage);
    expect(loadDraft("composer.thread_1", storage)).toBe("打ちかけの言葉");
    saveDraft("composer.thread_1", "", storage);
    expect(loadDraft("composer.thread_1", storage)).toBe("");
  });

  it("builds persona prompts with the chosen name", () => {
    const template = PERSONA_TEMPLATES[0]!;
    expect(buildPersonaPrompt("ソラ", template)).toContain("あなたの名前は「ソラ」です。");
    expect(buildPersonaPrompt("  ", template)).toContain("「パートナー」");
  });
});
