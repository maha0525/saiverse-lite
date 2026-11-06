// LiteRT-LM Engine の寿命管理。
//
// 前提 (設計上の制約 — この前提が崩れたら作り直しが要る):
// この機構は「ページ全体で Engine を 1 台だけ共有する」ことを前提にしている。
// createProvider() は呼ばれるたびに新しい LiteRtLocalProvider インスタンスを作るため、
// Engine を provider インスタンス側へ持たせると毎回 (約60秒かかる、§15.4 実測) 再初期化が
// 走ってしまう。だからここではモジュールレベルの変数に Engine を保持し、provider は
// 常に ensureEngine() 経由でこの1台を参照する。
// 将来、複数ペルソナが別々のモデルを同時に使う要求が出たら、この「1台だけ共有する」前提
// ごと作り直す必要がある (ペルソナごとの Engine プールなど) — 継ぎ足しでは対応できない。
import { Engine, loadLiteRtLm, type Engine as LiteRtEngine } from "@litert-lm/core";
import { type LiteRtModelId, LITERT_MODELS } from "./litertModels";

// LiteRT-LM の WASM 実体のローカル配信先。scripts/copy-litertlm-wasm.mjs が
// node_modules から public/litertlm-wasm/ へコピーしたものを指す。
// これを渡さないと LiteRtLm.DEFAULT_WASM_PATH (jsdelivr の CDN) から取得されてしまう。
const WASM_LOCAL_PATH = "/litertlm-wasm/";

export type LiteRtEngineStatusValue = "idle" | "loading" | "ready" | "error";

export interface LiteRtEngineStatus {
  status: LiteRtEngineStatusValue;
  modelId: LiteRtModelId | null;
  /** 読み込み開始時刻 (Date.now())。所要時間を UI が計算できるよう ready/error になっても保持する。 */
  startedAt: number | null;
  error: string | null;
}

const IDLE_STATUS: LiteRtEngineStatus = { status: "idle", modelId: null, startedAt: null, error: null };

let currentEngine: LiteRtEngine | null = null;
let currentModelId: LiteRtModelId | null = null;
let currentStatus: LiteRtEngineStatus = IDLE_STATUS;
let loadingPromise: Promise<LiteRtEngine> | null = null;
// loadLiteRtLm() はページの生存期間に一度しか呼べない (2回目は例外 — §15.2)。
// engine.delete() ではこの状態は戻らないため、engine の破棄とは独立して一度きりのガードを持つ。
let wasmLoaded = false;

const listeners = new Set<(status: LiteRtEngineStatus) => void>();

function setStatus(next: LiteRtEngineStatus): void {
  currentStatus = next;
  for (const listener of listeners) listener(currentStatus);
}

/** 現在のエンジン状態を返す (UI が「読み込み中だから会話できない」を出すために使う)。 */
export function getEngineStatus(): LiteRtEngineStatus {
  return currentStatus;
}

/** 状態が変わるたびに呼ばれる。戻り値を呼ぶと購読を解除する。 */
export function subscribe(listener: (status: LiteRtEngineStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** WebGPU 対応状況。UI がローカルモデルの選択可否判定に使う。 */
export function isWebGpuSupported(): boolean {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

/**
 * 読み込み中の経過時間を利用者向け文言にする。
 * Engine.create() は途中経過を返さないため、進捗率は出さず経過時間だけを正直に出す
 * (§15.4 実測: 初回ロードは約60〜120秒)。
 */
export function formatLoadingElapsedMessage(startedAt: number, nowMs: number): string {
  const elapsedSec = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  return `端末内モデルを読み込んでいます…（${elapsedSec}秒経過 / 初回は1分ほどかかります）`;
}

async function ensureWasmLoaded(): Promise<void> {
  if (wasmLoaded) return;
  await loadLiteRtLm(WASM_LOCAL_PATH);
  wasmLoaded = true;
}

async function disposeCurrentEngine(): Promise<void> {
  const engine = currentEngine;
  currentEngine = null;
  currentModelId = null;
  if (!engine) return;
  try {
    await engine.delete();
  } catch (error) {
    console.error("[SAIVerse Lite][litert-engine] engine.delete() failed", error);
  }
}

async function loadEngineFor(modelId: LiteRtModelId): Promise<LiteRtEngine> {
  const startedAt = Date.now();
  setStatus({ status: "loading", modelId, startedAt, error: null });
  // 利用者がモデルを差し替えた場合、古いエンジンを先に破棄してから読み込み直す
  // (要件: 複数モデルを同時に持たず、その場で読み込み直す)。
  if (currentEngine) await disposeCurrentEngine();
  try {
    await ensureWasmLoaded();
    const model = LITERT_MODELS[modelId];
    const engine = await Engine.create({
      model: model.sourceUrl,
      mainExecutorSettings: { maxNumTokens: model.recommendedMaxNumTokens },
      // これを立てないと getBenchmarkInfo() が全項目 0 を返す (§15.2 実測)。速度計測の前提。
      benchmarkEnabled: true,
    });
    currentEngine = engine;
    currentModelId = modelId;
    setStatus({ status: "ready", modelId, startedAt, error: null });
    return engine;
  } catch (error) {
    currentEngine = null;
    currentModelId = null;
    const message = error instanceof Error ? error.message : String(error);
    setStatus({ status: "error", modelId, startedAt, error: message });
    throw error;
  }
}

/**
 * 指定した modelId のエンジンを返す。保持中のエンジンが同じ modelId なら再利用し、
 * 違う modelId なら古いエンジンを破棄してから新しく読み込む。
 * 同時に複数回呼ばれても初期化は一度しか走らない (進行中の Promise を共有する)。
 */
export async function ensureEngine(modelId: LiteRtModelId): Promise<LiteRtEngine> {
  if (currentEngine && currentModelId === modelId) return currentEngine;
  if (loadingPromise) {
    // 進行中の読み込みが終わるのを待ってから、あらためて状況を見て判断し直す
    // (先の読み込みが自分の求める modelId を用意してくれているかもしれない)。
    await loadingPromise.catch(() => undefined);
    return ensureEngine(modelId);
  }
  loadingPromise = loadEngineFor(modelId);
  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

/** 明示的にエンジンを破棄して idle に戻す。 */
export async function disposeEngine(): Promise<void> {
  if (loadingPromise) await loadingPromise.catch(() => undefined);
  await disposeCurrentEngine();
  setStatus(IDLE_STATUS);
}
