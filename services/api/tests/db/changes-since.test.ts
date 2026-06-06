import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DbClient } from '../../src/db/client.js'
import {
  computeTimeWindow,
  queryBaselineSnapshot,
  queryNewTemplates,
  queryResolvedTemplates,
  queryTemplateSpikes,
} from '../../src/db/dashboard-changes-queries.js'

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const mockNewRows = [
  {
    template_id: 'tmpl-new-1',
    template_text: 'Connection timeout in {service}',
    service: 'api',
    occurrence_count: '42',
    error_count: '42',
    first_seen: '2026-03-20T14:30:00.000Z',
  },
]

const mockSpikeRows = [
  {
    template_id: 'tmpl-spike-1',
    template_text: 'Rate limit exceeded',
    service: 'api',
    current_count: '300',
    previous_count: '50',
    spike_ratio: '6.0',
  },
]

const mockResolvedRows = [
  {
    template_id: 'tmpl-resolved-1',
    template_text: 'Disk space warning',
    service: 'worker',
    last_seen: '2026-03-16T10:00:00.000Z',
    prev_count: '25',
  },
]

// ---------------------------------------------------------------------------
// Mock DbClient that captures queries
// ---------------------------------------------------------------------------

function createCapturingDb(mockData: unknown = []): {
  db: DbClient
  captured: Array<{ query: string; query_params: Record<string, unknown> }>
} {
  const captured: Array<{ query: string; query_params: Record<string, unknown> }> = []
  const db = {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      captured.push(params)
      return mockData
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, captured }
}

// ---------------------------------------------------------------------------
// computeTimeWindow tests
// ---------------------------------------------------------------------------

describe('computeTimeWindow', () => {
  it('computes correct windows for a 1-hour since', () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString()
    const tw = computeTimeWindow(oneHourAgo)

    const currentStart = new Date(tw.currentStart).getTime()
    const currentEnd = new Date(tw.currentEnd).getTime()
    const previousStart = new Date(tw.previousStart).getTime()
    const previousEnd = new Date(tw.previousEnd).getTime()

    // Current window: ~1 hour
    const currentDuration = currentEnd - currentStart
    assert.ok(
      currentDuration > 3_500_000 && currentDuration < 3_700_000,
      `current window ~1h: ${currentDuration}ms`,
    )

    // Previous window: same duration, ending at currentStart
    assert.equal(previousEnd, currentStart, 'previous ends where current starts')
    const previousDuration = previousEnd - previousStart
    assert.ok(
      Math.abs(previousDuration - currentDuration) < 100,
      `previous duration matches current: ${previousDuration} vs ${currentDuration}`,
    )
  })

  it('computes correct windows for a 12-hour since', () => {
    const twelveHoursAgo = new Date(Date.now() - 12 * 3_600_000).toISOString()
    const tw = computeTimeWindow(twelveHoursAgo)

    const currentStart = new Date(tw.currentStart).getTime()
    const previousEnd = new Date(tw.previousEnd).getTime()
    const previousStart = new Date(tw.previousStart).getTime()

    assert.equal(previousEnd, currentStart, 'previous ends where current starts')

    // Previous window starts ~24 hours ago (12h current + 12h previous)
    const totalSpan = new Date(tw.currentEnd).getTime() - previousStart
    assert.ok(
      totalSpan > 23 * 3_600_000 && totalSpan < 25 * 3_600_000,
      `total span ~24h: ${totalSpan}ms`,
    )
  })

  it('previous window extends before since', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString()
    const tw = computeTimeWindow(twoHoursAgo)

    const previousStart = new Date(tw.previousStart).getTime()
    const since = new Date(twoHoursAgo).getTime()

    assert.ok(previousStart < since, 'previous start is before since')
    // Previous start should be ~4 hours ago (2h before since which is 2h ago)
    const fourHoursAgo = Date.now() - 4 * 3_600_000
    assert.ok(Math.abs(previousStart - fourHoursAgo) < 100_000, 'previous start ~4h ago')
  })
})

// ---------------------------------------------------------------------------
// queryNewTemplates since-path tests
// ---------------------------------------------------------------------------

