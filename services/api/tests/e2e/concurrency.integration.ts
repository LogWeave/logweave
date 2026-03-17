/**
 * E2E concurrency tests — multi-tenant isolation under load, same-tenant data integrity.
 * Requires Docker Compose running: docker compose up --build -d
 */
import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import { createClient } from '@clickhouse/client'
import type { ClickHouseClient } from '@clickhouse/client'
import { generateEvents } from './log-generator.js'
import {
  isReachable,
  ingestBatch,
  getClickhouseNow,
  countRowsSince,
  pollUntil,
} from './helpers.js'

const CLICKHOUSE_URL = 'http://default:logweave@localhost:8123'
const API_URL = 'http://localhost:3000'
const CLUSTERER_URL = 'http://localhost:8000'

const KEY_A = 'e2e-key-tenant-a'
const KEY_B = 'e2e-key-tenant-b'
const TENANT_A = 'e2e-tenant-a'
const TENANT_B = 'e2e-tenant-b'

let clickhouse: ClickHouseClient
let reachable = false
let startTime: string

describe('E2E concurrency tests (Docker Compose)', () => {
  before(async () => {
    const [api, clusterer, ch] = await Promise.all([
      isReachable(`${API_URL}/healthz`),
      isReachable(`${CLUSTERER_URL}/health`),
      isReachable(`${CLICKHOUSE_URL}/ping`),
    ])
    reachable = api && clusterer && ch

    if (reachable) {
      clickhouse = createClient({ url: CLICKHOUSE_URL })
      startTime = await getClickhouseNow(clickhouse)
    }
  })

  after(async () => {
    if (clickhouse) await clickhouse.close()
  })

  // -- C1: Multi-tenant concurrent ingest --

  it('10 concurrent requests from 2 tenants — isolation holds', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const batchSize = 100

    // 5 concurrent requests per tenant, 10 total
    const requests = [
      ...Array.from({ length: 5 }, () =>
        ingestBatch(KEY_A, generateEvents(batchSize), { service: 'conc-tenant-a' }),
      ),
      ...Array.from({ length: 5 }, () =>
        ingestBatch(KEY_B, generateEvents(batchSize), { service: 'conc-tenant-b' }),
      ),
    ]

    const results = await Promise.all(requests)

    // All requests should succeed
    for (const { status, body } of results) {
      assert.equal(status, 200)
      assert.equal(body.accepted, batchSize)
    }

    const expectedPerTenant = 5 * batchSize // 500

    // Poll for rows to arrive
    await pollUntil(
      async () => {
        const [countA, countB] = await Promise.all([
          countRowsSince(clickhouse, TENANT_A, startTime),
          countRowsSince(clickhouse, TENANT_B, startTime),
        ])
        return countA >= expectedPerTenant && countB >= expectedPerTenant
      },
      { intervalMs: 1000, timeoutMs: 20_000, label: 'concurrent multi-tenant rows stored' },
    )

    const countA = await countRowsSince(clickhouse, TENANT_A, startTime)
    const countB = await countRowsSince(clickhouse, TENANT_B, startTime)

    assert.ok(
      countA >= expectedPerTenant,
      `Tenant A: expected >= ${expectedPerTenant}, got ${countA}`,
    )
    assert.ok(
      countB >= expectedPerTenant,
      `Tenant B: expected >= ${expectedPerTenant}, got ${countB}`,
    )

    // Verify no cross-contamination in both directions
    const crossCheckAtoB = await clickhouse.query({
      query: `SELECT count() AS cnt FROM logweave.log_metadata
              WHERE tenant_id = {tenant_id:String}
              AND ingest_time >= {since:String}
              AND service = 'conc-tenant-b'`,
      query_params: { tenant_id: TENANT_A, since: startTime },
      format: 'JSONEachRow',
    })
    const crossAtoB = (await crossCheckAtoB.json()) as Array<{ cnt: string }>
    assert.equal(
      Number(crossAtoB[0]?.cnt ?? 0),
      0,
      'Tenant A should have no rows with tenant B service tag',
    )

    const crossCheckBtoA = await clickhouse.query({
      query: `SELECT count() AS cnt FROM logweave.log_metadata
              WHERE tenant_id = {tenant_id:String}
              AND ingest_time >= {since:String}
              AND service = 'conc-tenant-a'`,
      query_params: { tenant_id: TENANT_B, since: startTime },
      format: 'JSONEachRow',
    })
    const crossBtoA = (await crossCheckBtoA.json()) as Array<{ cnt: string }>
    assert.equal(
      Number(crossBtoA[0]?.cnt ?? 0),
      0,
      'Tenant B should have no rows with tenant A service tag',
    )
  })

  // -- C2: Same-tenant concurrent ingest --

  it('10 concurrent requests from same tenant — no data corruption', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    // Fresh baseline after C1
    const c2Start = await getClickhouseNow(clickhouse)

    const batchSize = 100
    const concurrency = 10
    const expectedTotal = batchSize * concurrency // 1000

    const requests = Array.from({ length: concurrency }, () =>
      ingestBatch(KEY_A, generateEvents(batchSize), { service: 'conc-same-tenant' }),
    )

    const results = await Promise.all(requests)

    // All requests should succeed
    for (const { status, body } of results) {
      assert.equal(status, 200)
      assert.equal(body.accepted, batchSize)
    }

    // Poll for all rows
    await pollUntil(
      async () => (await countRowsSince(clickhouse, TENANT_A, c2Start)) >= expectedTotal,
      { intervalMs: 1000, timeoutMs: 20_000, label: 'concurrent same-tenant rows stored' },
    )

    const count = await countRowsSince(clickhouse, TENANT_A, c2Start)
    assert.ok(
      count >= expectedTotal,
      `Expected >= ${expectedTotal} rows, got ${count}`,
    )

    // Verify all rows have correct tenant_id
    const wrongTenant = await clickhouse.query({
      query: `SELECT count() AS cnt FROM logweave.log_metadata
              WHERE tenant_id != {tenant_id:String}
              AND ingest_time >= {since:String}
              AND service = 'conc-same-tenant'`,
      query_params: { tenant_id: TENANT_A, since: c2Start },
      format: 'JSONEachRow',
    })
    const wrongRows = (await wrongTenant.json()) as Array<{ cnt: string }>
    assert.equal(
      Number(wrongRows[0]?.cnt ?? 0),
      0,
      'All same-tenant rows should belong to tenant A',
    )
  })
})
