import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TailBuffer } from '../../src/tail/buffer.js'
import type { TailEvent } from '../../src/tail/types.js'

function makeEvent(overrides?: Partial<TailEvent>): Omit<TailEvent, 'seq'> {
  return {
    timestamp: new Date().toISOString(),
    service: 'payments',
    level: 'ERROR',
    templateId: 'tpl-1',
    templateText: 'Connection to <IP> timed out',
    anomalyScore: 0.5,
    statusCode: 500,
    durationMs: 1200,
    traceId: 'trace-abc',
    route: '/checkout',
    ...overrides,
  }
}

describe('TailBuffer', () => {
  // -- push --

  it('push adds events and increments seq', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('t1', makeEvent())
    buf.push('t1', makeEvent())

    const result = buf.recent('t1')
    assert.equal(result.events.length, 2)
    assert.equal(result.events[0].seq, 1)
    assert.equal(result.events[1].seq, 2)
  })

  it('push evicts oldest when buffer full (circular wrap)', () => {
    const buf = new TailBuffer({ bufferSize: 3 })
    buf.push('t1', makeEvent({ service: 'a' }))
    buf.push('t1', makeEvent({ service: 'b' }))
    buf.push('t1', makeEvent({ service: 'c' }))
    buf.push('t1', makeEvent({ service: 'd' })) // evicts 'a'

    const result = buf.recent('t1')
    assert.equal(result.events.length, 3)
    assert.equal(result.events[0].service, 'b')
    assert.equal(result.events[2].service, 'd')
  })

  // -- since --

  it('since returns only events after cursor', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('t1', makeEvent({ service: 'a' }))
    buf.push('t1', makeEvent({ service: 'b' }))
    buf.push('t1', makeEvent({ service: 'c' }))

    const result = buf.since('t1', 1) // after seq 1
    assert.equal(result.events.length, 2)
    assert.equal(result.events[0].service, 'b')
    assert.equal(result.events[1].service, 'c')
    assert.equal(result.cursor, 3)
  })

  it('since with gap returns oldest available + gap flag', () => {
    const buf = new TailBuffer({ bufferSize: 3 })
    // Push 5 events, buffer only holds 3
    for (let i = 1; i <= 5; i++) {
      buf.push('t1', makeEvent({ service: `svc-${i}` }))
    }

    // Ask for events after seq 1 (which was evicted)
    const result = buf.since('t1', 1)
    assert.equal(result.gap, true)
    assert.ok(result.missedEstimate !== undefined)
    assert.ok(result.events.length > 0)
    assert.equal(result.events[0].seq, 3) // oldest available
  })

  it('since returns empty for unknown tenant', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    const result = buf.since('unknown', 0)
    assert.equal(result.events.length, 0)
  })

  // -- recent --

  it('recent returns events within time window', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('t1', makeEvent())
    buf.push('t1', makeEvent())

    const result = buf.recent('t1', { seconds: 30 })
    assert.equal(result.events.length, 2)
  })

  it('recent respects limit param', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    for (let i = 0; i < 10; i++) {
      buf.push('t1', makeEvent())
    }

    const result = buf.recent('t1', { limit: 3 })
    assert.equal(result.events.length, 3)
  })

  // -- filters --

  it('filters by service', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('t1', makeEvent({ service: 'payments' }))
    buf.push('t1', makeEvent({ service: 'gateway' }))
    buf.push('t1', makeEvent({ service: 'payments' }))

    const result = buf.recent('t1', { service: 'payments' })
    assert.equal(result.events.length, 2)
    assert.ok(result.events.every(e => e.service === 'payments'))
  })

  it('filters by level', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('t1', makeEvent({ level: 'ERROR' }))
    buf.push('t1', makeEvent({ level: 'INFO' }))
    buf.push('t1', makeEvent({ level: 'ERROR' }))

    const result = buf.recent('t1', { level: 'ERROR' })
    assert.equal(result.events.length, 2)
  })

  it('filters by templateId', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('t1', makeEvent({ templateId: 'tpl-1' }))
    buf.push('t1', makeEvent({ templateId: 'tpl-2' }))
    buf.push('t1', makeEvent({ templateId: 'tpl-1' }))

    const result = buf.recent('t1', { templateId: 'tpl-1' })
    assert.equal(result.events.length, 2)
  })

  it('filters by minAnomalyScore', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('t1', makeEvent({ anomalyScore: 0.2 }))
    buf.push('t1', makeEvent({ anomalyScore: 0.8 }))
    buf.push('t1', makeEvent({ anomalyScore: 0.9 }))

    const result = buf.recent('t1', { minAnomalyScore: 0.7 })
    assert.equal(result.events.length, 2)
  })

  // -- subscribe --

  it('subscribe receives new events', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    const received: TailEvent[] = []

    buf.subscribe('t1', (evt) => received.push(evt))
    buf.push('t1', makeEvent({ service: 'a' }))
    buf.push('t1', makeEvent({ service: 'b' }))

    assert.equal(received.length, 2)
    assert.equal(received[0].service, 'a')
    assert.equal(received[1].service, 'b')
  })

  it('unsubscribe stops delivery', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    const received: TailEvent[] = []

    const unsub = buf.subscribe('t1', (evt) => received.push(evt))
    buf.push('t1', makeEvent())
    unsub()
    buf.push('t1', makeEvent())

    assert.equal(received.length, 1)
  })

  it('subscriber error does not crash push', () => {
    const buf = new TailBuffer({ bufferSize: 100 })

    buf.subscribe('t1', () => { throw new Error('subscriber boom') })
    // Should not throw
    buf.push('t1', makeEvent())

    const result = buf.recent('t1')
    assert.equal(result.events.length, 1)
  })

  // -- tenant isolation --

  it('tenant isolation: tenant A cannot see tenant B events', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('tA', makeEvent({ service: 'a-service' }))
    buf.push('tB', makeEvent({ service: 'b-service' }))

    const resultA = buf.recent('tA')
    const resultB = buf.recent('tB')
    assert.equal(resultA.events.length, 1)
    assert.equal(resultA.events[0].service, 'a-service')
    assert.equal(resultB.events.length, 1)
    assert.equal(resultB.events[0].service, 'b-service')
  })

  // -- memory + eviction --

  it('global memory ceiling triggers LRU eviction', () => {
    // Tiny ceiling: ~700 bytes = 1 event
    const buf = new TailBuffer({ bufferSize: 100, maxMemoryBytes: 700 })
    buf.push('t1', makeEvent())
    buf.push('t2', makeEvent()) // should evict t1

    assert.equal(buf.hasTenant('t1'), false)
    assert.equal(buf.hasTenant('t2'), true)
  })

  // -- stats --

  it('stats reports correct counts', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('t1', makeEvent())
    buf.push('t1', makeEvent())
    buf.push('t2', makeEvent())

    const stats = buf.stats()
    assert.equal(stats.tenants, 2)
    assert.equal(stats.totalEvents, 3)
    assert.ok(stats.memoryBytes > 0)
  })

  // -- cursor from since is usable for next call --

  it('cursor chains across multiple since calls', () => {
    const buf = new TailBuffer({ bufferSize: 100 })
    buf.push('t1', makeEvent({ service: 'a' }))
    buf.push('t1', makeEvent({ service: 'b' }))

    const first = buf.since('t1', 0)
    assert.equal(first.events.length, 2)

    buf.push('t1', makeEvent({ service: 'c' }))

    const second = buf.since('t1', first.cursor)
    assert.equal(second.events.length, 1)
    assert.equal(second.events[0].service, 'c')
  })
})
