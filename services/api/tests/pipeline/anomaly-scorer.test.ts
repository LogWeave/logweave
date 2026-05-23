import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { AnomalyScorer } from '../../src/pipeline/anomaly-scorer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger = pino({ level: 'silent' })

interface BaselineSpec {
  tenantId: string
  service: string
  templateId: string
  avgCount: number
}

/**
 * Mock DB that returns baseline rows scoped to whichever tenantId is in the
 * current `tenant_id` query parameter. Mirrors the real
 * `queryAnomalyBaselines` contract.
 */
function createBaselineMockDb(baselines: BaselineSpec[]): DbClient {
  return {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      const tenantId = params.query_params?.tenant_id as string | undefined
      return baselines
        .filter((b) => b.tenantId === tenantId)
        .map((b) => ({
          template_id: b.templateId,
          service: b.service,
          avg_count_per_interval: String(b.avgCount),
        }))
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

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
    scorer.recordAndScore(tenantId, service, '__warmup_sentinel__')
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
})
