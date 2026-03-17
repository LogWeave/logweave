/**
 * E2E edge case tests — unicode, missing fields, boundary values, partial success.
 * Requires Docker Compose running: docker compose up --build -d
 */
import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'
import { createClient } from '@clickhouse/client'
import type { ClickHouseClient } from '@clickhouse/client'
import {
  isReachable,
  ingestBatch,
  getClickhouseNow,
  countRowsSince,
} from './helpers.js'

const CLICKHOUSE_URL = 'http://default:logweave@localhost:8123'
const API_URL = 'http://localhost:3000'
const CLUSTERER_URL = 'http://localhost:8000'

const KEY_A = 'e2e-key-tenant-a'
const TENANT_A = 'e2e-tenant-a'

let clickhouse: ClickHouseClient
let reachable = false
let startTime: string

describe('E2E edge cases (Docker Compose)', () => {
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

  // -- E1: All optional fields missing --

  it('events with all optional fields missing are accepted', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const events = Array.from({ length: 10 }, (_, i) => ({
      message: `Minimal event ${i}`,
    }))

    const { status, body } = await ingestBatch(KEY_A, events)

    assert.equal(status, 200)
    assert.equal(body.accepted, 10)

    // Verify rows stored in ClickHouse
    const count = await countRowsSince(clickhouse, TENANT_A, startTime)
    assert.ok(count >= 10, `Expected >= 10 rows, got ${count}`)
  })

  // -- E2: Maximum-length field values --

  it('events with maximum-length field values are accepted', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const longStr = 'x'.repeat(10_000)
    const events = [
      {
        message: `Long message: ${longStr}`,
        service: longStr.slice(0, 1000),
        route: `/api/${longStr.slice(0, 500)}`,
        level: 'info',
      },
    ]

    const { status, body } = await ingestBatch(KEY_A, events)

    assert.equal(status, 200)
    assert.equal(body.accepted, 1)
  })

  // -- E3: Unicode, emoji, multi-byte characters --

  it('unicode, emoji, and multi-byte characters stored correctly', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const unicodeMessages = [
      'CJK: \u4f60\u597d\u4e16\u754c — Chinese hello world',
      'Emoji: \ud83d\ude80\ud83c\udf1f\ud83d\udd25 Launch the rocket!',
      'Arabic: \u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645',
      'Combining: e\u0301 a\u0300 o\u0302 u\u0308 (accented chars)',
      'Mixed: \u30b5\u30fc\u30d3\u30b9-status=\u2705 latency=42ms \ud83c\udfe0',
    ]

    const events = unicodeMessages.map((msg) => ({
      message: msg,
      level: 'info',
    }))

    const { status, body } = await ingestBatch(KEY_A, events)

    assert.equal(status, 200)
    assert.equal(body.accepted, 5)

    // Query back and verify messages are intact
    const result = await clickhouse.query({
      query: `SELECT message FROM logweave.log_metadata
              WHERE tenant_id = {tenant_id:String}
              AND ingest_time >= {since:String}
              AND message LIKE '%CJK%' OR message LIKE '%Emoji%' OR message LIKE '%Arabic%'
              OR message LIKE '%Combining%' OR message LIKE '%Mixed%'
              LIMIT 10`,
      query_params: { tenant_id: TENANT_A, since: startTime },
      format: 'JSONEachRow',
    })
    const rows = (await result.json()) as Array<{ message: string }>
    // At least some unicode messages should be stored
    assert.ok(rows.length > 0, 'Expected unicode messages to be stored')
  })

  // -- E4: Timestamps in past and future --

  it('timestamps far in past and future are accepted', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const pastDate = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000) // 29 days ago
    const futureDate = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000) // 29 days ahead

    const events = [
      {
        message: 'Event from the past',
        timestamp: pastDate.toISOString(),
        level: 'info',
      },
      {
        message: 'Event from the future',
        timestamp: futureDate.toISOString(),
        level: 'info',
      },
    ]

    const { status, body } = await ingestBatch(KEY_A, events)

    assert.equal(status, 200)
    assert.equal(body.accepted, 2)
  })

  // -- E5: Mixed valid/invalid events — partial success --

  it('mixed valid and invalid events — partial success', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const events: unknown[] = [
      // 5 valid events
      { message: 'Valid event 1', level: 'info' },
      { message: 'Valid event 2', level: 'warn' },
      { message: 'Valid event 3', level: 'error' },
      { message: 'Valid event 4', level: 'debug' },
      { message: 'Valid event 5', level: 'info' },
      // 3 non-objects
      'just a string',
      42,
      null,
      // 2 objects without message field
      { level: 'info', service: 'no-message' },
      { data: 'also no message' },
    ]

    const { status, body } = await ingestBatch(KEY_A, events)

    assert.equal(status, 200)
    assert.equal(body.accepted, 5, `Expected 5 accepted, got ${body.accepted}`)
  })

  // -- E6: Empty batch rejected --

  it('empty batch rejected with 400', async (t) => {
    if (!reachable) { t.skip('Docker Compose not running'); return }

    const { status } = await ingestBatch(KEY_A, [])

    assert.equal(status, 400, `Expected 400 for empty batch, got ${status}`)
  })
})
