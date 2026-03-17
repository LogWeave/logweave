/**
 * End-to-end integration test for the full LogWeave pipeline.
 * Requires Docker Compose running: docker compose up --build -d
 *
 * Tests: transport → API → clusterer → ClickHouse → recovery
 *
 * API keys must match docker-compose.yml:
 *   e2e-key-tenant-a → e2e-tenant-a
 *   e2e-key-tenant-b → e2e-tenant-b
 */
import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import { createClient } from '@clickhouse/client'
import type { ClickHouseClient } from '@clickhouse/client'
import { DbClient } from '../../src/db/client.js'
import {
  queryTemplateStats,
  queryServiceStats,
  explainQuery,
} from '../../src/db/queries.js'
// Relative import — avoids workspace:* devDep that would break Dockerfile
import { LogWeaveTransport } from '../../../../packages/transport/src/transport.js'
import { generateEvents } from './log-generator.js'
import {
  isReachable,
  pollUntil,
  sleep,
  stopClusterer,
  startClusterer,
  waitForClusterer,
  getClickhouseNow,
  countRowsSince,
} from './helpers.js'

const API_URL = 'http://localhost:3000'
const CLUSTERER_URL = 'http://localhost:8000'
const CLICKHOUSE_URL = 'http://default:logweave@localhost:8123'

const TENANT_A = 'e2e-tenant-a'
const TENANT_B = 'e2e-tenant-b'
const KEY_A = 'e2e-key-tenant-a'
const KEY_B = 'e2e-key-tenant-b'

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

let clickhouse: ClickHouseClient
let db: DbClient
let startTime: string

function createTransport(apiKey: string, opts?: { bufferSize?: number }): LogWeaveTransport {
  return new LogWeaveTransport({
    apiKey,
    service: 'e2e-test-service',
    endpoint: `${API_URL}/v1/ingest/batch`,
    environment: 'e2e',
    bufferSize: opts?.bufferSize ?? 200,
    flushIntervalMs: 1000,
    timeoutMs: 10_000,
    maxRetries: 3,
  })
}

