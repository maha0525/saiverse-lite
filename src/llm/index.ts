import type { ProviderConfig } from "../domain";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { MockProvider } from "./mock";
import { OpenAiProvider } from "./openai";
import type { LlmProvider } from "./types";

export function createProvider(config: ProviderConfig): LlmProvider {
  switch (config.kind) {
    case "mock": return new MockProvider(config);
    case "anthropic": return new AnthropicProvider(config);
    case "gemini": return new GeminiProvider(config);
    case "openai":
    case "openai-compatible":
      return new OpenAiProvider(config);
  }
}
