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

function openAiResponseItems(message: ProviderMessage): Record<string, unknown>[] {
  const rawItems = message.providerState?.openaiResponsesOutput;
  if (!Array.isArray(rawItems)) return [];
  return rawItems.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (item.type === "reasoning") return [item];
    if (
      item.type === "function_call"
      && typeof item.call_id === "string"
      && typeof item.name === "string"
      && typeof item.arguments === "string"
    ) return [item];
    if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)) return [item];
    return [];
  });
}

function responseInputItems(request: ProviderRequest): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  if (request.memoryContext) {
    input.push({ role: "developer", content: `【長期記憶】\n${request.memoryContext}` });
  }
  for (const message of request.messages) {
    if (message.role === "user") {
      input.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const responseItems = openAiResponseItems(message);
      if (responseItems.length > 0) {
        input.push(...responseItems);
        continue;
      }
      if (message.content) input.push({ role: "assistant", content: message.content });
      for (const call of message.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        });
      }
      continue;
    }
    if (message.toolCallId) {
      input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
    } else {
      // 公式エクスポート由来など、呼び出し ID のない tool message は
      // Responses API の function_call_output にできないため、文脈として保持する。
      input.push({ role: "user", content: `【ツール結果】\n${message.content}` });
    }
  }
  return input;
}

function responseTools(request: ProviderRequest): Record<string, unknown>[] {
  return request.tools.map((tool) => ({
    type: "function",
    name: tool.id,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

function streamErrorMessage(event: Record<string, unknown>): string {
  const response = event.response;
  const error = event.error ?? (
    typeof response === "object" && response !== null
      ? (response as Record<string, unknown>).error
      : undefined
  );
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return "OpenAI Responses API stream failed";
}

interface ToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAiProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig) {}

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    if (this.config.kind === "openai") {
      yield* this.streamResponses(request);
      return;
    }
    yield* this.streamChatCompletions(request);
  }

  private async *streamResponses(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const input = responseInputItems(request);
    const tools = responseTools(request);
    const body: Record<string, unknown> = {
      model: request.model,
      instructions: request.systemPrompt,
      input,
      stream: true,
      store: false,
      tools,
      tool_choice: request.toolChoice,
    };
    console.log("[SAIVerse Lite][OpenAI Responses] request", {
      model: request.model,
      inputItems: input.length,
      tools: tools.length,
      toolChoice: request.toolChoice,
      store: false,
    });
    const response = await fetch(endpoint(this.config.baseUrl, "/responses"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });
    await assertOk(response, this.config.label);
    const completedItems: Record<string, unknown>[] = [];
    for await (const event of readSse(response)) {
      const parsed = safeJson(event.data);
      if (!parsed) continue;
      const type = parsed.type;
      if (type === "response.output_text.delta" && typeof parsed.delta === "string" && parsed.delta) {
        yield { type: "text", text: parsed.delta };
        continue;
      }
      if (type === "response.output_item.done") {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item) completedItems.push(item);
        if (item?.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string") {
          yield {
            type: "tool-call",
            call: {
              id: item.call_id,
              name: item.name as ToolId,
              arguments: typeof item.arguments === "string" ? safeJson(item.arguments) ?? {} : {},
            },
          };
        }
        continue;
      }
      if (type === "response.completed") {
        const completed = parsed.response as Record<string, unknown> | undefined;
        const output = Array.isArray(completed?.output)
          ? completed.output.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
          : completedItems;
        const usage = completed?.usage as Record<string, unknown> | undefined;
        const inputDetails = usage?.input_tokens_details as Record<string, unknown> | undefined;
        const inputTokens = Number(usage?.input_tokens ?? 0);
        const outputTokens = Number(usage?.output_tokens ?? 0);
        const cachedTokens = Number(inputDetails?.cached_tokens ?? 0);
        console.log("[SAIVerse Lite][OpenAI Responses] completed", { inputTokens, outputTokens, cachedTokens });
        if (output.length > 0) {
          yield { type: "provider-state", state: { openaiResponsesOutput: output } };
        }
        yield { type: "usage", inputTokens, outputTokens, cachedTokens };
        continue;
      }
      if (type === "error" || type === "response.failed") {
        const message = streamErrorMessage(parsed);
        console.error("[SAIVerse Lite][OpenAI Responses] stream error", { type, message });
        throw new Error(message);
      }
    }
  }

  private async *streamChatCompletions(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
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
