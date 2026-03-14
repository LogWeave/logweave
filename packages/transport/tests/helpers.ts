/**
 * Test helpers — mock fetch utilities for transport tests.
 */

type FetchFn = typeof globalThis.fetch

interface MockFetchCall {
  url: string | URL | Request
  init: RequestInit | undefined
}

/**
 * Creates a mock fetch that always returns the same response.
 * Tracks all calls for assertion.
 */
export function mockFetch(status: number, body?: unknown): { fetch: FetchFn; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = []
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url: url as string | URL | Request, init })
    return new Response(body ? JSON.stringify(body) : null, { status })
  }
  return { fetch, calls }
}

/**
 * Creates a mock fetch that returns different responses in sequence.
 * After the sequence is exhausted, returns the last response.
 */
export function mockFetchSequence(
  responses: Array<{ status: number; body?: unknown }>,
): { fetch: FetchFn; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = []
  let index = 0
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url: url as string | URL | Request, init })
    const responseIndex = Math.min(index, responses.length - 1)
    const resp = responses[responseIndex]!
    index++
    return new Response(resp.body ? JSON.stringify(resp.body) : null, { status: resp.status })
  }
  return { fetch, calls }
}

/**
 * Creates a mock fetch that rejects with the given error.
 */
export function mockFetchError(error: Error): { fetch: FetchFn; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = []
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url: url as string | URL | Request, init })
    throw error
  }
  return { fetch, calls }
}

/**
 * A no-op sleep function for deterministic tests (skips actual delays).
 */
export function immediateSleep(_ms: number): Promise<void> {
  return Promise.resolve()
}
