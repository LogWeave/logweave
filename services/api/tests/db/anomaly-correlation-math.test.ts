import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import { queryAnomalyBaselines } from '../../src/db/anomaly-queries.js'
import { DbClient } from '../../src/db/client.js'
import { queryCorrelations, queryServiceOutlier } from '../../src/db/correlation-queries.js'
import { batchInsert } from '../../src/db/insert.js'
import { initSchema } from '../../src/db/schema.js'
import type { LogMetadataRow } from '../../src/types.js'
import { closeTestClient, getTestClient, testTenantId } from './helpers.js'

// Real-ClickHouse validation of the Chunk 5 / #258 data-correctness fixes.
// Seeds log_metadata so the materialized views populate template_stats
// (5-min) and service_stats (hourly), then asserts the *statistics* the
// queries produce — not just SQL shape (covered by unit tests).

const logger = pino({ level: 'silent' })

function fmt(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '')
}

/** UTC timestamp `daysAgo` days back, set to hour:minute. */
function tsAt(daysAgo: number, hour: number, minute: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysAgo)
  d.setUTCHours(hour, minute, 0, 0)
  return fmt(d)
}

function makeRow(
  tenantId: string,
  timestamp: string,
  overrides: Partial<LogMetadataRow>,
): LogMetadataRow {
  return {
    tenant_id: tenantId,
    timestamp,
    service: 'svc',
    level: 'INFO',
    environment: 'test',
    template_id: 'tmpl',
    template_text: 'a template',
    is_new_template: 0,
    anomaly_score: 0,
    duration_ms: 10,
    source_type: 'winston',
    source_ref: 's3://b/k',
    ...overrides,
  }
}

/** N rows for one template at one timestamp (→ N occurrences in that bucket). */
function occ(
  tenantId: string,
  timestamp: string,
  n: number,
  overrides: Partial<LogMetadataRow>,
): LogMetadataRow[] {
  return Array.from({ length: n }, () => makeRow(tenantId, timestamp, overrides))
}

