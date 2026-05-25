import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { LokiAdapter } from '../../src/connectors/loki-adapter.js'
import type { FetchRawLogsParams, LokiConnectorConfig } from '../../src/connectors/types.js'

// ---------------------------------------------------------------------------
// Setup: mock global fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch

function mockFetchWith(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  ;(globalThis as Record<string, unknown>).fetch = handler as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const baseConfig: LokiConnectorConfig = {
  type: 'loki',
  url: 'http://localhost:3100',
  streamSelector: '{app="payments"}',
}

const authConfig: LokiConnectorConfig = {
  ...baseConfig,
  orgId: 'tenant-abc',
  username: 'loki-user',
  password: 'loki-pass',
}

beforeEach(() => {
  mockFetchWith(async () => jsonResponse({}))
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('LokiAdapter.testConnection', () => {
  const adapter = new LokiAdapter()

  it('returns success when Loki is ready and labels found', async () => {
    mockFetchWith(async (input) => {
      const url = String(input)
      if (url.includes('/ready')) {
        return new Response('ready', { status: 200 })
      }
      if (url.includes('/loki/api/v1/labels')) {
        return jsonResponse({ data: ['app', 'env', 'host'] })
      }
      return jsonResponse({}, 404)
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, true)
    assert.ok(result.message.includes('3 label'))
  })

  it('returns failure when Loki is not ready', async () => {
    mockFetchWith(async () => new Response('not ready', { status: 503 }))

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('not ready'))
  })

  it('returns failure for auth error on labels', async () => {
    mockFetchWith(async (input) => {
      const url = String(input)
      if (url.includes('/ready')) return new Response('ready', { status: 200 })
      return jsonResponse({ error: 'Unauthorized' }, 401)
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('Authentication'))
  })

  it('returns failure on connection refused', async () => {
    mockFetchWith(async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('Cannot reach'))
  })

  it('sends X-Scope-OrgID header when orgId provided', async () => {
    let capturedHeaders: Headers | undefined
    mockFetchWith(async (input, init) => {
      const url = String(input)
      if (url.includes('/ready')) {
        capturedHeaders = new Headers(init?.headers)
        return new Response('ready', { status: 200 })
      }
      return jsonResponse({ data: [] })
    })

    await adapter.testConnection(authConfig)
    assert.ok(capturedHeaders)
    assert.equal(capturedHeaders.get('x-scope-orgid'), 'tenant-abc')
  })

  it('sends basic auth when username/password provided', async () => {
    let capturedHeaders: Headers | undefined
    mockFetchWith(async (input, init) => {
      const url = String(input)
      if (url.includes('/ready')) {
        capturedHeaders = new Headers(init?.headers)
        return new Response('ready', { status: 200 })
      }
      return jsonResponse({ data: [] })
    })

    await adapter.testConnection(authConfig)
    assert.ok(capturedHeaders)
    const authHeader = capturedHeaders.get('authorization') ?? ''
    assert.ok(authHeader.startsWith('Basic '))
    const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString()
    assert.equal(decoded, 'loki-user:loki-pass')
  })
})

// ---------------------------------------------------------------------------
// fetchRawLogs
// ---------------------------------------------------------------------------

describe('LokiAdapter.fetchRawLogs', () => {
  const adapter = new LokiAdapter()

  const baseParams: FetchRawLogsParams = {
    config: baseConfig,
    templateText: 'Connection from <IP> timed out',
    service: 'payments',
    timeRange: {
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-01-01T01:00:00Z'),
    },
    limit: 50,
  }

  it('returns matching lines from Loki stream results', async () => {
    mockFetchWith(async () =>
      jsonResponse({
        data: {
          result: [
            {
              stream: { app: 'payments', env: 'prod' },
              values: [
                ['1735689600000000000', 'Connection from 10.0.0.1 timed out'],
                ['1735689660000000000', 'Connection from 192.168.1.5 timed out'],
              ],
            },
          ],
        },
      }),
    )

    const result = await adapter.fetchRawLogs(baseParams)
    assert.equal(result.lines.length, 2)
    assert.ok(result.lines[0]?.message.includes('10.0.0.1'))
    assert.ok(result.lines[0]?.source.includes('app=payments'))
  })

  it('converts nanosecond timestamps to ISO strings', async () => {
    // 1735689600000000000 ns = 1735689600000 ms
    const expectedIso = new Date(1735689600000).toISOString()

    mockFetchWith(async () =>
      jsonResponse({
        data: {
          result: [
            {
              stream: { app: 'test' },
              values: [['1735689600000000000', 'some log']],
            },
          ],
        },
      }),
    )

    const result = await adapter.fetchRawLogs(baseParams)
    assert.equal(result.lines.length, 1)
    assert.equal(result.lines[0]?.timestamp, expectedIso)
  })

  it('returns empty on non-ok response', async () => {
    mockFetchWith(async () => jsonResponse({ error: 'bad query' }, 400))

    const result = await adapter.fetchRawLogs(baseParams)
    assert.equal(result.lines.length, 0)
    assert.equal(result.truncated, false)
  })

  it('handles multiple streams in result', async () => {
    mockFetchWith(async () =>
      jsonResponse({
        data: {
          result: [
            {
              stream: { app: 'payments', pod: 'a' },
              values: [['1735689600000000000', 'line from pod a']],
            },
            {
              stream: { app: 'payments', pod: 'b' },
              values: [['1735689600000000000', 'line from pod b']],
            },
          ],
        },
      }),
    )

    const result = await adapter.fetchRawLogs(baseParams)
    assert.equal(result.lines.length, 2)
    assert.equal(result.filesScanned, 2)
  })

  it('builds correct LogQL query with regex', async () => {
    let capturedUrl = ''
    mockFetchWith(async (input) => {
      capturedUrl = String(input)
      return jsonResponse({ data: { result: [] } })
    })

    await adapter.fetchRawLogs(baseParams)
    assert.ok(capturedUrl.includes('query='))
    // Decode the URL to check the LogQL
    const url = new URL(capturedUrl)
    const query = url.searchParams.get('query') ?? ''
    assert.ok(query.includes('{app="payments"}'))
    assert.ok(query.includes('|~'))
  })

  it('respects limit parameter', async () => {
    const values = Array.from({ length: 100 }, (_, i) => [
      `${1735689600000000000 + i * 1000000000}`,
      `log line ${i}`,
    ])

    mockFetchWith(async () =>
      jsonResponse({
        data: {
          result: [{ stream: { app: 'test' }, values }],
        },
      }),
    )

    const result = await adapter.fetchRawLogs({ ...baseParams, limit: 10 })
    assert.equal(result.lines.length, 10)
    assert.equal(result.truncated, true)
  })
})
