import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MemorySpoolStore } from '../../src/spool/memory-spool.js'
import type { LogEvent } from '../../src/types.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function evt(message: string): LogEvent {
  return { timestamp: '2026-06-27T00:00:00.000Z', level: 'info', message }
}

describe('MemorySpoolStore', () => {
  it('insert assigns a UUIDv7 event_id and embeds it in the stored event', () => {
    const spool = new MemorySpoolStore()
    const id = spool.insert(evt('hello'))

    assert.match(id, UUID_RE)
    const [stored] = spool.peekOldest(1)
    assert.equal(stored?.eventId, id)
    assert.equal(stored?.event.event_id, id, 'event_id embedded in the event payload')
    assert.equal(stored?.event.message, 'hello')
  })

  it('peekOldest returns events in enqueue order', () => {
    const spool = new MemorySpoolStore()
    spool.insert(evt('a'))
    spool.insert(evt('b'))
    spool.insert(evt('c'))

    assert.deepEqual(
      spool.peekOldest(2).map((e) => e.event.message),
      ['a', 'b'],
    )
    assert.equal(spool.count(), 3)
  })

  it('delete removes by event_id; unknown ids are ignored', () => {
    const spool = new MemorySpoolStore()
    const a = spool.insert(evt('a'))
    spool.insert(evt('b'))

    spool.delete([a, 'not-present'])
    assert.equal(spool.count(), 1)
    assert.equal(spool.peekOldest(10)[0]?.event.message, 'b')
  })

  it('drops oldest down to the low-water mark when the retention cap is exceeded', () => {
    const dropped: LogEvent[] = []
    const spool = new MemorySpoolStore({
      maxRetainedEvents: 10,
      onDrop: (events) => dropped.push(...events),
    })
    for (let i = 0; i < 12; i++) spool.insert(evt(`e${i}`))

    // Drop fires when length exceeds the cap (strict >), evicting down to
    // lowWaterMark = floor(10 * 0.9) = 9; later inserts refill up to the cap.
    assert.ok(spool.count() <= 10, 'count stays within the retention cap')
    assert.ok(dropped.length > 0, 'onDrop fired for evicted events')
    // The newest events are retained; the oldest (e0, e1) were dropped.
    assert.equal(spool.peekOldest(20).at(-1)?.event.message, 'e11', 'newest retained')
    assert.ok(!spool.peekOldest(20).some((e) => e.event.message === 'e0'), 'oldest dropped')
  })

  it('an onDrop that throws does not break insert', () => {
    const spool = new MemorySpoolStore({
      maxRetainedEvents: 2,
      onDrop: () => {
        throw new Error('boom')
      },
    })
    assert.doesNotThrow(() => {
      for (let i = 0; i < 5; i++) spool.insert(evt(`e${i}`))
    })
  })
})
