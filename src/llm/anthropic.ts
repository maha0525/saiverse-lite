import type { ProviderConfig, ToolCall, ToolId } from "../domain";
import { readSse, safeJson } from "./sse";
import { assertOk, type ImageGenerationResult, type LlmProvider, type ProviderEvent, type ProviderMessage, type ProviderRequest } from "./types";

function anthropicMessages(messages: ProviderMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content: message.content }] };
    }
    if (message.role === "assistant" && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
        ],
      };
    }
    return { role: message.role, content: message.content };
  });
}

interface AnthropicToolAccumulator { id: string; name: string; json: string }

export class AnthropicProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig) {}

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const system: Array<Record<string, unknown>> = [{ type: "text", text: request.systemPrompt, cache_control: { type: "ephemeral" } }];
    if (request.memoryContext) system.push({ type: "text", text: `【長期記憶】\n${request.memoryContext}` });
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 4096,
        stream: true,
        system,
        messages: anthropicMessages(request.messages),
        tools: request.tools.map((tool) => ({ name: tool.id, description: tool.description, input_schema: tool.inputSchema })),
        tool_choice: { type: request.toolChoice },
      }),
      signal: request.signal ?? null,
    });
    await assertOk(response, this.config.label);
    const toolBlocks = new Map<number, AnthropicToolAccumulator>();
    for await (const event of readSse(response)) {
      const parsed = safeJson(event.data);
      if (!parsed) continue;
      const eventType = typeof parsed.type === "string" ? parsed.type : event.event;
      if (eventType === "content_block_start") {
        const block = parsed.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          toolBlocks.set(Number(parsed.index), {
            id: String(block.id ?? `toolu_${crypto.randomUUID()}`),
            name: String(block.name ?? ""),
            json: "",
          });
        }
      }
      if (eventType === "content_block_delta") {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") yield { type: "text", text: delta.text };
        if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const current = toolBlocks.get(Number(parsed.index));
          if (current) current.json += delta.partial_json;
        }
      }
      if (eventType === "content_block_stop") {
        const current = toolBlocks.get(Number(parsed.index));
        if (current) {
          const call: ToolCall = { id: current.id, name: current.name as ToolId, arguments: safeJson(current.json) ?? {} };
          yield { type: "tool-call", call };
          toolBlocks.delete(Number(parsed.index));
        }
      }
      const usage = parsed.usage as Record<string, unknown> | undefined;
      if (usage) {
        yield {
          type: "usage",
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          cachedTokens: Number(usage.cache_read_input_tokens ?? 0),
        };
      }
    }
  }

  async generateImage(_prompt: string, _signal?: AbortSignal): Promise<ImageGenerationResult> {
    throw new Error("Anthropic は画像生成APIを提供していません。画像生成対応プロバイダを選んでください。");
  }
}
