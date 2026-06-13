import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import { insertAuditEvent } from '../../src/db/audit-queries.js'
import { initSchema } from '../../src/db/schema.js'
import { closeTestClient, getTestClient, getTestDb, jsonRows, testTenantId } from './helpers.js'

const logger = pino({ level: 'silent' })

// Real-ClickHouse proof that audit events land in audit_log — the marketed SOC2
// trail is only meaningful if the rows actually persist (AC for HP-Sec-6).
describe('insertAuditEvent (real ClickHouse)', () => {
  const client = getTestClient()
  const db = getTestDb()
  const tenantId = testTenantId('audit')

  before(async () => {
    await initSchema(client, logger)
  })

  after(async () => {
    await closeTestClient()
  })

  it('writes a rule.create row that is readable back from audit_log', async () => {
    await insertAuditEvent(db, tenantId, {
      keyId: 'session:user-7',
      action: 'rule.create',
      sourceIp: '203.0.113.9',
      details: JSON.stringify({ ruleId: 'rule-xyz', name: 'High errors' }),
    })

    let stored: Record<string, unknown> | undefined
    for (let attempt = 0; attempt < 5 && !stored; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200))
      const result = await client.query({
        query: `SELECT tenant_id, key_id, action, source_ip, details
                FROM logweave.audit_log
                WHERE tenant_id = {tenant_id:String} AND action = {action:String}
                LIMIT 1`,
        query_params: { tenant_id: tenantId, action: 'rule.create' },
      })
      const rows = await jsonRows<Record<string, unknown>>(result)
      stored = rows[0]
    }

    assert.ok(stored, 'Expected an audit_log row')
    assert.equal(stored.tenant_id, tenantId)
    assert.equal(stored.key_id, 'session:user-7')
    assert.equal(stored.action, 'rule.create')
    assert.equal(stored.source_ip, '203.0.113.9')
    assert.ok(String(stored.details).includes('rule-xyz'))
  })
})
