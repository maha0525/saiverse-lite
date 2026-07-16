import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../domain";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { OpenAiProvider } from "./openai";
import type { ProviderEvent, ProviderRequest } from "./types";

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

async function collectEvents(stream: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
    const cacheBody = JSON.parse(String(calls[0]?.init?.body)) as {
      tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    };
    const generateBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    const expectedSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };
    const cacheDeclaration = cacheBody.tools[0]?.functionDeclarations[0];
    expect(cacheDeclaration?.parameters).toBeUndefined();
    expect(cacheDeclaration?.parametersJsonSchema).toEqual(expectedSchema);
    const generateTools = generateBody.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    const generateDeclaration = generateTools[0]?.functionDeclarations[0];
    expect(generateDeclaration?.parameters).toBeUndefined();
    expect(generateDeclaration?.parametersJsonSchema).toEqual(expectedSchema);
    expect(generateBody.cachedContent).toBe("cachedContents/test");
    expect(generateBody.systemInstruction).toBeUndefined();
  });

  it("sends no cache_control by default (cache is opt-in)", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return new Response(`event: message_stop\ndata: {"type":"message_stop"}\n\n`, { status: 200 });
    }));
    const providerRequest = request([user("hello")]);
    providerRequest.tools = [];
    providerRequest.toolChoice = "none";
    await collectEvents(new AnthropicProvider(config("anthropic")).stream(providerRequest));
    expect(String(captured?.body)).not.toContain("cache_control");
    expect(new Headers(captured?.headers).get("anthropic-beta")).toBeNull();
    const body = JSON.parse(String(captured?.body)) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it("streams Anthropic tools and combines split cache usage without losing input tokens", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = init;
      return new Response([
        `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":1}}}\n\n`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n`,
        `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"memory_recall","input":{}}}\n\n`,
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"cat\\"}"}}\n\n`,
        `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n`,
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n`,
        `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const cachedConfig = { ...config("anthropic"), anthropicCacheTtl: "1h" as const };
    const events = await collectEvents(new AnthropicProvider(cachedConfig).stream(request([user("hello")])));
    const headers = new Headers(captured?.headers);
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe("true");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-beta")).toBe("extended-cache-ttl-2025-04-11");
    const body = JSON.parse(String(captured?.body)) as {
      system: Array<Record<string, unknown>>;
      messages: Array<{ content: Array<Record<string, unknown>> | string }>;
      tools: Array<Record<string, unknown>>;
      tool_choice: Record<string, unknown>;
    };
    expect(body.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    // 履歴末尾にもキャッシュ打点 (会話全体が次ターンでキャッシュ読みになる)
    const lastContent = body.messages[body.messages.length - 1]?.content;
    expect(Array.isArray(lastContent) ? lastContent[lastContent.length - 1]?.cache_control : undefined).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(body.tools[0]).toMatchObject({
      name: "memory_recall",
      input_schema: { type: "object", additionalProperties: false },
    });
    expect(body.tool_choice).toEqual({ type: "auto" });
    expect(events).toContainEqual({ type: "text", text: "hi" });
    expect(events).toContainEqual({ type: "tool-call", call: { id: "toolu_1", name: "memory_recall", arguments: { query: "cat" } } });
    expect(events).toContainEqual({ type: "usage", inputTokens: 35, outputTokens: 7, cachedTokens: 20 });
  });

  it("surfaces an Anthropic SSE error returned after HTTP 200", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )));
    await expect(collectEvents(new AnthropicProvider(config("anthropic")).stream(request([user("hello")]))))
      .rejects.toThrow("anthropic API stream error (overloaded_error): Overloaded");
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

  it("uses the Responses API for OpenAI reasoning models with tools", async () => {
    let capturedUrl = "";
    let captured: RequestInit | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      captured = init;
      return new Response([
        `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"覚えているよ"}\n\n`,
        `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted-reasoning"}}\n\n`,
        `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_2","name":"memory_recall","arguments":"{\\"query\\":\\"cat\\"}"}}\n\n`,
        `event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted-reasoning"},{"type":"function_call","id":"fc_1","call_id":"call_2","name":"memory_recall","arguments":"{\\"query\\":\\"cat\\"}"}],"usage":{"input_tokens":42,"output_tokens":7,"input_tokens_details":{"cached_tokens":12}}}}\n\n`,
      ].join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const providerRequest = request([
      user("思い出して"),
      {
        role: "assistant",
        content: "",
        toolCallId: null,
        toolName: null,
        toolCalls: [{ id: "call_1", name: "memory_recall", arguments: { query: "dog" } }],
        providerState: {
          openaiResponsesOutput: [
            { type: "reasoning", id: "rs_previous", summary: [], encrypted_content: "previous-encrypted-reasoning" },
            { type: "function_call", id: "fc_previous", call_id: "call_1", name: "memory_recall", arguments: "{\"query\":\"dog\"}" },
          ],
        },
      },
      {
        role: "tool",
        content: "犬の記憶",
        toolCallId: "call_1",
        toolName: "memory_recall",
        toolCalls: [],
      },
    ]);
    providerRequest.memoryContext = "猫が好き";
    const events = [];
    for await (const event of new OpenAiProvider(config("openai")).stream(providerRequest)) events.push(event);

    expect(capturedUrl).toBe("https://api.openai.test/v1/responses");
    const body = JSON.parse(String(captured?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "test-model",
      instructions: "fixed system",
      stream: true,
      store: false,
      tool_choice: "auto",
    });
    expect(body.messages).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.tools).toEqual([{
      type: "function",
      name: "memory_recall",
      description: "recall",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
    }]);
    expect(body.input).toEqual([
      { role: "developer", content: "【長期記憶】\n猫が好き" },
      { role: "user", content: "思い出して" },
      { type: "reasoning", id: "rs_previous", summary: [], encrypted_content: "previous-encrypted-reasoning" },
      { type: "function_call", id: "fc_previous", call_id: "call_1", name: "memory_recall", arguments: "{\"query\":\"dog\"}" },
      { type: "function_call_output", call_id: "call_1", output: "犬の記憶" },
    ]);
    expect(events).toContainEqual({ type: "text", text: "覚えているよ" });
    expect(events).toContainEqual({ type: "tool-call", call: { id: "call_2", name: "memory_recall", arguments: { query: "cat" } } });
    expect(events).toContainEqual({
      type: "provider-state",
      state: {
        openaiResponsesOutput: [
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "encrypted-reasoning" },
          { type: "function_call", id: "fc_1", call_id: "call_2", name: "memory_recall", arguments: "{\"query\":\"cat\"}" },
        ],
      },
    });
    expect(events).toContainEqual({ type: "usage", inputTokens: 42, outputTokens: 7, cachedTokens: 12 });
  });
});
