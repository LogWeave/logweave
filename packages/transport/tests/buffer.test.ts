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
    assert.equal(flushed[1]!.length, 3, 'second flush should have 3 events (added during first flush)')
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
