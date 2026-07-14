import type { Persona, ToolCall, ToolId } from "./domain";
import type { LlmProvider, ToolDefinition } from "./llm/types";
import type { LiteRepository } from "./storage/repository";

export const TOOL_REGISTRY: Record<ToolId, ToolDefinition> = {
  memory_recall: {
    id: "memory_recall",
    description: "端末内に保存された、このペルソナ自身の長期記憶をキーワードで検索する。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "思い出したい内容を表す短い検索語" },
      },
      required: ["query"],
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

export function toolDefinitionsFor(persona: Persona): ToolDefinition[] {
  return persona.toolIds.map((id) => TOOL_REGISTRY[id]);
}

export interface ToolExecutionResult {
  content: string;
  metadata: Record<string, unknown>;
}

function terms(value: string): string[] {
  const normalized = value.toLocaleLowerCase("ja").trim();
  const words = normalized.split(/[\s、。,.!?！？]+/).filter(Boolean);
  const result = [...words];
  for (const word of words) {
    if (/^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(word) && word.length >= 2) {
      for (let index = 0; index < word.length - 1; index += 1) result.push(word.slice(index, index + 2));
    }
  }
  return [...new Set(result)];
}

export async function executeTool(
  repository: LiteRepository,
  persona: Persona,
  provider: LlmProvider,
  call: ToolCall,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  if (!persona.toolIds.includes(call.name)) throw new Error(`未登録のツールです: ${call.name}`);
  console.log("[SAIVerse Lite][tool] start", { personaId: persona.id, tool: call.name, callId: call.id });
  if (call.name === "memory_recall") {
    const query = typeof call.arguments.query === "string" ? call.arguments.query.trim() : "";
    const queryTerms = terms(query);
    const memories = await repository.listMemories(persona.id);
    const ranked = memories
      .map((memory) => ({
        memory,
        score: queryTerms.length === 0 ? 1 : queryTerms.reduce((score, term) => score + (memory.content.toLocaleLowerCase("ja").includes(term) ? 1 : 0), 0),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
      .slice(0, 5)
      .map(({ memory }) => ({ id: memory.id, kind: memory.kind, content: memory.content, updatedAt: memory.updatedAt }));
    const content = JSON.stringify({ query, memories: ranked }, null, 2);
    console.log("[SAIVerse Lite][tool] memory_recall complete", { query, hits: ranked.length });
    return { content, metadata: { query, hitCount: ranked.length } };
  }
  const prompt = typeof call.arguments.prompt === "string" ? call.arguments.prompt.trim() : "";
  if (!prompt) throw new Error("画像生成プロンプトが空です");
  const image = await provider.generateImage(prompt, signal);
  console.log("[SAIVerse Lite][tool] image_generate complete", { promptLength: prompt.length });
  return {
    content: JSON.stringify({ ok: true, prompt, revisedPrompt: image.revisedPrompt }),
    metadata: { imageDataUrl: image.dataUrl, prompt, revisedPrompt: image.revisedPrompt },
  };
}
