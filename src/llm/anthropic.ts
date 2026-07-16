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

// 会話履歴の末尾にキャッシュ打点を置く。次のターンは「ツール定義+システム+記憶+履歴全体」が
// キャッシュ読み (約1/10価格) になり、増分だけが新規書き込みになる
// (システムプロンプト側の打点と合わせて 2/4 打点を使用)。
function markHistoryCacheBreakpoint(messages: Array<Record<string, unknown>>, cacheControl: Record<string, unknown>): Array<Record<string, unknown>> {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  if (typeof last.content === "string" && last.content) {
    last.content = [{ type: "text", text: last.content, cache_control: cacheControl }];
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const block = last.content[last.content.length - 1] as Record<string, unknown>;
    block.cache_control = cacheControl;
  }
  return messages;
}

interface AnthropicToolAccumulator {
  id: string;
  name: string;
  json: string;
  initialInput: Record<string, unknown> | null;
}

interface AnthropicUsageAccumulator {
  rawInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  seen: boolean;
}

function recordUsage(target: AnthropicUsageAccumulator, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const usage = value as Record<string, unknown>;
  if ("input_tokens" in usage) target.rawInputTokens = Number(usage.input_tokens ?? 0);
  if ("output_tokens" in usage) target.outputTokens = Number(usage.output_tokens ?? 0);
  if ("cache_read_input_tokens" in usage) target.cacheReadTokens = Number(usage.cache_read_input_tokens ?? 0);
  if ("cache_creation_input_tokens" in usage) target.cacheCreationTokens = Number(usage.cache_creation_input_tokens ?? 0);
  target.seen = true;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export class AnthropicProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig) {}

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    // キャッシュは明示設定時のみ (既定 none)。書き込み割増 (5m=1.25倍/1h=2倍) があるため、
    // 返信間隔が TTL を超える使い方では黙って有効化すると逆に割高になる。
    const ttl = this.config.anthropicCacheTtl ?? "none";
    const cacheControl = ttl === "none" ? null : ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    const system: Array<Record<string, unknown>> = [
      cacheControl
        ? { type: "text", text: request.systemPrompt, cache_control: cacheControl }
        : { type: "text", text: request.systemPrompt },
    ];
    if (request.memoryContext) system.push({ type: "text", text: `【長期記憶】\n${request.memoryContext}` });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (ttl === "1h") headers["anthropic-beta"] = "extended-cache-ttl-2025-04-11";
    const baseMessages = anthropicMessages(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: 4096,
      stream: true,
      system,
      messages: cacheControl ? markHistoryCacheBreakpoint(baseMessages, cacheControl) : baseMessages,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({ name: tool.id, description: tool.description, input_schema: tool.inputSchema }));
      body.tool_choice = { type: request.toolChoice };
    }
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });
    await assertOk(response, this.config.label);
    const toolBlocks = new Map<number, AnthropicToolAccumulator>();
    const usage: AnthropicUsageAccumulator = {
      rawInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      seen: false,
    };
    for await (const event of readSse(response)) {
      const parsed = safeJson(event.data);
      if (!parsed) continue;
      const eventType = typeof parsed.type === "string" ? parsed.type : event.event;
      if (eventType === "error") {
        const error = objectValue(parsed.error);
        const errorType = typeof error?.type === "string" ? error.type : "stream_error";
        const message = typeof error?.message === "string" ? error.message : "不明なストリーミングエラー";
        console.error(`[SAIVerse Lite][${this.config.label}] SSE error`, { type: errorType, message });
        throw new Error(`${this.config.label} API stream error (${errorType}): ${message}`);
      }
      if (eventType === "message_start") {
        recordUsage(usage, objectValue(parsed.message)?.usage);
      } else {
        recordUsage(usage, parsed.usage);
      }
      if (eventType === "content_block_start") {
        const block = parsed.content_block as Record<string, unknown> | undefined;
        if (block?.type === "tool_use") {
          toolBlocks.set(Number(parsed.index), {
            id: String(block.id ?? `toolu_${crypto.randomUUID()}`),
            name: String(block.name ?? ""),
            json: "",
            initialInput: objectValue(block.input),
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
          const call: ToolCall = {
            id: current.id,
            name: current.name as ToolId,
            arguments: safeJson(current.json) ?? current.initialInput ?? {},
          };
          yield { type: "tool-call", call };
          toolBlocks.delete(Number(parsed.index));
        }
      }
    }
    if (usage.seen) {
      const inputTokens = usage.rawInputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
      console.debug(`[SAIVerse Lite][${this.config.label}] Usage`, {
        rawInputTokens: usage.rawInputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        inputTokens,
        outputTokens: usage.outputTokens,
      });
      yield {
        type: "usage",
        inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cacheReadTokens,
      };
    }
  }

  async generateImage(_prompt: string, _signal?: AbortSignal): Promise<ImageGenerationResult> {
    throw new Error("Anthropic は画像生成APIを提供していません。画像生成対応プロバイダを選んでください。");
  }
}
