import { createChatMessage, newId, SYSTEM_NOTICE_KEY, type ChatMessage, type PageRecord, type Persona, type PersonaSession } from "../domain";
import type { JsonSchema, LlmProvider } from "../llm/types";
import type { RetryNotice } from "../llm/retry";
import { CATEGORY_CORE, epochSeconds, softDeleteCoreMemory } from "../pageRecords";
import type { LiteRepository } from "../storage/repository";
import { composeMessages } from "./conversation";
import { coreMemoriesInOrder, coreMemoryId } from "./head";
import { noticeMessage, presentHead } from "./notices";

// A port of the core memory columns of the body's sea/sluice.py. The notebook and
// promise columns wait for a notebook in Lite (docs/intent/saiverse_lite.md §12).

const MAX_OUTPUT_TOKENS = 4096;
const SCENE_PREVIEW_CHARS = 80;
/** body: builtin_data/tools/_core_memory_common.py DEFAULT_CORE_MEMORY_CHAR_BUDGET. */
export const CORE_MEMORY_CHAR_BUDGET = 2000;

const CORE_REF_DESCRIPTION = "同梱の「現在のコア記憶」一覧の core:N をそのまま写す (例: core:2)。";
const CORE_REF = /^core:([0-9]{1,9})$/;

export const SLUICE_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    reflection: { type: "string", description: "採取判断の短い独白。採取なしでも一言。" },
    core_adds: {
      type: "array",
      description: "新しく刻むコア記憶。採取なしなら空配列。",
      items: {
        type: "object",
        properties: { content: { type: "string", description: "新しいコア記憶の本文" } },
        required: ["content"],
      },
    },
    core_updates: {
      type: "array",
      description: "書き換え。memory_ref は同梱の一覧の core:N をそのまま写し、content は書き換え後の本文 (全文)。採取なしなら空配列。",
      items: {
        type: "object",
        properties: {
          memory_ref: { type: "string", description: CORE_REF_DESCRIPTION },
          content: { type: "string", description: "書き換え後の本文 (全文)。" },
        },
        required: ["memory_ref", "content"],
      },
    },
    core_removes: {
      type: "array",
      description: "不要になったコア記憶の削除。採取なしなら空配列。",
      items: {
        type: "object",
        properties: { memory_ref: { type: "string", description: CORE_REF_DESCRIPTION } },
        required: ["memory_ref"],
      },
    },
  },
  required: ["reflection", "core_adds", "core_updates", "core_removes"],
};

type CoreField = "core_adds" | "core_updates" | "core_removes";
type SluiceOp = Record<string, string>;

interface SluiceResult {
  reflection: string;
  fields: Record<CoreField, SluiceOp[]>;
  rejections: string[];
}

const FIELD_LABELS: Record<CoreField, string> = {
  core_adds: "コア記憶の追加",
  core_updates: "コア記憶の書き換え",
  core_removes: "コア記憶の削除",
};
const REQUIRED_FIELDS: Record<CoreField, string[]> = {
  core_adds: ["content"],
  core_updates: ["memory_ref", "content"],
  core_removes: ["memory_ref"],
};

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function isScene(page: PageRecord): boolean {
  return page.metadata.kind === "scene";
}

/** body: `_build_sluice_prompt`, without the notebook sections. */
export function buildSluicePrompt(corePages: PageRecord[]): string {
  const memories = coreMemoriesInOrder(corePages);
  const lines = memories.map((page) => {
    const flat = page.content.replace(/\n/g, " ");
    const body = isScene(page) && flat.length > SCENE_PREVIEW_CHARS ? truncate(flat, SCENE_PREVIEW_CHARS) : page.content;
    return `- [core:${coreMemoryId(page)}] ${body}`;
  });
  const totalChars = memories.reduce((sum, page) => sum + page.content.length, 0);
  return [
    "## 記憶整理の節目 — スルース",
    "まもなく古い会話が記憶整理で押し出されます。この機会に、残しておきたい",
    "ことがあれば、いま記録できます。押し出された後ではこの会話は手元から",
    "消えるため、採るならこのタイミングだけです。",
    "",
    "コア記憶 (core_adds / core_updates / core_removes):",
    "- 状態の変化（生活・仕事・健康・関係性など、いま進行中の事実）。状態には",
    "  日付を含めてください（例: 2026年6月頃〜 ユーザーは海外赴任中、9月帰国予定）。",
    "- 既存のコア記憶と矛盾する新情報（帰国・引っ越しなど。矛盾は core_updates で書き換え）。",
    "",
    "姿勢:",
    "- **採取しないのが普通です。** ほとんどの記憶整理では何も採りません",
    "  （各欄は空配列）。無理に何かを刻もうとしないでください。",
    "- 応答には全ての欄 (reflection / core_adds / core_updates / core_removes) を含めてください。",
    "  採るものが無い欄は空配列で。",
    "- 既にコア記憶にあることは再度採らないでください。",
    "",
    `### 現在のコア記憶（合計 ${totalChars.toLocaleString("en-US")} 字 / 目安 ${CORE_MEMORY_CHAR_BUDGET.toLocaleString("en-US")} 字）`,
    lines.length > 0 ? lines.join("\n") : "（まだコア記憶はありません）",
  ].join("\n");
}

