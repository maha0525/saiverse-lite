import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../domain";
import type { ProviderEvent, ProviderRequest } from "./types";

const ensureEngineMock = vi.fn();
vi.mock("./litertEngine", () => ({
  ensureEngine: (...args: unknown[]) => ensureEngineMock(...args),
}));

// vi.mock は巻き上げられるため、この import は上のモック登録より後に評価される。
import { LiteRtLocalProvider } from "./litertLocal";

interface FakeBenchmark {
  lastPrefillTokensPerSecond: number;
  lastPrefillTokenCount: number;
  lastDecodeTokensPerSecond: number;
  lastDecodeTokenCount: number;
  timeToFirstTokenInSecond: number;
}

interface FakeConversation {
  sendMessageStreaming: (message: unknown) => ReadableStream<Record<string, unknown>>;
  cancel: () => void;
  getTokenCount: () => Promise<number>;
  getBenchmarkInfo: () => Promise<FakeBenchmark>;
  delete: () => Promise<void>;
}

function config(): ProviderConfig {
  return {
    id: "provider_litert",
    kind: "litert-local",
    label: "端末内モデル（Gemma 4）",
    apiKey: "",
    baseUrl: "local://litert-lm",
    defaultModel: "gemma-4-e2b-it-web",
    imageModel: "",
    geminiAutoCache: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

function request(messages: ProviderRequest["messages"], overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "gemma-4-e2b-it-web",
    systemPrompt: "fixed system",
    memoryContext: "",
    messages,
    tools: [],
    toolChoice: "auto",
    ...overrides,
  };
}

const user = (content: string): ProviderRequest["messages"][number] => ({
  role: "user", content, toolCallId: null, toolName: null, toolCalls: [],
});

function streamOf(chunks: Array<Record<string, unknown>>): ReadableStream<Record<string, unknown>> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function fakeConversation(overrides: Partial<FakeConversation> = {}): FakeConversation {
  return {
    sendMessageStreaming: overrides.sendMessageStreaming ?? (() => streamOf([])),
    cancel: overrides.cancel ?? vi.fn(),
    getTokenCount: overrides.getTokenCount ?? vi.fn(async () => 0),
    getBenchmarkInfo: overrides.getBenchmarkInfo ?? vi.fn(async () => ({
      lastPrefillTokensPerSecond: 0,
      lastPrefillTokenCount: 0,
      lastDecodeTokensPerSecond: 0,
      lastDecodeTokenCount: 0,
      timeToFirstTokenInSecond: 0,
    })),
    delete: overrides.delete ?? vi.fn(async () => undefined),
  };
}

// createConversation は渡された ConversationConfig を検証したいので、引数を受ける形で宣言する
// (引数なしで宣言すると mock.calls の型が空タプルになり、呼び出し内容を読めない)。
function fakeEngine(conversation: FakeConversation) {
  return { createConversation: vi.fn(async (_config?: Record<string, unknown>) => conversation) };
}

async function collect(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

afterEach(() => {
  vi.restoreAllMocks();
  ensureEngineMock.mockReset();
});

describe("LiteRtLocalProvider.stream — chunk conversion", () => {
  it("converts a string-content chunk to a text event", async () => {
    const conversation = fakeConversation({
      sendMessageStreaming: () => streamOf([{ role: "assistant", content: "こんにちは" }]),
    });
    ensureEngineMock.mockResolvedValue(fakeEngine(conversation));

    const events = await collect(new LiteRtLocalProvider(config()).stream(request([user("hi")])));

    expect(events).toContainEqual({ type: "text", text: "こんにちは" });
  });

  it("converts a ContentPart[]-content chunk to a text event, joining all text parts", async () => {
    const conversation = fakeConversation({
      sendMessageStreaming: () => streamOf([{
        role: "assistant",
        content: [{ type: "text", text: "パート1" }, { type: "text", text: "パート2" }],
      }]),
    });
    ensureEngineMock.mockResolvedValue(fakeEngine(conversation));

    const events = await collect(new LiteRtLocalProvider(config()).stream(request([user("hi")])));

    expect(events).toContainEqual({ type: "text", text: "パート1パート2" });
  });

  it("converts a known tool call and silently ignores an unknown tool name", async () => {
    const conversation = fakeConversation({
      sendMessageStreaming: () => streamOf([{
        role: "assistant",
        tool_calls: [
          { type: "function", id: "call_1", function: { name: "memory_recall", arguments: { query: "猫" } } },
          { type: "function", id: "call_2", function: { name: "unknown_tool", arguments: {} } },
        ],
      }]),
    });
    ensureEngineMock.mockResolvedValue(fakeEngine(conversation));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const events = await collect(new LiteRtLocalProvider(config()).stream(request([user("思い出して")])));

    expect(events).toContainEqual({
      type: "tool-call",
      call: { id: "call_1", name: "memory_recall", arguments: { query: "猫" } },
    });
    expect(events.filter((event) => event.type === "tool-call")).toHaveLength(1);
  });

  it("reports usage from getBenchmarkInfo() after the stream completes", async () => {
    const conversation = fakeConversation({
      sendMessageStreaming: () => streamOf([{ role: "assistant", content: "ok" }]),
      getBenchmarkInfo: vi.fn(async () => ({
        lastPrefillTokensPerSecond: 200,
        lastPrefillTokenCount: 50,
        lastDecodeTokensPerSecond: 40,
        lastDecodeTokenCount: 12,
        timeToFirstTokenInSecond: 0.2,
      })),
    });
    ensureEngineMock.mockResolvedValue(fakeEngine(conversation));

    const events = await collect(new LiteRtLocalProvider(config()).stream(request([user("hi")])));

    expect(events).toContainEqual({ type: "usage", inputTokens: 50, outputTokens: 12, cachedTokens: 0 });
  });

  it("always deletes the conversation, never the engine, once the turn ends", async () => {
    const conversation = fakeConversation({ sendMessageStreaming: () => streamOf([{ role: "assistant", content: "ok" }]) });
    ensureEngineMock.mockResolvedValue(fakeEngine(conversation));

    await collect(new LiteRtLocalProvider(config()).stream(request([user("hi")])));

    expect(conversation.delete).toHaveBeenCalledTimes(1);
  });
});

describe("LiteRtLocalProvider.stream — cancellation", () => {
  it("ends silently when the abort signal fires and the stream then throws Task cancelled", async () => {
    const controller = new AbortController();
    let pulls = 0;
    const conversation = fakeConversation({
      sendMessageStreaming: () => new ReadableStream({
        pull(streamController) {
          pulls += 1;
          if (pulls === 1) {
            streamController.enqueue({ role: "assistant", content: "途中まで" });
            return undefined;
          }
          // 実際の並び: conversation.cancel() が呼ばれ、その後ストリームが例外で終わる (§15.2)。
          // ここでは cancel() 呼び出しの代わりに abort() 自体でその状況を模している。
          controller.abort();
          return Promise.reject(new Error("Task cancelled"));
        },
      }),
    });
    ensureEngineMock.mockResolvedValue(fakeEngine(conversation));

    const events = await collect(new LiteRtLocalProvider(config()).stream(
      request([user("hi")], { signal: controller.signal }),
    ));

    expect(events).toEqual([{ type: "text", text: "途中まで" }]);
    expect(conversation.delete).toHaveBeenCalledTimes(1);
  });

  it("re-throws Task cancelled when the signal was never aborted (a real anomaly)", async () => {
    const conversation = fakeConversation({
      sendMessageStreaming: () => new ReadableStream({
        pull() {
          return Promise.reject(new Error("Task cancelled"));
        },
      }),
    });
    ensureEngineMock.mockResolvedValue(fakeEngine(conversation));

    await expect(collect(new LiteRtLocalProvider(config()).stream(request([user("hi")]))))
      .rejects.toThrow("Task cancelled");
  });
});

describe("LiteRtLocalProvider.generateImage", () => {
  it("always fails instead of forwarding the prompt to an external API", async () => {
    await expect(new LiteRtLocalProvider(config()).generateImage("猫の絵")).rejects.toThrow();
  });
});

describe("LiteRtLocalProvider.stream — model id validation", () => {
  it("rejects a model id that is not a known local model, without touching the engine", async () => {
    await expect(collect(new LiteRtLocalProvider(config()).stream(request([user("hi")], { model: "gpt-5.6-terra" }))))
      .rejects.toThrow(/gpt-5\.6-terra/);
    expect(ensureEngineMock).not.toHaveBeenCalled();
  });
});

describe("LiteRtLocalProvider.stream — tool definitions", () => {
  // 包まない形 ({ name, description, parameters }) で渡すと、型定義が「両方受け付ける」と
  // 書いているにもかかわらず、実機ではテンプレート適用が
  // `Failed to apply template: undefined value` で落ちる (2026-08-21 実測)。
  // 会話そのものが成立しなくなる壊れ方なので、包んだ形をここで固定する。
  it("wraps each tool as { type: 'function', function: {...} }", async () => {
    const conversation = fakeConversation();
    const engine = fakeEngine(conversation);
    ensureEngineMock.mockResolvedValue(engine);

    await collect(new LiteRtLocalProvider(config()).stream(request([user("hi")], {
      tools: [{
        id: "memory_recall",
        description: "記憶を検索する",
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      }],
    })));

    const passedConfig = engine.createConversation.mock.calls[0]?.[0] as {
      preface?: { tools?: Array<Record<string, unknown>> };
      enableConstrainedDecoding?: boolean;
    };
    expect(passedConfig.preface?.tools).toEqual([{
      type: "function",
      function: {
        name: "memory_recall",
        description: "記憶を検索する",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    }]);
    expect(passedConfig.enableConstrainedDecoding).toBe(true);
  });

  it("omits tools entirely when the caller asks for none", async () => {
    const conversation = fakeConversation();
    const engine = fakeEngine(conversation);
    ensureEngineMock.mockResolvedValue(engine);

    await collect(new LiteRtLocalProvider(config()).stream(request([user("hi")], {
      tools: [{ id: "memory_recall", description: "記憶を検索する", inputSchema: { type: "object", properties: {} } }],
      toolChoice: "none",
    })));

    const passedConfig = engine.createConversation.mock.calls[0]?.[0] as {
      preface?: { tools?: unknown };
      enableConstrainedDecoding?: boolean;
    };
    expect(passedConfig.preface?.tools).toBeUndefined();
    expect(passedConfig.enableConstrainedDecoding).toBeUndefined();
  });
});
