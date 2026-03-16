import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import { batchInsert } from '../../src/db/insert.js'
import { initSchema } from '../../src/db/schema.js'
import type { LogMetadataRow } from '../../src/types.js'
import { closeTestClient, getTestClient, getTestDb, jsonRows, testTenantId } from './helpers.js'

const logger = pino({ level: 'silent' })

function makeRow(tenantId: string, overrides?: Partial<LogMetadataRow>): LogMetadataRow {
  return {
    tenant_id: tenantId,
    timestamp: '2026-03-14 12:00:00.000',
    service: 'test-svc',
    level: 'INFO',
    environment: 'test',
    template_id: 'abc-123',
    template_text: 'User <*> logged in',
    is_new_template: 0,
    anomaly_score: 0.1,
    status_code: 200,
    duration_ms: 42.5,
    trace_id: 'trace-001',
    route: '/api/login',
    source_type: 'winston',
    source_ref: 's3://bucket/key',
    ...overrides,
  }
}

describe('batchInsert', () => {
  const client = getTestClient()
  const db = getTestDb()
  const tenantId = testTenantId('insert')

  before(async () => {
    await initSchema(client, logger)
  })

  after(async () => {
    await closeTestClient()
  })

  it('inserts 100 rows and all are readable', async () => {
    const inputRows = Array.from({ length: 100 }, (_, i) =>
      makeRow(tenantId, {
        timestamp: `2026-03-14 12:${String(i).padStart(2, '0')}:00.000`,
        duration_ms: i * 10,
      }),
    )

    await batchInsert(db, inputRows)

    const result = await client.query({
      query: `SELECT count() AS cnt FROM logweave.log_metadata
              WHERE tenant_id = {tenant_id:String}`,
      query_params: { tenant_id: tenantId },
    })
    const countRows = await jsonRows<{ cnt: number | string }>(result)
    const first = countRows[0]
    assert.ok(first, 'Expected count result')
    assert.equal(Number(first.cnt), 100)
  })

  it('round-trips all fields correctly', async () => {
    const singleTenant = testTenantId('insert-roundtrip')
    const row = makeRow(singleTenant, {
      status_code: 503,
      duration_ms: 99.9,
      pre_processed_message: 'User admin logged in',
    })

    await batchInsert(db, [row])

    const result = await client.query({
      query: `SELECT * FROM logweave.log_metadata
              WHERE tenant_id = {tenant_id:String} LIMIT 1`,
      query_params: { tenant_id: singleTenant },
    })
    const rows = await jsonRows<Record<string, unknown>>(result)
    const stored = rows[0]
    assert.ok(stored, 'Expected at least one row')
    assert.equal(stored.tenant_id, singleTenant)
    assert.equal(stored.service, 'test-svc')
    assert.equal(stored.level, 'INFO')
    assert.equal(stored.environment, 'test')
    assert.equal(stored.template_id, 'abc-123')
    assert.equal(stored.template_text, 'User <*> logged in')
    assert.equal(stored.status_code, 503)
    assert.equal(stored.source_type, 'winston')
    assert.equal(stored.source_ref, 's3://bucket/key')
    assert.equal(stored.pre_processed_message, 'User admin logged in')
  })

  it('throws on empty array', async () => {
    await assert.rejects(() => batchInsert(db, []), {
      message: 'batchInsert requires at least one row',
    })
  })
})
