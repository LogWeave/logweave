import assert from 'node:assert/strict'
import { describe, it, beforeEach } from 'node:test'
import pino from 'pino'
import { ClusterClient } from '../../src/pipeline/cluster-client.js'

const CLUSTERER_URL = 'http://localhost:8000'
const TIMEOUT_MS = 500

/** Silent logger for tests — captures calls without output. */
function createTestLogger() {
  const calls: { level: string; obj: Record<string, unknown>; msg: string }[] = []
  const logger = pino({ level: 'silent' })

  // Wrap error method to capture structured calls
  const origError = logger.error.bind(logger)
  logger.error = ((obj: Record<string, unknown>, msg: string) => {
    calls.push({ level: 'error', obj, msg })
    origError(obj, msg)
  }) as typeof logger.error

  return { logger, calls }
}

/** Create a mock fetch that returns a canned response. */
function mockFetch(
  status: number,
  body: unknown,
  options?: { delay?: number },
): typeof globalThis.fetch {
  return async (_url: string | URL | Request, _init?: RequestInit) => {
    if (options?.delay) {
      await new Promise((resolve) => setTimeout(resolve, options.delay))
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/** Create a mock fetch that throws (simulates network errors). */
function mockFetchError(error: Error): typeof globalThis.fetch {
  return async () => {
    throw error
  }
}

const CLUSTERER_RESPONSE = {
  results: [
    { template_id: 'abc-123', template_text: 'User <*> logged in', is_new: true },
  ],
}

describe('ClusterClient', () => {
  // -- Success path --

  it('returns mapped results on successful cluster call', async () => {
    const { logger } = createTestLogger()
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetch(200, CLUSTERER_RESPONSE))

    const results = await client.cluster('tenant-a', ['User alice logged in'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.templateId, 'abc-123')
    assert.equal(results[0]?.templateText, 'User <*> logged in')
    assert.equal(results[0]?.isNewTemplate, true)
  })

  it('returns multiple results for multiple messages', async () => {
    const multiResponse = {
      results: [
        { template_id: 'id-1', template_text: 'template 1', is_new: false },
        { template_id: 'id-2', template_text: 'template 2', is_new: true },
        { template_id: 'id-1', template_text: 'template 1', is_new: false },
      ],
    }
    const { logger } = createTestLogger()
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetch(200, multiResponse))

    const results = await client.cluster('tenant-a', ['msg1', 'msg2', 'msg3'])

    assert.equal(results.length, 3)
    assert.equal(results[0]?.templateId, 'id-1')
    assert.equal(results[1]?.templateId, 'id-2')
    assert.equal(results[2]?.isNewTemplate, false)
  })

  it('resets consecutiveFailures to 0 on success', async () => {
    const { logger } = createTestLogger()
    // First call fails
    let callCount = 0
    const toggleFetch: typeof globalThis.fetch = async (url, init) => {
      callCount++
      if (callCount === 1) {
        return new Response('', { status: 500 })
      }
      return new Response(JSON.stringify(CLUSTERER_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, toggleFetch)

    await client.cluster('tenant-a', ['msg'])
    assert.equal(client.consecutiveFailures, 1)

    await client.cluster('tenant-a', ['msg'])
    assert.equal(client.consecutiveFailures, 0)
  })

  // -- Failure paths --

  it('returns fallback on timeout', async () => {
    const { logger } = createTestLogger()
    const abortError = new DOMException('The operation was aborted', 'AbortError')
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetchError(abortError))

    const results = await client.cluster('tenant-a', ['msg1', 'msg2'])

    assert.equal(results.length, 2)
    assert.equal(results[0]?.templateId, '0')
    assert.equal(results[0]?.templateText, '[unclustered]')
    assert.equal(results[0]?.isNewTemplate, false)
    assert.equal(results[1]?.templateId, '0')
  })

  it('returns fallback immediately on connection refused', async () => {
    const { logger } = createTestLogger()
    const connError = new TypeError('fetch failed')
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetchError(connError))

    const start = Date.now()
    const results = await client.cluster('tenant-a', ['msg'])
    const elapsed = Date.now() - start

    assert.equal(results.length, 1)
    assert.equal(results[0]?.templateId, '0')
    assert.ok(elapsed < 50, `Expected <50ms, got ${elapsed}ms`)
  })

  it('returns fallback on HTTP 503', async () => {
    const { logger } = createTestLogger()
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetch(503, { detail: 'Server busy' }))

    const results = await client.cluster('tenant-a', ['msg'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.templateId, '0')
  })

  it('returns fallback on HTTP 500', async () => {
    const { logger } = createTestLogger()
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetch(500, { detail: 'Internal error' }))

    const results = await client.cluster('tenant-a', ['msg'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.templateId, '0')
  })

  it('returns fallback on HTTP 422 and logs at ERROR level', async () => {
    const { logger, calls } = createTestLogger()
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetch(422, { detail: 'Validation error' }))

    const results = await client.cluster('tenant-a', ['msg'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.templateId, '0')
    // Verify structured error log
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.level, 'error')
    assert.equal(calls[0]?.obj.statusCode, 422)
    assert.equal(calls[0]?.obj.tenantId, 'tenant-a')
  })

  it('returns fallback on 200 with malformed body', async () => {
    const { logger } = createTestLogger()
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetch(200, { oops: 'no results' }))

    const results = await client.cluster('tenant-a', ['msg'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.templateId, '0')
  })

  it('returns fallback on 200 with malformed result items', async () => {
    const { logger } = createTestLogger()
    const badItems = { results: [{ garbage: true }, null, 42] }
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetch(200, badItems))

    const results = await client.cluster('tenant-a', ['msg'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.templateId, '0')
  })

  it('returns fallback on 200 with non-JSON body', async () => {
    const { logger } = createTestLogger()
    const htmlFetch: typeof globalThis.fetch = async () => {
      return new Response('<html>502 Bad Gateway</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    }
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, htmlFetch)

    const results = await client.cluster('tenant-a', ['msg'])

    assert.equal(results.length, 1)
    assert.equal(results[0]?.templateId, '0')
  })

  it('returns fallback on result count mismatch', async () => {
    const { logger } = createTestLogger()
    const mismatch = {
      results: [
        { template_id: 'id-1', template_text: 'tpl', is_new: false },
      ],
    }
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetch(200, mismatch))

    // Send 3 messages but clusterer returns 1 result
    const results = await client.cluster('tenant-a', ['msg1', 'msg2', 'msg3'])

    assert.equal(results.length, 3)
    assert.equal(results[0]?.templateId, '0')
  })

  it('times out on slow response with real AbortSignal.timeout', async () => {
    const { logger } = createTestLogger()
    const slowFetch: typeof globalThis.fetch = async (_url, init) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          resolve(new Response(JSON.stringify(CLUSTERER_RESPONSE), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }))
        }, 2000)
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(init.signal?.reason)
        })
      })
    }
    // 50ms timeout so the test runs fast
    const client = new ClusterClient(CLUSTERER_URL, 50, logger, slowFetch)

    const start = Date.now()
    const results = await client.cluster('tenant-a', ['msg'])
    const elapsed = Date.now() - start

    assert.equal(results[0]?.templateId, '0')
    assert.ok(elapsed < 200, `Expected timeout around 50ms, got ${elapsed}ms`)
  })

  // -- Health tracking --

  it('increments consecutiveFailures on each failure', async () => {
    const { logger } = createTestLogger()
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mockFetch(500, {}))

    assert.equal(client.consecutiveFailures, 0)
    await client.cluster('tenant-a', ['msg'])
    assert.equal(client.consecutiveFailures, 1)
    await client.cluster('tenant-a', ['msg'])
    assert.equal(client.consecutiveFailures, 2)
    await client.cluster('tenant-a', ['msg'])
    assert.equal(client.consecutiveFailures, 3)
  })

  it('tracks mixed success/failure/success correctly', async () => {
    const { logger } = createTestLogger()
    let callCount = 0
    const mixedFetch: typeof globalThis.fetch = async () => {
      callCount++
      // fail, fail, success, fail, success
      if (callCount === 3 || callCount === 5) {
        return new Response(JSON.stringify(CLUSTERER_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('', { status: 500 })
    }
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger, mixedFetch)

    await client.cluster('t', ['m']) // fail
    assert.equal(client.consecutiveFailures, 1)
    await client.cluster('t', ['m']) // fail
    assert.equal(client.consecutiveFailures, 2)
    await client.cluster('t', ['m']) // success
    assert.equal(client.consecutiveFailures, 0)
    await client.cluster('t', ['m']) // fail
    assert.equal(client.consecutiveFailures, 1)
    await client.cluster('t', ['m']) // success
    assert.equal(client.consecutiveFailures, 0)
  })
})
