// オンデバイス LiteRT-LM (Gemma 4 E2B) 最小スパイク。
//
// docs/gemma4_on_device.md 実装順 A の検証コード。SAIVerse Lite 本体 (src/) の
// コンポーネント体系・状態管理には一切依存しない、素の TypeScript + DOM 操作。
//
// 参照した型定義: node_modules/@litert-lm/core/dist/*.d.ts (@litert-lm/core@0.15.0 固定)
//
// 重要な既知の挙動 (型定義および node_modules/@litert-lm/core/dist/*.js の実装を読んで確認した事実):
// - loadLiteRtLm() は「ロード中 / ロード済みなら例外を投げる」実装 (load_litertlm.js の
//   hasGlobalLiteRtLmPromise() チェック)。エンジン破棄 (engine.delete()) は WASM の
//   グローバルロード状態を戻さないため、2 回目の「エンジン初期化」で無条件に
//   loadLiteRtLm() を呼ぶと必ず失敗する。本ファイルは初回だけ呼ぶガードを入れている。
// - Engine.create() は内部で getOrLoadGlobalLiteRtLm() (引数なし) を呼ぶため、
//   先に loadLiteRtLm('/litertlm-wasm/') を呼んでおけば CDN へは落ちない
//   (LiteRtLm.DEFAULT_WASM_PATH = https://cdn.jsdelivr.net/npm/@litert-lm/core@0.15.0/wasm)。
import type { ContentPart, Engine as LiteRtEngine, Conversation as LiteRtConversation } from "@litert-lm/core";
import { Engine, loadLiteRtLm } from "@litert-lm/core";

// このスパイクでは @webgpu/types を追加インストールしないため、
// navigator.gpu / navigator.deviceMemory の型は spike/webgpu-shims.d.ts で最小限だけ補っている。

const WASM_LOCAL_PATH = "/litertlm-wasm/";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`要素が見つかりません: #${id}`);
  }
  return el as T;
}

const envListEl = byId<HTMLDListElement>("env-list");
const modelUrlInput = byId<HTMLInputElement>("model-url");
const maxTokensInput = byId<HTMLInputElement>("max-tokens");
const initEngineBtn = byId<HTMLButtonElement>("init-engine-btn");
const disposeEngineBtn = byId<HTMLButtonElement>("dispose-engine-btn");
const engineStatusEl = byId<HTMLParagraphElement>("engine-status");
const systemPromptInput = byId<HTMLTextAreaElement>("system-prompt");
const startConversationBtn = byId<HTMLButtonElement>("start-conversation-btn");
const conversationStatusEl = byId<HTMLParagraphElement>("conversation-status");
const messageInput = byId<HTMLInputElement>("message-input");
const sendBtn = byId<HTMLButtonElement>("send-btn");
const cancelBtn = byId<HTMLButtonElement>("cancel-btn");
const outputEl = byId<HTMLDivElement>("output");
const channelsOutputEl = byId<HTMLPreElement>("channels-output");
const benchmarkOutputEl = byId<HTMLPreElement>("benchmark-output");
const logOutputEl = byId<HTMLPreElement>("log-output");

let wasmLoaded = false;
let engine: LiteRtEngine | null = null;
let conversation: LiteRtConversation | null = null;
let isGenerating = false;

// ---------- ログ ----------

