import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type BackpressureStats, SpoolWriter } from '../../src/spool/backpressure.js'
import { MemorySpoolStore } from '../../src/spool/memory-spool.js'
import type { LogEvent } from '../../src/types.js'

function evt(message: string): LogEvent {
  return { timestamp: '2026-06-27T00:00:00.000Z', level: 'info', message }
}

/** A virtual clock so the SLO/backoff elapses instantly and deterministically. */
function virtualClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms
    },
  }
}

function fill(spool: MemorySpoolStore, n: number): void {
  for (let i = 0; i < n; i++) spool.insert(evt(`fill-${i}`))
}

describe('SpoolWriter backpressure', () => {
  it('spools immediately when under the cap (no backpressure)', async () => {
    const spool = new MemorySpoolStore()
    let bp = 0
    const writer = new SpoolWriter({
      spool,
      maxSpooledEvents: 10,
      onBackpressure: () => bp++,
    })

    assert.equal(await writer.enqueue(evt('a')), 'spooled')
    assert.equal(spool.count(), 1)
    assert.equal(bp, 0, 'no backpressure under the cap')
  })

  it('blocks at the cap and spools once the pump drains within the SLO (nothing dropped)', async () => {
    const spool = new MemorySpoolStore()
    fill(spool, 10)
    const ids = spool.peekOldest(100).map((e) => e.eventId)
    const clock = virtualClock()
    let bp = 0
    let dropped = 0

    // Simulate the pump draining one event on the first poll.
    let drained = false
    const sleep = async (ms: number): Promise<void> => {
      if (!drained) {
        spool.delete([ids[0] as string])
        drained = true
      }
      await clock.sleep(ms)
    }

    const writer = new SpoolWriter({
      spool,
      maxSpooledEvents: 10,
      blockMs: 1000,
      pollMs: 100,
      onBackpressure: () => bp++,
      onDrop: () => dropped++,
      sleepFn: sleep,
      nowFn: clock.now,
    })

    assert.equal(await writer.enqueue(evt('new')), 'spooled')
    assert.equal(bp, 1, 'backpressure fired once')
    assert.equal(dropped, 0, 'nothing dropped — it drained in time')
    assert.equal(spool.count(), 10, 'one drained, one inserted')
  })

  it('fails open loudly (drops) when the SLO elapses while still full', async () => {
    const spool = new MemorySpoolStore()
    fill(spool, 10)
    const clock = virtualClock()
    let bp = 0
    const dropped: LogEvent[] = []

    const writer = new SpoolWriter({
      spool,
      maxSpooledEvents: 10,
      blockMs: 1000,
      pollMs: 100,
      onBackpressure: () => bp++,
      onDrop: (events) => dropped.push(...events),
      sleepFn: clock.sleep, // never drains
      nowFn: clock.now,
    })

    assert.equal(await writer.enqueue(evt('doomed')), 'dropped')
    assert.equal(bp, 1, 'backpressure fired before dropping')
    assert.equal(dropped.length, 1, 'fail-open reported the dropped event (never silent)')
    assert.equal(dropped[0]?.message, 'doomed')
    assert.equal(spool.count(), 10, 'spool unchanged — the new event was dropped, not forced in')
  })

  it('reports backpressure stats (spooled + cap)', async () => {
    const spool = new MemorySpoolStore()
    fill(spool, 5)
    const clock = virtualClock()
    let seen: BackpressureStats | undefined

    const writer = new SpoolWriter({
      spool,
      maxSpooledEvents: 5,
      blockMs: 200,
      pollMs: 100,
      onBackpressure: (s) => {
        seen = s
      },
      sleepFn: clock.sleep,
      nowFn: clock.now,
    })

    await writer.enqueue(evt('x'))
    assert.deepEqual(seen, { spooled: 5, cap: 5 })
  })

  it('fail-open without an onDrop handler does not throw (console.error fallback)', async () => {
    const spool = new MemorySpoolStore()
    fill(spool, 2)
    const clock = virtualClock()
    const writer = new SpoolWriter({
      spool,
      maxSpooledEvents: 2,
      blockMs: 100,
      pollMs: 50,
      sleepFn: clock.sleep,
      nowFn: clock.now,
    })

    let result: string | undefined
    await assert.doesNotReject(async () => {
      result = await writer.enqueue(evt('z'))
    })
    assert.equal(result, 'dropped')
  })
})
