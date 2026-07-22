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
    const providerError = new ProviderHttpError("Google Gemini", 503, body);
    const error = new ChatOperationError("send", providerError, true);

    const presentation = presentChatError(error, "send");

    expect(presentation.title).toBe("Google Geminiが混み合っています");
    expect(presentation.message).toContain("あなたの操作や設定が原因ではありません");
    expect(presentation.message).toContain("入力欄へ戻しました");
    expect(presentation.detail).toContain("Google Gemini API error (503)");
    expect(presentation.detail).toContain('"status":"UNAVAILABLE"');
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