describe('anomaly + correlation math (real ClickHouse)', () => {
  const client = getTestClient()
  const db = new DbClient(client)

  before(async () => {
    await initSchema(client, logger)
  })

  after(async () => {
    await closeTestClient()
  })

  // -------------------------------------------------------------------------
  // Finding 1 — baseline is a true per-interval rate that counts silent buckets
  // -------------------------------------------------------------------------
  it('finding 1: baseline divides by distinct-days × 12, not buckets-that-fired', async () => {
    const tenant = testTenantId('f1')
    // One template fires at hour 10 on 3 distinct days, in ONE 5-min bucket per
    // day, 12 occurrences each → 36 occurrences total across 3 days.
    const rows: LogMetadataRow[] = []
    for (const daysAgo of [2, 3, 4]) {
      rows.push(...occ(tenant, tsAt(daysAgo, 10, 0), 12, { template_id: 't1' }))
    }
    await batchInsert(db, rows)

    const baselines = await queryAnomalyBaselines(db, tenant)
    const row = baselines.find((b) => b.template_id === 't1' && b.hour_of_day === 10)
    assert.ok(row, 'expected a baseline row for t1 at hour 10')

    // Old (buggy) denominator = total / buckets-that-fired = 36 / 3 = 12.
    // New denominator = total / (distinct_days × 12) = 36 / (3 × 12) = 1.0.
    assert.ok(
      Math.abs(row.avg_count_per_interval - 1.0) < 0.001,
      `expected per-interval rate ≈ 1.0 (zero-filled), got ${row.avg_count_per_interval}`,
    )
  })

  // -------------------------------------------------------------------------
  // Finding 2 — the guard requires distinct DAYS, not distinct 5-min buckets
  // -------------------------------------------------------------------------
  it('finding 2: 3 firings in one day do NOT establish a baseline', async () => {
    const tenant = testTenantId('f2')
    // 3 distinct 5-min buckets, all on a SINGLE day. uniq(interval_start)=3
    // (old guard would pass) but uniq(toDate)=1 (new guard rejects).
    const rows = [
      ...occ(tenant, tsAt(2, 11, 0), 5, { template_id: 't2' }),
      ...occ(tenant, tsAt(2, 11, 5), 5, { template_id: 't2' }),
      ...occ(tenant, tsAt(2, 11, 10), 5, { template_id: 't2' }),
    ]
    await batchInsert(db, rows)

    const baselines = await queryAnomalyBaselines(db, tenant)
    const row = baselines.find((b) => b.template_id === 't2')
    assert.equal(row, undefined, 'a single day of data must NOT yield a baseline')
  })

  it('finding 2: 3 distinct days DO establish a baseline', async () => {
    const tenant = testTenantId('f2b')
    const rows: LogMetadataRow[] = []
    for (const daysAgo of [2, 3, 4]) {
      rows.push(...occ(tenant, tsAt(daysAgo, 12, 0), 5, { template_id: 't2b' }))
    }
    await batchInsert(db, rows)

    const baselines = await queryAnomalyBaselines(db, tenant)
    const row = baselines.find((b) => b.template_id === 't2b' && b.hour_of_day === 12)
    assert.ok(row, '3 distinct days should yield a baseline')
  })

  // -------------------------------------------------------------------------
  // Finding 3 — service_outlier baseline is matched by hour-of-day
  // -------------------------------------------------------------------------
  it('finding 3: outlier baseline uses same hour-of-day, not a flat all-day mean', async () => {
    const tenant = testTenantId('f3')
    const nowH = new Date().getUTCHours()
    const otherH = (nowH + 12) % 24
    const rows: LogMetadataRow[] = []

    // Baseline at the current hour-of-day across 6 prior days: ~5 errors/day.
    const perDay = [4, 5, 6, 4, 5, 6]
    for (let d = 1; d <= 6; d++) {
      rows.push(...occ(tenant, tsAt(d, nowH, 0), perDay[d - 1], { service: 'pay', level: 'ERROR' }))
      // Contaminator at a different hour-of-day: 50 errors/day. A flat all-day
      // baseline would be dragged up toward ~27; hour-of-day matching ignores it.
      rows.push(...occ(tenant, tsAt(d, otherH, 0), 50, { service: 'pay', level: 'ERROR' }))
    }
    await batchInsert(db, rows)

    const result = await queryServiceOutlier(db, tenant, { service: 'pay', hours: 1 })
    const r = result[0]
    assert.ok(r, 'expected an outlier row')
    const baselineMean = Number(r.baseline_mean)
    const dataPoints = Number(r.data_points)
    assert.equal(dataPoints, 6, 'baseline should be the 6 same-hour-of-day days only')
    assert.ok(
      baselineMean >= 4 && baselineMean <= 6,
      `baseline mean should reflect the ~5 same-hour samples, not the 50-error other hour; got ${baselineMean}`,
    )
  })

  // -------------------------------------------------------------------------
  // Finding 4 — correlations are de-seasonalized by hour-of-day
  // -------------------------------------------------------------------------
  it('finding 4: de-seasonalization drops diurnal-only matches, keeps real co-movement', async () => {
    const tenant = testTenantId('f4')
    const now = new Date()
    // 24 five-minute buckets over the last ~2 hours → two hours-of-day, 12
    // buckets each, enough for a within-hour residual.
    const rows: LogMetadataRow[] = []
    for (let i = 1; i <= 24; i++) {
      const bucket = new Date(now.getTime() - i * 5 * 60_000)
      const when = fmt(bucket)
      // Diurnal step keyed on the REAL UTC hour so it aligns with the query's
      // hour-of-day partition (consecutive hours differ in parity).
      const hourBase = bucket.getUTCHours() % 2 === 0 ? 10 : 2
      const wave = (i % 5) + 1 // within-hour variation shared by A and C only

      // Anchor A and candidate C both carry the diurnal step AND the within-hour
      // wave → they co-move beyond the daily rhythm.
      rows.push(
        ...occ(tenant, when, hourBase + wave, { template_id: 'A', template_text: 'anchor' }),
      )
      rows.push(
        ...occ(tenant, when, hourBase + wave, { template_id: 'C', template_text: 'cand C' }),
      )
      // Candidate B carries ONLY the diurnal step (flat within each hour) → its
      // residual after de-seasonalization is ~0, so it must not correlate.
      rows.push(...occ(tenant, when, hourBase, { template_id: 'B', template_text: 'cand B' }))
    }
    await batchInsert(db, rows)

    const result = await queryCorrelations(db, tenant, { templateId: 'A', hours: 2, limit: 50 })
    const ids = result.map((r) => r.template_id)
    assert.ok(ids.includes('C'), `expected genuine co-mover C to be reported, got ${ids}`)
    assert.ok(
      !ids.includes('B'),
      `diurnal-only B must be removed by de-seasonalization, got ${ids}`,
    )
  })
})
