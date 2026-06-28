import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ArchiveNotifyQueue } from '../../src/archive/notify-queue.js'

describe('ArchiveNotifyQueue', () => {
  it('enqueues and dequeues oldest-first', () => {
    const q = new ArchiveNotifyQueue()
    assert.equal(q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' }), true)
    assert.equal(q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/b' }), true)
    assert.equal(q.size(), 2)

    const first = q.dequeue(1)
    assert.deepEqual(first, [{ tenantId: 't', sourceRef: 'tenant=t/a' }])
    assert.equal(q.size(), 1)
  })

  it('is idempotent on sourceRef while pending', () => {
    const q = new ArchiveNotifyQueue()
    assert.equal(q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' }), true)
    assert.equal(q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' }), false)
    assert.equal(q.size(), 1)
  })

  it('re-accepts a sourceRef after it has been dequeued', () => {
    const q = new ArchiveNotifyQueue()
    q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' })
    q.dequeue(1)
    // Drained → no longer pending → a fresh notify is accepted again (the
    // consumer dedupes on event_id/ReplacingMergeTree at insert time).
    assert.equal(q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' }), true)
    assert.equal(q.size(), 1)
  })

  it('drops (does not throw) when full and counts the drops', () => {
    const q = new ArchiveNotifyQueue(2)
    assert.equal(q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' }), true)
    assert.equal(q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/b' }), true)
    assert.equal(q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/c' }), false)
    assert.equal(q.size(), 2)
    assert.equal(q.dropped(), 1)
  })

  it('dequeue returns at most what is available', () => {
    const q = new ArchiveNotifyQueue()
    q.enqueue({ tenantId: 't', sourceRef: 'tenant=t/a' })
    assert.equal(q.dequeue(10).length, 1)
    assert.deepEqual(q.dequeue(5), [])
  })
})
