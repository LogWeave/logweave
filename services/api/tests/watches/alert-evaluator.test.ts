import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import { AnomalyScorer, WARMUP_SENTINEL_TEMPLATE_ID } from '../../src/pipeline/anomaly-scorer.js'
import { AlertDispatcher, type AlertEvent, type TemplateAlertEvent } from '../../src/watches/alert-observer.js'
import { AlertEvaluator } from '../../src/watches/alert-evaluator.js'
import { WatchStore } from '../../src/watches/watch-store.js'
import { type BaselineSpec, createBaselineMockDb, createMockDb } from '../helpers/mock-db.js'

const silentLogger = pino({ level: 'silent' })

interface SetupOptions {
  clock?: number
  cooldownMs?: number
  baselines?: BaselineSpec[]
}

interface Setup {
  watchStore: WatchStore
  scorer: AnomalyScorer
  evaluator: AlertEvaluator
  alerts: AlertEvent[]
  clock: { t: number }
  /** Register tenant+service as first-seen N ms ago via the public record path. */
  registerWarmup(tenantId: string, service: string, msAgo: number): void
}

function createTestSetup(options: SetupOptions = {}): Setup {
  const clock = { t: options.clock ?? Date.now() }
  const watchStore = new WatchStore()
  const scorer = new AnomalyScorer({
    db: options.baselines ? createBaselineMockDb(options.baselines) : createMockDb(),
    logger: silentLogger,
    coldStartMs: 0,
    steadyThreshold: 3,
    now: () => clock.t,
  })
  const alerts: AlertEvent[] = []
  const dispatcher = new AlertDispatcher(silentLogger)
  dispatcher.register({ notify: async (alert) => { alerts.push(alert) } })

  const evaluator = new AlertEvaluator({
    watchStore,
    anomalyScorer: scorer,
    dispatcher,
    logger: silentLogger,
    cooldownMs: options.cooldownMs ?? 30 * 60 * 1000,
    now: () => clock.t,
  })

  function registerWarmup(tenantId: string, service: string, msAgo: number): void {
    const restore = clock.t
    clock.t = restore - msAgo
    scorer.recordAndScore(tenantId, service, WARMUP_SENTINEL_TEMPLATE_ID)
    clock.t = restore
  }

  return { watchStore, scorer, evaluator, alerts, clock, registerWarmup }
}

describe('AlertEvaluator', () => {
  it('fires alert when score > threshold and no cooldown', async () => {
    const { watchStore, scorer, evaluator, alerts, registerWarmup } = createTestSetup({
      baselines: [{ tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 }],
    })

    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()
    await watchStore.add('t1', 'tmpl-1', 'Error in {service}')

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    const count = await evaluator.evaluate()
    assert.equal(count, 1, 'should fire 1 alert')
    assert.equal(alerts.length, 1)
    const alert = alerts[0] as TemplateAlertEvent
    assert.equal(alert.type, 'spike')
    assert.equal(alert.tenantId, 't1')
    assert.equal(alert.service, 'api')
    assert.equal(alert.templateId, 'tmpl-1')
    assert.equal(alert.templateText, 'Error in {service}')
    assert.equal(alert.currentCount, 50)
    assert.equal(alert.baselineCount, 10)
    assert.ok(alert.score > 1.0)
  })

  it('respects 30-minute cooldown', async () => {
    const { watchStore, scorer, evaluator, alerts, registerWarmup } = createTestSetup({
      baselines: [{ tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 }],
    })

    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()
    await watchStore.add('t1', 'tmpl-1')

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    await evaluator.evaluate()
    assert.equal(alerts.length, 1)

    await evaluator.evaluate()
    assert.equal(alerts.length, 1, 'should still be 1 alert (cooldown active)')
  })

  it('fires alert after cooldown expires', async () => {
    const { watchStore, scorer, evaluator, alerts, clock, registerWarmup } = createTestSetup({
      cooldownMs: 1000,
      baselines: [{ tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 }],
    })

    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()
    await watchStore.add('t1', 'tmpl-1')

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    await evaluator.evaluate()
    assert.equal(alerts.length, 1)

    clock.t += 2000

    await evaluator.evaluate()
    assert.equal(alerts.length, 2, 'should fire again after cooldown')
  })

  it('no alert when score < threshold', async () => {
    const { watchStore, scorer, evaluator, alerts, registerWarmup } = createTestSetup({
      baselines: [{ tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 100 }],
    })

    registerWarmup('t1', 'api', 2 * 3_600_000)
    await scorer.refreshBaselines()
    await watchStore.add('t1', 'tmpl-1')

    for (let i = 0; i < 5; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('dispatches to all observers — catches individual observer errors', async () => {
    const clock = { t: Date.now() }
    const watchStore = new WatchStore()
    const scorer = new AnomalyScorer({
      db: createBaselineMockDb([
        { tenantId: 't1', service: 'api', templateId: 'tmpl-1', avgCount: 10 },
      ]),
      logger: silentLogger,
      coldStartMs: 0,
      steadyThreshold: 3,
      now: () => clock.t,
    })

    const receivedAlerts: AlertEvent[] = []
    const dispatcher = new AlertDispatcher(silentLogger)
    dispatcher.register({ notify: async () => { throw new Error('observer 1 failed') } })
    dispatcher.register({ notify: async (alert) => { receivedAlerts.push(alert) } })

    const evaluator = new AlertEvaluator({
      watchStore, anomalyScorer: scorer, dispatcher, logger: silentLogger, now: () => clock.t,
    })

    // Register warmup via the public record path
    const restore = clock.t
    clock.t = restore - 2 * 3_600_000
    scorer.recordAndScore('t1', 'api', WARMUP_SENTINEL_TEMPLATE_ID)
    clock.t = restore
    await scorer.refreshBaselines()

    await watchStore.add('t1', 'tmpl-1')

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    await evaluator.evaluate()
    assert.equal(receivedAlerts.length, 1, 'second observer should still receive alert')
  })

  it('no alerts when no watches exist', async () => {
    const { evaluator, alerts } = createTestSetup()
    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('error in scorer does not crash evaluator', async () => {
    const now = Date.now()
    const watchStore = new WatchStore()
    const brokenScorer = {
      getWatchedScores: () => { throw new Error('scorer exploded') },
    } as unknown as AnomalyScorer

    const alerts: AlertEvent[] = []
    const dispatcher = new AlertDispatcher(silentLogger)
    dispatcher.register({ notify: async (alert) => { alerts.push(alert) } })

    const evaluator = new AlertEvaluator({
      watchStore,
      anomalyScorer: brokenScorer,
      dispatcher,
      logger: silentLogger,
      now: () => now,
    })

    await watchStore.add('t1', 'tmpl-1')

    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('new_burst type when template has no baseline', async () => {
    const { watchStore, scorer, evaluator, alerts, registerWarmup } = createTestSetup()

    registerWarmup('t1', 'api', 2 * 3_600_000)
    // No baselines provided — template is new
    await watchStore.add('t1', 'tmpl-new')

    for (let i = 0; i < 25; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-new')
    }

    await evaluator.evaluate()
    assert.equal(alerts.length, 1)
    const alert = alerts[0] as TemplateAlertEvent
    assert.equal(alert.type, 'new_burst', 'should be new_burst when no baseline')
    assert.equal(alert.baselineCount, 0)
  })
})
