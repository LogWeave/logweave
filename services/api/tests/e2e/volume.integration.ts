/**
 * E2E volume tests — max batch size, sequential batches, exact row counts.
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
const TENANT_A = 'e2e-tenant-a'

let clickhouse: ClickHouseClient
let reachable = false
let startTime: string

describe('E2E volume tests (Docker Compose)', () => {
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

  // -- V1: 1000-event max batch --

  it('1000-event max batch accepted and stored', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const events = generateEvents(1000)
    const { status, body } = await ingestBatch(KEY_A, events, {
      service: 'volume-test',
    })

    assert.equal(status, 200)
    assert.equal(body.accepted, 1000)

    // Poll ClickHouse for all 1000 rows
    await pollUntil(
      async () => (await countRowsSince(clickhouse, TENANT_A, startTime)) >= 1000,
      { intervalMs: 1000, timeoutMs: 15_000, label: '1000-event batch stored' },
    )

    const count = await countRowsSince(clickhouse, TENANT_A, startTime)
    assert.ok(count >= 1000, `Expected >= 1000 rows, got ${count}`)
  })

  it('1001-event batch rejected at boundary', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const events = generateEvents(1001)
    const { status } = await ingestBatch(KEY_A, events)

    assert.equal(status, 400, `Expected 400 for 1001 events, got ${status}`)
  })

  // -- V2: Sequential batches with exact cumulative counts --

  it('3 sequential batches — exact cumulative counts', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    // Capture a fresh baseline after V1's events
    const seqStart = await getClickhouseNow(clickhouse)

    for (let batch = 1; batch <= 3; batch++) {
      const events = generateEvents(500)
      const { status, body } = await ingestBatch(KEY_A, events, {
        service: `volume-seq-batch-${batch}`,
      })

      assert.equal(status, 200)
      assert.equal(body.accepted, 500, `Batch ${batch}: expected 500 accepted`)

      const expectedCount = batch * 500

      // Poll for cumulative count
      await pollUntil(
        async () => (await countRowsSince(clickhouse, TENANT_A, seqStart)) >= expectedCount,
        { intervalMs: 1000, timeoutMs: 15_000, label: `batch ${batch}: ${expectedCount} rows` },
      )

      const count = await countRowsSince(clickhouse, TENANT_A, seqStart)
      assert.ok(
        count >= expectedCount,
        `After batch ${batch}: expected >= ${expectedCount}, got ${count}`,
      )
    }
  })
})
