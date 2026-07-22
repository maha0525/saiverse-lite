import { describe, expect, it } from "vitest";
import { ChatOperationError, presentChatError } from "./chatErrors";
import { ProviderHttpError } from "./llm/types";

describe("chat error presentation", () => {
  it("explains a Gemini 503 as provider-side congestion and preserves raw details", () => {
    const body = JSON.stringify({
      error: {
        code: 503,
        message: "This model is currently experiencing high demand. Please try again later.",
        status: "UNAVAILABLE",
      },
    });
    const providerError = new ProviderHttpError("Google Gemini", 503, body, "gemini-3.5-flash");
    const error = new ChatOperationError("send", providerError, true);

    const presentation = presentChatError(error, "send");

    expect(presentation.title).toBe("いま使えないモデルです");
    expect(presentation.message).toContain("あなたの操作や設定が原因ではありません");
    // The model that actually failed is not always the one in settings, so it
    // has to be named rather than implied.
    expect(presentation.message).toContain("モデル「gemini-3.5-flash」");
    expect(presentation.message).toContain("パートナー画面の「モデルID」");
    // The settings screen no longer has a chat-model field; pointing at one
    // would send the user hunting for something that is not there.
    expect(presentation.message).not.toContain("会話モデルID");
    expect(presentation.message).toContain("入力欄へ戻しました");
    expect(presentation.detail).toContain("Google Gemini API error (503)");
    expect(presentation.detail).toContain("model: gemini-3.5-flash");
    expect(presentation.detail).toContain('"status":"UNAVAILABLE"');
  });

  it("calls a per-minute 429 a pace limit, not congestion", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "You exceeded your current quota. Please retry in 23.8s.",
        status: "RESOURCE_EXHAUSTED",
        details: [{ violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "5" }] }],
      },
    });
    const error = new ChatOperationError("send", new ProviderHttpError("Google Gemini", 429, body), true);

    const presentation = presentChatError(error, "send");

    expect(presentation.title).toBe("送信のペースが上限に達しました");
    expect(presentation.message).toContain("上限に達しました");
  });

  it("tells the user a daily quota will not clear by waiting", () => {
    const body = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] }],
      },
    });
    const error = new ChatOperationError("send", new ProviderHttpError("Google Gemini", 429, body), true);

    const presentation = presentChatError(error, "send");

    expect(presentation.title).toBe("今日の利用枠を使い切りました");
    expect(presentation.message).toContain("待っても戻りません");
  });

  it("distinguishes authentication errors from provider outages", () => {
    const error = new ChatOperationError(
      "send",
      new ProviderHttpError("Anthropic", 401, '{"error":{"message":"invalid x-api-key"}}'),
      true,
    );

    const presentation = presentChatError(error, "send");

    expect(presentation.title).toBe("APIキーが受け付けられませんでした");
    expect(presentation.message).toContain("設定画面");
  });
});
