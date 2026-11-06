import { describe, expect, it } from "vitest";
import { createDefaultPersona, type Persona, type ProviderConfig } from "./domain";
import { toolDefinitionsFor } from "./tools";

function provider(imageModel: string): ProviderConfig {
  return {
    id: "provider_test",
    kind: "openai",
    label: "テスト",
    apiKey: "key",
    baseUrl: "https://example.invalid/v1",
    defaultModel: "test-model",
    imageModel,
    geminiAutoCache: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function personaWithBothTools(): Persona {
  return { ...createDefaultPersona(1), toolIds: ["memory_recall", "image_generate"] };
}

describe("toolDefinitionsFor", () => {
  it("offers both tools when the provider has an image model", () => {
    const definitions = toolDefinitionsFor(personaWithBothTools(), provider("gpt-image-1"));

    expect(definitions.map((definition) => definition.id)).toEqual(["memory_recall", "image_generate"]);
  });

  // A provider with no image model can only fail the call. Offering the tool anyway
  // burns a tool round and makes the persona explain an error it was set up to hit.
  // Anthropic and every on-device model ship with a blank image model.
  it("hides image generation when the provider has no image model", () => {
    const definitions = toolDefinitionsFor(personaWithBothTools(), provider(""));

    expect(definitions.map((definition) => definition.id)).toEqual(["memory_recall"]);
  });

  it("treats a whitespace-only image model as absent", () => {
    const definitions = toolDefinitionsFor(personaWithBothTools(), provider("   "));

    expect(definitions.map((definition) => definition.id)).toEqual(["memory_recall"]);
  });

  it("never adds a tool the persona did not register", () => {
    const persona: Persona = { ...createDefaultPersona(1), toolIds: ["image_generate"] };

    expect(toolDefinitionsFor(persona, provider("gpt-image-1")).map((definition) => definition.id))
      .toEqual(["image_generate"]);
    expect(toolDefinitionsFor(persona, provider("")).map((definition) => definition.id)).toEqual([]);
  });
});
