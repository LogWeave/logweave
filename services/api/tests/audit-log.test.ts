import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { insertAuditEvent } from '../src/db/audit-queries.js'
import type { DbClient } from '../src/db/client.js'

// ---------------------------------------------------------------------------
// Mock DbClient
// ---------------------------------------------------------------------------

interface CommandCall {
  query: string
  query_params: Record<string, unknown>
}

function createMockDb() {
  const commands: CommandCall[] = []
  const db = {
    command: async (params: CommandCall) => {
      commands.push(params)
    },
    query: async () => [],
    insert: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, commands }
}

// ---------------------------------------------------------------------------
// insertAuditEvent — runs on every login, logout, tail SSE start/end. The
// audit_log table is the SOC2 paper trail; a regression here silently
// breaks compliance, so we lock the call shape down explicitly.
// ---------------------------------------------------------------------------

const TENANT_A = 'tenant-a'

describe('insertAuditEvent', () => {
  it('writes via db.command with all fields populated', async () => {
    const { db, commands } = createMockDb()

    await insertAuditEvent(db, TENANT_A, {
      keyId: 'key-123',
      action: 'tail.connect',
      sourceIp: '192.168.1.1',
      details: '{"filters":{"service":"payments"}}',
      durationMs: 5000,
      eventsStreamed: 42,
    })

    assert.equal(commands.length, 1)
    const cmd = commands[0]
    assert.ok(cmd, 'command must have been captured')
    assert.match(cmd.query, /INSERT INTO logweave\.audit_log/)
    assert.equal(cmd.query_params.tenant_id, TENANT_A)
    assert.equal(cmd.query_params.key_id, 'key-123')
    assert.equal(cmd.query_params.action, 'tail.connect')
    assert.equal(cmd.query_params.source_ip, '192.168.1.1')
    assert.equal(cmd.query_params.details, '{"filters":{"service":"payments"}}')
    assert.equal(cmd.query_params.duration_ms, 5000)
    assert.equal(cmd.query_params.events_streamed, 42)
  })

  it('defaults optional fields when omitted', async () => {
    const { db, commands } = createMockDb()

    await insertAuditEvent(db, TENANT_A, {
      keyId: 'key-456',
      action: 'auth.login',
    })

    assert.equal(commands.length, 1)
    const cmd = commands[0]
    assert.ok(cmd)
    assert.equal(cmd.query_params.source_ip, '')
    assert.equal(cmd.query_params.details, '')
    assert.equal(cmd.query_params.duration_ms, 0)
    assert.equal(cmd.query_params.events_streamed, 0)
  })

  it('parameterises tenant_id (no string interpolation)', async () => {
    const { db, commands } = createMockDb()

    // Tenant IDs are bearer-token-derived; a SQL-injection-shaped tenant
    // value must land as a query parameter, not interpolated into the SQL.
    const adversarial = "evil'; DROP TABLE logweave.audit_log;--"
    await insertAuditEvent(db, adversarial, { keyId: 'k', action: 'auth.login' })

    const cmd = commands[0]
    assert.ok(cmd)
    assert.equal(cmd.query_params.tenant_id, adversarial)
    // The adversarial string must NOT appear in the SQL itself.
    assert.doesNotMatch(cmd.query, /DROP TABLE/)
  })

  it('different tenants produce isolated query_params', async () => {
    const { db, commands } = createMockDb()

    await insertAuditEvent(db, 'tenant-a', { keyId: 'k1', action: 'auth.login' })
    await insertAuditEvent(db, 'tenant-b', { keyId: 'k2', action: 'auth.login' })

    assert.equal(commands.length, 2)
    assert.equal(commands[0]?.query_params.tenant_id, 'tenant-a')
    assert.equal(commands[1]?.query_params.tenant_id, 'tenant-b')
  })
})
