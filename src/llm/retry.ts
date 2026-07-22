const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface RetryTiming {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

/** Reported just before each backoff wait, so the UI can explain the pause. */
export interface RetryAttempt {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  maxAttempts: number;
  status: number;
  delayMs: number;
}

export type RetryNotice = (attempt: RetryAttempt) => void;

export interface RetryOptions extends Partial<RetryTiming> {
  onRetry?: RetryNotice;
}

/** Default retry parameters. Tests can lower these to avoid real delays. */
export const retryDefaults: RetryTiming = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
};

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? retryDefaults.maxAttempts;
  const initialDelay = options?.initialDelayMs ?? retryDefaults.initialDelayMs;
  const maxDelay = options?.maxDelayMs ?? retryDefaults.maxDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(input, init);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts) {
      return response;
    }
    if (init?.signal?.aborted) return response;

    // Consume the error body to avoid resource leaks
    await response.text().catch(() => {});

    // Respect Retry-After header (seconds) when present
    let delay = initialDelay * 2 ** (attempt - 1);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const parsed = Number(retryAfter);
      if (Number.isFinite(parsed) && parsed >= 0) delay = parsed * 1000;
    }
    delay = Math.min(delay, maxDelay);

    // Jitter ±25%
    const jittered = delay * (0.75 + Math.random() * 0.5);
    console.log(`[SAIVerse Lite] Retry ${attempt}/${maxAttempts} after HTTP ${response.status}, waiting ${Math.round(jittered)}ms`);
    options?.onRetry?.({ attempt, maxAttempts, status: response.status, delayMs: Math.round(jittered) });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, jittered);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  throw new Error("fetchWithRetry: unreachable");
}
