import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

describe('loadConfig', () => {
  const validEnv = {
    LOGWEAVE_CLICKHOUSE_URL: 'http://localhost:8123',
    LOGWEAVE_CLUSTERER_URL: 'http://localhost:8000',
    LOGWEAVE_API_KEYS: '{"test-key-1":"tenant-a","test-key-2":"tenant-b"}',
  }

  beforeEach(() => {
    // Clear all LOGWEAVE_ vars to isolate tests
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LOGWEAVE_')) {
        delete process.env[key]
      }
    }
    delete process.env.NODE_ENV
  })

  it('throws when LOGWEAVE_CLICKHOUSE_URL is missing', async () => {
    process.env.LOGWEAVE_CLUSTERER_URL = validEnv.LOGWEAVE_CLUSTERER_URL
    process.env.LOGWEAVE_API_KEYS = validEnv.LOGWEAVE_API_KEYS

    const { loadConfig } = await import('../src/config.js')
    assert.throws(
      () => loadConfig(),
      (err: unknown) => {
        return err instanceof Error && err.message.includes('clickhouseUrl')
      },
    )
  })

  it('throws when LOGWEAVE_CLUSTERER_URL is missing', async () => {
    process.env.LOGWEAVE_CLICKHOUSE_URL = validEnv.LOGWEAVE_CLICKHOUSE_URL
    process.env.LOGWEAVE_API_KEYS = validEnv.LOGWEAVE_API_KEYS

    const { loadConfig } = await import('../src/config.js')
    assert.throws(
      () => loadConfig(),
      (err: unknown) => {
        return err instanceof Error && err.message.includes('clustererUrl')
      },
    )
  })

  it('produces correct config with valid env vars', async () => {
    Object.assign(process.env, validEnv)
    process.env.LOGWEAVE_PORT = '4000'
    process.env.LOGWEAVE_LOG_LEVEL = 'debug'

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()

    assert.equal(config.port, 4000)
    assert.equal(config.clickhouseUrl, 'http://localhost:8123')
    assert.equal(config.clustererUrl, 'http://localhost:8000')
    assert.equal(config.logLevel, 'debug')
  })

  it('applies defaults for optional values', async () => {
    Object.assign(process.env, validEnv)

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()

    assert.equal(config.port, 3000)
    assert.equal(config.clustererTimeoutMs, 500)
    assert.equal(config.logLevel, 'info')
    assert.equal(config.shutdownTimeoutMs, 10_000)
  })

  it('parses LOGWEAVE_API_KEYS into a Map', async () => {
    Object.assign(process.env, validEnv)

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()

    assert.ok(config.apiKeys instanceof Map)
    assert.equal(config.apiKeys.get('test-key-1'), 'tenant-a')
    assert.equal(config.apiKeys.get('test-key-2'), 'tenant-b')
    assert.equal(config.apiKeys.size, 2)
  })

  it('throws on invalid LOGWEAVE_API_KEYS JSON', async () => {
    Object.assign(process.env, validEnv)
    process.env.LOGWEAVE_API_KEYS = 'not json'

    const { loadConfig } = await import('../src/config.js')
    assert.throws(() => loadConfig())
  })

  it('throws on empty LOGWEAVE_API_KEYS object', async () => {
    Object.assign(process.env, validEnv)
    process.env.LOGWEAVE_API_KEYS = '{}'

    const { loadConfig } = await import('../src/config.js')
    assert.throws(() => loadConfig())
  })
})
