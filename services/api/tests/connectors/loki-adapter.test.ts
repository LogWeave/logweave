import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { LokiAdapter } from '../../src/connectors/loki-adapter.js'
import type { FetchRawLogsParams, LokiConnectorConfig } from '../../src/connectors/types.js'
import { closedBaseUrl, type MockHttpServer, startMockServer } from './mock-server.js'

// safeFetch blocks loopback by default; allowlist 127.0.0.1 so the tests can
// drive the adapter against a local mock Loki through the real fetch path.

let server: MockHttpServer
let baseConfig: LokiConnectorConfig
const prevAllowlist = process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS

before(async () => {
  process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS = '127.0.0.1'
  server = await startMockServer(() => ({ status: 200, body: {} }))
  baseConfig = { type: 'loki', url: server.baseUrl, streamSelector: '{app="payments"}' }
})

after(async () => {
  await server.close()
  if (prevAllowlist === undefined) delete process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS
  else process.env.LOGWEAVE_CONNECTOR_ALLOWED_HOSTS = prevAllowlist
})

// ---------------------------------------------------------------------------
// testConnection
// ---------------------------------------------------------------------------

describe('LokiAdapter.testConnection', () => {
  const adapter = new LokiAdapter()

  it('returns success when Loki is ready and labels found', async () => {
    server.setHandler((req) => {
      if (req.url?.includes('/ready')) return { status: 200, body: 'ready' }
      if (req.url?.includes('/loki/api/v1/labels')) {
        return { status: 200, body: { data: ['app', 'env', 'host'] } }
      }
      return { status: 404, body: {} }
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, true)
    assert.ok(result.message.includes('3 label'))
  })

  it('returns failure when Loki is not ready', async () => {
    server.setHandler(() => ({ status: 503, body: 'not ready' }))

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('not ready'))
  })

  it('returns failure for auth error on labels', async () => {
    server.setHandler((req) => {
      if (req.url?.includes('/ready')) return { status: 200, body: 'ready' }
      return { status: 401, body: { error: 'Unauthorized' } }
    })

    const result = await adapter.testConnection(baseConfig)
    assert.equal(result.success, false)
    assert.ok(result.message.includes('Authentication'))
  })

  it('returns failure on connection refused', async () => {
    const result = await adapter.testConnection({ ...baseConfig, url: await closedBaseUrl() })
    assert.equal(result.success, false)
    assert.ok(result.message.includes('Cannot reach'))
  })

  it('sends X-Scope-OrgID header when orgId provided', async () => {
    server.setHandler((req) => {
      if (req.url?.includes('/ready')) return { status: 200, body: 'ready' }
      return { status: 200, body: { data: [] } }
    })

    server.requests.length = 0
    await adapter.testConnection({ ...baseConfig, orgId: 'tenant-abc' })
    assert.equal(String(server.requests[0]?.headers['x-scope-orgid'] ?? ''), 'tenant-abc')
  })

  it('sends basic auth when username/password provided', async () => {
    server.setHandler((req) => {
      if (req.url?.includes('/ready')) return { status: 200, body: 'ready' }
      return { status: 200, body: { data: [] } }
    })

    server.requests.length = 0
    await adapter.testConnection({ ...baseConfig, username: 'loki-user', password: 'loki-pass' })
    const authHeader = String(server.requests[0]?.headers.authorization ?? '')
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

  it('returns matching lines from Loki stream results', async () => {
    server.setHandler(() => ({
      status: 200,
      body: {
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
      },
    }))

    const result = await adapter.fetchRawLogs(params())
    assert.equal(result.lines.length, 2)
    assert.ok(result.lines[0]?.message.includes('10.0.0.1'))
    assert.ok(result.lines[0]?.source.includes('app=payments'))
  })

  it('converts nanosecond timestamps to ISO strings', async () => {
    const expectedIso = new Date(1735689600000).toISOString()
    server.setHandler(() => ({
      status: 200,
      body: {
        data: {
          result: [{ stream: { app: 'test' }, values: [['1735689600000000000', 'some log']] }],
        },
      },
    }))

    const result = await adapter.fetchRawLogs(params())
    assert.equal(result.lines.length, 1)
    assert.equal(result.lines[0]?.timestamp, expectedIso)
  })

  it('returns empty on non-ok response', async () => {
    server.setHandler(() => ({ status: 400, body: { error: 'bad query' } }))

    const result = await adapter.fetchRawLogs(params())
    assert.equal(result.lines.length, 0)
    assert.equal(result.truncated, false)
  })

  it('handles multiple streams in result', async () => {
    server.setHandler(() => ({
      status: 200,
      body: {
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
      },
    }))

    const result = await adapter.fetchRawLogs(params())
    assert.equal(result.lines.length, 2)
    assert.equal(result.filesScanned, 2)
  })

  it('builds correct LogQL query with regex', async () => {
    server.setHandler(() => ({ status: 200, body: { data: { result: [] } } }))

    await adapter.fetchRawLogs(params())
    const url = new URL(server.last()?.url ?? '/', server.baseUrl)
    const query = url.searchParams.get('query') ?? ''
    assert.ok(query.includes('{app="payments"}'))
    assert.ok(query.includes('|~'))
  })

  it('strips backticks so a template cannot break out of the LogQL line filter', async () => {
    server.setHandler(() => ({ status: 200, body: { data: { result: [] } } }))

    // A template carrying a backtick (from a tenant log line) must not be able to
    // close the backtick-quoted line filter and inject LogQL.
    await adapter.fetchRawLogs(params({ templateText: 'evil`} |~ `whoami' }))
    const url = new URL(server.last()?.url ?? '/', server.baseUrl)
    const query = url.searchParams.get('query') ?? ''
    // The line filter is one backtick-quoted string: exactly the two delimiters.
    const backticks = (query.match(/`/g) ?? []).length
    assert.equal(backticks, 2)
  })

  it('respects limit parameter', async () => {
    const values = Array.from({ length: 100 }, (_, i) => [
      `${1735689600000000000 + i * 1000000000}`,
      `log line ${i}`,
    ])
    server.setHandler(() => ({
      status: 200,
      body: { data: { result: [{ stream: { app: 'test' }, values }] } },
    }))

    const result = await adapter.fetchRawLogs(params({ limit: 10 }))
    assert.equal(result.lines.length, 10)
    assert.equal(result.truncated, true)
  })
})
