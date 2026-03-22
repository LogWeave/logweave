/**
 * Retry logic for LogWeave transport HTTP calls.
 *
 * - Exponential backoff with full jitter: delay = random(0, 1000 * 2^attempt)
 * - 429 responses retry with Retry-After header (capped at 30s) or exponential backoff
 * - Other 4xx responses warn once and return null (no retry)
 * - 5xx responses trigger retry
 * - Network errors (fetch throws) trigger retry
 * - After all retries exhausted, drops batch and warns
 * - Accepts an AbortSignal to cancel inflight retries (used by close())
 */

export interface RetryOptions {
  /** Maximum number of retries after the initial attempt. Default: 3 */
  readonly maxRetries: number
  /** Per-attempt HTTP timeout in milliseconds. Default: 2000 */
  readonly timeoutMs: number
  /** Injectable fetch for testing. Defaults to globalThis.fetch */
  readonly fetchFn?: typeof globalThis.fetch
  /** Injectable sleep for testing. Defaults to setTimeout-based sleep */
  readonly sleepFn?: (ms: number) => Promise<void>
  /** Abort signal to cancel all pending retries (e.g. during close()) */
  readonly signal?: AbortSignal
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
  })
}

/**
 * Fetch with retry logic.
 *
 * Returns the Response on success, or null if the batch should be dropped
 * (4xx error, or all retries exhausted).
 */
export async function retryFetch(
  url: string,
  init: RequestInit,
  options: RetryOptions,
): Promise<Response | null> {
  const {
    maxRetries,
    timeoutMs,
    fetchFn = globalThis.fetch,
    sleepFn = defaultSleep,
    signal,
  } = options

  const totalAttempts = 1 + maxRetries

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    // Check if we've been told to stop
    if (signal?.aborted) {
      return null
    }

    // Wait before retries (not before the first attempt)
    if (attempt > 0) {
      const maxDelay = 1000 * 2 ** (attempt - 1)
      const jitteredDelay = Math.random() * maxDelay
      await sleepFn(jitteredDelay)

      // Re-check abort after sleeping
      if (signal?.aborted) {
        return null
      }
    }

    try {
      // Per-attempt timeout via AbortSignal.timeout
      const timeoutSignal = AbortSignal.timeout(timeoutMs)

      // Combine timeout signal with the caller's abort signal
      const combinedSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal

      const response = await fetchFn(url, {
        ...init,
        signal: combinedSignal,
      })

      // 2xx — success
      if (response.ok) {
        return response
      }

      // 429 — rate limited, retry with Retry-After or exponential backoff
      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after')
        const retrySeconds = retryAfterHeader ? Math.min(Number(retryAfterHeader), 30) : 0

        if (retrySeconds > 0) {
          console.warn(`[LogWeave] rate limited (429), retrying after ${retrySeconds}s`)
          await sleepFn(retrySeconds * 1000)
        } else {
          const delay = Math.random() * 1000 * 2 ** attempt
          console.warn(`[LogWeave] rate limited (429), retrying with backoff ${Math.round(delay)}ms`)
          await sleepFn(delay)
        }

        if (signal?.aborted) return null
        continue
      }

      // Other 4xx — client error, do not retry
      if (response.status >= 400 && response.status < 500) {
        console.warn(`[LogWeave] batch rejected with status ${response.status} — not retrying`)
        return null
      }

      // 5xx — server error, will retry on next loop iteration
    } catch {
      // Network error or timeout — will retry on next loop iteration
      if (signal?.aborted) {
        return null
      }
    }
  }

  // All retries exhausted
  console.warn(`[LogWeave] batch failed after ${totalAttempts} attempts — dropping batch`)
  return null
}
