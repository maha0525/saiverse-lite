import type { Persona, ProviderConfig, ToolCall, ToolId } from "./domain";
import type { RetryNotice } from "./llm/retry";
import type { LlmProvider, ToolDefinition } from "./llm/types";
import { AtlasRefError, readPage, searchMemory, writePage } from "./memory/atlas";
import { MEMOPEDIA_CATEGORIES } from "./memory/memopedia";
import type { LiteRepository } from "./storage/repository";

export const TOOL_REGISTRY: Record<ToolId, ToolDefinition> = {
  memory_recall: {
    id: "memory_recall",
    description: "ChronicleとMemopedia、Fragment、過去の会話を横断してキーワードで検索します。取得した参照は memory_read で読めます。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "思い出したい内容を表す短い検索語" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  memory_read: {
    id: "memory_read",
    description: "記憶の地図帳（Memory Atlas）の1ページをその場で読みます。読んだ内容は会話の流れに残り、時間とともに流れていきます。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "読みたいページの参照（例: m:3 / core / c:2 / ch:5）" },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
  memory_write: {
    id: "memory_write",
    description: "記憶の地図帳（Memory Atlas）のページに書きます。宛先 memopedia:N は Memopedia ページ本文への追記です。宛先 core は新しいコア記憶を刻みます — コア記憶は常時開の特殊ページで、system プロンプトに常駐し続けます。宛先 core:N は既存コア記憶の上書きです。ref の代わりに title（と category）を指定すると、Memopedia に新しいページを作ります。ref と title はどちらか一方だけ指定してください。Chronicle（chronicle:N）には書けません（時間の地図の編纂はシステムが行います）。",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "書き先の参照（m:3 = 追記 / core = コア記憶新規 / c:2 = コア記憶上書き）。title とは排他" },
        content: { type: "string", description: "書きたい本文" },
        title: { type: "string", description: "新しく作るページの題名。ref とは排他" },
        category: { type: "string", enum: [...MEMOPEDIA_CATEGORIES], description: "新規ページのカテゴリ（title 指定時のみ。既定: terms）" },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  image_generate: {
    id: "image_generate",
    description: "現在のプロバイダの画像生成APIを使い、指定された内容の画像を生成する。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "生成する画像の詳しい説明" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
};

/**
 * A tool the provider cannot perform must not be offered to the model.
 *
 * `image_generate` calls `provider.generateImage()`, which needs an image model
 * to call - a provider without one (Anthropic, and every on-device model) can
 * only fail. Offering it anyway costs a wasted tool round every time the model
 * takes the bait, and the persona has to explain an error it was set up to hit.
 *
 * `providerDefaults.ts` has claimed since the model table was introduced that a
 * blank image model "disables the tool". Nothing implemented that; this does.
 */
export function toolDefinitionsFor(persona: Persona, provider: ProviderConfig): ToolDefinition[] {
  const canGenerateImages = provider.imageModel.trim().length > 0;
  return persona.toolIds
    .filter((id) => id !== "image_generate" || canGenerateImages)
    .map((id) => TOOL_REGISTRY[id]);
}

export interface ToolExecutionResult {
  content: string;
  metadata: Record<string, unknown>;
}

function stringArgument(call: ToolCall, name: string): string | undefined {
  const value = call.arguments[name];
  return typeof value === "string" ? value : undefined;
}

/** A bad reference is the model's to fix, so it comes back as the result. body: builtin_data/tools/memory_read.py. */
async function atlasResult(run: () => Promise<string>): Promise<ToolExecutionResult> {
  try {
    return { content: await run(), metadata: {} };
  } catch (error) {
    if (error instanceof AtlasRefError) return { content: `Error: ${error.message}`, metadata: {} };
    throw error;
  }
}

export async function executeTool(
  repository: LiteRepository,
  persona: Persona,
  provider: LlmProvider,
  call: ToolCall,
  signal?: AbortSignal,
  onRetry?: RetryNotice,
): Promise<ToolExecutionResult> {
  if (!persona.toolIds.includes(call.name)) throw new Error(`未登録のツールです: ${call.name}`);
  console.log("[SAIVerse Lite][tool] start", { personaId: persona.id, tool: call.name, callId: call.id });
  if (call.name === "memory_recall") {
    const query = stringArgument(call, "query")?.trim() ?? "";
    const { text, hitCount } = await searchMemory(repository, persona.id, query);
    console.log("[SAIVerse Lite][tool] memory_recall complete", { query, hits: hitCount });
    return { content: text, metadata: { query, hitCount } };
  }
  if (call.name === "memory_read") return atlasResult(() => readPage(repository, persona.id, stringArgument(call, "ref") ?? ""));
  if (call.name === "memory_write") {
    const ref = stringArgument(call, "ref");
    const title = stringArgument(call, "title");
    const category = stringArgument(call, "category");
    return atlasResult(() => writePage(repository, persona.id, {
      content: stringArgument(call, "content") ?? "",
      ...(ref !== undefined ? { ref } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(category !== undefined ? { category } : {}),
    }));
  }
  const prompt = stringArgument(call, "prompt")?.trim() ?? "";
  if (!prompt) throw new Error("画像生成プロンプトが空です");
  const image = await provider.generateImage(prompt, signal, onRetry);
  console.log("[SAIVerse Lite][tool] image_generate complete", { promptLength: prompt.length });
  return {
    content: JSON.stringify({ ok: true, prompt, revisedPrompt: image.revisedPrompt }),
    metadata: { imageDataUrl: image.dataUrl, prompt, revisedPrompt: image.revisedPrompt },
  };
}
