import { describe, expect, it } from "vitest";
import { formatApproxSizeGb, isLiteRtModelId, LITERT_MODELS } from "./litertModels";

describe("formatApproxSizeGb", () => {
  it("formats the E2B download size to one decimal place", () => {
    expect(formatApproxSizeGb(LITERT_MODELS["gemma-4-e2b-it-web"].approxByteLength)).toBe("約 2.0 GB");
  });

  it("formats the E4B download size to one decimal place", () => {
    expect(formatApproxSizeGb(LITERT_MODELS["gemma-4-e4b-it-web"].approxByteLength)).toBe("約 3.0 GB");
  });

  it("rounds rather than truncates", () => {
    expect(formatApproxSizeGb(2_960_000_000)).toBe("約 3.0 GB");
  });
});

describe("isLiteRtModelId", () => {
  it("accepts every key registered in LITERT_MODELS", () => {
    for (const id of Object.keys(LITERT_MODELS)) expect(isLiteRtModelId(id)).toBe(true);
  });

  it("rejects an unrelated model string", () => {
    expect(isLiteRtModelId("gpt-5.6-terra")).toBe(false);
  });
});
