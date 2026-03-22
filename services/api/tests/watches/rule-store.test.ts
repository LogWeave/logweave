import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DbClient } from '../../src/db/client.js'
import { RuleStore, type AlertRule, type ThresholdConfig } from '../../src/watches/rule-store.js'

function createMockDb(overrides?: Partial<DbClient>): DbClient {
  return {
    query: async () => [],
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
    ...overrides,
  } as unknown as DbClient
}

function makeThresholdRule(tenantId: string, overrides?: Partial<AlertRule>): Omit<AlertRule, 'ruleId'> {
  return {
    tenantId,
    name: 'High error rate',
    ruleType: 'threshold',
    enabled: true,
    config: {
      metric: 'error_count',
      service: 'api',
      operator: '>',
      value: 10,
      windowMinutes: 5,
    } satisfies ThresholdConfig,
    channels: [],
    ...overrides,
  }
}

describe('RuleStore', () => {
  it('add + list returns the rule', async () => {
    const store = new RuleStore()
    const result = await store.add(makeThresholdRule('t1'))
    assert.notEqual(result, 'limit_exceeded')
    const rule = result as AlertRule

    const list = store.list('t1')
    assert.equal(list.length, 1)
    assert.equal(list[0].ruleId, rule.ruleId)
    assert.equal(list[0].name, 'High error rate')
    assert.equal(list[0].ruleType, 'threshold')
    assert.equal(list[0].enabled, true)
  })

  it('add generates UUIDv7 ruleId', async () => {
    const store = new RuleStore()
    const result = await store.add(makeThresholdRule('t1'))
    const rule = result as AlertRule
    assert.ok(rule.ruleId.length > 0, 'ruleId should be non-empty')
    assert.match(rule.ruleId, /^[0-9a-f-]{36}$/, 'ruleId should be UUID format')
  })

  it('add with explicit ruleId preserves it', async () => {
    const store = new RuleStore()
    const result = await store.add({ ...makeThresholdRule('t1'), ruleId: 'custom-id' })
    const rule = result as AlertRule
    assert.equal(rule.ruleId, 'custom-id')
  })

  it('update changes enabled flag', async () => {
    const store = new RuleStore()
    const result = await store.add(makeThresholdRule('t1'))
    const rule = result as AlertRule

    const updated = await store.update('t1', rule.ruleId, { enabled: false })
    assert.ok(updated)
    assert.equal(updated.enabled, false)

    const got = store.get('t1', rule.ruleId)
    assert.ok(got)
    assert.equal(got.enabled, false)
  })

  it('update changes config', async () => {
    const store = new RuleStore()
    const result = await store.add(makeThresholdRule('t1'))
    const rule = result as AlertRule

    const newConfig: ThresholdConfig = { metric: 'warn_count', service: 'api', operator: '>=', value: 50, windowMinutes: 15 }
    const updated = await store.update('t1', rule.ruleId, { config: newConfig })
    assert.ok(updated)
    assert.deepEqual(updated.config, newConfig)
  })

  it('update returns undefined for unknown rule', async () => {
    const store = new RuleStore()
    const result = await store.update('t1', 'nonexistent', { enabled: false })
    assert.equal(result, undefined)
  })

  it('remove returns true if present, false if not', async () => {
    const store = new RuleStore()
    const result = await store.add(makeThresholdRule('t1'))
    const rule = result as AlertRule

    assert.equal(await store.remove('t1', rule.ruleId), true)
    assert.equal(await store.remove('t1', rule.ruleId), false)
    assert.equal(store.list('t1').length, 0)
  })

  it('remove from unknown tenant is no-op', async () => {
    const store = new RuleStore()
    assert.equal(await store.remove('unknown', 'some-id'), false)
  })

  it('get returns undefined for unknown rule', async () => {
    const store = new RuleStore()
    assert.equal(store.get('t1', 'nonexistent'), undefined)
  })

  it('tenant isolation — rules from tenant A not visible to tenant B', async () => {
    const store = new RuleStore()
    await store.add(makeThresholdRule('t-a'))
    await store.add(makeThresholdRule('t-b'))

    assert.equal(store.list('t-a').length, 1)
    assert.equal(store.list('t-b').length, 1)
    assert.equal(store.list('t-c').length, 0)
  })

  it('getEnabledByType filters correctly', async () => {
    const store = new RuleStore()
    await store.add(makeThresholdRule('t1'))
    await store.add({
      ...makeThresholdRule('t1'),
      ruleType: 'template_watch',
      config: { templateId: 'tmpl-1', templateText: 'Error in <*>' },
    })

    const thresholdRules = store.getEnabledByType('threshold')
    assert.equal(thresholdRules.length, 1)
    assert.equal(thresholdRules[0].ruleType, 'threshold')

    const watchRules = store.getEnabledByType('template_watch')
    assert.equal(watchRules.length, 1)
    assert.equal(watchRules[0].ruleType, 'template_watch')
  })

  it('getEnabledByType excludes disabled rules', async () => {
    const store = new RuleStore()
    const result = await store.add(makeThresholdRule('t1'))
    const rule = result as AlertRule
    await store.update('t1', rule.ruleId, { enabled: false })

    assert.equal(store.getEnabledByType('threshold').length, 0)
  })

  it('enforces per-tenant rule limit', async () => {
    const store = new RuleStore({ maxPerTenant: 2 })
    await store.add(makeThresholdRule('t1'))
    await store.add(makeThresholdRule('t1'))
    const result = await store.add(makeThresholdRule('t1'))
    assert.equal(result, 'limit_exceeded')
    assert.equal(store.list('t1').length, 2)
  })

  it('list returns sorted by ruleId', async () => {
    const store = new RuleStore()
    await store.add({ ...makeThresholdRule('t1'), ruleId: 'z-rule' })
    await store.add({ ...makeThresholdRule('t1'), ruleId: 'a-rule' })
    await store.add({ ...makeThresholdRule('t1'), ruleId: 'm-rule' })

    const list = store.list('t1')
    assert.deepEqual(
      list.map((r) => r.ruleId),
      ['a-rule', 'm-rule', 'z-rule'],
    )
  })

  it('add with DB persists — rollback on error', async () => {
    const db = createMockDb({
      insert: async () => {
        throw new Error('DB insert failed')
      },
    })
    const store = new RuleStore({ db })

    await assert.rejects(() => store.add(makeThresholdRule('t1')), /DB insert failed/)
    assert.equal(store.list('t1').length, 0, 'should rollback in-memory state')
  })

  it('remove with DB persists — rollback on error', async () => {
    // Add rule without DB (in-memory only)
    const store = new RuleStore()
    const result = await store.add(makeThresholdRule('t1'))
    const rule = result as AlertRule

    // Swap in a failing DB for the remove
    ;(store as unknown as { db: DbClient }).db = createMockDb({
      insert: async () => {
        throw new Error('DB delete failed')
      },
    })

    await assert.rejects(() => store.remove('t1', rule.ruleId), /DB delete failed/)
    assert.equal(store.list('t1').length, 1, 'should rollback — rule still present')
  })

  it('update with DB rollback on error', async () => {
    const store = new RuleStore()
    const result = await store.add(makeThresholdRule('t1'))
    const rule = result as AlertRule

    // Swap in a failing DB
    ;(store as unknown as { db: DbClient }).db = createMockDb({
      insert: async () => {
        throw new Error('DB update failed')
      },
    })

    await assert.rejects(() => store.update('t1', rule.ruleId, { enabled: false }), /DB update failed/)
    assert.equal(store.get('t1', rule.ruleId)?.enabled, true, 'should rollback to original enabled state')
  })
})
