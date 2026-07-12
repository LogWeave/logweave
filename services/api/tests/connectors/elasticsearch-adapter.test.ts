import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ElasticsearchAdapter } from '../../src/connectors/elasticsearch-adapter.js'
import type {
  ElasticsearchConnectorConfig,
  FetchRawLogsParams,
} from '../../src/connectors/types.js'
import { closedBaseUrl, type MockHttpServer, startMockServer } from './mock-server.js'

// The adapter routes all requests through safeFetch, which blocks loopback by
// default. Allowlist 127.0.0.1 so the tests can target a local mock server, and
// exercise the real adapter -> safeFetch -> socket path.

let server: MockHttpServer
let baseConfig: ElasticsearchConnectorConfig
const prevAllowlist = process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS

before(async () => {
  process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS = '127.0.0.1'
  server = await startMockServer(() => ({ status: 200, body: {} }))
  baseConfig = { type: 'elasticsearch', url: server.baseUrl, index: 'logs-*' }
})

after(async () => {
  await server.close()
  if (prevAllowlist === undefined) delete process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS
  else process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS = prevAllowlist
})

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('ElasticsearchAdapter.testConnection', () => {
  const adapter = new ElasticsearchAdapter()

  it('returns success when cluster is healthy and index exists', async () => {
    server.setHandler((req) => {
      if (req.url?.includes('/_cluster/health')) {
        return { status: 200, body: { status: 'green', cluster_name: 'test' } }
      }
      if (req.url?.includes('/_count')) {
        return { status: 200, body: { count: 42 } }
      }
      return { status: 404, body: {} }
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, true)
    assert.ok(result.message.includes('42'))
    assert.ok(result.message.includes('green'))
  })

  it('returns failure for auth error', async () => {
    server.setHandler(() => ({ status: 401, body: { error: 'Unauthorized' } }))

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('Authentication'))
  })

  it('returns failure when index not found', async () => {
    server.setHandler((req) => {
      if (req.url?.includes('/_cluster/health')) return { status: 200, body: { status: 'green' } }
      return { status: 404, body: { error: 'index_not_found' } }
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('not found'))
  })

  it('returns failure on connection refused', async () => {
    const adapter = new ElasticsearchAdapter()
    const result = await adapter.testConnection({ ...baseConfig, url: await closedBaseUrl() })
    assert.equal(result.success, false)
    assert.ok(result.message.includes('Cannot reach'))
  })

  it('sends basic auth header when username/password provided', async () => {
    server.setHandler((req) => {
      if (req.url?.includes('/_cluster/health')) return { status: 200, body: { status: 'green' } }
      return { status: 200, body: { count: 0 } }
    })

    server.requests.length = 0
    await adapter.testConnection({ ...baseConfig, username: 'elastic', password: 'secret' })
    const authHeader = String(server.requests[0]?.headers.authorization ?? '')
    assert.ok(authHeader.startsWith('Basic '))
    const decoded = Buffer.from(authHeader.replace('Basic ', ''), 'base64').toString()
    assert.equal(decoded, 'elastic:secret')
  })

  it('sends API key header when apiKey provided', async () => {
    server.setHandler((req) => {
      if (req.url?.includes('/_cluster/health')) return { status: 200, body: { status: 'green' } }
      return { status: 200, body: { count: 0 } }
    })

    server.requests.length = 0
    await adapter.testConnection({ ...baseConfig, apiKey: 'my-api-key' })
    assert.equal(String(server.requests[0]?.headers.authorization ?? ''), 'ApiKey my-api-key')
  })
})

// ---------------------------------------------------------------------------
// fetchRawLogs
// ---------------------------------------------------------------------------

describe('ElasticsearchAdapter.fetchRawLogs', () => {
  const adapter = new ElasticsearchAdapter()

  function params(overrides: Partial<FetchRawLogsParams> = {}): FetchRawLogsParams {
    return {
      config: baseConfig,
      templateText: 'Connection from <IP> timed out',
      service: 'payments',
      timeRange: {
        start: new Date('2026-01-01T00:00:00Z'),
        end: new Date('2026-01-01T01:00:00Z'),
      },
      limit: 50,
      ...overrides,
    }
  }

  it('returns matching lines from ES hits', async () => {
    server.setHandler(() => ({
      status: 200,
      body: {
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
      },
    }))

    const result = await adapter.fetchRawLogs(params())
    assert.equal(result.lines.length, 2)
    assert.equal(result.lines[0]?.source, 'logs-2026.01')
    assert.ok(result.lines[0]?.message.includes('10.0.0.1'))
  })

  it('returns empty on non-ok response', async () => {
    server.setHandler(() => ({ status: 400, body: { error: 'bad query' } }))

    const result = await adapter.fetchRawLogs(params())
    assert.equal(result.lines.length, 0)
    assert.equal(result.truncated, false)
  })

  it('indicates truncation when totalHits > limit', async () => {
    const hits = Array.from({ length: 50 }, (_, i) => ({
      _source: { message: `line ${i}`, '@timestamp': '2026-01-01T00:00:00Z' },
      _index: 'logs',
    }))
    server.setHandler(() => ({ status: 200, body: { hits: { total: { value: 500 }, hits } } }))

    const result = await adapter.fetchRawLogs(params())
    assert.equal(result.lines.length, 50)
    assert.equal(result.truncated, true)
    assert.equal(result.hasMore, true)
  })

  it('sends correct ES query structure', async () => {
    server.setHandler(() => ({ status: 200, body: { hits: { total: { value: 0 }, hits: [] } } }))

    await adapter.fetchRawLogs(params())
    const query = JSON.parse(server.last()?.body ?? '{}')
    assert.ok(query.query.bool.filter)
    assert.equal(query.query.bool.filter.length, 2)
    assert.ok(query.query.bool.filter[0].range)
    assert.ok(query.query.bool.filter[1].regexp)
  })

  it('uses custom message and timestamp fields', async () => {
    const customConfig: ElasticsearchConnectorConfig = {
      ...baseConfig,
      messageField: 'log_message',
      timestampField: 'created_at',
    }
    server.setHandler(() => ({
      status: 200,
      body: {
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
      },
    }))

    const result = await adapter.fetchRawLogs(params({ config: customConfig }))
    assert.equal(result.lines.length, 1)
    assert.equal(result.lines[0]?.timestamp, '2026-01-01T00:30:00Z')

    const query = JSON.parse(server.last()?.body ?? '{}')
    assert.ok(query._source.includes('log_message'))
    assert.ok(query._source.includes('created_at'))
  })
})