/** body: `_parse_structured_result`. A broken shape throws; one broken element is dropped and recorded. */
export function parseSluiceResult(text: string): SluiceResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`スルースの応答が JSON ではありません: ${text.slice(0, 200)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("スルースの応答がオブジェクトではありません");
  const record = parsed as Record<string, unknown>;
  if (typeof record.reflection !== "string") throw new Error("スルースの応答に reflection がありません");
  const rejections: string[] = [];
  const fields = {} as Record<CoreField, SluiceOp[]>;
  for (const field of ["core_adds", "core_updates", "core_removes"] as const) {
    const value = record[field];
    if (!Array.isArray(value)) throw new Error(`スルースの応答に ${field} の配列がありません`);
    fields[field] = [];
    value.forEach((item: unknown, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`${field}[${index}] がオブジェクトではありません`);
      const op = item as Record<string, unknown>;
      const missing = REQUIRED_FIELDS[field].find((name) => op[name] === undefined || op[name] === null);
      const mistyped = REQUIRED_FIELDS[field].find((name) => typeof op[name] !== "string");
      if (missing) rejections.push(`${FIELD_LABELS[field]}の${index + 1}件目を棄却: 必須欄 ${missing} がありません。`);
      else if (mistyped) rejections.push(`${FIELD_LABELS[field]}の${index + 1}件目を棄却: ${mistyped} が文字列ではありません (${JSON.stringify(op[mistyped])})。`);
      else fields[field].push(op as SluiceOp);
    });
  }
  return { reflection: record.reflection, fields, rejections };
}

function parseCoreRef(raw: string): number | null {
  const match = CORE_REF.exec(raw.trim());
  return match ? Number(match[1]) : null;
}

interface AppliedOps {
  applied: number;
  lines: string[];
}

/**
 * body: `_apply_core_ops`. Updates and removes compare against the text the model
 * was shown, so a stale decision never overwrites an edit made during the call.
 */
async function applyCoreOps(repository: LiteRepository, personaId: string, result: SluiceResult, shown: Map<number, string>): Promise<AppliedOps> {
  const lines: string[] = [];
  let applied = 0;
  const live = async (): Promise<PageRecord[]> => coreMemoriesInOrder(await repository.listPages(personaId, CATEGORY_CORE));

  for (const op of result.fields.core_adds) {
    const content = op.content!.trim();
    if (!content) {
      lines.push("add 失敗: 本文が空でした。");
      continue;
    }
    const duplicate = (await live()).find((page) => page.content.trim() === content);
    if (duplicate) {
      applied += 1;
      lines.push(`コア記憶 core:${coreMemoryId(duplicate)} と同一内容のため再採取をスキップしました。`);
      continue;
    }
    const [page] = await repository.addCoreMemories(personaId, [{ content, confirmed: 0, metadata: { source: "sluice" } }]);
    applied += 1;
    lines.push(`コア記憶 core:${coreMemoryId(page!)} に採取: ${content}`);
  }

  const target = async (ref: string, verb: string): Promise<{ id: number; page: PageRecord } | null> => {
    const id = parseCoreRef(ref);
    if (id === null) {
      lines.push(`${verb} 失敗: memory_ref が core:N の形ではありません (${JSON.stringify(ref)})。`);
      return null;
    }
    const before = shown.get(id);
    if (before === undefined) {
      lines.push(`${verb} 失敗: core:${id} のスナップショット情報が無いため適用しませんでした。`);
      return null;
    }
    const page = (await live()).find((candidate) => coreMemoryId(candidate) === id);
    if (!page || page.content !== before) {
      lines.push(`記憶 core:${id} は実行中に変更されたため適用しませんでした。`);
      return null;
    }
    return { id, page };
  };

  for (const op of result.fields.core_updates) {
    const content = op.content!.trim();
    if (!content) {
      lines.push(`update 失敗: ${op.memory_ref} の新しい本文が空でした。`);
      continue;
    }
    const found = await target(op.memory_ref!, "update");
    if (!found) continue;
    if (isScene(found.page)) {
      lines.push(`update 失敗: core:${found.id} は場面の記憶 (実会話の写し) なので書き換えの対象外です。`);
      continue;
    }
    await repository.putPage({
      ...found.page,
      content,
      updatedAt: epochSeconds(Date.now()),
      metadata: { ...found.page.metadata, confirmed: 0 },
    });
    applied += 1;
    lines.push(`コア記憶 core:${found.id} を更新: ${content}`);
  }

  for (const op of result.fields.core_removes) {
    const found = await target(op.memory_ref!, "remove");
    if (!found) continue;
    await repository.putPage(softDeleteCoreMemory(found.page, epochSeconds(Date.now())));
    applied += 1;
    lines.push(`コア記憶 core:${found.id} を削除しました。`);
  }
  return { applied, lines };
}

/** body: `_persist_record`. A system row, never in the persona's voice; `discardable` keeps a no-op run out of the window. */
async function persistRecord(
  repository: LiteRepository,
  persona: Persona,
  threadId: string,
  text: string,
  prompt: string,
  applied: number,
): Promise<ChatMessage> {
  const record = createChatMessage({
    id: newId("message"),
    threadId,
    personaId: persona.id,
    role: "system",
    content: text,
    createdAt: Date.now(),
    seq: await repository.nextMessageSeq(persona.id),
    scope: applied > 0 ? "committed" : "discardable",
    pairedActionText: prompt,
    metadata: { tags: ["internal", "event_message", "sluice"], [SYSTEM_NOTICE_KEY]: "sluice_capture" },
  });
  await repository.putMessage(record);
  return record;
}

export interface SluiceLlm {
  provider: LlmProvider;
  model: string;
  onRetry?: RetryNotice;
  signal?: AbortSignal;
}

/**
 * Sends the whole window with the head, the way a response is sent, so the persona
 * decides what to keep with its own memory in view. Throws on an unusable reply:
 * the anchor must not move past rows the persona did not get to look at.
 */
export async function runSluice(
  repository: LiteRepository,
  persona: Persona,
  session: PersonaSession,
  threadId: string,
  rows: ChatMessage[],
  llm: SluiceLlm,
): Promise<void> {
  const passphrase = session.passphrase ?? "";
  const corePages = await repository.listPages(persona.id, CATEGORY_CORE);
  const shown = new Map(coreMemoriesInOrder(corePages).map((page) => [coreMemoryId(page), page.content]));
  const prompt = buildSluicePrompt(corePages);
  const completion = await llm.provider.complete({
    model: llm.model,
    systemPrompt: presentHead(session.headText ?? "", passphrase),
    memoryContext: session.chronicleText ?? "",
    messages: [...composeMessages(rows, passphrase, []), noticeMessage(prompt, passphrase)],
    responseSchema: SLUICE_RESPONSE_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...(llm.signal ? { signal: llm.signal } : {}),
    ...(llm.onRetry ? { onRetry: llm.onRetry } : {}),
  });
  const result = parseSluiceResult(completion.text);
  const { applied, lines } = await applyCoreOps(repository, persona.id, result, shown);
  const resultLines = [...result.rejections, ...lines];
  const body = ["記憶整理の節目 — スルースの採取判断:"];
  if (result.reflection.trim()) body.push(`${persona.name || persona.id}の判断: ${result.reflection.trim()}`);
  body.push(...resultLines);
  if (applied === 0 && resultLines.length === 0) body.push("今回は採取しませんでした。");
  await persistRecord(repository, persona, threadId, body.join("\n"), prompt, applied);
}
