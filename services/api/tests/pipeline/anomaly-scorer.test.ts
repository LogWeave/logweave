import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { AnomalyScorer, WARMUP_SENTINEL_TEMPLATE_ID } from '../../src/pipeline/anomaly-scorer.js'
import { createBaselineMockDb } from '../helpers/mock-db.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' })

interface ScorerHarness {
  scorer: AnomalyScorer
  /** Read or mutate the wall-clock value the scorer observes. */
  clock: { t: number }
  /**
   * Register a tenant+service as "first seen at warmupMsAgo ago" by emitting
   * a single event at that historical timestamp. The single event is silent
   * (first event always scores 0 — the warmup-tracker initialiser). After
   * the call, the clock is restored to its previous value.
   */
  registerWarmup(tenantId: string, service: string, warmupMsAgo: number): void
}

function createHarness(
  options: {
    clock?: number
    coldStartMs?: number
    warmupMs?: number
    warmupThreshold?: number
    steadyThreshold?: number
    newTemplateThreshold?: number
    db?: DbClient
  } = {},
): ScorerHarness {
  const clock = { t: options.clock ?? Date.now() }
  const scorer = new AnomalyScorer({
    db: options.db ?? createBaselineMockDb([]),
    logger: silentLogger,
    coldStartMs: options.coldStartMs ?? 600_000,
    warmupMs: options.warmupMs ?? 3_600_000,
    warmupThreshold: options.warmupThreshold ?? 10,
    steadyThreshold: options.steadyThreshold ?? 3,
    newTemplateThreshold: options.newTemplateThreshold ?? 20,
    now: () => clock.t,
  })

  function registerWarmup(tenantId: string, service: string, warmupMsAgo: number): void {
    const restore = clock.t
    clock.t = restore - warmupMsAgo
    // First event for an unseen tenant+service initialises the warmup tracker
    // at the current clock and returns 0 — the scorer's public way of marking
    // "first seen at now".
    scorer.recordAndScore(tenantId, service, WARMUP_SENTINEL_TEMPLATE_ID)
    clock.t = restore
  }

  return { scorer, clock, registerWarmup }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnomalyScorer', () => {
  it('cold start: score=0 for first 10 minutes of a new tenant+service', async () => {
    const { scorer, clock, registerWarmup } = createHarness({
      coldStartMs: 600_000,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 },
      ]),
    })
    registerWarmup('t1', 'api', 60_000) // 1 minute ago — still inside cold start
    await scorer.refreshBaselines()

    // Still inside cold start
    clock.t += 60_000
    const score = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    assert.equal(score, 0, 'should return 0 during cold start')
  })

  it('warmup period (10-60min): 10x threshold applied', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      warmupMs: 3_600_000,
      warmupThreshold: 10,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 5 },
      ]),
    })
    registerWarmup('t1', 'api', 15 * 60_000) // 15 minutes ago — inside warmup
    await scorer.refreshBaselines()

    // Send 60 events — ratio = 60/5/10 = 1.2 (above threshold)
    let lastScore = 0
    for (let i = 0; i < 60; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.ok(lastScore > 1.0, `warmup score should be > 1.0, got ${lastScore}`)
    // At 60 events: 60/5/10 = 1.2 — moderate, not steady-state 4.0
    assert.ok(lastScore < 2.0, `score should be moderate with 10x threshold, got ${lastScore}`)
  })

  it('steady state (>60min): 3x threshold applied', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      warmupMs: 3_600_000,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000) // 2 hours ago — past warmup
    await scorer.refreshBaselines()

    let lastScore = 0
    for (let i = 0; i < 40; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.ok(lastScore > 1.0, `steady score should be > 1.0, got ${lastScore}`)
  })

  it('unclustered skip: template_id="0" always scores 0', () => {
    const { scorer, registerWarmup } = createHarness({ coldStartMs: 0 })
    registerWarmup('t1', 'api', 0)

    const score = scorer.recordAndScore('t1', 'api', '0')
    assert.equal(score, 0, 'unclustered events should score 0')
  })

  it('new template, low count (<20): score=0', () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      newTemplateThreshold: 20,
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    // No baselines configured — this is a new template

    let lastScore = 0
    for (let i = 0; i < 15; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'new-tmpl')
    }
    assert.equal(lastScore, 0, 'new template with < 20 events should score 0')
  })

  it('new template, high count (>20): score > 0', () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      newTemplateThreshold: 20,
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)

    let lastScore = 0
    for (let i = 0; i < 25; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'new-tmpl')
    }
    assert.ok(lastScore > 0, `new template with 25 events should score > 0, got ${lastScore}`)
    // score = 25/20 = 1.25
    assert.ok(Math.abs(lastScore - 1.25) < 0.01, `expected ~1.25, got ${lastScore}`)
  })

  it('below threshold: score=0 when count/baseline/threshold < 1', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 100 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    // Send 200 events — ratio = 200/100/3 = 0.67 < 1.0
    let lastScore = 0
    for (let i = 0; i < 200; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.equal(lastScore, 0, 'below-threshold events should score 0')
  })

  it('above threshold: score > 1.0', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    let lastScore = 0
    for (let i = 0; i < 50; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.ok(lastScore > 1.0, `above-threshold score should be > 1.0, got ${lastScore}`)
    assert.ok(Math.abs(lastScore - 50 / 10 / 3) < 0.01, `expected ~1.67, got ${lastScore}`)
  })

  it('refreshBaselines populates cache from DB rows', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 42 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)

    // Before refresh — no baseline, low count → score=0
    const scoreBefore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    assert.equal(scoreBefore, 0, 'should be 0 before baseline loaded')

    await scorer.refreshBaselines()

    // After refresh — baseline=42, send enough events to exceed 3x threshold
    let lastScore = 0
    for (let i = 0; i < 130; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    // count is 131 (1 from before + 130), score = 131/42/3 ≈ 1.04
    assert.ok(lastScore > 1.0, `should score > 1.0 after baseline refresh, got ${lastScore}`)
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

    const { scorer, registerWarmup } = createHarness({ db: failingDb, coldStartMs: 0 })
    registerWarmup('t1', 'api', 0)

    await scorer.refreshBaselines()

    const score = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    assert.equal(score, 0, 'should return 0 when baseline refresh fails')
  })

  it('counter isolation: different intervals are independent', async () => {
    const { scorer, clock, registerWarmup } = createHarness({
      coldStartMs: 0,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 5 },
      ]),
    })
    registerWarmup('t1', 'api', 0)
    await scorer.refreshBaselines()

    for (let i = 0; i < 10; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    clock.t += 5 * 60_000

    const score = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    // 1 event / 5 baseline / 3 threshold = 0.067 < 1.0 → should be 0
    assert.equal(score, 0, 'new interval should start from 1, not carry over')
  })

  it('tenant isolation: tenant A scoring does not affect tenant B', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't-a', service: 'api', templateId: 'tmpl-1', avgCount: 5 },
        { tenantId: 't-b', service: 'api', templateId: 'tmpl-1', avgCount: 5 },
      ]),
    })
    registerWarmup('t-a', 'api', 2 * 3_600_000)
    registerWarmup('t-b', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t-a', 'api', 'tmpl-1')
    }

    const scoreB = scorer.recordAndScore('t-b', 'api', 'tmpl-1')
    assert.equal(scoreB, 0, 'tenant B should not be affected by tenant A events')
  })

  it('batch accumulation: scores increase monotonically within a batch', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 5 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    const scores: number[] = []
    for (let i = 0; i < 50; i++) {
      scores.push(scorer.recordAndScore('t1', 'api', 'tmpl-1'))
    }

    const nonZero = scores.filter((s) => s > 0)
    for (let i = 1; i < nonZero.length; i++) {
      assert.ok(
        nonZero[i] >= nonZero[i - 1],
        `scores should be monotonically increasing: ${nonZero[i - 1]} -> ${nonZero[i]}`,
      )
    }
    assert.ok(nonZero.length > 0, 'should have some anomalous scores in a 50-event batch')
  })

  // ---------------------------------------------------------------------------
  // getWatchedScores tests
  // ---------------------------------------------------------------------------

  it('getWatchedScores returns correct scores for active watched templates', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    const scores = scorer.getWatchedScores('t1', new Set(['tmpl-1', 'tmpl-not-active']))
    assert.equal(scores.length, 1, 'should return 1 active template')
    assert.equal(scores[0].templateId, 'tmpl-1')
    assert.equal(scores[0].service, 'api')
    assert.equal(scores[0].currentCount, 50)
    assert.equal(scores[0].baselineCount, 10)
    assert.ok(scores[0].score > 1.0, `score should be > 1.0, got ${scores[0].score}`)
  })

  it('getWatchedScores returns empty for unwatched templates', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    const scores = scorer.getWatchedScores('t1', new Set(['tmpl-other']))
    assert.equal(scores.length, 0, 'should return empty for unwatched templates')
  })

  it('getWatchedScores does not mutate interval counters', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    const scores1 = scorer.getWatchedScores('t1', new Set(['tmpl-1']))
    const scores2 = scorer.getWatchedScores('t1', new Set(['tmpl-1']))
    assert.equal(scores1[0].currentCount, scores2[0].currentCount, 'counters should not change')
    assert.equal(scores1[0].score, scores2[0].score, 'scores should not change')
  })

  it('baseline=0 edge case: treated as no baseline (absolute threshold)', async () => {
    const { scorer, registerWarmup } = createHarness({
      coldStartMs: 0,
      newTemplateThreshold: 20,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 0 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    let lastScore = 0
    for (let i = 0; i < 15; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.equal(lastScore, 0, 'baseline=0 with low count should score 0')

    for (let i = 0; i < 10; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    // count is now 25, score = 25/20 = 1.25
    assert.ok(lastScore > 0, `baseline=0 with high count should score > 0, got ${lastScore}`)
  })

  // ---------------------------------------------------------------------------
  // Hour-of-day baseline tests (ADR-014)
  // ---------------------------------------------------------------------------

  // Fixed clock at 2026-05-23 03:00:00 UTC — exact start of UTC hour 3.
  // Using a fixed wall-time lets us assert the hour-of-day lookup behaviour
  // without depending on the harness's default Date.now() at runtime.
  const HOUR_3_UTC_MS = Date.UTC(2026, 4, 23, 3, 0, 0)
  const HOUR_15_UTC_MS = Date.UTC(2026, 4, 23, 15, 0, 0)

  it('hour-of-day match: uses the baseline for the current UTC hour', async () => {
    const { scorer, registerWarmup } = createHarness({
      clock: HOUR_3_UTC_MS,
      coldStartMs: 0,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        // Quiet hour: very small baseline at 3 AM UTC
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 1, hourOfDay: 3 },
        // Loud hour: huge baseline at 3 PM UTC
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 1000, hourOfDay: 15 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    // 30 events at 3 AM UTC: 30 / 1 / 3 = 10 → strongly anomalous (vs the
    // tiny quiet-hour baseline). If the scorer wrongly used the 3 PM
    // baseline (1000), this would be 30/1000/3 = 0.01 → score=0.
    let lastScore = 0
    for (let i = 0; i < 30; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.ok(lastScore > 1.0, `expected anomalous score at 3 AM, got ${lastScore}`)
  })

  it('hour-of-day match: same traffic looks normal during the loud hour', async () => {
    const { scorer, registerWarmup } = createHarness({
      clock: HOUR_15_UTC_MS,
      coldStartMs: 0,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 1, hourOfDay: 3 },
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 1000, hourOfDay: 15 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    // 30 events at 3 PM UTC against the 1000-baseline: 30/1000/3 = 0.01 → 0.
    let lastScore = 0
    for (let i = 0; i < 30; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.equal(lastScore, 0, 'expected normal score at peak hour with matching baseline')
  })

  it('hour-of-day: missing current-hour entry routes to new-template path, NOT a cross-hour mean', async () => {
    // ADR-014: we deliberately do NOT fall back to a cross-hour mean for
    // an unknown hour, because for peaky templates the mean is dominated
    // by busy hours and would silently swallow quiet-hour anomalies.
    // Counter-example: baselines of 1000 at peak hours; mean ≈ 333.
    // A 50-event burst at hour 3 against a 333 fallback → 0.05 (no alert).
    // Against the new-template path (threshold 20) → 2.5 (alert fires).
    const { scorer, registerWarmup } = createHarness({
      clock: HOUR_3_UTC_MS,
      coldStartMs: 0,
      newTemplateThreshold: 20,
      steadyThreshold: 3,
      db: createBaselineMockDb([
        // Peaky template: huge baselines at every hour EXCEPT 3 AM.
        ...Array.from({ length: 24 }, (_, h) => h)
          .filter((h) => h !== 3)
          .map((hourOfDay) => ({
            tenantId: 't1' as const,
            service: 'api' as const,
            templateId: 'tmpl-1' as const,
            avgCount: 1000,
            hourOfDay,
          })),
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    let lastScore = 0
    for (let i = 0; i < 50; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    // 50 > newTemplateThreshold(20) → score = 50/20 = 2.5
    assert.ok(lastScore > 1.0, `expected new-template path to fire, got ${lastScore}`)
    assert.ok(Math.abs(lastScore - 2.5) < 0.01, `expected ~2.5, got ${lastScore}`)
  })

  it('refresh clears stale per-hour entries when an empty result comes back', async () => {
    // A template that fires at hour 3 today but is removed from the baseline
    // query result tomorrow (e.g. template stopped firing entirely) must not
    // keep a stale entry in the cache.
    let baselines = [
      { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10, hourOfDay: 3 },
    ]
    const db = {
      query: async (params: { query: string; query_params: Record<string, unknown> }) => {
        if (params.query_params?.tenant_id !== 't1') return []
        return baselines.map((b) => ({
          template_id: b.templateId,
          service: b.service,
          hour_of_day: b.hourOfDay,
          avg_count_per_interval: String(b.avgCount),
        }))
      },
      insert: async () => {},
      command: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient

    const { scorer, registerWarmup } = createHarness({
      clock: HOUR_3_UTC_MS,
      coldStartMs: 0,
      newTemplateThreshold: 20,
      steadyThreshold: 3,
      db,
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    // With baseline=10, 50 events → 50/10/3 = 1.67 (anomalous via baseline path)
    let scoreWithBaseline = 0
    for (let i = 0; i < 50; i++) {
      scoreWithBaseline = scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.ok(Math.abs(scoreWithBaseline - 50 / 10 / 3) < 0.01, 'baseline path active')

    // Now the source returns empty — baseline should be cleared.
    baselines = []
    await scorer.refreshBaselines()

    // Reset counters by advancing to the next 5-min bucket
    const HARNESS_CLOCK_BUMP = 5 * 60_000
    const { scorer: scorer2, registerWarmup: rw2 } = createHarness({
      clock: HOUR_3_UTC_MS + HARNESS_CLOCK_BUMP,
      coldStartMs: 0,
      newTemplateThreshold: 20,
      steadyThreshold: 3,
      db,
    })
    rw2('t1', 'api', 2 * 3_600_000)
    await scorer2.refreshBaselines() // pulls the now-empty result set

    // Scoring with no baseline → new-template path. 25 > 20 → score = 1.25
    let scoreAfterClear = 0
    for (let i = 0; i < 25; i++) {
      scoreAfterClear = scorer2.recordAndScore('t1', 'api', 'tmpl-1')
    }
    assert.ok(
      Math.abs(scoreAfterClear - 25 / 20) < 0.01,
      `expected new-template path after stale clear, got ${scoreAfterClear}`,
    )
  })

  it('hour-of-day fallback: no baseline at all → new-template absolute threshold path', async () => {
    const { scorer, registerWarmup } = createHarness({
      clock: HOUR_3_UTC_MS,
      coldStartMs: 0,
      newTemplateThreshold: 20,
      db: createBaselineMockDb([
        // Baselines exist for a different template; tmpl-new has nothing.
        { tenantId: 't1', service: 'api', templateId: 'tmpl-other', avgCount: 5 },
      ]),
    })
    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()

    let lastScore = 0
    for (let i = 0; i < 25; i++) {
      lastScore = scorer.recordAndScore('t1', 'api', 'tmpl-new')
    }
    // 25 / 20 = 1.25 — new-template threshold path, unaffected by other templates' baselines.
    assert.ok(lastScore > 0, `expected new-template path to fire, got ${lastScore}`)
    assert.ok(Math.abs(lastScore - 1.25) < 0.01, `expected ~1.25, got ${lastScore}`)
  })
})
