import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { AnomalyScorer } from '../../src/pipeline/anomaly-scorer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' })

function createMockDb(rows: unknown[] = []): DbClient {
  return {
    query: async () => rows,
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

/** Create a scorer with clock frozen at a given time. */
function createScorer(
  options: {
    clock?: number
    coldStartMs?: number
    warmupMs?: number
    warmupThreshold?: number
    steadyThreshold?: number
    newTemplateThreshold?: number
    db?: DbClient
  } = {},
) {
  const clock = options.clock ?? Date.now()
  return new AnomalyScorer({
    db: options.db ?? createMockDb(),
    logger: silentLogger,
    coldStartMs: options.coldStartMs ?? 600_000,
    warmupMs: options.warmupMs ?? 3_600_000,
    warmupThreshold: options.warmupThreshold ?? 10,
    steadyThreshold: options.steadyThreshold ?? 3,
    newTemplateThreshold: options.newTemplateThreshold ?? 20,
    now: () => clock,
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnomalyScorer', () => {
  it('cold start: score=0 for first 10 minutes of a new tenant+service', () => {
    const scorer = createScorer({ coldStartMs: 600_000 })

    // Pre-populate baseline so we know scoring would fire if not for cold start
    scorer.setBaseline('t1', 'api', 'tmpl-1', 10)

    const score = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    assert.equal(score, 0, 'should return 0 during cold start')
  })

  it('warmup period (10-60min): 10x threshold applied', () => {
    const now = Date.now()
    const scorer = createScorer({
      clock: now,
      coldStartMs: 0, // skip cold start
      warmupMs: 3_600_000,
      warmupThreshold: 10,
      steadyThreshold: 3,
    })

    // Register tenant warmup 15 minutes ago
    scorer.setWarmup('t1', 'api', now - 15 * 60_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 5)

    // Send 60 events — ratio = 60/5/10 = 1.2 (above threshold)
    let lastScore = 0
    for (let i = 0; i < 60; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.ok(lastScore > 1.0, `warmup score should be > 1.0, got ${lastScore}`)

    // Verify the threshold is 10x, not 3x
    // At 60 events: 60/5/10 = 1.2
    assert.ok(lastScore < 2.0, `score should be moderate with 10x threshold, got ${lastScore}`)
  })

  it('steady state (>60min): 3x threshold applied', () => {
    const now = Date.now()
    const scorer = createScorer({
      clock: now,
      coldStartMs: 0,
      warmupMs: 3_600_000,
      steadyThreshold: 3,
    })

    // Register warmup 2 hours ago — past the warmup period
    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 10)

    // Send 40 events — ratio = 40/10/3 = 1.33
    let lastScore = 0
    for (let i = 0; i < 40; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.ok(lastScore > 1.0, `steady score should be > 1.0, got ${lastScore}`)
  })

  it('unclustered skip: template_id="0" always scores 0', () => {
    const scorer = createScorer({ coldStartMs: 0 })
    scorer.setWarmup('t1', 'api', 0)

    const score = scorer.recordAndScore('t1', 'api', '0')
    assert.equal(score, 0, 'unclustered events should score 0')
  })

  it('new template, low count (<20): score=0', () => {
    const now = Date.now()
    const scorer = createScorer({
      clock: now,
      coldStartMs: 0,
      newTemplateThreshold: 20,
    })
    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    // No baseline set — this is a new template

    let lastScore = 0
    for (let i = 0; i < 15; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'new-tmpl')
    }
    assert.equal(lastScore, 0, 'new template with < 20 events should score 0')
  })

  it('new template, high count (>20): score > 0', () => {
    const now = Date.now()
    const scorer = createScorer({
      clock: now,
      coldStartMs: 0,
      newTemplateThreshold: 20,
    })
    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    // No baseline set

    let lastScore = 0
    for (let i = 0; i < 25; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'new-tmpl')
    }
    assert.ok(lastScore > 0, `new template with 25 events should score > 0, got ${lastScore}`)
    // score = 25/20 = 1.25
    assert.ok(Math.abs(lastScore - 1.25) < 0.01, `expected ~1.25, got ${lastScore}`)
  })

  it('below threshold: score=0 when count/baseline/threshold < 1', () => {
    const now = Date.now()
    const scorer = createScorer({
      clock: now,
      coldStartMs: 0,
      steadyThreshold: 3,
    })
    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 100)

    // Send 200 events — ratio = 200/100/3 = 0.67 < 1.0
    let lastScore = 0
    for (let i = 0; i < 200; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.equal(lastScore, 0, 'below-threshold events should score 0')
  })

  it('above threshold: score > 1.0', () => {
    const now = Date.now()
    const scorer = createScorer({
      clock: now,
      coldStartMs: 0,
      steadyThreshold: 3,
    })
    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 10)

    // Send 50 events — ratio = 50/10/3 = 1.67
    let lastScore = 0
    for (let i = 0; i < 50; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.ok(lastScore > 1.0, `above-threshold score should be > 1.0, got ${lastScore}`)
    assert.ok(Math.abs(lastScore - 50 / 10 / 3) < 0.01, `expected ~1.67, got ${lastScore}`)
  })

  it('baseline refresh failure: score=0, no throw', async () => {
    const failingDb = {
      query: async () => {
        throw new Error('ClickHouse down')
      },
      insert: async () => {},
      command: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient

    const scorer = createScorer({ db: failingDb, coldStartMs: 0 })
    scorer.setWarmup('t1', 'api', 0)

    // Trigger a refresh — should not throw
    await scorer.refreshBaselines()

    // Scoring should still work (returns 0 for no baseline)
    const score = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    assert.equal(score, 0, 'should return 0 when baseline refresh fails')
  })

  it('counter isolation: different intervals are independent', () => {
    let clockTime = Date.now()
    const scorer = new AnomalyScorer({
      db: createMockDb(),
      logger: silentLogger,
      coldStartMs: 0,
      now: () => clockTime,
    })
    scorer.setWarmup('t1', 'api', 0)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 5)

    // Record 10 events in the current interval
    for (let i = 0; i < 10; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    // Advance clock to next 5-min interval
    clockTime += 5 * 60_000

    // Score should be based on fresh counter (1 event, not 11)
    const score = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    // 1 event / 5 baseline / 3 threshold = 0.067 < 1.0 → should be 0
    assert.equal(score, 0, 'new interval should start from 1, not carry over')
  })

  it('tenant isolation: tenant A scoring does not affect tenant B', () => {
    const now = Date.now()
    const scorer = createScorer({
      clock: now,
      coldStartMs: 0,
      steadyThreshold: 3,
    })
    scorer.setWarmup('t-a', 'api', now - 2 * 3_600_000)
    scorer.setWarmup('t-b', 'api', now - 2 * 3_600_000)
    scorer.setBaseline('t-a', 'api', 'tmpl-1', 5)
    scorer.setBaseline('t-b', 'api', 'tmpl-1', 5)

    // Send 50 events for tenant A
    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t-a', 'api', 'tmpl-1')
    }

    // Tenant B's first event should be based on count=1, not 51
    const scoreB = scorer.recordAndScore('t-b', 'api', 'tmpl-1')
    // 1/5/3 = 0.067 < 1.0 → should be 0
    assert.equal(scoreB, 0, 'tenant B should not be affected by tenant A events')
  })

  it('batch accumulation: scores increase monotonically within a batch', () => {
    const now = Date.now()
    const scorer = createScorer({
      clock: now,
      coldStartMs: 0,
      steadyThreshold: 3,
    })
    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 5)

    const scores: number[] = []
    for (let i = 0; i < 50; i++) {
      scores.push(scorer.recordAndScore('t1', 'api', 'tmpl-1'))
    }

    // Non-zero scores should be increasing
    const nonZero = scores.filter((s) => s > 0)
    for (let i = 1; i < nonZero.length; i++) {
      assert.ok(
        nonZero[i] >= nonZero[i - 1],
        `scores should be monotonically increasing: ${nonZero[i - 1]} -> ${nonZero[i]}`,
      )
    }

    // Should have at least some non-zero scores
    assert.ok(nonZero.length > 0, 'should have some anomalous scores in a 50-event batch')
  })

  it('baseline=0 edge case: treated as no baseline (absolute threshold)', () => {
    const now = Date.now()
    const scorer = createScorer({
      clock: now,
      coldStartMs: 0,
      newTemplateThreshold: 20,
    })
    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    // Set baseline explicitly to 0
    scorer.setBaseline('t1', 'api', 'tmpl-1', 0)

    // 15 events — below absolute threshold of 20, should be 0
    let lastScore = 0
    for (let i = 0; i < 15; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.equal(lastScore, 0, 'baseline=0 with low count should score 0')

    // 25 events — above absolute threshold
    for (let i = 0; i < 10; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    // count is now 25, score = 25/20 = 1.25
    assert.ok(lastScore > 0, `baseline=0 with high count should score > 0, got ${lastScore}`)
  })
})
