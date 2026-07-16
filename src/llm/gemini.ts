import type { ProviderConfig, ToolId } from "../domain";
import { readSse, safeJson } from "./sse";
import { assertOk, type ImageGenerationResult, type LlmProvider, type ProviderEvent, type ProviderMessage, type ProviderRequest } from "./types";

interface GeminiPart { [key: string]: unknown }
interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }

function geminiMessages(messages: ProviderMessage[], memoryContext: string): GeminiContent[] {
  const result: GeminiContent[] = [];
  if (memoryContext) result.push({ role: "user", parts: [{ text: `【長期記憶（システム提供）】\n${memoryContext}` }] });
  for (const message of messages) {
    if (message.role === "tool") {
      result.push({ role: "user", parts: [{ functionResponse: { name: message.toolName, response: { result: message.content } } }] });
    } else if (message.role === "assistant" && message.toolCalls.length > 0) {
      result.push({
        role: "model",
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...message.toolCalls.map((call) => ({ functionCall: { name: call.name, args: call.arguments } })),
        ],
      });
    } else {
      result.push({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] });
    }
  }
  return result;
}

function toolConfig(request: ProviderRequest): Record<string, unknown>[] {
  return [{
    functionDeclarations: request.tools.map((tool) => ({
      name: tool.id,
      description: tool.description,
      // Gemini's `parameters` field accepts only its restricted OpenAPI Schema.
      // `parametersJsonSchema` is the full JSON Schema field and preserves
      // constraints such as additionalProperties: false.
      parametersJsonSchema: tool.inputSchema,
    })),
  }];
}

function approxTokens(systemPrompt: string, contents: GeminiContent[]): number {
  return Math.floor((systemPrompt.length + JSON.stringify(contents).length) / 4);
}

export class GeminiProvider implements LlmProvider {
  constructor(readonly config: ProviderConfig) {}

  private headers(): HeadersInit { return { "content-type": "application/json", "x-goog-api-key": this.config.apiKey }; }
  private api(path: string): string { return `${this.config.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`; }

  private async createCache(request: ProviderRequest, prefix: GeminiContent[]): Promise<string | null> {
    if (!this.config.geminiAutoCache || approxTokens(request.systemPrompt, prefix) < 1024 || prefix.length === 0) return null;
    try {
      const response = await fetch(this.api("cachedContents"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: `models/${request.model}`,
          displayName: `saiverse-lite-${Date.now()}`,
          systemInstruction: { parts: [{ text: request.systemPrompt }] },
          contents: prefix,
          tools: toolConfig(request),
          ttl: "300s",
        }),
        signal: request.signal ?? null,
      });
      if (!response.ok) {
        console.log("[SAIVerse Lite][Gemini cache] create failed; inline fallback", { status: response.status });
        return null;
      }
      const payload = await response.json() as { name?: string };
      if (!payload.name) return null;
      console.log("[SAIVerse Lite][Gemini cache] created", { name: payload.name, prefixMessages: prefix.length });
      return payload.name;
    } catch (error) {
      if (request.signal?.aborted) throw error;
      console.log("[SAIVerse Lite][Gemini cache] create failed; inline fallback", error);
      return null;
    }
  }

  private async deleteCache(name: string): Promise<void> {
    try {
      const response = await fetch(this.api(name), { method: "DELETE", headers: this.headers() });
      console.log("[SAIVerse Lite][Gemini cache] deleted", { name, status: response.status });
    } catch (error) {
      console.warn("[SAIVerse Lite][Gemini cache] delete failed; TTL limits the orphan", { name, error });
    }
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const contents = geminiMessages(request.messages, request.memoryContext);
    const prefix = contents.slice(0, -1);
    const cacheName = await this.createCache(request, prefix);
    const body: Record<string, unknown> = {
      contents: cacheName ? contents.slice(-1) : contents,
      tools: toolConfig(request),
      toolConfig: { functionCallingConfig: { mode: request.toolChoice === "none" ? "NONE" : "AUTO" } },
    };
    if (cacheName) body.cachedContent = cacheName;
    else body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
    try {
      const response = await fetch(this.api(`models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: request.signal ?? null,
      });
      await assertOk(response, this.config.label);
      for await (const event of readSse(response)) {
        const parsed = safeJson(event.data);
        if (!parsed) continue;
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        for (const candidate of candidates) {
          const content = (candidate as Record<string, unknown>).content as Record<string, unknown> | undefined;
          const parts = Array.isArray(content?.parts) ? content.parts : [];
          for (const partValue of parts) {
            const part = partValue as Record<string, unknown>;
            if (typeof part.text === "string" && part.text) yield { type: "text", text: part.text };
            const fn = part.functionCall as Record<string, unknown> | undefined;
            if (fn && typeof fn.name === "string") {
              yield {
                type: "tool-call",
                call: {
                  id: `gemini_${crypto.randomUUID()}`,
                  name: fn.name as ToolId,
                  arguments: typeof fn.args === "object" && fn.args !== null ? fn.args as Record<string, unknown> : {},
                },
              };
            }
          }
        }
        const usage = parsed.usageMetadata as Record<string, unknown> | undefined;
        if (usage) {
          yield {
            type: "usage",
            inputTokens: Number(usage.promptTokenCount ?? 0),
            outputTokens: Number(usage.candidatesTokenCount ?? 0),
            cachedTokens: Number(usage.cachedContentTokenCount ?? 0),
          };
        }
      }
    } finally {
      if (cacheName) await this.deleteCache(cacheName);
    }
  }

  async generateImage(prompt: string, signal?: AbortSignal): Promise<ImageGenerationResult> {
    const response = await fetch(this.api(`models/${encodeURIComponent(this.config.imageModel)}:generateContent`), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: signal ?? null,
    });
    await assertOk(response, this.config.label);
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string }; text?: string }> } }> };
    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const image = parts.find((part) => part.inlineData?.data)?.inlineData;
    if (!image?.data) throw new Error("Gemini 画像生成レスポンスに画像がありません");
    return {
      dataUrl: `data:${image.mimeType ?? "image/png"};base64,${image.data}`,
      revisedPrompt: parts.map((part) => part.text ?? "").join("").trim() || null,
    };
  }
}
