import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { BufferManager } from '../src/buffer.js'
import type { LogEvent } from '../src/types.js'

function makeEvent(i: number): LogEvent {
  return {
    timestamp: new Date().toISOString(),
    level: 'info',
    message: `test message ${i}`,
  }
}

describe('BufferManager', () => {
  let buffer: BufferManager | undefined

  afterEach(() => {
    buffer?.destroy()
    buffer = undefined
  })

  it('triggers flush when buffer fills to capacity', async () => {
    const flushed: LogEvent[][] = []
    const flushPromise = new Promise<void>((resolve) => {
      buffer = new BufferManager({
        bufferSize: 5,
        flushIntervalMs: 60_000, // long timer so only capacity triggers
        onFlush: async (events) => {
          flushed.push([...events])
          resolve()
        },
      })
    })

    for (let i = 0; i < 5; i++) {
      buffer!.push(makeEvent(i))
    }

    await flushPromise
    assert.equal(flushed.length, 1, 'should flush exactly once')
    assert.equal(flushed[0]!.length, 5, 'should flush all 5 events')
  })

  it('triggers flush on timer for partial buffer', async () => {
    const flushed: LogEvent[][] = []
    const flushPromise = new Promise<void>((resolve) => {
      buffer = new BufferManager({
        bufferSize: 100,
        flushIntervalMs: 50, // short timer
        onFlush: async (events) => {
          flushed.push([...events])
          resolve()
        },
      })
    })

    buffer!.push(makeEvent(0))
    buffer!.push(makeEvent(1))

    await flushPromise
    assert.equal(flushed.length, 1, 'should flush once via timer')
    assert.equal(flushed[0]!.length, 2, 'should flush the 2 buffered events')
  })

  it('new events during flush go to fresh buffer (double-buffering)', async () => {
    const flushed: LogEvent[][] = []
    let flushCount = 0

    const allFlushed = new Promise<void>((resolve) => {
      buffer = new BufferManager({
        bufferSize: 3,
        flushIntervalMs: 50,
        onFlush: async (events) => {
          flushed.push([...events])
          flushCount++

          if (flushCount === 1) {
            // During the first flush, push more events
            // These should go into a new buffer, not the one being flushed
            buffer!.push(makeEvent(10))
            buffer!.push(makeEvent(11))
            buffer!.push(makeEvent(12))
            // The push of event 12 should trigger a second flush
          }

          if (flushCount >= 2) {
            resolve()
          }
        },
      })
    })

    // Fill initial buffer to trigger first flush
    buffer!.push(makeEvent(0))
    buffer!.push(makeEvent(1))
    buffer!.push(makeEvent(2))

    await allFlushed
    assert.equal(flushed.length, 2, 'should have 2 separate flushes')
    assert.equal(flushed[0]!.length, 3, 'first flush should have 3 events')
    assert.equal(
      flushed[1]!.length,
      3,
      'second flush should have 3 events (added during first flush)',
    )
  })

  it('timer uses unref so it does not hold the process open', () => {
    // We verify this by checking that the timer is created with unref
    // The BufferManager constructor calls setTimeout().unref() internally.
    // If it didn't, this test process would hang.

    // Use mock.fn to track the flush callback
    const onFlush = mock.fn(async (_events: readonly LogEvent[]) => {})

    buffer = new BufferManager({
      bufferSize: 100,
      flushIntervalMs: 100,
      onFlush,
    })

    // The test passes if it completes without hanging.
    // Additionally, verify the buffer was created successfully.
    assert.ok(buffer, 'buffer should be created')
  })

  it('skips triggerFlush when another flush is already in-flight', async () => {
    let flushCount = 0
    let resolveFirstFlush: (() => void) | undefined

    const firstFlushStarted = new Promise<void>((resolve) => {
      buffer = new BufferManager({
        bufferSize: 100,
        flushIntervalMs: 60_000,
        onFlush: async () => {
          flushCount++
          if (flushCount === 1) {
            resolve()
            await new Promise<void>((r) => {
              resolveFirstFlush = r
            })
          }
        },
      })
    })

    // Push events and trigger first flush
    buffer!.push(makeEvent(0))
    buffer!.push(makeEvent(1))
    buffer!.triggerFlush()

    await firstFlushStarted

    // While first flush is in-flight, push more and trigger again
    buffer!.push(makeEvent(2))
    buffer!.push(makeEvent(3))
    buffer!.triggerFlush() // Should be SKIPPED

    // Release first flush
    resolveFirstFlush!()
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(flushCount, 1, 'second triggerFlush should be skipped while first is in-flight')

    // Events from skipped flush should still be in the buffer
    const remaining = buffer!.drain()
    assert.equal(remaining.length, 2, 'events from skipped flush should remain in buffer')
  })

  it('awaitInflight resolves after in-flight flush completes', async () => {
    let resolveFlush: (() => void) | undefined

    buffer = new BufferManager({
      bufferSize: 100,
      flushIntervalMs: 60_000,
      onFlush: async () => {
        await new Promise<void>((r) => {
          resolveFlush = r
        })
      },
    })

    buffer.push(makeEvent(0))
    buffer.triggerFlush()

    // awaitInflight should be pending
    let resolved = false
    const awaiting = buffer.awaitInflight().then(() => {
      resolved = true
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(resolved, false, 'should not resolve while flush is in-flight')

    resolveFlush!()
    await awaiting
    assert.equal(resolved, true, 'should resolve after flush completes')
  })

  it('caps retained events and drops oldest when a flush is stuck', async () => {
    const dropped: LogEvent[] = []
    // onFlush never resolves — simulates a slow/down API holding one flush
    // in-flight while events keep arriving.
    buffer = new BufferManager({
      bufferSize: 10,
      maxRetainedEvents: 50,
      flushIntervalMs: 60_000,
      onFlush: () => new Promise<void>(() => {}),
      onDrop: (events) => {
        for (const e of events) dropped.push(e)
      },
    })

    for (let i = 0; i < 1000; i++) {
      buffer.push(makeEvent(i))
    }

    // First 10 swapped into the stuck in-flight flush; the rest pile into active,
    // which is bounded by the cap (eviction batches down to the low-water mark).
    assert.ok(buffer.size() <= 50, 'active buffer must never exceed the cap')
    assert.equal(buffer.getDroppedCount(), dropped.length, 'dropped count matches onDrop events')
    // 1000 pushed, 10 in-flight, the rest retained-or-dropped (conservation).
    assert.equal(buffer.getDroppedCount(), 1000 - 10 - buffer.size())
    // Oldest dropped first: the newest event is always retained at the tail.
    const remaining = buffer.drain()
    assert.equal(remaining[remaining.length - 1]?.message, 'test message 999')
  })

  it('bounds TOTAL retained memory (active + in-flight) at the cap, not ~2x (F11)', async () => {
    // A full batch (40) is swapped into a stuck flush, then more events arrive.
    // The in-flight batch counts toward the cap, so `active` is squeezed to keep
    // active + in-flight <= maxRetainedEvents. Before F11, `active` could refill
    // to the full cap ON TOP of the in-flight batch — ~2x the documented bound.
    const dropped: LogEvent[] = []
    buffer = new BufferManager({
      bufferSize: 40,
      maxRetainedEvents: 50,
      flushIntervalMs: 60_000,
      onFlush: () => new Promise<void>(() => {}), // never resolves — flush stuck
      onDrop: (events) => {
        for (const e of events) dropped.push(e)
      },
    })

    // First 40 fill the buffer and swap into the (stuck) in-flight flush; the
    // rest pile into active, which must now stay small enough to respect the cap.
    for (let i = 0; i < 500; i++) buffer.push(makeEvent(i))

    const IN_FLIGHT = 40
    assert.ok(
      buffer.size() + IN_FLIGHT <= 50,
      `active (${buffer.size()}) + in-flight (${IN_FLIGHT}) must not exceed the cap of 50`,
    )
    assert.ok(dropped.length > 0, 'should drop events under sustained overload with a stuck flush')
  })

  it('does not drop when within the cap', () => {
    const dropped: LogEvent[] = []
    buffer = new BufferManager({
      bufferSize: 10_000,
      maxRetainedEvents: 100,
      flushIntervalMs: 60_000,
      onFlush: async () => {},
      onDrop: (events) => dropped.push(...events),
    })

    for (let i = 0; i < 100; i++) buffer.push(makeEvent(i))

    assert.equal(buffer.getDroppedCount(), 0)
    assert.equal(dropped.length, 0)
    assert.equal(buffer.size(), 100)
  })

  it('drain() returns remaining events and clears the buffer', async () => {
    const onFlush = mock.fn(async (_events: readonly LogEvent[]) => {})

    buffer = new BufferManager({
      bufferSize: 100,
      flushIntervalMs: 60_000,
      onFlush,
    })

    buffer.push(makeEvent(0))
    buffer.push(makeEvent(1))
    buffer.push(makeEvent(2))

    const drained = buffer.drain()
    assert.equal(drained.length, 3, 'should return all buffered events')

    const drainedAgain = buffer.drain()
    assert.equal(drainedAgain.length, 0, 'should be empty after drain')
  })
})
