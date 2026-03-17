/**
 * E2E failure mode tests — clusterer flapping with circuit breaker recovery.
 * Requires Docker Compose running: docker compose up --build -d
 */
import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import { createClient } from '@clickhouse/client'
import type { ClickHouseClient } from '@clickhouse/client'
import { generateEvents } from './log-generator.js'
import {
  isReachable,
  sleep,
  ingestBatch,
  getClickhouseNow,
  countRowsSince,
  pollUntil,
  stopClusterer,
  startClusterer,
  waitForClusterer,
} from './helpers.js'

const CLICKHOUSE_URL = 'http://default:logweave@localhost:8123'
const API_URL = 'http://localhost:3000'
const CLUSTERER_URL = 'http://localhost:8000'

const KEY_A = 'e2e-key-tenant-a'
const TENANT_A = 'e2e-tenant-a'

let clickhouse: ClickHouseClient
let reachable = false

describe('E2E failure modes (Docker Compose)', () => {
  before(async () => {
    const [api, clusterer, ch] = await Promise.all([
      isReachable(`${API_URL}/healthz`),
      isReachable(`${CLUSTERER_URL}/health`),
      isReachable(`${CLICKHOUSE_URL}/ping`),
    ])
    reachable = api && clusterer && ch

    if (reachable) {
      clickhouse = createClient({ url: CLICKHOUSE_URL })
    }
  })

  after(async () => {
    // Safety net: always restart clusterer
    try { startClusterer() } catch { /* may already be running */ }
    if (clickhouse) await clickhouse.close()
  })

  // -- F1: Clusterer flapping --

  it('clusterer flapping — correct mix of clustered and unclustered', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const startTime = await getClickhouseNow(clickhouse)

    // Phase 1: Stop clusterer and send events (expect unclustered)
    stopClusterer()
    await sleep(2000)
    const clustererDown = await isReachable(`${CLUSTERER_URL}/health`)
    assert.equal(clustererDown, false, 'Clusterer should be unreachable after stop')

    const downEvents = generateEvents(100)
    const downResults = await Promise.all(
      // Send in 10 batches of 10 to ensure circuit breaker trips (threshold = 5)
      Array.from({ length: 10 }, (_, i) =>
        ingestBatch(KEY_A, downEvents.slice(i * 10, (i + 1) * 10), {
          service: 'flap-down',
        }),
      ),
    )

    for (const { status } of downResults) {
      assert.equal(status, 200, 'Ingest should succeed even with clusterer down')
    }

    // Wait for unclustered rows to appear
    await pollUntil(
      async () => (await countRowsSince(clickhouse, TENANT_A, startTime, 'unclustered')) >= 90,
      { intervalMs: 1000, timeoutMs: 15_000, label: 'unclustered rows from flapping' },
    )

    const unclusteredCount = await countRowsSince(
      clickhouse, TENANT_A, startTime, 'unclustered',
    )
    assert.ok(
      unclusteredCount >= 90,
      `Expected >= 90 unclustered rows, got ${unclusteredCount}`,
    )

    // Phase 2: Restart clusterer and warm up circuit breaker
    startClusterer()
    await waitForClusterer(30_000)

    // Warm-up: send small batches to trigger circuit breaker probes.
    // Circuit breaker probes every 10th call when open. Send 20 single-event
    // batches to guarantee at least 2 probes succeed and close the circuit.
    for (let i = 0; i < 20; i++) {
      await ingestBatch(KEY_A, [{ message: `warmup-${i}` }], {
        service: 'flap-warmup',
      })
    }

    // Phase 3: Send events with clusterer up (expect mostly clustered)
    const upStart = await getClickhouseNow(clickhouse)

    const upEvents = generateEvents(100)
    const { status, body } = await ingestBatch(KEY_A, upEvents, {
      service: 'flap-up',
    })

    assert.equal(status, 200)
    assert.equal(body.accepted, 100)

    // Poll for rows to appear
    await pollUntil(
      async () => (await countRowsSince(clickhouse, TENANT_A, upStart)) >= 100,
      { intervalMs: 1000, timeoutMs: 15_000, label: 'clustered rows after restart' },
    )

    // Expect >= 80% clustered (circuit breaker should be closed after warm-up)
    const clusteredAfter = await countRowsSince(
      clickhouse, TENANT_A, upStart, 'clustered',
    )
    const totalAfter = await countRowsSince(clickhouse, TENANT_A, upStart)
    const clusteredPct = (clusteredAfter / totalAfter) * 100

    assert.ok(
      clusteredPct >= 80,
      `Expected >= 80% clustered after restart, got ${clusteredPct.toFixed(1)}% (${clusteredAfter}/${totalAfter})`,
    )

    // Verify we have both types of rows from this entire test
    const totalUnclustered = await countRowsSince(
      clickhouse, TENANT_A, startTime, 'unclustered',
    )
    const totalClustered = await countRowsSince(
      clickhouse, TENANT_A, startTime, 'clustered',
    )

    assert.ok(totalUnclustered > 0, 'Should have unclustered rows from phase 1')
    assert.ok(totalClustered > 0, 'Should have clustered rows from phase 3')
  })
})
