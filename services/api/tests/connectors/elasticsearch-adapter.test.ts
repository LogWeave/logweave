import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, type mock } from 'node:test'
import { ElasticsearchAdapter } from '../../src/connectors/elasticsearch-adapter.js'
import type {
  ElasticsearchConnectorConfig,
  FetchRawLogsParams,
} from '../../src/connectors/types.js'

// ---------------------------------------------------------------------------
// Setup: mock global fetch
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch
let _fetchMock: ReturnType<typeof mock.fn<typeof fetch>>

function mockFetchWith(handler: (input: string | URL | Request) => Promise<Response>): void {
  _fetchMock = (globalThis as Record<string, unknown>).fetch = handler as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const baseConfig: ElasticsearchConnectorConfig = {
  type: 'elasticsearch',
  url: 'http://localhost:9200',
  index: 'logs-*',
}

const authConfig: ElasticsearchConnectorConfig = {
  ...baseConfig,
  username: 'elastic',
  password: 'secret',
}

const apiKeyConfig: ElasticsearchConnectorConfig = {
  ...baseConfig,
  apiKey: 'my-api-key',
}

// ---------------------------------------------------------------------------
// Restore fetch after each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Default: return a minimal success response
  mockFetchWith(async () => jsonResponse({}))
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('ElasticsearchAdapter.testConnection', () => {
  const adapter = new ElasticsearchAdapter()

  it('returns success when cluster is healthy and index exists', async () => {
    mockFetchWith(async (input) => {
      const url = String(input)
      if (url.includes('/_cluster/health')) {
        return jsonResponse({ status: 'green', cluster_name: 'test' })
      }
      if (url.includes('/_count')) {
        return jsonResponse({ count: 42 })
      }
      return jsonResponse({}, 404)
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, true)
    assert.ok(result.message.includes('42'))
    assert.ok(result.message.includes('green'))
  })

  it('returns failure for auth error', async () => {
    mockFetchWith(async () => jsonResponse({ error: 'Unauthorized' }, 401))

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('Authentication'))
  })

  it('returns failure when index not found', async () => {
    mockFetchWith(async (input) => {
      const url = String(input)
      if (url.includes('/_cluster/health')) {
        return jsonResponse({ status: 'green' })
      }
      return jsonResponse({ error: 'index_not_found' }, 404)
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('not found'))
  })

  it('returns failure on connection refused', async () => {
    mockFetchWith(async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('Cannot reach'))
  })

  it('sends basic auth header when username/password provided', async () => {
    let capturedHeaders: Headers | undefined
    mockFetchWith(async (input, init) => {
      if (String(input).includes('/_cluster/health')) {
        capturedHeaders = new Headers((init as RequestInit)?.headers)
        return jsonResponse({ status: 'green' })
      }
      return jsonResponse({ count: 0 })
    })

    await adapter.testConnection(authConfig)
    assert.ok(capturedHeaders)
    const authHeader = capturedHeaders.get('authorization') ?? ''
    assert.ok(authHeader.startsWith('Basic '))
    const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString()
    assert.equal(decoded, 'elastic:secret')
  })

  it('sends API key header when apiKey provided', async () => {
    let capturedHeaders: Headers | undefined
    mockFetchWith(async (input, init) => {
      if (String(input).includes('/_cluster/health')) {
        capturedHeaders = new Headers((init as RequestInit)?.headers)
        return jsonResponse({ status: 'green' })
      }
      return jsonResponse({ count: 0 })
    })

    await adapter.testConnection(apiKeyConfig)
    assert.ok(capturedHeaders)
    const authHeader = capturedHeaders.get('authorization') ?? ''
    assert.equal(authHeader, 'ApiKey my-api-key')
  })
})

// ---------------------------------------------------------------------------
// fetchRawLogs
// ---------------------------------------------------------------------------

describe('ElasticsearchAdapter.fetchRawLogs', () => {
  const adapter = new ElasticsearchAdapter()

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

  it('returns matching lines from ES hits', async () => {
    mockFetchWith(async () =>
      jsonResponse({
        hits: {
          total: { value: 2 },
          hits: [
            {
              _source: {
                message: 'Connection from 10.0.0.1 timed out',
                '@timestamp': '2026-01-01T00:30:00Z',
              },
              _index: 'logs-2026.01',
            },
            {
              _source: {
                message: 'Connection from 192.168.1.5 timed out',
                '@timestamp': '2026-01-01T00:31:00Z',
              },
              _index: 'logs-2026.01',
            },
          ],
        },
      }),
    )

    const result = await adapter.fetchRawLogs(baseParams)
    assert.equal(result.lines.length, 2)
    assert.equal(result.lines[0]?.source, 'logs-2026.01')
    assert.ok(result.lines[0]?.message.includes('10.0.0.1'))
  })

  it('returns empty on non-ok response', async () => {
    mockFetchWith(async () => jsonResponse({ error: 'bad query' }, 400))

    const result = await adapter.fetchRawLogs(baseParams)
    assert.equal(result.lines.length, 0)
    assert.equal(result.truncated, false)
  })

  it('indicates truncation when totalHits > limit', async () => {
    const hits = Array.from({ length: 50 }, (_, i) => ({
      _source: { message: `line ${i}`, '@timestamp': '2026-01-01T00:00:00Z' },
      _index: 'logs',
    }))

    mockFetchWith(async () =>
      jsonResponse({
        hits: { total: { value: 500 }, hits },
      }),
    )

    const result = await adapter.fetchRawLogs(baseParams)
    assert.equal(result.lines.length, 50)
    assert.equal(result.truncated, true)
    assert.equal(result.hasMore, true)
  })

  it('sends correct ES query structure', async () => {
    let capturedBody: string | undefined
    mockFetchWith(async (input, init) => {
      if (String(input).includes('/_search')) {
        capturedBody = (init as RequestInit)?.body as string
      }
      return jsonResponse({ hits: { total: { value: 0 }, hits: [] } })
    })

    await adapter.fetchRawLogs(baseParams)
    assert.ok(capturedBody)
    const query = JSON.parse(capturedBody)
    assert.ok(query.query.bool.filter)
    assert.equal(query.query.bool.filter.length, 2)
    // First filter should be range
    assert.ok(query.query.bool.filter[0].range)
    // Second filter should be regexp
    assert.ok(query.query.bool.filter[1].regexp)
  })

  it('uses custom message and timestamp fields', async () => {
    const customConfig: ElasticsearchConnectorConfig = {
      ...baseConfig,
      messageField: 'log_message',
      timestampField: 'created_at',
    }

    let capturedBody: string | undefined
    mockFetchWith(async (input, init) => {
      if (String(input).includes('/_search')) {
        capturedBody = (init as RequestInit)?.body as string
      }
      return jsonResponse({
        hits: {
          total: { value: 1 },
          hits: [
            {
              _source: {
                log_message: 'Connection from 10.0.0.1 timed out',
                created_at: '2026-01-01T00:30:00Z',
              },
              _index: 'logs',
            },
          ],
        },
      })
    })

    const result = await adapter.fetchRawLogs({ ...baseParams, config: customConfig })
    assert.equal(result.lines.length, 1)
    assert.equal(result.lines[0]?.timestamp, '2026-01-01T00:30:00Z')

    const query = JSON.parse(capturedBody ?? '{}')
    assert.ok(query._source.includes('log_message'))
    assert.ok(query._source.includes('created_at'))
  })
})