describe('queryNewTemplates with since', () => {
  it('SQL uses current_active CTE (set-difference)', async () => {
    const { db, captured } = createCapturingDb(mockNewRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryNewTemplates(db, 'tenant-a', { since })

    assert.equal(captured.length, 1)
    const sql = captured[0].query
    assert.ok(sql.includes('current_active'), 'should use current_active CTE')
    assert.ok(sql.includes('previous_ids'), 'should use previous_ids CTE')
    assert.ok(
      sql.includes('p.template_id IS NULL'),
      'should use set-difference (LEFT JOIN WHERE NULL)',
    )
  })

  it('SQL does NOT contain is_new_template', async () => {
    const { db, captured } = createCapturingDb(mockNewRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryNewTemplates(db, 'tenant-a', { since })

    const sql = captured[0].query
    assert.ok(!sql.includes('is_new_template'), 'since-path must NOT use is_new_template flag')
  })

  it('queries template_stats not log_metadata', async () => {
    const { db, captured } = createCapturingDb(mockNewRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryNewTemplates(db, 'tenant-a', { since })

    const sql = captured[0].query
    assert.ok(sql.includes('template_stats'), 'since-path should query template_stats')
    assert.ok(!sql.includes('log_metadata'), 'since-path should NOT query log_metadata')
  })

  it('passes absolute timestamps as params', async () => {
    const { db, captured } = createCapturingDb(mockNewRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryNewTemplates(db, 'tenant-a', { since })

    const params = captured[0].query_params
    assert.ok(params.current_start, 'should have current_start param')
    assert.ok(params.current_end, 'should have current_end param')
    assert.ok(params.previous_start, 'should have previous_start param')
    assert.ok(params.previous_end, 'should have previous_end param')
  })

  it('respects tenant isolation', async () => {
    const { db, captured } = createCapturingDb(mockNewRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryNewTemplates(db, 'tenant-xyz', { since })

    assert.equal(captured[0].query_params.tenant_id, 'tenant-xyz')
  })
})

// ---------------------------------------------------------------------------
// queryNewTemplates hours-path (regression) tests
// ---------------------------------------------------------------------------

describe('queryNewTemplates with hours (regression)', () => {
  // Issue #218: hours-path now mirrors since-path — set-difference on template_stats.
  // The previous is_new_template=1 filter was based on Drain3's global "first ever seen"
  // state, which fires once per template lifetime and missed templates dormant-then-surging.
  it('SQL uses set-difference on template_stats (not is_new_template flag)', async () => {
    const { db, captured } = createCapturingDb(mockNewRows)

    await queryNewTemplates(db, 'tenant-a', { hours: 24 })

    const sql = captured[0].query
    assert.ok(
      !sql.includes('is_new_template'),
      'hours-path must NOT use is_new_template (Drain3-global flag)',
    )
    assert.ok(sql.includes('template_stats'), 'hours-path should query template_stats')
    assert.ok(!sql.includes('log_metadata'), 'hours-path should NOT query log_metadata')
    assert.ok(sql.includes('current_active'), 'should use current_active CTE')
    assert.ok(sql.includes('previous_ids'), 'should use previous_ids CTE')
    assert.ok(
      sql.includes('p.template_id IS NULL'),
      'should use set-difference (LEFT JOIN WHERE NULL)',
    )
  })

  it('defaults to hours=24 when neither hours nor since provided', async () => {
    const { db, captured } = createCapturingDb(mockNewRows)

    await queryNewTemplates(db, 'tenant-a')

    const params = captured[0].query_params
    assert.equal(params.hours, 24, 'should default to 24 hours')
    assert.equal(params.window, 48, 'should use 2x window for previous comparison')
    assert.ok(!captured[0].query.includes('current_start'), 'should NOT use absolute timestamps')
  })
})

// ---------------------------------------------------------------------------
// queryTemplateSpikes since-path tests
// ---------------------------------------------------------------------------

describe('queryTemplateSpikes with since', () => {
  it('SQL uses absolute timestamps', async () => {
    const { db, captured } = createCapturingDb(mockSpikeRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryTemplateSpikes(db, 'tenant-a', { since })

    const sql = captured[0].query
    assert.ok(sql.includes('{current_start:DateTime64(3)}'), 'should use absolute current_start')
    assert.ok(sql.includes('{previous_start:DateTime64(3)}'), 'should use absolute previous_start')
    assert.ok(!sql.includes('toIntervalHour'), 'should NOT use relative offsets')
  })

  it('respects tenant isolation', async () => {
    const { db, captured } = createCapturingDb(mockSpikeRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryTemplateSpikes(db, 'tenant-xyz', { since })

    assert.equal(captured[0].query_params.tenant_id, 'tenant-xyz')
  })

  it('excludes zero-baseline rows (no 999-ratio sentinel, INNER JOIN on previous)', async () => {
    const { db, captured } = createCapturingDb(mockSpikeRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryTemplateSpikes(db, 'tenant-a', { since, minBaseline: 0 })

    const sql = captured[0].query
    assert.ok(!sql.includes('999'), 'must not use 999 sentinel for missing previous')
    assert.ok(
      sql.includes('INNER JOIN previous'),
      'must INNER JOIN previous to drop zero-baseline rows',
    )
    assert.ok(
      sql.includes('p.cnt >= greatest({min_baseline:UInt32}, 1)'),
      'must enforce min_baseline of at least 1 even when caller passes 0',
    )
  })
})

describe('queryTemplateSpikes with hours', () => {
  it('excludes zero-baseline rows (no 999-ratio sentinel, INNER JOIN on previous)', async () => {
    const { db, captured } = createCapturingDb(mockSpikeRows)

    await queryTemplateSpikes(db, 'tenant-a', { hours: 1, minBaseline: 0 })

    const sql = captured[0].query
    assert.ok(!sql.includes('999'), 'must not use 999 sentinel for missing previous')
    assert.ok(
      sql.includes('INNER JOIN previous'),
      'must INNER JOIN previous to drop zero-baseline rows',
    )
    assert.ok(
      sql.includes('p.cnt >= greatest({min_baseline:UInt32}, 1)'),
      'must enforce min_baseline of at least 1 even when caller passes 0',
    )
  })
})

// ---------------------------------------------------------------------------
// queryResolvedTemplates since-path tests
// ---------------------------------------------------------------------------

describe('queryResolvedTemplates with since', () => {
  it('SQL uses absolute timestamps', async () => {
    const { db, captured } = createCapturingDb(mockResolvedRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryResolvedTemplates(db, 'tenant-a', { since })

    const sql = captured[0].query
    assert.ok(sql.includes('{current_start:DateTime64(3)}'), 'should use absolute current_start')
    assert.ok(sql.includes('{previous_start:DateTime64(3)}'), 'should use absolute previous_start')
    assert.ok(!sql.includes('toIntervalHour'), 'should NOT use relative offsets')
  })

  it('retains HAVING prev_count >= 5', async () => {
    const { db, captured } = createCapturingDb(mockResolvedRows)
    const since = new Date(Date.now() - 3_600_000).toISOString()

    await queryResolvedTemplates(db, 'tenant-a', { since })

    assert.ok(
      captured[0].query.includes('HAVING prev_count >= 5'),
      'should keep minimum count threshold',
    )
  })
})

// ---------------------------------------------------------------------------
// queryBaselineSnapshot tests (issue #218)
// ---------------------------------------------------------------------------

describe('queryBaselineSnapshot', () => {
  it('returns empty when previous window has zero events', async () => {
    const { db } = createCapturingDb([{ prev_events: 0 }])
    const result = await queryBaselineSnapshot(db, 'tenant-a', { hours: 1 })
    assert.equal(result.status, 'empty')
    assert.equal(result.previousWindowEvents, 0)
  })

  it('returns sparse when previous window has < 50 events', async () => {
    const { db } = createCapturingDb([{ prev_events: 25 }])
    const result = await queryBaselineSnapshot(db, 'tenant-a', { hours: 1 })
    assert.equal(result.status, 'sparse')
    assert.equal(result.previousWindowEvents, 25)
  })

  it('returns ok when previous window has >= 50 events', async () => {
    const { db } = createCapturingDb([{ prev_events: 1500 }])
    const result = await queryBaselineSnapshot(db, 'tenant-a', { hours: 1 })
    assert.equal(result.status, 'ok')
    assert.equal(result.previousWindowEvents, 1500)
  })

  it('handles string-typed counts from ClickHouse JSON', async () => {
    const { db } = createCapturingDb([{ prev_events: '300' }])
    const result = await queryBaselineSnapshot(db, 'tenant-a', { hours: 1 })
    assert.equal(result.status, 'ok')
    assert.equal(result.previousWindowEvents, 300)
  })

  it('hours-path uses previous-window time range only', async () => {
    const { db, captured } = createCapturingDb([{ prev_events: 100 }])
    await queryBaselineSnapshot(db, 'tenant-a', { hours: 1 })
    const sql = captured[0].query
    assert.ok(sql.includes('template_stats'), 'should query template_stats')
    assert.ok(sql.includes('countMerge(occurrence_count)'), 'should aggregate occurrence_count')
    assert.equal(captured[0].query_params.hours, 1)
    assert.equal(captured[0].query_params.window, 2, 'window should be 2x hours')
  })

  it('since-path passes absolute timestamps', async () => {
    const { db, captured } = createCapturingDb([{ prev_events: 100 }])
    const since = new Date(Date.now() - 3_600_000).toISOString()
    await queryBaselineSnapshot(db, 'tenant-a', { since })
    const params = captured[0].query_params
    assert.ok(params.previous_start, 'should have previous_start param')
    assert.ok(params.previous_end, 'should have previous_end param')
    assert.ok(!params.hours, 'should NOT use hours when since is provided')
  })

  it('respects tenant isolation', async () => {
    const { db, captured } = createCapturingDb([{ prev_events: 100 }])
    await queryBaselineSnapshot(db, 'tenant-xyz', { hours: 1 })
    assert.equal(captured[0].query_params.tenant_id, 'tenant-xyz')
  })

  it('handles empty result rows (defensive)', async () => {
    const { db } = createCapturingDb([])
    const result = await queryBaselineSnapshot(db, 'tenant-a', { hours: 1 })
    assert.equal(result.status, 'empty')
    assert.equal(result.previousWindowEvents, 0)
  })
})
