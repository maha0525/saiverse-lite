// 端末内 LiteRT-LM (Gemma 4 E2B / E4B) provider adapter。
//
// 参照した型定義: node_modules/@litert-lm/core/dist/*.d.ts (@litert-lm/core@0.15.0 固定)。
// 参照した動作実例: spike/local-gemma.ts (docs/gemma4_on_device.md 実装順 A で実機確認済み)。
//
// 会話の作り方: 今回は毎回 Conversation を作り直す (design doc §6.4「最初は正しさを優先」)。
// KV cache を跨いだ再利用は実測してから判断する対象であり、ここでは扱わない。
// 会話履歴の正典は IndexedDB の ChatMessage (呼び出し元の repository) であり、LiteRT-LM の
// Conversation はその都度使い捨てのランタイム表現でしかない — 既存 provider (Gemini/Anthropic/
// OpenAI) と同じ立て付け。
import type {
  ContentPart,
  JsonValue as LiteRtJsonValue,
  Message as LiteRtMessage,
  Schema as LiteRtSchema,
  Tool as LiteRtTool,
  ToolCall as LiteRtToolCall,
} from "@litert-lm/core";
import { newId, type ProviderConfig, type ToolCall, type ToolId } from "../domain";
import { ensureEngine } from "./litertEngine";
import { isLiteRtModelId } from "./litertModels";
import type {
  CompletionRequest,
  CompletionResult,
  ImageGenerationResult,
  LlmProvider,
  ProviderEvent,
  ProviderMessage,
  ProviderRequest,
  ToolDefinition,
} from "./types";

const KNOWN_TOOL_IDS: readonly ToolId[] = ["memory_recall", "memory_read", "memory_write", "image_generate"];

function isToolId(name: string): name is ToolId {
  return (KNOWN_TOOL_IDS as readonly string[]).includes(name);
}

// 固定 prefix (system prompt + Chronicle) の組み立て方。
// 他の provider は Chronicle を role=user の一通で送るが、ここでは従来どおり preface の
// system に積む。preface に user を置いたときの Gemma のチャットテンプレートの挙動は未確認。
function prefaceMessages(request: ProviderRequest): LiteRtMessage[] {
  const messages: LiteRtMessage[] = [];
  if (request.systemPrompt) messages.push({ role: "system", content: request.systemPrompt });
  if (request.memoryContext) messages.push({ role: "system", content: request.memoryContext });
  return messages;
}

// ツール定義は「包んだ形」({ type, function: {...} }) で渡す。
//
// 型定義 (conversation_config.d.ts) は Tool = FunctionDeclaration | FunctionTool と書き、
// 「C++ ランタイムは両方の形を受け付ける」とコメントしているが、包まない形で渡すと実際には
// テンプレート適用が `Failed to apply template: undefined value` で落ちる (2026-08-21 実測)。
// ライブラリ自身のツール実行機構 (dist/orchestration/auto_tool_chat.js) も、包んだ形に
// 変換してから preface.tools へ入れている — そちらが実際に動く形である。
function toLiteRtTools(tools: ToolDefinition[]): LiteRtTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.id,
      description: tool.description,
      // JsonSchema (additionalProperties を持つ) と LiteRT-LM の Schema (持たない) は
      // 型としては別物だが、実行時に additionalProperties が渡らないだけで害はない。
      parameters: tool.inputSchema as unknown as LiteRtSchema,
    },
  }));
}

function toLiteRtToolCall(call: ToolCall): LiteRtToolCall {
  return {
    type: "function",
    id: call.id,
    // ToolCall.arguments (Record<string, unknown>) と LiteRT-LM の Record<string, JsonValue> は
    // 実質同じ JSON 値 (ツール引数は常に JSON) だが、こちら側の型は静的にそれを保証していない
    // ため cast する。
    function: { name: call.name, arguments: call.arguments as unknown as Record<string, LiteRtJsonValue> },
  };
}

// 会話履歴 (これまでのターン) を LiteRT-LM の Message[] へ変換する。
// tool ロールの結果は auto_tool_chat.js が実際に送っている形 (ToolResponsePart の配列) に合わせる
// — dist/orchestration/auto_tool_chat.js を読んで確認した、モデルが受理する tool 結果の形。
function toLiteRtMessage(message: ProviderMessage): LiteRtMessage {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: [{
        type: "tool_response",
        ...(message.toolName ? { name: message.toolName } : {}),
        response: message.content,
      }],
    };
  }
  if (message.role === "assistant" && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      ...(message.content ? { content: message.content } : {}),
      tool_calls: message.toolCalls.map(toLiteRtToolCall),
    };
  }
  return { role: message.role, content: message.content };
}

function toLiteRtMessages(messages: ProviderMessage[]): LiteRtMessage[] {
  return messages.map(toLiteRtMessage);
}

// README のサンプルは content[0].text だけを見ているが、複数パートに備えて全パートを走査する
// (spike/local-gemma.ts の extractText と同じ考え方)。Message.channels (thinking 等) は
// ここで意図的に読まない — raw reasoning を本文へ混ぜない、という design doc §6.2 の方針。
function extractText(content: string | ContentPart[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).filter((text) => text.length > 0).join("");
}

