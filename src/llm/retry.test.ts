import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, serverRequestedDelayMs, type RetryAttempt } from "./retry";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("fetchWithRetry", () => {
  it("returns immediately on a successful response", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://api.test/v1");
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 503 and succeeds on the second attempt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://api.test/v1", undefined, {
      initialDelayMs: 1,
      maxDelayMs: 10,
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 and 500", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limit", { status: 429 }))
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://api.test/v1", undefined, {
      initialDelayMs: 1,
      maxDelayMs: 10,
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 400 or 401", async () => {
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://api.test/v1", undefined, {
      initialDelayMs: 1,
    });
    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and returns the last error response", async () => {
    const fetchMock = vi.fn(async () => new Response("overloaded", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://api.test/v1", undefined, {
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 5,
    });
    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("respects abort signal during retry wait", async () => {
    const fetchMock = vi.fn(async () => new Response("overloaded", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const promise = fetchWithRetry("https://api.test/v1", { signal: controller.signal }, {
      initialDelayMs: 5000,
    });
    // Abort while waiting for the retry delay
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports every backoff wait through onRetry so the UI can explain the pause", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(new Response("rate limit", { status: 429 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const notices: Array<{ attempt: number; maxAttempts: number; status: number; delayMs: number }> = [];

    const response = await fetchWithRetry("https://api.test/v1", undefined, {
      maxAttempts: 4,
      initialDelayMs: 1,
      maxDelayMs: 10,
      onRetry: (attempt) => notices.push(attempt),
    });

    expect(response.status).toBe(200);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ attempt: 1, maxAttempts: 4, status: 503 });
    expect(notices[1]).toMatchObject({ attempt: 2, maxAttempts: 4, status: 429 });
    for (const notice of notices) expect(notice.delayMs).toBeGreaterThanOrEqual(0);
  });

  it("does not report a retry when the first response is final", async () => {
    const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();

    await fetchWithRetry("https://api.test/v1", undefined, { initialDelayMs: 1, onRetry });
    expect(onRetry).not.toHaveBeenCalled();
  });

  // Gemini sends no Retry-After header; the delay lives only in the body. This
  // is the shape the live API returned on 2026-07-23.
  const geminiRateLimitBody = JSON.stringify({
    error: {
      code: 429,
      message: "You exceeded your current quota.\n* Quota exceeded for metric: generate_content_free_tier_requests, limit: 5\nPlease retry in 23.800583875s.",
      status: "RESOURCE_EXHAUSTED",
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "5" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "23s" },
      ],
    },
  });

  it("waits the delay Gemini puts in the body, not its own shorter ladder", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(geminiRateLimitBody, { status: 429, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const notices: RetryAttempt[] = [];

    const response = await fetchWithRetry("https://api.test/v1", undefined, {
      initialDelayMs: 1,
      maxDelayMs: 30,          // caps the 23s request down to something testable
      maxTotalWaitMs: 60_000,
      onRetry: (attempt) => notices.push(attempt),
    });

    expect(response.status).toBe(200);
    expect(notices[0]?.serverRequested).toBe(true);
    // 23s, capped by maxDelayMs — not the 1ms first rung of our own ladder.
    expect(notices[0]?.delayMs).toBe(30);
  });

  it("stops instead of pretending, when the demanded wait exceeds the budget", async () => {
    const fetchMock = vi.fn(async () => new Response(geminiRateLimitBody, { status: 429, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onRetry = vi.fn();

    const response = await fetchWithRetry("https://api.test/v1", undefined, {
      maxAttempts: 6,
      initialDelayMs: 1,
      maxDelayMs: 30_000,
      maxTotalWaitMs: 5_000,   // the server wants 23s; we cannot honour that
      onRetry,
    });

    expect(response.status).toBe(429);
    // One attempt only: burning the rest on waits the server already called too
    // short would just be noise.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("parses the delay from the RetryInfo detail and from the prose message", () => {
    const headerless = new Response(null, { status: 429 });
    expect(serverRequestedDelayMs(headerless, geminiRateLimitBody)).toBe(23_000);
    expect(serverRequestedDelayMs(headerless, "Please retry in 7.5s.")).toBe(7_500);
    expect(serverRequestedDelayMs(headerless, "overloaded, no delay here")).toBeNull();
  });

  it("prefers an explicit Retry-After header over the body", () => {
    const withHeader = new Response(null, { status: 429, headers: { "retry-after": "42" } });
    expect(serverRequestedDelayMs(withHeader, geminiRateLimitBody)).toBe(42_000);
  });

  it("respects Retry-After header", async () => {
    const start = Date.now();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limit", {
        status: 429,
        headers: { "retry-after": "0" },
      }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://api.test/v1", undefined, {
      initialDelayMs: 5000,
      maxDelayMs: 10000,
    });
    expect(response.status).toBe(200);
    // With Retry-After: 0, the delay should be near-zero (jitter applies to 0)
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
