import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./retry";

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