function* toolCallEvents(toolCalls: LiteRtToolCall[] | undefined): Generator<ProviderEvent> {
  for (const call of toolCalls ?? []) {
    const name = call.function.name;
    if (!isToolId(name)) {
      console.warn("[SAIVerse Lite][litert-local] unknown tool call ignored", { name, arguments: call.function.arguments });
      continue;
    }
    yield {
      type: "tool-call",
      call: {
        id: call.id ?? newId("litert"),
        name,
        arguments: call.function.arguments,
      },
    };
  }
}

export class LiteRtLocalProvider implements LlmProvider {
  readonly supportsStructuredOutput = false;

  constructor(readonly config: ProviderConfig) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (request.responseSchema) throw new Error("端末内モデル（Gemma 4）は構造化出力に対応していません。");
    const result: CompletionResult = { text: "", inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    const stream = this.stream({
      model: request.model,
      systemPrompt: request.systemPrompt,
      memoryContext: request.memoryContext,
      messages: request.messages,
      tools: [],
      toolChoice: "none",
      ...(request.signal ? { signal: request.signal } : {}),
    });
    for await (const event of stream) {
      if (event.type === "text") result.text += event.text;
      else if (event.type === "usage") {
        result.inputTokens = event.inputTokens;
        result.outputTokens = event.outputTokens;
      }
    }
    return result;
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    if (!isLiteRtModelId(request.model)) {
      throw new Error(`端末内モデルとして認識できないモデル ID です: ${request.model}`);
    }
    const engine = await ensureEngine(request.model);
    // toolChoice: "none" はこのアプリでは今のところ使われないが (chatService は常に "auto")、
    // 契約として存在する以上、preface に tools を積まないことで尊重する
    // (LiteRT-LM に「今回だけツール無効」という別スイッチはないため)。
    const tools = request.toolChoice === "none" || request.tools.length === 0 ? [] : toLiteRtTools(request.tools);
    const conversation = await engine.createConversation({
      preface: {
        messages: prefaceMessages(request),
        ...(tools.length > 0 ? { tools } : {}),
      },
      ...(tools.length > 0 ? { enableConstrainedDecoding: true } : {}),
    });

    let cancelledByUser = false;
    const onAbort = (): void => {
      cancelledByUser = true;
      try {
        conversation.cancel();
      } catch (error) {
        console.error("[SAIVerse Lite][litert-local] conversation.cancel() failed", error);
      }
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (request.signal?.aborted) return;

      const stream = conversation.sendMessageStreaming(toLiteRtMessages(request.messages));
      // ReadableStream の async iteration はブラウザ対応にばらつきがあるため
      // getReader() のループで読む (spike/local-gemma.ts と同じ方針、依頼元の指示)。
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;
          const text = extractText(value.content);
          if (text) yield { type: "text", text };
          yield* toolCallEvents(value.tool_calls);
        }
      } catch (error) {
        // cancel() の後、ストリームは正常終了せず Error: Task cancelled を throw する
        // (§15.2 の実測)。利用者による停止として静かに終える。abort されていないのに
        // 同じ例外が来た場合は本物の異常なので再送出する。
        const isCancelledError = error instanceof Error && error.message === "Task cancelled";
        if (isCancelledError && cancelledByUser) return;
        throw error;
      }

      const tokenCount = await conversation.getTokenCount();
      const benchmark = await conversation.getBenchmarkInfo();
      // preface (system prompt + 長期記憶) の prefill は毎回作り直すため毎ターン走る。
      // KV cache 再利用の判断材料にできるよう、prefill 側の値も含めてログに残す。
      console.log("[SAIVerse Lite][litert-local] turn benchmark", {
        model: request.model,
        prefillTokens: benchmark.lastPrefillTokenCount,
        prefillTokensPerSecond: benchmark.lastPrefillTokensPerSecond,
        decodeTokens: benchmark.lastDecodeTokenCount,
        decodeTokensPerSecond: benchmark.lastDecodeTokensPerSecond,
        timeToFirstTokenInSecond: benchmark.timeToFirstTokenInSecond,
        totalConversationTokens: tokenCount,
      });
      yield {
        type: "usage",
        inputTokens: benchmark.lastPrefillTokenCount,
        outputTokens: benchmark.lastDecodeTokenCount,
        cachedTokens: 0,
      };
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
      try {
        await conversation.delete();
      } catch (error) {
        console.error("[SAIVerse Lite][litert-local] conversation.delete() failed", error);
      }
    }
  }

  async generateImage(_prompt: string, _signal?: AbortSignal): Promise<ImageGenerationResult> {
    // Gemma 4 は画像を理解するモデルであり、生成するモデルではない。Web API も
    // text-in/text-out に限定される (design doc §7)。外部 API へ黙って転送することは
    // 絶対にしない — 「オンデバイス」の表示のまま通信が発生するのは利用者への裏切りになる。
    throw new Error(
      "端末内モデル（Gemma 4）は画像を生成できません。画像生成に対応するプロバイダを選んでください。",
    );
  }
}
