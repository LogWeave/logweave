import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { loadConfig } from '../src/config.js'

const REQUIRED_ENV: Record<string, string> = {
  LOGWEAVE_CLICKHOUSE_URL: 'http://localhost:8123',
  LOGWEAVE_CLUSTERER_URL: 'http://localhost:8000',
}

describe('loadConfig — _internal tenant reservation', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of Object.keys(REQUIRED_ENV)) {
      saved[k] = process.env[k]
      process.env[k] = REQUIRED_ENV[k]
    }
    saved.LOGWEAVE_API_KEYS = process.env.LOGWEAVE_API_KEYS
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('rejects an API key mapped to tenant_id "_internal"', () => {
    process.env.LOGWEAVE_API_KEYS = JSON.stringify({ 'key-x': '_internal' })
    assert.throws(() => loadConfig(), /_internal.*reserved/)
  })

  it('accepts normal tenant_ids', () => {
    process.env.LOGWEAVE_API_KEYS = JSON.stringify({ 'key-x': 'tenant-a' })
    const cfg = loadConfig()
    assert.equal(cfg.apiKeys.get('key-x'), 'tenant-a')
  })

  it('rejects even when _internal is one of several values', () => {
    process.env.LOGWEAVE_API_KEYS = JSON.stringify({
      'key-x': 'tenant-a',
      'key-y': '_internal',
    })
    assert.throws(() => loadConfig(), /_internal.*reserved/)
  })
})
