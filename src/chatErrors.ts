import { ProviderHttpError } from "./llm/types";

export type ChatOperation = "send" | "regenerate";

export class ChatOperationError extends Error {
  constructor(
    readonly operation: ChatOperation,
    readonly originalError: unknown,
    readonly rollbackSucceeded: boolean,
    readonly rollbackError: unknown = null,
  ) {
    super(originalError instanceof Error ? originalError.message : String(originalError), {
      cause: originalError,
    });
    this.name = "ChatOperationError";
  }
}

export interface ChatErrorPresentation {
  title: string;
  message: string;
  detail: string;
}

function rawError(error: unknown): string {
  if (error instanceof ProviderHttpError) {
    const model = error.model ? `\nmodel: ${error.model}` : "";
    return `${error.provider} API error (${error.status})${model}\n${error.responseBody}`;
  }
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  return String(error);
}

function operationState(error: ChatOperationError | null, operation: ChatOperation): string {
  if (!error) return "";
  if (operation === "send") {
    return error.rollbackSucceeded
      ? "送信内容は履歴に残さず、入力欄へ戻しました。"
      : "送信内容は入力欄へ戻しましたが、履歴の巻き戻しに失敗した可能性があります。技術的な詳細を添えてサポートへご連絡ください。";
  }
  return error.rollbackSucceeded
    ? "元の返答はそのまま残しています。"
    : "元の返答を戻せなかった可能性があります。技術的な詳細を添えてサポートへご連絡ください。";
}

function withState(message: string, state: string): string {
  return state ? `${message} ${state}` : message;
}

export function presentChatError(error: unknown, fallbackOperation: ChatOperation): ChatErrorPresentation {
  const operationError = error instanceof ChatOperationError ? error : null;
  const operation = operationError?.operation ?? fallbackOperation;
  const original = operationError?.originalError ?? error;
  const state = operationState(operationError, operation);
  const detail = [
    rawError(original),
    operationError?.rollbackError ? `[会話履歴の巻き戻しエラー]\n${rawError(operationError.rollbackError)}` : "",
  ].filter(Boolean).join("\n\n");

  if (original instanceof ProviderHttpError) {
    const provider = original.provider;
    const body = original.responseBody.toLowerCase();

    // A 429 is the caller's own allowance running out, not the service being
    // busy. Calling it congestion sends the user to wait for a spike that will
    // never pass, and hides the setting they actually need to change.
    if (original.status === 429) {
      if (/perday|per day|daily/.test(body)) {
        return {
          title: "今日の利用枠を使い切りました",
          message: withState(
            `${provider}のAPIキーに割り当てられた1日分の上限に達しています。混雑ではないので待っても戻りません。日付が変わるまで待つか、設定画面で別のモデルへ切り替えるか、${provider}側で有料プランに切り替えてください。`,
            state,
          ),
          detail,
        };
      }
      return {
        title: "送信のペースが上限に達しました",
        message: withState(
          `${provider}のAPIキーが、短い時間に送れる回数の上限に達しました。無料枠では特に低く設定されています。少し置いてからもう一度お試しください。繰り返し出る場合は設定画面で別のモデルへ切り替えてください。`,
          state,
        ),
        detail,
      };
    }

    if (/high demand|unavailable|overload|overloaded|capacity|temporar/.test(body)) {
      // Naming the model matters: a persona carries its own model that wins over
      // the one in settings, so "I already switched models" and "the failing
      // model" are routinely two different things.
      const named = original.model ? `モデル「${original.model}」` : "選んでいるモデル";
      return {
        title: "いま使えないモデルです",
        message: withState(
          `${provider}側が混み合っていて、${named}が応答を返せません。あなたの操作や設定が原因ではありません。`
          + `この混雑はモデルごとに起きるため、直らないときはパートナー画面の「モデルID」を別のモデルへ変えてください`
          + `（設定画面の会話モデルIDより、パートナー側の指定が優先されます）。`,
          state,
        ),
        detail,
      };
    }
    if (original.status >= 500) {
      return {
        title: `${provider}で一時的な問題が起きています`,
        message: withState("AIサービス提供元で一時的な障害が起きています。あなたの操作や設定が原因ではありません。時間を置いてもう一度お試しください。", state),
        detail,
      };
    }
    if (original.status === 401 || original.status === 403) {
      return {
        title: "APIキーが受け付けられませんでした",
        message: withState(`${provider}のAPIキーが有効か、利用権限があるかを設定画面で確認してください。`, state),
        detail,
      };
    }
    if (original.status === 404) {
      return {
        title: "モデルまたは接続先が見つかりません",
        message: withState(`${provider}のモデルIDと接続先URLを設定画面で確認してください。`, state),
        detail,
      };
    }
    if (original.status === 400 || original.status === 422) {
      return {
        title: "モデル設定を確認してください",
        message: withState(`${provider}が現在のモデル・機能の組み合わせを受け付けませんでした。下の技術的な詳細は、不具合報告や設定確認に利用できます。`, state),
        detail,
      };
    }
  }

  const originalMessage = original instanceof Error ? original.message : String(original);
  const lower = originalMessage.toLowerCase();
  if (/high demand|unavailable|overload|overloaded|capacity|temporar/.test(lower)) {
    return {
      title: "AIサービスが混み合っています",
      message: withState("AIサービス提供元の一時的な混雑です。あなたの操作や設定が原因ではありません。少し待ってからもう一度お試しください。", state),
      detail,
    };
  }
  if (original instanceof Error && original.name === "AbortError") {
    return {
      title: operation === "send" ? "送信を中止しました" : "再生成を中止しました",
      message: withState("処理は完了していません。", state),
      detail,
    };
  }
  if (original instanceof TypeError && /fetch|network|load failed/.test(lower)) {
    return {
      title: "AIサービスへ接続できませんでした",
      message: withState("端末の通信状態、またはAIサービス提供元への接続に一時的な問題があります。接続を確認してもう一度お試しください。", state),
      detail,
    };
  }
  if (originalMessage.includes("APIキー")) {
    return {
      title: "APIキーが設定されていません",
      message: withState("設定画面で、このパートナーが使うAIサービスのAPIキーを入力してください。", state),
      detail,
    };
  }
  return {
    title: operation === "send" ? "送信を完了できませんでした" : "再生成を完了できませんでした",
    message: withState("予期しない問題が起きました。下の技術的な詳細を開くと、不具合報告に必要な情報を確認できます。", state),
    detail,
  };
}
