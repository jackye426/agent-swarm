/** Sleep helper for retry backoff (exported for tests). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the error is a transient transport failure worth retrying. */
export function isRetryableTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("socket hang up") ||
    err.name === "AbortError"
  );
}

export interface RetryFetchOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; error: Error }) => void;
}

/**
 * Wrap fetch with exponential backoff on transport-layer failures only.
 * HTTP 4xx/5xx responses are returned normally — not retried here.
 */
export function createRetryFetch(
  baseFetch: typeof fetch = globalThis.fetch,
  options: RetryFetchOptions = {},
): typeof fetch {
  const maxAttempts = options.maxAttempts ?? Number(process.env.TASKGRAPH_SUPABASE_RETRY_ATTEMPTS ?? 5);
  const baseDelayMs = options.baseDelayMs ?? Number(process.env.TASKGRAPH_SUPABASE_RETRY_BASE_MS ?? 500);

  return async (input, init) => {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await baseFetch(input, init);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        if (!isRetryableTransportError(error) || attempt === maxAttempts) {
          throw error;
        }

        const delayMs = Math.round(baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100);
        options.onRetry?.({ attempt, maxAttempts, delayMs, error });
        console.warn(
          `[Supabase] fetch failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms: ${error.message}`,
        );
        await sleep(delayMs);
      }
    }

    throw lastError ?? new Error("fetch retry exhausted");
  };
}
