import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../domain";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { OpenAiProvider } from "./openai";
import type { ProviderRequest } from "./types";

function config(kind: ProviderConfig["kind"]): ProviderConfig {
  return {
    id: kind,
    kind,
    label: kind,
    apiKey: "test-key",
    baseUrl: kind === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : `https://api.${kind}.test/v1`,
    defaultModel: "test-model",
    imageModel: "test-image",
    geminiAutoCache: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function request(messages: ProviderRequest["messages"]): ProviderRequest {
  return {
    model: "test-model",
    systemPrompt: "fixed system",
    memoryContext: "",
    messages,
    tools: [{
      id: "memory_recall",
      description: "recall",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    }],
    toolChoice: "auto",
  };
}

const user = (content: string): ProviderRequest["messages"][number] => ({ role: "user", content, toolCallId: null, toolName: null, toolCalls: [] });
const assistant = (content: string): ProviderRequest["messages"][number] => ({ role: "assistant", content, toolCallId: null, toolName: null, toolCalls: [] });

afterEach(() => vi.unstubAllGlobals());

describe("provider transports", () => {
  it("uses and always deletes a Gemini explicit cache", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/cachedContents")) return new Response(JSON.stringify({ name: "cachedContents/test" }), { status: 200 });
      if (url.includes(":streamGenerateContent")) {
        return new Response(`data: {"candidates":[{"content":{"parts":[{"text":"hello"}]}}],"usageMetadata":{"promptTokenCount":2000,"candidatesTokenCount":1,"cachedContentTokenCount":1800}}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (url.endsWith("/cachedContents/test")) return new Response(null, { status: 200 });
      return new Response("unexpected", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GeminiProvider(config("gemini"));
    const events = [];
    for await (const event of provider.stream(request([user("a".repeat(5000)), assistant("ok"), user("next")]))) events.push(event);
    expect(events).toContainEqual({ type: "text", text: "hello" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/cachedContents",
      "https://generativelanguage.googleapis.com/v1beta/models/test-model:streamGenerateContent?alt=sse",
      "https://generativelanguage.googleapis.com/v1beta/cachedContents/test",
    ]);
    const generateBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(generateBody.cachedContent).toBe("cachedContents/test");
    expect(generateBody.systemInstruction).toBeUndefined();
  });

  it("sends no cache_control by default (cache is opt-in)", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return new Response(`event: message_stop\ndata: {"type":"message_stop"}\n\n`, { status: 200 });
    }));
    for await (const _event of new AnthropicProvider(config("anthropic")).stream(request([user("hello")]))) { /* drain */ }
    expect(String(captured?.body)).not.toContain("cache_control");
    expect(new Headers(captured?.headers).get("anthropic-beta")).toBeNull();
  });

  it("sets Anthropic browser header and both cache breakpoints when TTL is chosen", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return new Response(`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`, { status: 200 });
    }));
    const events = [];
    const cachedConfig = { ...config("anthropic"), anthropicCacheTtl: "1h" as const };
    for await (const event of new AnthropicProvider(cachedConfig).stream(request([user("hello")]))) events.push(event);
    const headers = new Headers(captured?.headers);
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(headers.get("anthropic-beta")).toBe("extended-cache-ttl-2025-04-11");
    const body = JSON.parse(String(captured?.body)) as { system: Array<Record<string, unknown>>; messages: Array<{ content: Array<Record<string, unknown>> | string }> };
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // 履歴末尾にもキャッシュ打点 (会話全体が次ターンでキャッシュ読みになる)
    const lastContent = body.messages[body.messages.length - 1]?.content;
    expect(Array.isArray(lastContent) ? lastContent[lastContent.length - 1]?.cache_control : undefined).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(events).toContainEqual({ type: "text", text: "hi" });
  });

  it("assembles streamed OpenAI-compatible function arguments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"memory_recall","arguments":"{\\"query\\":\\"cat\\"}"}}]}}]}\n\ndata: [DONE]\n\n`,
      { status: 200 },
    )));
    const events = [];
    for await (const event of new OpenAiProvider(config("openai-compatible")).stream(request([user("remember")]))) events.push(event);
    expect(events).toContainEqual({ type: "tool-call", call: { id: "call_1", name: "memory_recall", arguments: { query: "cat" } } });
  });
});
