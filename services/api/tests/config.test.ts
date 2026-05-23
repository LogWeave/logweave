import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

describe('loadConfig', () => {
  const validEnv = {
    LOGWEAVE_CLICKHOUSE_URL: 'http://localhost:8123',
    LOGWEAVE_CLUSTERER_URL: 'http://localhost:8000',
    LOGWEAVE_API_KEYS: '{"test-key-1":"tenant-a","test-key-2":"tenant-b"}',
  }

  // Only mutate the env keys this suite actually touches. Snapshotting all of
  // process.env (or all LOGWEAVE_* keys) couples the test to whatever else
  // happens to be present — if config.ts later reads a non-LOGWEAVE_ key, a
  // broad snapshot/clear silently masks the dependency.
  const MANAGED_KEYS = [
    'LOGWEAVE_CLICKHOUSE_URL',
    'LOGWEAVE_CLUSTERER_URL',
    'LOGWEAVE_API_KEYS',
    'LOGWEAVE_PORT',
    'LOGWEAVE_LOG_LEVEL',
    'LOGWEAVE_RECOVERY_ENABLED',
  ] as const

  const envSnapshot = new Map<string, string | undefined>()

  beforeEach(() => {
    envSnapshot.clear()
    for (const key of MANAGED_KEYS) {
      envSnapshot.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
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
    assert.equal(config.recoveryIntervalMs, 60_000)
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

  it('recoveryEnabled defaults to true', async () => {
    Object.assign(process.env, validEnv)

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    assert.equal(config.recoveryEnabled, true)
  })

  it('recoveryEnabled=false disables recovery', async () => {
    Object.assign(process.env, validEnv)
    process.env.LOGWEAVE_RECOVERY_ENABLED = 'false'

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    assert.equal(config.recoveryEnabled, false)
  })
})
