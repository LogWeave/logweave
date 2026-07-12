import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'

describe('loadConfig', () => {
  const validEnv = {
    LOGWEAVE_CLICKHOUSE_URL: 'http://localhost:8123',
    LOGWEAVE_CLUSTERER_URL: 'http://localhost:8000',
    LOGWEAVE_API_KEYS: '{"test-key-1":"tenant-a","test-key-2":"tenant-b"}',
  }

  // Every LOGWEAVE_* env var loadConfig reads. The "applies defaults" test
  // asserts default values, which only hold when the var is unset — so we
  // must clear every key the schema consults, not just the ones a given
  // test body assigns. Keep this in sync with src/config.ts loadConfig().
  const MANAGED_KEYS = [
    'LOGWEAVE_PORT',
    'LOGWEAVE_CLICKHOUSE_URL',
    'LOGWEAVE_CLICKHOUSE_USER',
    'LOGWEAVE_CLICKHOUSE_PASSWORD',
    'LOGWEAVE_CLUSTERER_URL',
    'LOGWEAVE_CLUSTERER_TIMEOUT_MS',
    'LOGWEAVE_LOG_LEVEL',
    'LOGWEAVE_SHUTDOWN_TIMEOUT_MS',
    'LOGWEAVE_RECOVERY_ENABLED',
    'LOGWEAVE_RECOVERY_INTERVAL_MS',
    'LOGWEAVE_RECOVERY_LOOKBACK_HOURS',
    'LOGWEAVE_API_KEYS',
    'LOGWEAVE_DASHBOARD_BASE_URL',
    'LOGWEAVE_RATE_LIMIT_RPM',
    'LOGWEAVE_RATE_LIMIT_TENANT_RPM',
    'LOGWEAVE_RATE_LIMIT_INGEST_RPM',
    'LOGWEAVE_MAX_CONCURRENT_QUERIES',
    'LOGWEAVE_ENCRYPTION_KEY',
    'LOGWEAVE_RETENTION_ENABLED',
    'LOGWEAVE_RETENTION_INTERVAL_MS',
    'LOGWEAVE_AWS_ACCOUNT_ID',
    'LOGWEAVE_S3_CFN_TEMPLATE_URL',
    'LOGWEAVE_ARCHIVE_RECONCILE_ENABLED',
    'LOGWEAVE_VECTOR_ARCHIVE_URL',
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

  it('rejects an encryption key shorter than 32 chars', async () => {
    Object.assign(process.env, validEnv)
    process.env.LOGWEAVE_ENCRYPTION_KEY = 'a'.repeat(31)

    const { loadConfig } = await import('../src/config.js')
    assert.throws(() => loadConfig(), /at least 32 chars/)
  })

  it('accepts an encryption key of exactly 32 chars', async () => {
    Object.assign(process.env, validEnv)
    process.env.LOGWEAVE_ENCRYPTION_KEY = 'a'.repeat(32)

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    assert.equal(config.encryptionKey, 'a'.repeat(32))
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

  it('archiveReconcileEnabled defaults to false without the forward path', async () => {
    Object.assign(process.env, validEnv)

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    assert.equal(config.archiveReconcileEnabled, false)
  })

  it('archiveReconcileEnabled honours the explicit flag without the forward path', async () => {
    Object.assign(process.env, validEnv)
    process.env.LOGWEAVE_ARCHIVE_RECONCILE_ENABLED = 'true'

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    assert.equal(config.archiveReconcileEnabled, true)
  })

  it('forces archiveReconcileEnabled on when the forward path is set (#287)', async () => {
    // The reconcile sweep is the only writer that backfills forwarded objects
    // into log_metadata; forwarding without it black-holes logs into S3.
    Object.assign(process.env, validEnv)
    process.env.LOGWEAVE_VECTOR_ARCHIVE_URL = 'http://vector:8686/v1/archive'

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    assert.equal(config.archiveReconcileEnabled, true)
  })

  it('forces archiveReconcileEnabled on even over an explicit false when forwarding (#287)', async () => {
    Object.assign(process.env, validEnv)
    process.env.LOGWEAVE_VECTOR_ARCHIVE_URL = 'http://vector:8686/v1/archive'
    process.env.LOGWEAVE_ARCHIVE_RECONCILE_ENABLED = 'false'

    const { loadConfig } = await import('../src/config.js')
    const config = loadConfig()
    assert.equal(config.archiveReconcileEnabled, true)
  })
})
