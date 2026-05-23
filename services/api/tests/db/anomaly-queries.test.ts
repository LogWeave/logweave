import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DbClient } from '../../src/db/client.js'
import { BASELINE_WINDOW_DAYS, queryAnomalyBaselines } from '../../src/db/anomaly-queries.js'

// Window length is a product decision recorded in ADR-014. Lock it down
// so it can't silently drift on a refactor.
describe('anomaly baseline window', () => {
  it('BASELINE_WINDOW_DAYS is 7 (ADR-014)', () => {
    assert.equal(BASELINE_WINDOW_DAYS, 7)
  })

  it('queryAnomalyBaselines passes BASELINE_WINDOW_DAYS as window_days param', async () => {
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
    // Sanity: the SQL groups by hour_of_day (ADR-014 lookup contract).
    assert.match(captured.query, /toHour\(interval_start\)\s+AS\s+hour_of_day/)
    assert.match(captured.query, /GROUP BY template_id, service, hour_of_day/)
  })
})
