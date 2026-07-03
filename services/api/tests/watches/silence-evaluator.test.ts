import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { AnomalyScorer, ServiceSilenceScore } from '../../src/pipeline/anomaly-scorer.js'
import { AlertDispatcher, type AlertEvent } from '../../src/watches/alert-observer.js'
import { SilenceEvaluator } from '../../src/watches/silence-evaluator.js'
import type { TenantSettingsStore } from '../../src/watches/tenant-settings.js'

const silentLogger = pino({ level: 'silent' })

function createTestSetup(options: { clock?: number; cooldownMs?: number } = {}) {
  let clock = options.clock ?? Date.now()
  const alerts: AlertEvent[] = []
  const dispatcher = new AlertDispatcher(silentLogger)
  dispatcher.register({
    notify: async (alert) => {
      alerts.push(alert)
    },
  })

  let activeTenants: string[] = []
  const scoresByTenant = new Map<string, ServiceSilenceScore[]>()
  const trackedByTenant = new Map<string, Set<string>>()
  const maintenanceTenants = new Set<string>()

  const fakeScorer = {
    getActiveTenants: () => activeTenants,
    getServiceSilenceScores: (tenantId: string) => scoresByTenant.get(tenantId) ?? [],
    getTrackedServices: (tenantId: string) => trackedByTenant.get(tenantId) ?? new Set<string>(),
  } as unknown as AnomalyScorer

  const fakeSettingsStore = {
    isInMaintenance: (tenantId: string) => maintenanceTenants.has(tenantId),
  } as unknown as TenantSettingsStore

  const evaluator = new SilenceEvaluator({
    scorer: fakeScorer,
    dispatcher,
    logger: silentLogger,
    settingsStore: fakeSettingsStore,
    cooldownMs: options.cooldownMs ?? 30 * 60 * 1000,
    now: () => clock,
  })

  return {
    evaluator,
    alerts,
    setClock: (t: number) => {
      clock = t
    },
    setActiveTenants: (tenants: string[]) => {
      activeTenants = tenants
    },
    setScores: (tenantId: string, scores: ServiceSilenceScore[]) => {
      scoresByTenant.set(tenantId, scores)
      // Default: any service reported by the scorer is still "tracked" —
      // tests that care about the forgotten/stale case override this
      // explicitly via forgetService/forgetTenant.
      const tracked = trackedByTenant.get(tenantId) ?? new Set<string>()
      for (const s of scores) tracked.add(s.service)
      trackedByTenant.set(tenantId, tracked)
    },
    forgetService: (tenantId: string, service: string) => {
      trackedByTenant.get(tenantId)?.delete(service)
    },
    setMaintenance: (tenantId: string, inMaintenance: boolean) => {
      if (inMaintenance) maintenanceTenants.add(tenantId)
      else maintenanceTenants.delete(tenantId)
    },
  }
}

