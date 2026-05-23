import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DbClient } from '../../src/db/client.js'
import {
  BASELINE_ROW_WARN_THRESHOLD,
  BASELINE_WINDOW_DAYS,
  queryAnomalyBaselines,
} from '../../src/db/anomaly-queries.js'

// Window length and row-cap warning threshold are product decisions recorded
// in ADR-014. Lock them down so they can't silently drift on a refactor.
describe('anomaly baseline window', () => {
  it('BASELINE_WINDOW_DAYS is 7 (ADR-014)', () => {
    assert.equal(BASELINE_WINDOW_DAYS, 7)
  })

  it('BASELINE_ROW_WARN_THRESHOLD is set (ADR-014)', () => {
    assert.ok(BASELINE_ROW_WARN_THRESHOLD >= 50_000)
  })

  it('queryAnomalyBaselines query has expected shape', async () => {
    let captured: { query: string; query_params: Record<string, unknown> } | undefined
    const db = {
      query: async (params: { query: string; query_params: Record<string, unknown> }) => {
        captured = params
        return []
      },
      insert: async () => {},
      command: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient

    await queryAnomalyBaselines(db, 't1')
    assert.ok(captured, 'query should have been called')
    assert.equal(captured.query_params.window_days, BASELINE_WINDOW_DAYS)
    assert.equal(captured.query_params.min_samples, 3, 'min-sample guard (ADR-014)')

    // Hour-of-day grouping (ADR-014 lookup contract)
    assert.match(captured.query, /toHour\(interval_start\)\s+AS\s+hour_of_day/)
    assert.match(captured.query, /GROUP BY template_id, service, hour_of_day/)
    // HAVING guard prevents 1-sample baselines (ADR-014)
    assert.match(captured.query, /HAVING uniq\(interval_start\) >= \{min_samples:UInt32\}/)
    // Deterministic ordering — no silent truncation
    assert.match(captured.query, /ORDER BY template_id, service, hour_of_day/)
    // No LIMIT clause (ADR-014: rely on cardinality bound + warn threshold)
    assert.doesNotMatch(captured.query, /\bLIMIT\b/)
  })
})
