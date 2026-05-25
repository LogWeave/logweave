import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { InternalEventEmitter } from '../src/internal-events/emitter.js'

interface CapturedRow {
  ts: string
  service: string
  event: string
  severity: string
  code: string
  summary: string
  fields: string
}

function makeFakeDb(opts: { throwOn?: 'insert' } = {}) {
  const inserts: Array<{ table: string; values: unknown[] }> = []
  return {
    db: {
      // biome-ignore lint: shape-match for DbClient.insert
      async insert(params: { table: string; values: unknown[]; format: string }) {
        if (opts.throwOn === 'insert') throw new Error('CH down')
        inserts.push({ table: params.table, values: params.values })
      },
    } as never,
    inserts,
  }
}

describe('InternalEventEmitter', () => {
  let stdoutLines: string[] = []
  const captureStdout = (line: string) => {
    stdoutLines.push(line)
  }

  beforeEach(() => {
    stdoutLines = []
  })

  afterEach(() => {
    stdoutLines = []
  })

  it('writes a single JSON line to stdout per emit', () => {
    const emitter = new InternalEventEmitter({
      service: 'api',
      stdout: captureStdout,
      isProd: true,
    })
    emitter.emit({
      event: 'service.started',
      severity: 'info',
      code: 'SERVICE_STARTED',
      summary: 'api up',
      fields: { service_version: '1.0' },
    })
    assert.equal(stdoutLines.length, 1)
    const parsed = JSON.parse(stdoutLines[0] ?? '')
    assert.equal(parsed.event, 'service.started')
    assert.equal(parsed.service, 'api')
    assert.equal(parsed.fields.service_version, '1.0')
  })

  it('ships to ClickHouse when db is provided', async () => {
    const { db, inserts } = makeFakeDb()
    const emitter = new InternalEventEmitter({
      service: 'api',
      db,
      stdout: captureStdout,
      isProd: true,
    })
    emitter.emit({
      event: 'clickhouse.query_failed',
      severity: 'error',
      code: 'CH_QUERY_TIMEOUT',
      summary: 'query timeout',
      fields: { query_kind: 'lookup', duration_ms: 5000 },
    })
    // fire-and-forget — wait a tick for the microtask queue
    await new Promise((r) => setImmediate(r))
    assert.equal(inserts.length, 1)
    const row = inserts[0]?.values[0] as CapturedRow
    assert.equal(row.table ?? inserts[0]?.table, 'logweave.internal_events')
    assert.equal(row.event, 'clickhouse.query_failed')
    const parsedFields = JSON.parse(row.fields)
    assert.equal(parsedFields.query_kind, 'lookup')
    assert.equal(parsedFields.duration_ms, 5000)
  })

  it('still writes to stdout when ClickHouse insert throws', async () => {
    const { db } = makeFakeDb({ throwOn: 'insert' })
    const emitter = new InternalEventEmitter({
      service: 'api',
      db,
      stdout: captureStdout,
      isProd: true,
    })
    emitter.emit({
      event: 'clickhouse.unreachable',
      severity: 'error',
      code: 'CH_UNREACHABLE',
      summary: 'CH down',
    })
    await new Promise((r) => setImmediate(r))
    assert.equal(stdoutLines.length, 1)
    // does not throw
  })

  it('throws on unknown event in dev', () => {
    const emitter = new InternalEventEmitter({
      service: 'api',
      stdout: captureStdout,
      isProd: false,
    })
    assert.throws(() =>
      emitter.emit({
        // biome-ignore lint: deliberate type-bypass to test runtime guard
        event: 'made.up' as never,
        severity: 'info',
        code: 'X',
        summary: 'x',
      }),
    )
  })

  it('silently drops unknown event in prod', () => {
    const emitter = new InternalEventEmitter({
      service: 'api',
      stdout: captureStdout,
      isProd: true,
    })
    emitter.emit({
      // biome-ignore lint: deliberate type-bypass to test runtime guard
      event: 'made.up' as never,
      severity: 'info',
      code: 'X',
      summary: 'x',
    })
    assert.equal(stdoutLines.length, 0)
  })

  it('redacts api keys in fields before stdout or CH', async () => {
    const { db, inserts } = makeFakeDb()
    const emitter = new InternalEventEmitter({
      service: 'api',
      db,
      stdout: captureStdout,
      isProd: true,
    })
    emitter.emit({
      event: 'auth.key_invalid',
      severity: 'warn',
      code: 'KEY_INVALID',
      summary: 'bad key',
      fields: { api_key: 'lw_supersecret123', route: '/v1/ingest' },
    })
    await new Promise((r) => setImmediate(r))
    const stdoutEvent = JSON.parse(stdoutLines[0] ?? '')
    assert.match(String(stdoutEvent.fields.api_key), /^<redacted/)
    assert.equal(stdoutEvent.fields.route, '/v1/ingest')
    const chRow = inserts[0]?.values[0] as CapturedRow
    const chFields = JSON.parse(chRow.fields)
    assert.match(String(chFields.api_key), /^<redacted/)
  })

  it('strips stack traces from CH payload but keeps them on stdout', async () => {
    const { db, inserts } = makeFakeDb()
    const emitter = new InternalEventEmitter({
      service: 'api',
      db,
      stdout: captureStdout,
      isProd: true,
    })
    emitter.emit({
      event: 'clickhouse.query_failed',
      severity: 'error',
      code: 'CH_QUERY_FAILED',
      summary: 'boom',
      fields: { stack: 'Error\n    at foo (a.js:1:1)', code: 'X' },
    })
    await new Promise((r) => setImmediate(r))
    const stdoutEvent = JSON.parse(stdoutLines[0] ?? '')
    assert.equal(stdoutEvent.fields.stack, 'Error\n    at foo (a.js:1:1)')
    const chRow = inserts[0]?.values[0] as CapturedRow
    const chFields = JSON.parse(chRow.fields)
    assert.equal(chFields.stack, undefined)
    assert.equal(chFields.code, 'X')
  })

  it('coalesces high-volume sampled events to once per 10s per (event, tenant, code)', () => {
    let mockTime = 1_000_000
    const emitter = new InternalEventEmitter({
      service: 'api',
      stdout: captureStdout,
      now: () => new Date(mockTime),
      isProd: true,
    })
    const emitAuthFail = () =>
      emitter.emit({
        event: 'auth.key_invalid',
        severity: 'warn',
        code: 'KEY_INVALID',
        summary: 'bad key',
        fields: { tenant_id: 't1', route: '/v1/ingest' },
      })

    // First fires, next 9 within 10s are suppressed
    for (let i = 0; i < 10; i++) emitAuthFail()
    assert.equal(stdoutLines.length, 1)

    // Advance > 10s — next emission fires
    mockTime += 11_000
    emitAuthFail()
    assert.equal(stdoutLines.length, 2)

    // Different tenant gets its own bucket
    mockTime += 1
    emitter.emit({
      event: 'auth.key_invalid',
      severity: 'warn',
      code: 'KEY_INVALID',
      summary: 'bad key',
      fields: { tenant_id: 't2', route: '/v1/ingest' },
    })
    assert.equal(stdoutLines.length, 3)
  })

  it('emitConfigLoaded only passes allowlisted keys verbatim', () => {
    const emitter = new InternalEventEmitter({
      service: 'api',
      stdout: captureStdout,
      isProd: true,
    })
    emitter.emitConfigLoaded({
      port: 3000,
      logLevel: 'info',
      clickhousePassword: 'hunter2',
    })
    const parsed = JSON.parse(stdoutLines[0] ?? '')
    assert.equal(parsed.fields.port, 3000)
    assert.equal(parsed.fields.logLevel, 'info')
    assert.match(String(parsed.fields.clickhousePassword), /^<redacted/)
  })
})
