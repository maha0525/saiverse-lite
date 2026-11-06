// LiteRT-LM の端末内モデル ID から、取得元 URL とサイズ・推奨設定を引く唯一の正典。
// モデル ID の文字列はここにしか書かない — providerDefaults.ts の DEFAULT_CHAT_MODEL や
// litertEngine.ts / litertLocal.ts はすべてこの表のキーを参照する側に回る。
//
// docs/gemma4_on_device.md §5.1 の manifest (revision を固定し、ダウンロード後に SHA-256 を
// 照合する仕組み) は実装順 C (端末保存 / OPFS) の範囲であり、ここには入れていない。
// 今回 (実装順 B) は同 §15.1 の実測どおり、Hugging Face の `/resolve/main/` を検証段階の
// 配布元としてそのまま使う — revision 固定と hash 照合は OPFS 保存を実装するときに追加する。

export type LiteRtModelId = "gemma-4-e2b-it-web" | "gemma-4-e4b-it-web";

export interface LiteRtModelInfo {
  id: LiteRtModelId;
  /**
   * 利用者向けの日本語表示名。実装名 (id) をそのまま見せない。
   * 「端末内」はプロバイダ名 (「端末内モデル（Gemma 4）」) が既に言っているので重ねない。
   * 表示側がサイズを後ろに足すため、末尾を括弧で閉じない (括弧が二重になる)。
   */
  label: string;
  sourceUrl: string;
  /** ダウンロードサイズの目安 (バイト)。公称値であり実測ではない。 */
  approxByteLength: number;
  /** Engine の mainExecutorSettings.maxNumTokens に渡す初期値。両モデルとも 4096 から実測する。 */
  recommendedMaxNumTokens: number;
}

export const LITERT_MODELS: Record<LiteRtModelId, LiteRtModelInfo> = {
  "gemma-4-e2b-it-web": {
    id: "gemma-4-e2b-it-web",
    label: "Gemma 4 E2B 軽量",
    sourceUrl: "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm",
    approxByteLength: 2_010_000_000,
    recommendedMaxNumTokens: 4096,
  },
  "gemma-4-e4b-it-web": {
    id: "gemma-4-e4b-it-web",
    label: "Gemma 4 E4B 高性能",
    sourceUrl: "https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm",
    approxByteLength: 2_970_000_000,
    recommendedMaxNumTokens: 4096,
  },
};

/** persona / provider 設定に載った文字列が既知のモデル ID かどうかを検査する。 */
export function isLiteRtModelId(value: string): value is LiteRtModelId {
  return Object.prototype.hasOwnProperty.call(LITERT_MODELS, value);
}

/**
 * ダウンロードサイズ (バイト) を利用者向けの「約 X.X GB」表示に変換する。
 * バイト数→GB表示の唯一の正典。呼び出し側で独自に割り算しないこと。
 */
export function formatApproxSizeGb(approxByteLength: number): string {
  return `約 ${(approxByteLength / 1_000_000_000).toFixed(1)} GB`;
}

/** 初期提供の既定モデル (design doc §4: 最初は E2B、E4B は高性能端末向けの実験機能)。 */
export const DEFAULT_LITERT_MODEL_ID: LiteRtModelId = "gemma-4-e2b-it-web";