function nowStamp(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function log(message: string): void {
  logOutputEl.textContent += `[${nowStamp()}] ${message}\n`;
  logOutputEl.scrollTop = logOutputEl.scrollHeight;
}

// エラーはデバッグのため stack trace まで全文出す (切り詰めない)。
function logError(context: string, error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
  log(`[ERROR] ${context}:\n${detail}`);
}

// ---------- 1. 環境チェック ----------

function formatGB(bytes: number | undefined): string {
  if (bytes === undefined) return "(不明)";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB (${bytes.toLocaleString("ja-JP")} bytes)`;
}

function addEnvRow(label: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  envListEl.append(dt, dd);
}

function disableAllOperations(reason: string): void {
  for (const btn of [initEngineBtn, disposeEngineBtn, startConversationBtn, sendBtn, cancelBtn]) {
    btn.disabled = true;
  }
  messageInput.disabled = true;
  addEnvRow("操作ボタン", `無効化: ${reason}`);
  log(`操作ボタンを無効化しました: ${reason}`);
}

async function runEnvironmentCheck(): Promise<void> {
  envListEl.textContent = "";
  log("環境チェック開始");

  // navigator.gpu
  const gpu = navigator.gpu;
  addEnvRow("navigator.gpu", gpu ? "あり" : "なし");

  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        addEnvRow("adapter 取得", "成功");
        const info = adapter.info;
        if (info) {
          addEnvRow("adapter.info.vendor", info.vendor ?? "(空)");
          addEnvRow("adapter.info.architecture", info.architecture ?? "(空)");
          addEnvRow("adapter.info.device", info.device ?? "(空)");
          addEnvRow("adapter.info.description", info.description ?? "(空)");
        } else {
          addEnvRow("adapter.info", "取得できませんでした (ブラウザ非対応の可能性)");
        }
      } else {
        addEnvRow("adapter 取得", "失敗 (requestAdapter() が null を返しました)");
      }
    } catch (error) {
      addEnvRow("adapter 取得", "例外発生 (詳細はログ欄)");
      logError("navigator.gpu.requestAdapter()", error);
    }
  }

  // navigator.storage.estimate()
  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      addEnvRow("storage quota", formatGB(estimate.quota));
      addEnvRow("storage usage", formatGB(estimate.usage));
    } catch (error) {
      addEnvRow("storage.estimate()", "例外発生 (詳細はログ欄)");
      logError("navigator.storage.estimate()", error);
    }
  } else {
    addEnvRow("navigator.storage.estimate", "未対応");
  }

  // navigator.storage.persisted()
  if (navigator.storage?.persisted) {
    try {
      const persisted = await navigator.storage.persisted();
      addEnvRow("storage persisted", persisted ? "許可済み" : "未許可 (ブラウザ判断で削除され得ます)");
    } catch (error) {
      addEnvRow("storage.persisted()", "例外発生 (詳細はログ欄)");
      logError("navigator.storage.persisted()", error);
    }
  } else {
    addEnvRow("navigator.storage.persisted", "未対応");
  }

  // navigator.deviceMemory (非標準)
  addEnvRow("navigator.deviceMemory", navigator.deviceMemory !== undefined ? `${navigator.deviceMemory} GB (概算・非対応ブラウザあり)` : "(非対応ブラウザ)");

  log("環境チェック完了");

  if (!gpu) {
    disableAllOperations("navigator.gpu が存在しません (WebGPU 非対応ブラウザ)");
  }
}

// ---------- 2. モデル読み込み ----------

function setEngineButtonsBusy(busy: boolean): void {
  initEngineBtn.disabled = busy;
}

function setEngineReadyState(ready: boolean): void {
  disposeEngineBtn.disabled = !ready;
  startConversationBtn.disabled = !ready;
  initEngineBtn.disabled = ready;
}

async function onInitEngine(): Promise<void> {
  if (engine) {
    log("既にエンジンが初期化されています。先に「エンジン破棄」してください。");
    return;
  }

  const modelUrl = modelUrlInput.value.trim();
  if (!modelUrl) {
    log("モデル URL が空です。");
    return;
  }
  const maxNumTokens = Number.parseInt(maxTokensInput.value, 10);
  const effectiveMaxTokens = Number.isFinite(maxNumTokens) && maxNumTokens > 0 ? maxNumTokens : 4096;

  setEngineButtonsBusy(true);
  engineStatusEl.textContent = "初期化中…";
  engineStatusEl.className = "";

  const t0 = performance.now();
  try {
    if (!wasmLoaded) {
      log(`loadLiteRtLm('${WASM_LOCAL_PATH}') を呼び出します (CDN ではなくローカル配信を使う)`);
      await loadLiteRtLm(WASM_LOCAL_PATH);
      wasmLoaded = true;
      const t1 = performance.now();
      log(`WASM ロード完了: ${(t1 - t0).toFixed(0)} ms`);
    } else {
      log("WASM は既にロード済みのため loadLiteRtLm() を再度呼ばずスキップします (2回目呼ぶと 'already loading / loaded' 例外になる)");
    }

    const tModelStart = performance.now();
    log(`Engine.create() 開始 (model=${modelUrl}, maxNumTokens=${effectiveMaxTokens})`);
    engine = await Engine.create({
      model: modelUrl,
      mainExecutorSettings: { maxNumTokens: effectiveMaxTokens },
      // これを立てないと getBenchmarkInfo() が全項目 0 を返す (実測 2026-08-21)。
      // TTFT と decode 速度は本スパイクの主目的なので常に有効化する。
      benchmarkEnabled: true,
    });
    const tModelEnd = performance.now();
    log(`Engine.create() 完了 (モデル読み込み): ${(tModelEnd - tModelStart).toFixed(0)} ms / 総計 ${(tModelEnd - t0).toFixed(0)} ms`);

    engineStatusEl.textContent = "初期化済み";
    engineStatusEl.className = "status-ok";
    setEngineReadyState(true);
  } catch (error) {
    engineStatusEl.textContent = "初期化失敗 (詳細はログ欄)";
    engineStatusEl.className = "status-bad";
    logError("エンジン初期化", error);
    engine = null;
    setEngineReadyState(false);
  } finally {
    setEngineButtonsBusy(false);
  }
}

async function onDisposeEngine(): Promise<void> {
  if (!engine) return;

  disposeEngineBtn.disabled = true;
  try {
    // 会話が残っていればまず破棄しておく。
    if (conversation) {
      try {
        await conversation.delete();
        log("conversation.delete() 完了");
      } catch (error) {
        logError("conversation.delete()", error);
      }
      conversation = null;
      resetConversationUi();
    }

    await engine.delete();
    log("engine.delete() 完了");
    engineStatusEl.textContent = "破棄済み (再初期化可能)";
    engineStatusEl.className = "";
  } catch (error) {
    logError("エンジン破棄", error);
  } finally {
    engine = null;
    setEngineReadyState(false);
  }
}

// ---------- 3. 会話 ----------

function resetConversationUi(): void {
  conversationStatusEl.textContent = "未開始";
  conversationStatusEl.className = "";
  messageInput.disabled = true;
  sendBtn.disabled = true;
  cancelBtn.disabled = true;
  benchmarkOutputEl.textContent = "(未取得)";
  channelsOutputEl.textContent = "(まだデータがありません)";
}

async function onStartConversation(): Promise<void> {
  if (!engine) {
    log("エンジンが初期化されていません。");
    return;
  }

  startConversationBtn.disabled = true;
  conversationStatusEl.textContent = "開始中…";
  conversationStatusEl.className = "";

  try {
    const systemPrompt = systemPromptInput.value.trim();
    conversation = await engine.createConversation({
      preface: {
        messages: systemPrompt ? [{ role: "system", content: systemPrompt }] : [],
      },
    });
    log(`会話開始 (system prompt ${systemPrompt ? `${systemPrompt.length} 文字` : "なし"})`);
    conversationStatusEl.textContent = "開始済み";
    conversationStatusEl.className = "status-ok";
    messageInput.disabled = false;
    sendBtn.disabled = false;
    outputEl.textContent = "";
    channelsOutputEl.textContent = "(まだデータがありません)";
    benchmarkOutputEl.textContent = "(未取得)";
  } catch (error) {
    conversationStatusEl.textContent = "開始失敗 (詳細はログ欄)";
    conversationStatusEl.className = "status-bad";
    logError("会話開始", error);
    conversation = null;
  } finally {
    startConversationBtn.disabled = false;
  }
}

// content は string | ContentPart[] | undefined の union。
// README のサンプルは content[0].text だけを見ているが、複数パートに備えて全パートを走査する。
function extractText(content: string | ContentPart[] | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("");
}

function setGeneratingState(generating: boolean): void {
  isGenerating = generating;
  sendBtn.disabled = generating;
  messageInput.disabled = generating;
  cancelBtn.disabled = !generating;
}

async function onSend(): Promise<void> {
  if (!conversation || isGenerating) return;
  const text = messageInput.value.trim();
  if (!text) return;

  messageInput.value = "";
  outputEl.textContent += `${outputEl.textContent ? "\n\n" : ""}> ${text}\n`;
  const channelsAcc: Record<string, string> = {};
  channelsOutputEl.textContent = "(まだデータがありません)";

  setGeneratingState(true);
  log(`送信: ${text}`);

  try {
    const stream = conversation.sendMessageStreaming(text);
    // README は for-await...of のサンプルだが、ReadableStream の async iteration は
    // ブラウザ対応にばらつきがあるため getReader() のループで読む (依頼元の指示)。
    const reader = stream.getReader();
    let chunkCount = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      chunkCount++;

      const chunkText = extractText(value.content);
      if (chunkText) {
        outputEl.textContent += chunkText;
      }

      if (value.channels) {
        for (const [channel, chunk] of Object.entries(value.channels)) {
          channelsAcc[channel] = (channelsAcc[channel] ?? "") + chunk;
        }
        channelsOutputEl.textContent = JSON.stringify(channelsAcc, null, 2);
      }

      if (value.tool_calls && value.tool_calls.length > 0) {
        log(`予期しない tool_calls を受信 (このスパイクはツール未登録): ${JSON.stringify(value.tool_calls)}`);
      }
    }
    log(`生成完了 (chunk数: ${chunkCount})`);
  } catch (error) {
    logError("送信 / ストリーミング受信", error);
  } finally {
    setGeneratingState(false);
  }

  if (conversation) {
    try {
      const tokenCount = await conversation.getTokenCount();
      // BenchmarkInfo は wasm_binding_types.d.ts で定義されているが、パッケージ直下からは
      // 再エクスポートされていない (index.d.ts は Backend と Wasm 名前空間しか公開しない)。
      // Conversation.getBenchmarkInfo() の戻り値型として推論に任せ、明示 import はしない。
      const benchmark = await conversation.getBenchmarkInfo();
      benchmarkOutputEl.textContent = JSON.stringify({ tokenCount, ...benchmark }, null, 2);
    } catch (error) {
      logError("getTokenCount() / getBenchmarkInfo()", error);
    }
  }
}

function onCancel(): void {
  if (!conversation || !isGenerating) return;
  conversation.cancel();
  log("停止要求送信 (conversation.cancel())");
}

// ---------- 配線 ----------

initEngineBtn.addEventListener("click", () => {
  void onInitEngine();
});
disposeEngineBtn.addEventListener("click", () => {
  void onDisposeEngine();
});
startConversationBtn.addEventListener("click", () => {
  void onStartConversation();
});
sendBtn.addEventListener("click", () => {
  void onSend();
});
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !sendBtn.disabled) {
    void onSend();
  }
});
cancelBtn.addEventListener("click", onCancel);

resetConversationUi();
void runEnvironmentCheck();
log("spike/local-gemma.ts 初期化完了");
