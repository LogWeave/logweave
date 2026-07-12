import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import { DbClient } from '../../src/db/client.js'
import { batchInsert } from '../../src/db/insert.js'
import { explainQuery, queryLogMetadata, tenantQuery } from '../../src/db/queries.js'
import { initSchema } from '../../src/db/schema.js'
import type { LogMetadataRow } from '../../src/types.js'
import { closeTestClient, getTestClient, jsonRows, testTenantId } from './helpers.js'

const logger = pino({ level: 'silent' })

function makeRow(tenantId: string, overrides?: Partial<LogMetadataRow>): LogMetadataRow {
  return {
    tenant_id: tenantId,
    timestamp: new Date().toISOString().replace('T', ' ').replace('Z', ''),
    service: 'test-svc',
    level: 'INFO',
    environment: 'test',
    source_type: 'winston',
    source_ref: 's3://bucket/key',
    ...overrides,
  }
}

describe('queries', () => {
  const client = getTestClient()
  const db = new DbClient(client)
  const tenantA = testTenantId('queries-A')
  const tenantB = testTenantId('queries-B')

  before(async () => {
    await initSchema(client, logger)

    // Insert data for two tenants
    await batchInsert(db, [
      makeRow(tenantA, { template_id: 'tmpl-a1', template_text: 'A template' }),
      makeRow(tenantA, { template_id: 'tmpl-a2', template_text: 'Another template' }),
      makeRow(tenantB, { template_id: 'tmpl-b1', template_text: 'B template' }),
    ])
  })

  after(async () => {
    await closeTestClient()
  })

  it('tenantQuery binds tenant_id parameter correctly', () => {
    const q = tenantQuery(
      'SELECT * FROM logweave.log_metadata WHERE tenant_id = {tenant_id:String}',
      'my-tenant',
    )
    assert.equal(q.query_params.tenant_id, 'my-tenant')
  })

  it('tenantQuery merges extra params', () => {
    const q = tenantQuery(
      'SELECT * FROM logweave.log_metadata WHERE tenant_id = {tenant_id:String} AND level = {level:String}',
      'my-tenant',
      { level: 'ERROR' },
    )
    assert.equal(q.query_params.tenant_id, 'my-tenant')
    assert.equal(q.query_params.level, 'ERROR')
  })

  it('tenant A cannot see tenant B data', async () => {
    const rowsA = await queryLogMetadata(db, tenantA)
    const rowsB = await queryLogMetadata(db, tenantB)

    assert.equal(rowsA.length, 2, 'Tenant A should have 2 rows')
    assert.equal(rowsB.length, 1, 'Tenant B should have 1 row')

    // Verify no cross-contamination
    for (const row of rowsA as Array<{ tenant_id: string }>) {
      assert.equal(row.tenant_id, tenantA)
    }
    for (const row of rowsB as Array<{ tenant_id: string }>) {
      assert.equal(row.tenant_id, tenantB)
    }
  })

  it('parameterized query prevents SQL injection', async () => {
    const maliciousTenant = "'; DROP TABLE logweave.log_metadata; --"

    // This should not throw — it just returns no rows
    const injectionResult = await queryLogMetadata(db, maliciousTenant)
    assert.equal(injectionResult.length, 0)

    // Verify table still exists
    const result = await client.query({
      query: 'SELECT count() AS cnt FROM logweave.log_metadata',
    })
    const countRows = await jsonRows<{ cnt: string }>(result)
    const first = countRows[0]
    assert.ok(first, 'Expected count result')
    assert.ok(Number(first.cnt) > 0, 'Table should still exist with data')
  })

  it('EXPLAIN shows partition pruning for tenant query', async () => {
    const query = 'SELECT * FROM logweave.log_metadata WHERE tenant_id = {tenant_id:String}'
    const explain = await explainQuery(db, query, { tenant_id: tenantA })

    // EXPLAIN output should contain indication of key condition or pruning
    const output = JSON.stringify(explain)
    assert.ok(
      output.includes('tenant_id') || output.includes('Key'),
      'EXPLAIN should reference tenant_id key condition',
    )
  })
})
