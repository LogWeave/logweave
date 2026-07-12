import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { loadDefaults, loadServiceConfigs, validateServiceConfig } from '../src/config.js'

describe('validateServiceConfig', () => {
  it('accepts a valid minimal config', () => {
    const config = validateServiceConfig({
      service: 'auth',
      templates: [{ message: 'User logged in', level: 'info' }],
    })

    assert.equal(config.service, 'auth')
    assert.equal(config.templates.length, 1)
  })

  it('accepts a full config with all optional fields', () => {
    const config = validateServiceConfig({
      service: 'payments',
      environment: 'production',
      metadata: { region: 'us-east-1' },
      generators: {
        orderId: { type: 'sequence', prefix: 'ORD-' },
      },
      templates: [
        {
          message: 'Payment processed for {{orderId}}',
          level: 'info',
          weight: 5,
          fields: { amount: 99.99 },
          generators: { currency: { type: 'choice', values: ['USD', 'EUR'] } },
        },
      ],
      spike: {
        extra_templates: [{ message: 'Gateway timeout', level: 'error' }],
        error_weight_multiplier: 5,
      },
    })

    assert.equal(config.service, 'payments')
    assert.equal(config.environment, 'production')
  })

  it('rejects non-object input', () => {
    assert.throws(() => validateServiceConfig('not an object'), /must be a JSON object/)
    assert.throws(() => validateServiceConfig(null), /must be a JSON object/)
    assert.throws(() => validateServiceConfig([]), /must be a JSON object/)
  })

  it('rejects missing service field', () => {
    assert.throws(
      () =>
        validateServiceConfig({
          templates: [{ message: 'hi', level: 'info' }],
        }),
      /Missing or empty required field: "service"/,
    )
  })

  it('rejects empty service field', () => {
    assert.throws(
      () =>
        validateServiceConfig({
          service: '',
          templates: [{ message: 'hi', level: 'info' }],
        }),
      /Missing or empty required field: "service"/,
    )
  })

  it('rejects missing templates field', () => {
    assert.throws(
      () => validateServiceConfig({ service: 'test' }),
      /Missing or empty required field: "templates"/,
    )
  })

  it('rejects empty templates array', () => {
    assert.throws(
      () => validateServiceConfig({ service: 'test', templates: [] }),
      /Missing or empty required field: "templates"/,
    )
  })

  it('rejects template without message', () => {
    assert.throws(
      () =>
        validateServiceConfig({
          service: 'test',
          templates: [{ level: 'info' }],
        }),
      /missing required field: "message"/,
    )
  })

  it('rejects template without level', () => {
    assert.throws(
      () =>
        validateServiceConfig({
          service: 'test',
          templates: [{ message: 'hello' }],
        }),
      /missing required field: "level"/,
    )
  })

  it('rejects negative weight', () => {
    assert.throws(
      () =>
        validateServiceConfig({
          service: 'test',
          templates: [{ message: 'hello', level: 'info', weight: -1 }],
        }),
      /must be a non-negative number/,
    )
  })

  it('rejects invalid generator type', () => {
    assert.throws(
      () =>
        validateServiceConfig({
          service: 'test',
          generators: { bad: { type: 'nonexistent' } },
          templates: [{ message: 'hello', level: 'info' }],
        }),
      /invalid type: "nonexistent"/,
    )
  })
})

describe('loadServiceConfigs', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logweave-config-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loads all JSON files from a directory', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({
        service: 'auth',
        templates: [{ message: 'Login', level: 'info' }],
      }),
    )
    fs.writeFileSync(
      path.join(tmpDir, 'payments.json'),
      JSON.stringify({
        service: 'payments',
        templates: [{ message: 'Payment', level: 'info' }],
      }),
    )

    const configs = loadServiceConfigs(tmpDir)
    assert.equal(configs.length, 2)

    const services = configs.map((c) => c.service).sort()
    assert.deepEqual(services, ['auth', 'payments'])
  })

  it('filters by service name', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({
        service: 'auth',
        templates: [{ message: 'Login', level: 'info' }],
      }),
    )
    fs.writeFileSync(
      path.join(tmpDir, 'payments.json'),
      JSON.stringify({
        service: 'payments',
        templates: [{ message: 'Payment', level: 'info' }],
      }),
    )

    const configs = loadServiceConfigs(tmpDir, ['auth'])
    assert.equal(configs.length, 1)
    assert.equal(configs[0]?.service, 'auth')
  })

  it('returns all when filter is ["all"]', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({
        service: 'auth',
        templates: [{ message: 'Login', level: 'info' }],
      }),
    )

    const configs = loadServiceConfigs(tmpDir, ['all'])
    assert.equal(configs.length, 1)
  })

  it('throws when directory does not exist', () => {
    assert.throws(() => loadServiceConfigs('/nonexistent/path'), /not found/)
  })

  it('throws when no JSON files found', () => {
    assert.throws(() => loadServiceConfigs(tmpDir), /No service config files found/)
  })

  it('throws when no matching services found', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'auth.json'),
      JSON.stringify({
        service: 'auth',
        templates: [{ message: 'Login', level: 'info' }],
      }),
    )

    assert.throws(() => loadServiceConfigs(tmpDir, ['nonexistent']), /No matching services/)
  })
})

describe('loadDefaults', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logweave-defaults-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loads valid defaults config', () => {
    const defaultsPath = path.join(tmpDir, 'defaults.json')
    fs.writeFileSync(
      defaultsPath,
      JSON.stringify({
        rate: 100,
        buffer_size: 500,
        flush_interval_ms: 2000,
        mode: 'steady',
        mode_timings: {
          spike_duration_seconds: 30,
          storm_duration_seconds: 60,
          quiet_duration_seconds: 30,
          chaos_steady_min_seconds: 120,
          chaos_steady_max_seconds: 300,
        },
      }),
    )

    const defaults = loadDefaults(defaultsPath)
    assert.equal(defaults.rate, 100)
    assert.equal(defaults.buffer_size, 500)
    assert.equal(defaults.mode, 'steady')
    assert.equal(defaults.mode_timings.spike_duration_seconds, 30)
  })

  it('throws when file does not exist', () => {
    assert.throws(() => loadDefaults('/nonexistent/defaults.json'), /not found/)
  })
})
