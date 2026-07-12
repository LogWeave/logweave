import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { queryDashboardVolume } from '../../src/db/dashboard/volume.js'
import { batchInsert } from '../../src/db/insert.js'
import { initSchema } from '../../src/db/schema.js'
import type { LogMetadataRow } from '../../src/types.js'
import { closeTestClient, getTestClient, getTestDb, testTenantId } from './helpers.js'

const logger = pino({ level: 'silent' })

function recentTs(): string {
  return new Date(Date.now() - 15 * 60_000).toISOString().replace('T', ' ').replace('Z', '')
}

function makeRow(tenantId: string, overrides?: Partial<LogMetadataRow>): LogMetadataRow {
  return {
    tenant_id: tenantId,
    timestamp: recentTs(),
    service: 'test-svc',
    level: 'INFO',
    environment: 'test',
    template_id: 'tmpl-1',
    template_text: 'Connection from <*>',
    is_new_template: 0,
    anomaly_score: 0.5,
    duration_ms: 100,
    source_type: 'winston',
    source_ref: 's3://bucket/key',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Query-builder unit tests — table selection, no ClickHouse needed
// ---------------------------------------------------------------------------

interface QueryCall {
  query: string
}

function captureQuery(): { db: DbClient; calls: QueryCall[] } {
  const calls: QueryCall[] = []
  const db = {
    query: async (params: { query: string }) => {
      calls.push({ query: params.query })
      return []
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, calls }
}

describe('queryDashboardVolume — table selection', () => {
  it('uses service_stats_5m when the window fits in 7 days', async () => {
    const { db, calls } = captureQuery()
    await queryDashboardVolume(db, 't1', { hours: 24 })
    assert.match(calls[0]?.query ?? '', /FROM logweave\.service_stats_5m\b/)
  })

  it('uses service_stats when the window exceeds 7 days', async () => {
    const { db, calls } = captureQuery()
    await queryDashboardVolume(db, 't1', { hours: 24 * 10 })
    assert.match(calls[0]?.query ?? '', /FROM logweave\.service_stats\b/)
    assert.doesNotMatch(calls[0]?.query ?? '', /service_stats_5m/)
  })

  it('uses service_stats_5m at exactly the 7-day boundary', async () => {
    const { db, calls } = captureQuery()
    await queryDashboardVolume(db, 't1', { hours: 24 * 7 })
    assert.match(calls[0]?.query ?? '', /FROM logweave\.service_stats_5m\b/)
  })

  it('picks the table by the oldest edge of an offset comparison window', async () => {
    // hours=24, offset=24*6 -> window reaches 24*7 = 168h back -> still smooth
    const smooth = captureQuery()
    await queryDashboardVolume(smooth.db, 't1', { hours: 24, offset: 24 * 6 })
    assert.match(smooth.calls[0]?.query ?? '', /service_stats_5m/)

    // hours=24, offset=24*10 -> window reaches 24*11h back -> beyond 7 days
    const coarse = captureQuery()
    await queryDashboardVolume(coarse.db, 't1', { hours: 24, offset: 24 * 10 })
    assert.match(coarse.calls[0]?.query ?? '', /FROM logweave\.service_stats\b/)
    assert.doesNotMatch(coarse.calls[0]?.query ?? '', /service_stats_5m/)
  })
})

// ---------------------------------------------------------------------------
// Real-ClickHouse integration test — proves unclustered rows are now counted
// ---------------------------------------------------------------------------

describe('queryDashboardVolume — unclustered rows are counted (real ClickHouse)', () => {
  const client = getTestClient()
  const db = getTestDb()

  before(async () => {
    await initSchema(client, logger)
  })

  after(async () => {
    await closeTestClient()
  })

  it('includes unclustered (template_id=0) rows in the smooth (<=7d) path', async () => {
    const tenant = testTenantId('volume-smooth')

    await batchInsert(db, [
      makeRow(tenant, { template_id: 'tmpl-real' }),
      makeRow(tenant, { template_id: '0', template_text: '' }),
    ])

    const rows = await queryDashboardVolume(db, tenant, { hours: 1 })
    const total = rows.reduce((sum, r) => sum + Number(r.log_count), 0)

    assert.equal(total, 2, 'both the clustered and unclustered row should be counted')
  })

  it('includes unclustered (template_id=0) rows in the coarse (>7d) path', async () => {
    const tenant = testTenantId('volume-coarse')

    await batchInsert(db, [
      makeRow(tenant, { template_id: 'tmpl-real' }),
      makeRow(tenant, { template_id: '0', template_text: '' }),
    ])

    const rows = await queryDashboardVolume(db, tenant, { hours: 24 * 10 })
    const total = rows.reduce((sum, r) => sum + Number(r.log_count), 0)

    assert.equal(total, 2, 'both the clustered and unclustered row should be counted')
  })
})