describe('SilenceEvaluator', () => {
  it('fires service_silent for a service reported silent by the scorer', async () => {
    const { evaluator, alerts, setActiveTenants, setScores } = createTestSetup()
    setActiveTenants(['t1'])
    setScores('t1', [{ service: 'api', expectedCount: 20, actualCount: 0 }])

    const count = await evaluator.evaluate()

    assert.equal(count, 1)
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]?.type, 'service_silent')
    if (alerts[0]?.type === 'service_silent') {
      assert.equal(alerts[0].service, 'api')
      assert.equal(alerts[0].expectedCount, 20)
      assert.equal(alerts[0].actualCount, 0)
    }
  })

  it('respects cooldown — does not re-fire within the cooldown window', async () => {
    const { evaluator, alerts, setActiveTenants, setScores } = createTestSetup({
      cooldownMs: 30 * 60 * 1000,
    })
    setActiveTenants(['t1'])
    setScores('t1', [{ service: 'api', expectedCount: 20, actualCount: 0 }])

    await evaluator.evaluate()
    const secondCount = await evaluator.evaluate()

    assert.equal(secondCount, 0, 'second evaluate within cooldown should not fire')
    assert.equal(alerts.length, 1, 'only the first alert should be dispatched')
  })

  it('fires again after the cooldown expires', async () => {
    const { evaluator, alerts, setActiveTenants, setScores, setClock } = createTestSetup({
      cooldownMs: 30 * 60 * 1000,
    })
    setActiveTenants(['t1'])
    setScores('t1', [{ service: 'api', expectedCount: 20, actualCount: 0 }])

    await evaluator.evaluate()
    setClock(Date.now() + 31 * 60 * 1000)
    const secondCount = await evaluator.evaluate()

    assert.equal(secondCount, 1, 'should fire again once cooldown has passed')
    assert.equal(alerts.length, 2)
  })

  it('dispatches service_silence_resolved once a silent service recovers', async () => {
    const { evaluator, alerts, setActiveTenants, setScores } = createTestSetup()
    setActiveTenants(['t1'])
    setScores('t1', [{ service: 'api', expectedCount: 20, actualCount: 0 }])
    await evaluator.evaluate()

    setScores('t1', [])
    await evaluator.evaluate()

    const resolved = alerts.find((a) => a.type === 'service_silence_resolved')
    assert.ok(resolved, 'expected a service_silence_resolved event')
    if (resolved?.type === 'service_silence_resolved') {
      assert.equal(resolved.service, 'api')
    }
  })

  it('does not dispatch resolved for a service that was never firing', async () => {
    const { evaluator, alerts, setActiveTenants, setScores } = createTestSetup()
    setActiveTenants(['t1'])
    setScores('t1', [])

    await evaluator.evaluate()

    assert.equal(alerts.length, 0)
  })

  it('skips tenants in a maintenance window', async () => {
    const { evaluator, alerts, setActiveTenants, setScores, setMaintenance } = createTestSetup()
    setActiveTenants(['t1'])
    setScores('t1', [{ service: 'api', expectedCount: 20, actualCount: 0 }])
    setMaintenance('t1', true)

    const count = await evaluator.evaluate()

    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('isolates tenants — one tenant silent does not affect another', async () => {
    const { evaluator, alerts, setActiveTenants, setScores } = createTestSetup()
    setActiveTenants(['t1', 't2'])
    setScores('t1', [{ service: 'api', expectedCount: 20, actualCount: 0 }])
    setScores('t2', [])

    await evaluator.evaluate()

    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]?.tenantId, 't1')
  })

  it('does not dispatch a false resolved for a service the scorer has forgotten while still silent', async () => {
    const { evaluator, alerts, setActiveTenants, setScores, forgetService } = createTestSetup()
    setActiveTenants(['t1'])
    setScores('t1', [{ service: 'api', expectedCount: 20, actualCount: 0 }])
    await evaluator.evaluate()

    // Scorer pruned the service (2h of total inactivity) — it drops out of
    // getServiceSilenceScores, but it never actually recovered.
    forgetService('t1', 'api')
    setScores('t1', [])
    await evaluator.evaluate()

    const resolved = alerts.filter((a) => a.type === 'service_silence_resolved')
    assert.equal(
      resolved.length,
      0,
      'a forgotten-while-silent service must not be reported resolved',
    )
  })

  it('does not dispatch a false resolved when a tenant disappears entirely while still silent', async () => {
    const { evaluator, alerts, setActiveTenants, setScores } = createTestSetup()
    setActiveTenants(['t1'])
    setScores('t1', [{ service: 'api', expectedCount: 20, actualCount: 0 }])
    await evaluator.evaluate()

    // Tenant has no tracked services left at all — scorer no longer reports it as active.
    setActiveTenants([])
    await evaluator.evaluate()
    await evaluator.evaluate()

    const resolved = alerts.filter((a) => a.type === 'service_silence_resolved')
    assert.equal(resolved.length, 0, 'a vanished tenant must not be reported resolved')
  })

  it('start/stop do not throw and are idempotent', () => {
    const { evaluator } = createTestSetup()
    evaluator.start()
    evaluator.start()
    evaluator.stop()
    evaluator.stop()
  })
})
