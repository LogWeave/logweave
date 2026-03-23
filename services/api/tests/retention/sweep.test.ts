import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { RetentionSweep } from '../../src/retention/sweep.js'
import { TenantSettingsStore } from '../../src/watches/tenant-settings.js'

// ---------------------------------------------------------------------------
// Mock DB
// ---------------------------------------------------------------------------

function createMockDb() {
  const commands: Array<{ query: string; query_params?: Record<string, unknown> }> = []
  const db = {
    query: async () => [],
    insert: async () => {},
    command: async (params: { query: string; query_params?: Record<string, unknown> }) => {
      commands.push(params)
    },
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, commands }
}

function createSettingsStore(tenants: Record<string, { retentionDays?: number }>) {
  const store = new TenantSettingsStore()
  for (const [tenantId, settings] of Object.entries(tenants)) {
    // Use internal method — set() is async and needs DB, so we populate directly
    store.set(tenantId, settings)
  }
  return store
}

const logger = pino({ level: 'silent' })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RetentionSweep', () => {
  it('issues DELETE for tenant with retentionDays > 30', async () => {
    const { db, commands } = createMockDb()
    const store = createSettingsStore({ 'tenant-growth': { retentionDays: 90 } })
    const sweep = new RetentionSweep({ db, settingsStore: store, logger })

    const result = await sweep.sweep()

    assert.equal(result.tenantsProcessed, 1)
    assert.ok(commands.length > 0, 'should issue DELETE commands')
    // Every command should reference the tenant
    for (const cmd of commands) {
      assert.ok(cmd.query.includes('ALTER TABLE'), `should use ALTER TABLE DELETE: ${cmd.query}`)
      assert.equal(cmd.query_params?.tenant_id, 'tenant-growth')
    }
  })

  it('skips tenant with default 30d retention (table TTL handles it)', async () => {
    const { db, commands } = createMockDb()
    const store = createSettingsStore({ 'tenant-startup': {} })
    const sweep = new RetentionSweep({ db, settingsStore: store, logger })

    const result = await sweep.sweep()

    assert.equal(result.tenantsProcessed, 0)
    assert.equal(commands.length, 0)
  })

  it('skips tenant with explicit retentionDays=30', async () => {
    const { db, commands } = createMockDb()
    const store = createSettingsStore({ 'tenant-startup': { retentionDays: 30 } })
    const sweep = new RetentionSweep({ db, settingsStore: store, logger })

    const result = await sweep.sweep()

    assert.equal(result.tenantsProcessed, 0)
    assert.equal(commands.length, 0)
  })

  it('processes multiple tenants with different retention', async () => {
    const { db, commands } = createMockDb()
    const store = createSettingsStore({
      'tenant-startup': { retentionDays: 30 },
      'tenant-growth': { retentionDays: 90 },
      'tenant-scale': { retentionDays: 365 },
    })
    const sweep = new RetentionSweep({ db, settingsStore: store, logger })

    const result = await sweep.sweep()

    // Only growth and scale should be processed (startup = 30d, skipped)
    assert.equal(result.tenantsProcessed, 2)
    const tenantIds = commands.map((c) => c.query_params?.tenant_id)
    assert.ok(tenantIds.includes('tenant-growth'))
    assert.ok(tenantIds.includes('tenant-scale'))
    assert.ok(!tenantIds.includes('tenant-startup'))
  })

  it('targets the correct tables', async () => {
    const { db, commands } = createMockDb()
    const store = createSettingsStore({ 'tenant-growth': { retentionDays: 90 } })
    const sweep = new RetentionSweep({ db, settingsStore: store, logger })

    await sweep.sweep()

    const tables = commands.map((c) => {
      const match = c.query.match(/ALTER TABLE (\S+)/)
      return match ? match[1] : null
    })

    assert.ok(tables.includes('logweave.log_metadata'))
    assert.ok(tables.includes('logweave.template_stats'))
    assert.ok(tables.includes('logweave.service_stats'))
    assert.ok(tables.includes('logweave.alert_history'))
    assert.ok(tables.includes('logweave.deploys'))
  })

  it('handles DB error gracefully without crashing', async () => {
    const db = {
      query: async () => [],
      insert: async () => {},
      command: async () => {
        throw new Error('ClickHouse unavailable')
      },
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient
    const store = createSettingsStore({ 'tenant-growth': { retentionDays: 90 } })
    const sweep = new RetentionSweep({ db, settingsStore: store, logger })

    // Should not throw — errors logged per table, sweep continues
    const result = await sweep.sweep()
    assert.equal(result.errors, 5, 'one error per table (5 tables)')
    assert.equal(result.tenantsProcessed, 1)
  })

  it('uses correct retention cutoff in DELETE query', async () => {
    const { db, commands } = createMockDb()
    const store = createSettingsStore({ 'tenant-growth': { retentionDays: 90 } })
    const sweep = new RetentionSweep({ db, settingsStore: store, logger })

    await sweep.sweep()

    for (const cmd of commands) {
      assert.equal(cmd.query_params?.retention_days, 90, 'should pass retentionDays as param')
    }
  })

  it('does not delete from short-lived tables (service_stats_5m)', async () => {
    const { db, commands } = createMockDb()
    const store = createSettingsStore({ 'tenant-growth': { retentionDays: 90 } })
    const sweep = new RetentionSweep({ db, settingsStore: store, logger })

    await sweep.sweep()

    const tables = commands.map((c) => {
      const match = c.query.match(/ALTER TABLE (\S+)/)
      return match ? match[1] : null
    })
    assert.ok(!tables.includes('logweave.service_stats_5m'), 'should skip service_stats_5m')
  })
})
