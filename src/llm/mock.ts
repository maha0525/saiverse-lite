import type { ProviderConfig } from "../domain";
import type { ImageGenerationResult, LlmProvider, ProviderEvent, ProviderRequest } from "./types";

const MOCK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export class MockProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig) {}

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    let lastUserIndex = -1;
    for (let index = request.messages.length - 1; index >= 0; index -= 1) {
      if (request.messages[index]?.role === "user") { lastUserIndex = index; break; }
    }
    const last = lastUserIndex >= 0 ? request.messages[lastUserIndex] : undefined;
    const toolResult = [...request.messages.slice(lastUserIndex + 1)].reverse().find((message) => message.role === "tool");
    if (!toolResult && request.toolChoice === "auto" && last?.content.includes("思い出して")) {
      yield {
        type: "tool-call",
        call: { id: `mock_call_${crypto.randomUUID()}`, name: "memory_recall", arguments: { query: last.content.replace("思い出して", "").trim() } },
      };
      return;
    }
    const response = toolResult
      ? `記憶を確認したよ。${toolResult.content}`
      : request.toolChoice === "none"
        ? `要約: ${last?.content.slice(0, 300) ?? "会話はまだありません。"}`
        : `モック応答: ${last?.content ?? "こんにちは"}`;
    for (const chunk of response.match(/.{1,8}/gs) ?? [response]) {
      await Promise.resolve();
      yield { type: "text", text: chunk };
    }
    yield { type: "usage", inputTokens: request.messages.length * 8, outputTokens: response.length, cachedTokens: 0 };
  }

  async generateImage(_prompt: string, _signal?: AbortSignal): Promise<ImageGenerationResult> {
    return { dataUrl: MOCK_PNG, revisedPrompt: "モック画像" };
  }
}
