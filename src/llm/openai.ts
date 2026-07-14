import type { ProviderConfig, ToolCall, ToolId } from "../domain";
import { readSse, safeJson } from "./sse";
import {
  assertOk,
  type ImageGenerationResult,
  type LlmProvider,
  type ProviderEvent,
  type ProviderMessage,
  type ProviderRequest,
} from "./types";

function endpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function openAiMessage(message: ProviderMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  if (message.role === "assistant" && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

interface ToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAiProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig) {}

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const messages: Record<string, unknown>[] = [{ role: "system", content: request.systemPrompt }];
    if (request.memoryContext) messages.push({ role: "system", content: `【長期記憶】\n${request.memoryContext}` });
    messages.push(...request.messages.map(openAiMessage));
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
      tools: request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.id, description: tool.description, parameters: tool.inputSchema },
      })),
      tool_choice: request.toolChoice,
    };
    if (this.config.kind === "openai") body.stream_options = { include_usage: true };
    const response = await fetch(endpoint(this.config.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });
    await assertOk(response, this.config.label);
    const calls = new Map<number, ToolAccumulator>();
    for await (const event of readSse(response)) {
      if (event.data === "[DONE]") break;
      const parsed = safeJson(event.data);
      if (!parsed) continue;
      const usage = parsed.usage as Record<string, unknown> | undefined;
      if (usage) {
        yield {
          type: "usage",
          inputTokens: Number(usage.prompt_tokens ?? 0),
          outputTokens: Number(usage.completion_tokens ?? 0),
          cachedTokens: Number((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0),
        };
      }
      const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
      for (const choice of choices) {
        const delta = (choice as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) yield { type: "text", text: delta.content };
        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const rawCall of toolCalls) {
          const raw = rawCall as Record<string, unknown>;
          const index = Number(raw.index ?? 0);
          const fn = raw.function as Record<string, unknown> | undefined;
          const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof raw.id === "string") current.id = raw.id;
          if (typeof fn?.name === "string") current.name += fn.name;
          if (typeof fn?.arguments === "string") current.arguments += fn.arguments;
          calls.set(index, current);
        }
      }
    }
    for (const call of [...calls.values()]) {
      yield {
        type: "tool-call",
        call: {
          id: call.id || `call_${crypto.randomUUID()}`,
          name: call.name as ToolId,
          arguments: safeJson(call.arguments) ?? {},
        },
      };
    }
  }

  async generateImage(prompt: string, signal?: AbortSignal): Promise<ImageGenerationResult> {
    const response = await fetch(endpoint(this.config.baseUrl, "/images/generations"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({ model: this.config.imageModel, prompt, size: "1024x1024" }),
      signal: signal ?? null,
    });
    await assertOk(response, this.config.label);
    const payload = await response.json() as { data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> };
    const first = payload.data?.[0];
    if (!first) throw new Error("画像生成レスポンスに画像がありません");
    const dataUrl = first.b64_json ? `data:image/png;base64,${first.b64_json}` : first.url;
    if (!dataUrl) throw new Error("画像生成レスポンスの形式を解釈できません");
    return { dataUrl, revisedPrompt: first.revised_prompt ?? null };
  }
}
