import type { Persona, PersonaSession } from "../domain";
import type { RetryNotice } from "../llm/retry";
import type { LlmProvider } from "../llm/types";
import type { LiteRepository } from "../storage/repository";
import { compileFold, runBandOverflow, type AuxiliaryLlm } from "./chronicle";
import { extractAndReflect, recordExtractionFailure, retryExtractionBacklog } from "./entities";
import { planEviction } from "./eviction";
import { buildHeadFields } from "./head";
import { runSluice } from "./sluice";
import { CHRONICLE_UNIT_CHARS, METABOLISM_TARGET_CHARS, readWindow, windowNeedsMetabolism } from "./window";

// A port of the body's sea/session_lifecycle.py `_run_metabolism_locked`, without
// folded ranges: everything a run compiles leaves the window through the anchor.

export interface MetabolismOptions {
  repository: LiteRepository;
  persona: Persona;
  provider: LlmProvider;
  /** The model the persona talks with. The sluice uses it. */
  chatModel: string;
  /** The model for the Chronicle and entity extraction steps. */
  lightModel: string;
  /** Closes an undersized tail so the run before a response always makes progress. */
  closeUndersizedTail?: boolean;
  signal?: AbortSignal;
  onRetry?: RetryNotice;
  onStage?(text: string): void;
}

export type MetabolismOutcome =
  /** The anchor moved and the head was rebuilt. */
  | "ok"
  /** Nothing was due, or nothing could be folded yet. */
  | "nothing"
  /** Another run holds this persona. */
  | "busy"
  /** The run failed. `metabolismError` holds the reason and the anchor stayed. */
  | "failed"
  /** The user stopped the response the run was serving. The anchor stayed. */
  | "aborted";

const SLUICE_UNSUPPORTED_NOTICE = "このモデルは構造化出力に対応していないため、会話を送る範囲から外す前にコア記憶へ残す工程（スルース）を飛ばしました。";
const CONSOLIDATION_FAILED_NOTICE = "上位のあらすじの作成に失敗しました。一次あらすじは残っています。次の記憶整理でもう一度試します。";

const runningPersonas = new Set<string>();

/** Keeps runs to one per persona: `navigator.locks` across tabs, the set within this tab when it is missing. */
async function withPersonaLock<T>(personaId: string, run: () => Promise<T>): Promise<T | "busy"> {
  if (runningPersonas.has(personaId)) return "busy";
  runningPersonas.add(personaId);
  try {
    const locks = globalThis.navigator?.locks;
    if (!locks) return await run();
    return await locks.request(`saiverse-lite-metabolism-${personaId}`, { ifAvailable: true }, (lock) => (lock ? run() : "busy" as const));
  } finally {
    runningPersonas.delete(personaId);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runLocked(options: MetabolismOptions): Promise<MetabolismOutcome> {
  const { repository, persona, provider } = options;
  const session = await repository.getSession(persona.id);
  const threadId = session?.activeThreadId;
  const anchorId = session?.anchorMessageId;
  if (!session || !threadId || !anchorId) return "nothing";
  // Read under the lock: an earlier run may have moved the anchor since the caller looked.
  const rows = await readWindow(repository, threadId, anchorId);
  if (!windowNeedsMetabolism(rows)) return "nothing";
  const plan = planEviction(rows, {
    targetChars: METABOLISM_TARGET_CHARS,
    unitChars: CHRONICLE_UNIT_CHARS,
    closeUndersizedTail: options.closeUndersizedTail ?? false,
  });
  if (plan.folds.length === 0) return "nothing";

  options.onStage?.("記憶を整理しています…");
  const shared = {
    ...(options.onRetry ? { onRetry: options.onRetry } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const light: AuxiliaryLlm = { provider, model: options.lightModel, ...shared };
  await retryExtractionBacklog(repository, persona.id, light);

  let consolidationFailed = false;
  for (const fold of plan.folds) {
    await compileFold(repository, persona.id, light, fold, async ({ entryId, messages }) => {
      try {
        await extractAndReflect(repository, persona.id, light, messages, entryId);
      } catch (error) {
        console.error("[SAIVerse Lite][metabolism] entity extraction failed; it will be retried", { entryId, error });
        await recordExtractionFailure(repository, persona.id, entryId);
      }
    });
    consolidationFailed = (await runBandOverflow(repository, persona.id, light)).failed || consolidationFailed;
  }

  let notice: string | null = consolidationFailed ? CONSOLIDATION_FAILED_NOTICE : null;
  if (provider.supportsStructuredOutput) {
    options.onStage?.("残しておきたいことを確かめています…");
    await runSluice(repository, persona, session, threadId, rows, { provider, model: options.chatModel, ...shared });
  } else {
    notice = SLUICE_UNSUPPORTED_NOTICE;
  }

  const evicted = plan.folds.reduce((sum, fold) => sum + fold.length, 0);
  // The last row always stays: the anchor has to point at a real row.
  const newAnchor = rows[Math.min(evicted, rows.length - 1)]!;
  const head = await buildHeadFields(repository, persona, threadId, newAnchor.id);
  await repository.updateSession(persona.id, (current): PersonaSession => {
    const outcome = { ...current, metabolismError: null, metabolismNotice: notice };
    // The user can change thread during a run. The entries it compiled stay; the anchor and head were for the old thread.
    return current.activeThreadId === threadId ? { ...outcome, ...head, anchorMessageId: newAnchor.id } : outcome;
  });
  return "ok";
}

/** Never throws. A failure leaves the anchor where it was, so the next run covers the same rows. */
export async function runMetabolism(options: MetabolismOptions): Promise<MetabolismOutcome> {
  const { repository, persona, signal } = options;
  try {
    return await withPersonaLock(persona.id, () => runLocked(options));
  } catch (error) {
    if (signal?.aborted) return "aborted";
    console.error("[SAIVerse Lite][metabolism] failed", { personaId: persona.id, error });
    const message = `記憶の整理に失敗しました。次の応答のあとにもう一度試します。（${errorText(error)}）`;
    await repository.updateSession(persona.id, (session) => ({ ...session, metabolismError: message }));
    return "failed";
  }
}
