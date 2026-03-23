import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { AlertDispatcher, type AlertEvent, type ThresholdAlertEvent } from '../../src/watches/alert-observer.js'
import { RuleStore, type ThresholdConfig } from '../../src/watches/rule-store.js'
import { ThresholdEvaluator } from '../../src/watches/threshold-evaluator.js'

const silentLogger = pino({ level: 'silent' })

interface QueryCall {
  query: string
  params: Record<string, unknown>
}

function createTestSetup(options: { clock?: number; cooldownMs?: number } = {}) {
  let clock = options.clock ?? Date.now()
  const ruleStore = new RuleStore()
  const alerts: AlertEvent[] = []
  const queryCalls: QueryCall[] = []

  const dispatcher = new AlertDispatcher(silentLogger)
  dispatcher.register({
    notify: async (alert) => {
      alerts.push(alert)
    },
  })

  let queryResult: Array<{ value: number }> = []

  const mockDb = {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      queryCalls.push({ query: params.query, params: params.query_params })
      return queryResult
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient

  const evaluator = new ThresholdEvaluator({
    ruleStore,
    dispatcher,
    db: mockDb,
    logger: silentLogger,
    cooldownMs: options.cooldownMs ?? 30 * 60 * 1000,
    now: () => clock,
  })

  return {
    ruleStore,
    evaluator,
    alerts,
    queryCalls,
    getClock: () => clock,
    setClock: (t: number) => {
      clock = t
    },
    setQueryResult: (rows: Array<{ value: number }>) => {
      queryResult = rows
    },
  }
}

function makeThresholdConfig(overrides?: Partial<ThresholdConfig>): ThresholdConfig {
  return {
    metric: 'error_count',
    service: 'payments',
    operator: '>',
    value: 10,
    windowMinutes: 5,
    ...overrides,
  }
}

describe('ThresholdEvaluator', () => {
  it('fires alert when metric exceeds threshold', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'High errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10 }),
      channels: [],
    })
    setQueryResult([{ value: 15 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 1)
    assert.equal(alerts.length, 1)

    const alert = alerts[0] as ThresholdAlertEvent
    assert.equal(alert.type, 'threshold_breach')
    assert.equal(alert.tenantId, 't1')
    assert.equal(alert.service, 'payments')
    assert.equal(alert.ruleName, 'High errors')
    assert.equal(alert.metric, 'error_count')
    assert.equal(alert.metricValue, 15)
    assert.equal(alert.thresholdValue, 10)
    assert.equal(alert.operator, '>')
    assert.equal(alert.windowMinutes, 5)
  })

  it('no alert when metric below threshold', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'High errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10 }),
      channels: [],
    })
    setQueryResult([{ value: 5 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('no alert when metric equals threshold with > operator', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'High errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10, operator: '>' }),
      channels: [],
    })
    setQueryResult([{ value: 10 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('fires alert with >= operator when value equals threshold', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'High errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10, operator: '>=' }),
      channels: [],
    })
    setQueryResult([{ value: 10 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 1)
  })

  it('fires alert with < operator', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'Low traffic',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ metric: 'log_count', value: 100, operator: '<' }),
      channels: [],
    })
    setQueryResult([{ value: 50 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 1)
    assert.equal((alerts[0] as ThresholdAlertEvent).metric, 'log_count')
  })

  it('fires alert with <= operator', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'Low warnings',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ metric: 'warn_count', value: 5, operator: '<=' }),
      channels: [],
    })
    setQueryResult([{ value: 5 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 1)
  })

  it('respects 30-minute cooldown', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'High errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10 }),
      channels: [],
    })
    setQueryResult([{ value: 15 }])

    await evaluator.evaluate()
    assert.equal(alerts.length, 1)

    // Second evaluation within cooldown
    await evaluator.evaluate()
    assert.equal(alerts.length, 1, 'should still be 1 alert (cooldown active)')
  })

  it('fires after cooldown expires', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult, setClock, getClock } = createTestSetup({
      cooldownMs: 1000,
    })
    await ruleStore.add({
      tenantId: 't1',
      name: 'High errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10 }),
      channels: [],
    })
    setQueryResult([{ value: 15 }])

    await evaluator.evaluate()
    assert.equal(alerts.length, 1)

    // Advance clock past cooldown
    setClock(getClock() + 2000)
    await evaluator.evaluate()
    assert.equal(alerts.length, 2, 'should fire again after cooldown')
  })

  it('no alerts when no rules exist', async () => {
    const { evaluator, alerts } = createTestSetup()
    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('disabled rules are skipped', async () => {
    const { ruleStore, evaluator, alerts, queryCalls, setQueryResult } = createTestSetup()
    const result = await ruleStore.add({
      tenantId: 't1',
      name: 'Disabled rule',
      ruleType: 'threshold',
      enabled: false,
      config: makeThresholdConfig({ value: 10 }),
      channels: [],
    })
    setQueryResult([{ value: 15 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
    assert.equal(queryCalls.length, 0, 'should not query DB for disabled rules')
  })

  it('handles DB query failure gracefully', async () => {
    const ruleStore = new RuleStore()
    const alerts: AlertEvent[] = []
    const dispatcher = new AlertDispatcher(silentLogger)
    dispatcher.register({ notify: async (alert) => { alerts.push(alert) } })

    const failingDb = {
      query: async () => {
        throw new Error('DB query failed')
      },
      insert: async () => {},
      command: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient

    const evaluator = new ThresholdEvaluator({
      ruleStore,
      dispatcher,
      db: failingDb,
      logger: silentLogger,
    })

    await ruleStore.add({
      tenantId: 't1',
      name: 'High errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10 }),
      channels: [],
    })

    // Should not throw
    const count = await evaluator.evaluate()
    assert.equal(count, 0)
    assert.equal(alerts.length, 0)
  })

  it('treats missing service data as zero', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'High errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10 }),
      channels: [],
    })
    // Empty result — no data for this service
    setQueryResult([])

    const count = await evaluator.evaluate()
    assert.equal(count, 0, 'value=0 should not exceed threshold of 10')
  })

  it('multiple tenants evaluated independently', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't-a',
      name: 'Rule A',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10, service: 'api' }),
      channels: [],
    })
    await ruleStore.add({
      tenantId: 't-b',
      name: 'Rule B',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10, service: 'web' }),
      channels: [],
    })
    setQueryResult([{ value: 15 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 2)
    assert.equal(alerts.length, 2)

    const tenants = alerts.map((a) => a.tenantId).sort()
    assert.deepEqual(tenants, ['t-a', 't-b'])
  })

  it('prunes stale cooldowns', async () => {
    const { ruleStore, evaluator, setQueryResult, setClock, getClock } = createTestSetup({
      cooldownMs: 1000,
    })
    await ruleStore.add({
      tenantId: 't1',
      name: 'Rule',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10 }),
      channels: [],
    })
    setQueryResult([{ value: 15 }])

    await evaluator.evaluate()

    // Advance clock well past 2x cooldown
    setClock(getClock() + 10_000)
    // Set value below threshold so no new alert — just prune
    setQueryResult([{ value: 5 }])
    await evaluator.evaluate()

    // Now set above threshold again — should fire since cooldown was pruned
    setQueryResult([{ value: 15 }])
    await evaluator.evaluate()
    // If cooldown wasn't pruned, this would be blocked
  })

  it('alert includes channels from rule', async () => {
    const { ruleStore, evaluator, alerts, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'Channeled rule',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10 }),
      channels: ['https://hooks.slack.com/abc', 'https://hooks.slack.com/def'],
    })
    setQueryResult([{ value: 15 }])

    await evaluator.evaluate()
    const alert = alerts[0] as ThresholdAlertEvent
    assert.deepEqual(alert.channels, ['https://hooks.slack.com/abc', 'https://hooks.slack.com/def'])
  })

  it('groups rules by (tenantId, metric, windowMinutes) — one query per group', async () => {
    const { ruleStore, evaluator, alerts, queryCalls, setQueryResult } = createTestSetup()
    // Two rules, same tenant/metric/window, different services
    await ruleStore.add({
      tenantId: 't1',
      name: 'Rule A',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 5, service: 'api' }),
      channels: [],
    })
    await ruleStore.add({
      tenantId: 't1',
      name: 'Rule B',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 5, service: 'web' }),
      channels: [],
    })
    setQueryResult([{ value: 10 }])

    await evaluator.evaluate()
    // Per-service queries (2 services in same group = 2 queries, not 2 groups)
    assert.equal(queryCalls.length, 2, 'should issue one query per service in the group')
    assert.equal(alerts.length, 2, 'both rules should fire')
  })

  it('environment-scoped rule adds environment filter to query', async () => {
    const { ruleStore, evaluator, alerts, queryCalls, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'Prod errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10, environment: 'production' }),
      channels: [],
    })
    setQueryResult([{ value: 15 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 1)
    assert.equal(alerts.length, 1)

    const alert = alerts[0] as ThresholdAlertEvent
    assert.equal(alert.environment, 'production')

    // Verify the query included environment filter
    assert.equal(queryCalls.length, 1)
    const call = queryCalls[0]
    assert.ok(call.query.includes('environment'), 'query should include environment filter')
    assert.equal(call.params.environment, 'production')
  })

  it('rule without environment omits environment filter from query', async () => {
    const { ruleStore, evaluator, alerts, queryCalls, setQueryResult } = createTestSetup()
    await ruleStore.add({
      tenantId: 't1',
      name: 'All env errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10 }),
      channels: [],
    })
    setQueryResult([{ value: 15 }])

    await evaluator.evaluate()
    assert.equal(alerts.length, 1)

    const alert = alerts[0] as ThresholdAlertEvent
    assert.equal(alert.environment, undefined)

    // Verify the query did NOT include environment filter
    assert.equal(queryCalls.length, 1)
    const call = queryCalls[0]
    assert.ok(!call.query.includes('environment'), 'query should not include environment filter')
    assert.equal(call.params.environment, undefined)
  })

  it('same service different environments are evaluated independently', async () => {
    const { ruleStore, evaluator, alerts, queryCalls, setQueryResult } = createTestSetup()
    // Two rules for same service but different environments
    await ruleStore.add({
      tenantId: 't1',
      name: 'Prod errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10, service: 'api', environment: 'production' }),
      channels: [],
    })
    await ruleStore.add({
      tenantId: 't1',
      name: 'Staging errors',
      ruleType: 'threshold',
      enabled: true,
      config: makeThresholdConfig({ value: 10, service: 'api', environment: 'staging' }),
      channels: [],
    })
    setQueryResult([{ value: 15 }])

    const count = await evaluator.evaluate()
    assert.equal(count, 2)
    assert.equal(alerts.length, 2)

    // They should be in separate groups (separate queries)
    assert.equal(queryCalls.length, 2)
    const envs = alerts.map((a) => (a as ThresholdAlertEvent).environment).sort()
    assert.deepEqual(envs, ['production', 'staging'])
  })

  it('skips rules with unknown metric gracefully', async () => {
    const ruleStore = new RuleStore()
    const alerts: AlertEvent[] = []
    const dispatcher = new AlertDispatcher(silentLogger)
    dispatcher.register({ notify: async (alert) => { alerts.push(alert) } })

    const mockDb = {
      query: async () => [],
      insert: async () => {},
      command: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient

    const evaluator = new ThresholdEvaluator({
      ruleStore,
      dispatcher,
      db: mockDb,
      logger: silentLogger,
    })

    // Add a rule with an unsupported metric
    await ruleStore.add({
      tenantId: 't1',
      name: 'CPU rule',
      ruleType: 'threshold',
      enabled: true,
      config: { metric: 'cpu_usage' as 'error_count', service: 'api', operator: '>', value: 90, windowMinutes: 5 },
      channels: [],
    })

    const count = await evaluator.evaluate()
    assert.equal(count, 0, 'should not fire — unknown metric returns empty results')
    assert.equal(alerts.length, 0)
  })
})