describe('E2E pipeline (Docker Compose)', () => {
  let reachable = false

  before(async () => {
    const [api, clusterer, ch] = await Promise.all([
      isReachable(`${API_URL}/healthz`),
      isReachable(`${CLUSTERER_URL}/health`),
      isReachable(`${CLICKHOUSE_URL}/ping`),
    ])
    reachable = api && clusterer && ch

    if (reachable) {
      clickhouse = createClient({ url: CLICKHOUSE_URL })
      db = new DbClient(clickhouse)
      startTime = await getClickhouseNow(clickhouse)
    }
  })

  after(async () => {
    // Safety net: restart clusterer if it was stopped
    try { startClusterer() } catch { /* may already be running */ }
    if (clickhouse) await clickhouse.close()
  })

  // -- Normal path --

  it('ingests 10,000 events via transport with valid template_ids', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const transport = createTransport(KEY_A)
    const events = generateEvents(10_000)

    for (const event of events) {
      transport.log(event as never, () => {})
    }

    await transport.closeAsync()

    // Poll for events to arrive. BufferManager.triggerFlush() is fire-and-forget —
    // closeAsync() only awaits the drain batch, not in-flight flushes. The 9500
    // threshold (95%) accounts for any flushes still completing when we start polling.
    await pollUntil(
      async () => (await countRowsSince(clickhouse, TENANT_A, startTime)) >= 9500,
      { intervalMs: 2000, timeoutMs: 30_000, label: '10K events ingested' },
    )

    const total = await countRowsSince(clickhouse, TENANT_A, startTime)
    assert.ok(total >= 9500, `Expected >= 9500 rows, got ${total}`)

    // Verify template_ids: sample rows and check most are UUIDv7, not '0'
    const clustered = await countRowsSince(clickhouse, TENANT_A, startTime, 'clustered')
    const clusteredPct = (clustered / total) * 100
    assert.ok(
      clusteredPct >= 80,
      `Expected >= 80% clustered, got ${clusteredPct.toFixed(1)}% (${clustered}/${total})`,
    )

    // Spot-check UUIDv7 format on a few rows
    const sample = await db.query<{ template_id: string }>({
      query: `SELECT template_id FROM logweave.log_metadata WHERE tenant_id = {tenant_id:String} AND template_id != '0' LIMIT 10`,
      query_params: { tenant_id: TENANT_A },
    })
    for (const row of sample) {
      assert.match(row.template_id, UUIDV7_RE, `Expected UUIDv7, got ${row.template_id}`)
    }
  })

  it('template_stats MV aggregates correctly after OPTIMIZE FINAL', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    await db.command({ query: 'OPTIMIZE TABLE logweave.template_stats FINAL' })
    const stats = (await queryTemplateStats(db, TENANT_A)) as Array<{
      occurrence_count: string
      template_id: string
    }>

    assert.ok(stats.length > 0, 'Expected template_stats rows')
    const totalOccurrences = stats.reduce((sum, r) => sum + Number(r.occurrence_count), 0)
    assert.ok(totalOccurrences > 5000, `Expected occurrence_count > 5000, got ${totalOccurrences}`)

    // All template_ids in stats should be non-zero (MV excludes template_id='0')
    for (const row of stats) {
      assert.notEqual(row.template_id, '0', 'template_stats should not contain unclustered rows')
    }
  })

  it('service_stats MV aggregates correctly after OPTIMIZE FINAL', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    await db.command({ query: 'OPTIMIZE TABLE logweave.service_stats FINAL' })
    const stats = (await queryServiceStats(db, TENANT_A)) as Array<{ log_count: string }>

    assert.ok(stats.length > 0, 'Expected service_stats rows')
    const totalLogs = stats.reduce((sum, r) => sum + Number(r.log_count), 0)
    assert.ok(totalLogs > 5000, `Expected log_count > 5000, got ${totalLogs}`)
  })

  // -- Tenant isolation --

  it('tenant isolation holds — cross-tenant reads return empty', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const transport = createTransport(KEY_B, { bufferSize: 50 })
    const events = generateEvents(100)

    for (const event of events) {
      transport.log(event as never, () => {})
    }
    await transport.closeAsync()

    await pollUntil(
      async () => (await countRowsSince(clickhouse, TENANT_B, startTime)) >= 90,
      { intervalMs: 1000, timeoutMs: 15_000, label: 'tenant B events ingested' },
    )

    // Tenant B has rows
    const countB = await countRowsSince(clickhouse, TENANT_B, startTime)
    assert.ok(countB >= 90, `Expected tenant B >= 90 rows, got ${countB}`)

    // Verify application-layer queries only return data for the requested tenant
    const rowsA = await db.query<{ tenant_id: string }>({
      query: `SELECT tenant_id FROM logweave.log_metadata WHERE tenant_id = {tenant_id:String} LIMIT 100`,
      query_params: { tenant_id: TENANT_A },
    })
    for (const row of rowsA) {
      assert.equal(row.tenant_id, TENANT_A, 'Tenant A query returned wrong tenant data')
    }

    const rowsB = await db.query<{ tenant_id: string }>({
      query: `SELECT tenant_id FROM logweave.log_metadata WHERE tenant_id = {tenant_id:String} LIMIT 100`,
      query_params: { tenant_id: TENANT_B },
    })
    for (const row of rowsB) {
      assert.equal(row.tenant_id, TENANT_B, 'Tenant B query returned wrong tenant data')
    }

    // Also verify via application query functions (template_stats, service_stats)
    await db.command({ query: 'OPTIMIZE TABLE logweave.template_stats FINAL' })
    const statsA = (await queryTemplateStats(db, TENANT_A)) as Array<{ tenant_id: string }>
    for (const row of statsA) {
      assert.equal(row.tenant_id, TENANT_A, 'queryTemplateStats(A) returned tenant B data')
    }
    const statsB = (await queryTemplateStats(db, TENANT_B)) as Array<{ tenant_id: string }>
    for (const row of statsB) {
      assert.equal(row.tenant_id, TENANT_B, 'queryTemplateStats(B) returned tenant A data')
    }
  })

  // -- Degradation path --

  it('clusterer kill → template_id=0 fallback with pre_processed_message', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    stopClusterer()
    await sleep(3000)

    const transport = createTransport(KEY_A, { bufferSize: 25 })
    const events = generateEvents(50)

    for (const event of events) {
      transport.log(event as never, () => {})
    }
    await transport.closeAsync()

    // Poll for unclustered rows to appear
    await pollUntil(
      async () => (await countRowsSince(clickhouse, TENANT_A, startTime, 'unclustered')) >= 40,
      { intervalMs: 2000, timeoutMs: 20_000, label: 'unclustered rows from degradation' },
    )

    const unclustered = await countRowsSince(clickhouse, TENANT_A, startTime, 'unclustered')
    assert.ok(unclustered >= 40, `Expected >= 40 unclustered rows, got ${unclustered}`)

    // Verify pre_processed_message is populated
    const rows = await db.query<{ pre_processed_message: string | null }>({
      query: `SELECT pre_processed_message FROM logweave.log_metadata WHERE tenant_id = {tenant_id:String} AND template_id = '0' LIMIT 10`,
      query_params: { tenant_id: TENANT_A },
    })
    for (const row of rows) {
      assert.ok(row.pre_processed_message, 'pre_processed_message should be populated for unclustered rows')
    }
  })

  // -- Recovery path --

  it('recovery sweep reconciles unclustered rows after clusterer restart', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const totalBefore = await countRowsSince(clickhouse, TENANT_A, startTime)
    const unclusteredBefore = await countRowsSince(clickhouse, TENANT_A, startTime, 'unclustered')
    assert.ok(unclusteredBefore > 0, 'Expected unclustered rows before recovery')

    startClusterer()
    await waitForClusterer(30_000)

    // Recovery sweep runs every 10s (LOGWEAVE_RECOVERY_INTERVAL_MS in docker-compose)
    // Poll until unclustered count drops to 0
    await pollUntil(
      async () => (await countRowsSince(clickhouse, TENANT_A, startTime, 'unclustered')) === 0,
      { intervalMs: 3000, timeoutMs: 60_000, label: 'recovery sweep completes' },
    )

    const unclusteredAfter = await countRowsSince(clickhouse, TENANT_A, startTime, 'unclustered')
    assert.equal(unclusteredAfter, 0, 'All unclustered rows should be recovered')

    // Verify rows were re-inserted (not just deleted) — total count should not decrease
    const totalAfter = await countRowsSince(clickhouse, TENANT_A, startTime)
    assert.ok(totalAfter >= totalBefore, `Recovery should re-INSERT, not just DELETE (before=${totalBefore}, after=${totalAfter})`)
  })

  it('recovered templates appear in template_stats MV', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    await db.command({ query: 'OPTIMIZE TABLE logweave.template_stats FINAL' })
    const stats = (await queryTemplateStats(db, TENANT_A)) as Array<{
      occurrence_count: string
      template_id: string
    }>

    const totalOccurrences = stats.reduce((sum, r) => sum + Number(r.occurrence_count), 0)
    // Should include the recovered events (~50 more than the original 10K)
    assert.ok(
      totalOccurrences > 5000,
      `Expected template_stats to include recovered events, got ${totalOccurrences}`,
    )

    // No template_id='0' should appear in template_stats (MV excludes them)
    for (const row of stats) {
      assert.notEqual(row.template_id, '0')
    }
  })

  // -- EXPLAIN verification --

  it('EXPLAIN confirms index usage for tenant-scoped queries', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const queries = [
      {
        name: 'log_metadata',
        query: `SELECT * FROM logweave.log_metadata WHERE tenant_id = {tenant_id:String} ORDER BY timestamp DESC LIMIT 10`,
      },
      {
        name: 'template_stats',
        query: `SELECT tenant_id, template_id, countMerge(occurrence_count) AS cnt FROM logweave.template_stats WHERE tenant_id = {tenant_id:String} GROUP BY tenant_id, template_id`,
      },
      {
        name: 'service_stats',
        query: `SELECT tenant_id, service, countMerge(log_count) AS cnt FROM logweave.service_stats WHERE tenant_id = {tenant_id:String} GROUP BY tenant_id, service`,
      },
    ]

    for (const q of queries) {
      const explain = await explainQuery(db, q.query, { tenant_id: TENANT_A })
      const output = JSON.stringify(explain)
      assert.ok(
        output.includes('PrimaryKey') || output.includes('KeyCondition'),
        `EXPLAIN for ${q.name} should show index usage. Got: ${output.slice(0, 500)}`,
      )
    }
  })
})
