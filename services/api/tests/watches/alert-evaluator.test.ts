import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { AnomalyScorer } from '../../src/pipeline/anomaly-scorer.js'
import { AlertDispatcher, type AlertEvent } from '../../src/watches/alert-observer.js'
import { AlertEvaluator } from '../../src/watches/alert-evaluator.js'
import { WatchStore } from '../../src/watches/watch-store.js'

const silentLogger = pino({ level: 'silent' })

function createMockDb(): DbClient {
  return {
    query: async () => [],
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

function createTestSetup(options: { clock?: number; cooldownMs?: number } = {}) {
  const clock = options.clock ?? Date.now()
  const watchStore = new WatchStore()
  const scorer = new AnomalyScorer({
    db: createMockDb(),
    logger: silentLogger,
    coldStartMs: 0,
    steadyThreshold: 3,
    now: () => clock,
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
    now: () => clock,
  })

  return { watchStore, scorer, evaluator, alerts, clock }
}

describe('AlertEvaluator', () => {
  it('fires alert when score > threshold and no cooldown', async () => {
    const now = Date.now()
    const { watchStore, scorer, evaluator, alerts } = createTestSetup({ clock: now })

    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 10)
    await watchStore.add('t1', 'tmpl-1', 'Error in {service}')

    // Record enough events to trigger anomaly (50/10/3 = 1.67)
    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    const count = await evaluator.evaluate()
    assert.equal(count, 1, 'should fire 1 alert')
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].type, 'spike')
    assert.equal(alerts[0].tenantId, 't1')
    assert.equal(alerts[0].service, 'api')
    assert.equal(alerts[0].templateId, 'tmpl-1')
    assert.equal(alerts[0].templateText, 'Error in {service}')
    assert.equal(alerts[0].currentCount, 50)
    assert.equal(alerts[0].baselineCount, 10)
    assert.ok(alerts[0].score > 1.0)
  })

  it('respects 30-minute cooldown', async () => {
    const now = Date.now()
    const { watchStore, scorer, evaluator, alerts } = createTestSetup({ clock: now })

    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 10)
    await watchStore.add('t1', 'tmpl-1')

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    // First evaluation fires
    await evaluator.evaluate()
    assert.equal(alerts.length, 1)

    // Second evaluation within cooldown — should NOT fire
    await evaluator.evaluate()
    assert.equal(alerts.length, 1, 'should still be 1 alert (cooldown active)')
  })

  it('fires alert after cooldown expires', async () => {
    let clockTime = Date.now()
    const watchStore = new WatchStore()
    const scorer = new AnomalyScorer({
      db: createMockDb(),
      logger: silentLogger,
      coldStartMs: 0,
      steadyThreshold: 3,
      now: () => clockTime,
    })
    const alerts: AlertEvent[] = []
    const dispatcher = new AlertDispatcher(silentLogger)
    dispatcher.register({ notify: async (alert) => { alerts.push(alert) } })

    const evaluator = new AlertEvaluator({
      watchStore,
      anomalyScorer: scorer,
      dispatcher,
      logger: silentLogger,
      cooldownMs: 1000, // 1 second for testing
      now: () => clockTime,
    })

    scorer.setWarmup('t1', 'api', clockTime - 2 * 3_600_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 10)
    await watchStore.add('t1', 'tmpl-1')

    for (let i = 0; i < 50; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    await evaluator.evaluate()
    assert.equal(alerts.length, 1)

    // Advance clock past cooldown
    clockTime += 2000

    await evaluator.evaluate()
    assert.equal(alerts.length, 2, 'should fire again after cooldown')
  })

  it('no alert when score < threshold', async () => {
    const now = Date.now()
    const { watchStore, scorer, evaluator, alerts } = createTestSetup({ clock: now })

    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 100)
    await watchStore.add('t1', 'tmpl-1')

    // 5 events: 5/100/3 = 0.017 — well below threshold
    for (let i = 0; i < 5; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-1')
    }

    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('dispatches to all observers — catches individual observer errors', async () => {
    const now = Date.now()
    const watchStore = new WatchStore()
    const scorer = new AnomalyScorer({
      db: createMockDb(),
      logger: silentLogger,
      coldStartMs: 0,
      steadyThreshold: 3,
      now: () => now,
    })

    const receivedAlerts: AlertEvent[] = []
    const dispatcher = new AlertDispatcher(silentLogger)
    // First observer throws
    dispatcher.register({ notify: async () => { throw new Error('observer 1 failed') } })
    // Second observer should still receive
    dispatcher.register({ notify: async (alert) => { receivedAlerts.push(alert) } })

    const evaluator = new AlertEvaluator({
      watchStore, anomalyScorer: scorer, dispatcher, logger: silentLogger, now: () => now,
    })

    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    scorer.setBaseline('t1', 'api', 'tmpl-1', 10)
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

    // Should not throw
    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('new_burst type when template has no baseline', async () => {
    const now = Date.now()
    const { watchStore, scorer, evaluator, alerts } = createTestSetup({ clock: now })

    scorer.setWarmup('t1', 'api', now - 2 * 3_600_000)
    // No baseline set — template is new
    await watchStore.add('t1', 'tmpl-new')

    // Record 25 events — exceeds absolute threshold of 20
    for (let i = 0; i < 25; i++) {
      scorer.recordAndScore('t1', 'api', 'tmpl-new')
    }

    await evaluator.evaluate()
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].type, 'new_burst', 'should be new_burst when no baseline')
    assert.equal(alerts[0].baselineCount, 0)
  })
})
