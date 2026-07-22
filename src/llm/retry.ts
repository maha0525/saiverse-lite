const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface RetryTiming {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /**
   * Total time this call may spend waiting between attempts. Gemini's free tier
   * asks for ~24s on a rate-limit rejection, which alone exceeds a 1/2/4/8s
   * ladder, so the budget - not the attempt count - is what has to be generous.
   */
  maxTotalWaitMs: number;
}

/** Reported just before each backoff wait, so the UI can explain the pause. */
export interface RetryAttempt {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  maxAttempts: number;
  status: number;
  delayMs: number;
  /** True when the wait came from the server, not from our own backoff ladder. */
  serverRequested: boolean;
}

export type RetryNotice = (attempt: RetryAttempt) => void;

export interface RetryOptions extends Partial<RetryTiming> {
  onRetry?: RetryNotice;
}

/** Default retry parameters. Tests can lower these to avoid real delays. */
export const retryDefaults: RetryTiming = {
  maxAttempts: 6,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  maxTotalWaitMs: 75000,
};

/**
 * How long the server itself said to wait, or null when it did not say.
 *
 * Gemini sends no Retry-After header - verified against the live API on
 * 2026-07-23, where a 429 carried only `retryDelay` inside the JSON body. So
 * reading the header alone silently discards the one number the server gave us.
 */
export function serverRequestedDelayMs(response: Response, bodyText: string): number | null {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const httpDate = Date.parse(header);
    if (!Number.isNaN(httpDate)) return Math.max(0, httpDate - Date.now());
  }
  // {"error":{"details":[{"@type":"...RetryInfo","retryDelay":"23s"}]}}
  const structured = /"retryDelay"\s*:\s*"?(\d+(?:\.\d+)?)s"?/.exec(bodyText);
  if (structured?.[1]) return Number(structured[1]) * 1000;
  // "Please retry in 23.800583875s."
  const prose = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(bodyText);
  if (prose?.[1]) return Number(prose[1]) * 1000;
  return null;
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: RetryOptions,
): Promise<Response> {
  const maxAttempts = options?.maxAttempts ?? retryDefaults.maxAttempts;
  const initialDelay = options?.initialDelayMs ?? retryDefaults.initialDelayMs;
  const maxDelay = options?.maxDelayMs ?? retryDefaults.maxDelayMs;
  const maxTotalWait = options?.maxTotalWaitMs ?? retryDefaults.maxTotalWaitMs;
  let spentWaitingMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(input, init);
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts) {
      return response;
    }
    if (init?.signal?.aborted) return response;

    // Read the error body: it carries the server's own retry delay, and reading
    // it also releases the connection.
    const bodyText = await response.text().catch(() => "");

    const requested = serverRequestedDelayMs(response, bodyText);
    const backoff = Math.min(initialDelay * 2 ** (attempt - 1), maxDelay);
    // Jitter ±25%, but only on our own guess. A delay the server named is not
    // ours to shorten - undercutting it just earns another rejection.
    const delay = requested === null
      ? Math.round(backoff * (0.75 + Math.random() * 0.5))
      : Math.round(Math.min(requested, maxDelay));

    if (spentWaitingMs + delay > maxTotalWait) {
      // Waiting as instructed would blow the budget. Returning the rejection now
      // is more honest than burning the remaining attempts on shorter waits the
      // server has already told us are too short.
      console.log(
        `[SAIVerse Lite] Giving up after HTTP ${response.status}: next wait ${delay}ms exceeds the remaining budget `
        + `(${Math.max(0, maxTotalWait - spentWaitingMs)}ms of ${maxTotalWait}ms)`,
      );
      return response;
    }
    spentWaitingMs += delay;

    const source = requested === null ? "backoff" : "server-requested";
    console.log(`[SAIVerse Lite] Retry ${attempt}/${maxAttempts} after HTTP ${response.status}, waiting ${delay}ms (${source})`);
    options?.onRetry?.({ attempt, maxAttempts, status: response.status, delayMs: delay, serverRequested: requested !== null });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  throw new Error("fetchWithRetry: unreachable");
}
