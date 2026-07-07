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

  // Set when an iteration already performed an inline wait (429 Retry-After, or
  // 5xx Retry-After) before `continue`. The next iteration must NOT also run the
  // pre-attempt backoff — otherwise a single rate-limit response waits twice
  // (the server-instructed delay plus an extra exponential backoff).
  let skipBackoff = false

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    // The final attempt cannot retry, so any "wait then retry" delay on it is
    // pure waste — it just stalls flushing (BufferManager allows one in-flight
    // flush) for up to the Retry-After cap before the inevitable drop.
    const isLastAttempt = attempt === totalAttempts - 1

    // Check if we've been told to stop
    if (signal?.aborted) {
      return null
    }

    // Wait before retries (not before the first attempt, and not when the
    // previous iteration already waited inline as instructed by Retry-After).
    if (attempt > 0 && !skipBackoff) {
      const maxDelay = 1000 * 2 ** (attempt - 1)
      const jitteredDelay = Math.random() * maxDelay
      await sleepFn(jitteredDelay)

      // Re-check abort after sleeping
      if (signal?.aborted) {
        return null
      }
    }
    skipBackoff = false

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
        // No retries left — drop now rather than honoring Retry-After for a
        // wait we can't act on.
        if (isLastAttempt) break

        const retryAfterHeader = response.headers.get('retry-after')
        const retrySeconds = retryAfterHeader ? Math.min(Number(retryAfterHeader), 30) : 0

        if (retrySeconds > 0) {
          console.warn(`[LogWeave] rate limited (429), retrying after ${retrySeconds}s`)
          await sleepFn(retrySeconds * 1000)
        } else {
          const delay = Math.random() * 1000 * 2 ** attempt
          console.warn(
            `[LogWeave] rate limited (429), retrying with backoff ${Math.round(delay)}ms`,
          )
          await sleepFn(delay)
        }

        if (signal?.aborted) return null
        // This iteration already waited the full backoff inline — don't let the
        // next iteration's pre-attempt backoff stack another delay on top.
        skipBackoff = true
        continue
      }

      // Other 4xx — client error, do not retry
      if (response.status >= 400 && response.status < 500) {
        console.warn(`[LogWeave] batch rejected with status ${response.status} — not retrying`)
        return null
      }

      // 5xx — server error. Honor Retry-After if present (the LogWeave API
      // returns 503 + Retry-After when ClickHouse is unavailable) so we back off
      // as instructed instead of hammering with short exponential delays.
      // Without the header, fall through to exponential backoff next iteration.
      if (response.status >= 500) {
        const retryAfterHeader = response.headers.get('retry-after')
        const retrySeconds = retryAfterHeader ? Math.min(Number(retryAfterHeader), 30) : 0
        // Only honor Retry-After when there's another attempt to make. On the
        // terminal attempt the batch is dropped regardless, so sleeping the full
        // (up to 30s) delay just stalls all flushing for nothing.
        if (retrySeconds > 0 && !isLastAttempt) {
          console.warn(
            `[LogWeave] server unavailable (${response.status}), retrying after ${retrySeconds}s`,
          )
          await sleepFn(retrySeconds * 1000)
          if (signal?.aborted) return null
          // Skip the next iteration's pre-attempt backoff (we just waited the
          // server-instructed delay); then fall through to the next attempt.
          skipBackoff = true
        }
      }
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
