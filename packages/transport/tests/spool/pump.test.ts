import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { describe, it } from 'node:test'
import { MemorySpoolStore } from '../../src/spool/memory-spool.js'
import { batchKey, defaultSleep, Pump } from '../../src/spool/pump.js'
import type { LogEvent } from '../../src/types.js'

/** Fast, signal-ignoring sleep so backoff/poll delays don't slow tests. */
const fastSleep = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

function evt(message: string): LogEvent {
  return { timestamp: '2026-06-27T00:00:00.000Z', level: 'info', message }
}

/** Poll until `pred()` is true or the timeout elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 2))
  }
}

interface Call {
  url: string
  init: RequestInit
}

/** A fetch stub that records calls and returns a status (or throws for network errors). */
function stubFetch(behavior: () => number | 'throw'): {
  fn: typeof globalThis.fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const status = behavior()
    if (status === 'throw') throw new Error('network down')
    return new Response('{}', { status })
  }) as unknown as typeof globalThis.fetch
  return { fn, calls }
}

function makePump(spool: MemorySpoolStore, fetchFn: typeof globalThis.fetch, extra = {}) {
  return new Pump({
    spool,
    endpoint: 'http://test/v1/ingest/batch',
    apiKey: 'k',
    service: 'svc',
    environment: 'test',
    batchSize: 10,
    timeoutMs: 100,
    fetchFn,
    sleepFn: fastSleep,
    ...extra,
  })
}

describe('Pump delivery loop', () => {
  it('2xx → deletes delivered events from the spool', async () => {
    const spool = new MemorySpoolStore()
    for (const m of ['a', 'b', 'c']) spool.insert(evt(m))
    const { fn, calls } = stubFetch(() => 200)
    const pump = makePump(spool, fn)

    pump.start()
    await waitFor(() => spool.count() === 0)
    await pump.stop()

    assert.equal(spool.count(), 0, 'all delivered events removed')
    assert.ok(calls.length >= 1)
  })

  it('5xx → retains events and keeps retrying', async () => {
    const spool = new MemorySpoolStore()
    spool.insert(evt('a'))
    spool.insert(evt('b'))
    const { fn, calls } = stubFetch(() => 503)
    const pump = makePump(spool, fn)

    pump.start()
    await waitFor(() => calls.length >= 2) // proves it retried
    await pump.stop()

    assert.equal(spool.count(), 2, 'nothing deleted on transient failure')
  })

  it('network error → retains and retries', async () => {
    const spool = new MemorySpoolStore()
    spool.insert(evt('a'))
    const { fn, calls } = stubFetch(() => 'throw')
    const pump = makePump(spool, fn)

    pump.start()
    await waitFor(() => calls.length >= 2)
    await pump.stop()

    assert.equal(spool.count(), 1)
  })

  it('4xx → reports via onDrop and skips (deletes) the batch', async () => {
    const spool = new MemorySpoolStore()
    spool.insert(evt('a'))
    spool.insert(evt('b'))
    const dropped: LogEvent[] = []
    const { fn } = stubFetch(() => 400)
    const pump = makePump(spool, fn, { onDrop: (e: readonly LogEvent[]) => dropped.push(...e) })

    pump.start()
    await waitFor(() => spool.count() === 0)
    await pump.stop()

    assert.equal(spool.count(), 0, 'unrecoverable batch skipped so the queue progresses')
    assert.equal(dropped.length, 2, 'onDrop reported the lost events')
  })

  it('429 is treated as transient (retried, not dropped)', async () => {
    const spool = new MemorySpoolStore()
    spool.insert(evt('a'))
    const { fn, calls } = stubFetch(() => 429)
    const pump = makePump(spool, fn)

    pump.start()
    await waitFor(() => calls.length >= 2)
    await pump.stop()

    assert.equal(spool.count(), 1, '429 must not drop the batch')
  })

  it('drains across multiple batches when batchSize is small', async () => {
    const spool = new MemorySpoolStore()
    for (const m of ['a', 'b', 'c', 'd', 'e']) spool.insert(evt(m))
    const { fn, calls } = stubFetch(() => 200)
    const pump = makePump(spool, fn, { batchSize: 2 })

    pump.start()
    await waitFor(() => spool.count() === 0)
    await pump.stop()

    assert.ok(calls.length >= 3, 'three batches for five events at batchSize 2')
  })

  it('sends the Idempotency-Key and event_id-bearing batch body', async () => {
    const spool = new MemorySpoolStore()
    const id = spool.insert(evt('a'))
    const { fn, calls } = stubFetch(() => 200)
    const pump = makePump(spool, fn)

    pump.start()
    await waitFor(() => spool.count() === 0)
    await pump.stop()

    const first = calls[0]
    assert.ok(first)
    const headers = first.init.headers as Record<string, string>
    assert.equal(headers['Idempotency-Key'], batchKey([id]))
    assert.equal(headers.Authorization, 'Bearer k')
    const body = JSON.parse(first.init.body as string) as {
      service: string
      events: Array<{ event_id: string; message: string }>
    }
    assert.equal(body.service, 'svc')
    assert.equal(body.events[0]?.event_id, id)
    assert.equal(body.events[0]?.message, 'a')
  })

  it('4xx without an onDrop handler still deletes the batch and does not throw', async () => {
    const spool = new MemorySpoolStore()
    spool.insert(evt('a'))
    const { fn } = stubFetch(() => 400)
    const pump = makePump(spool, fn) // no onDrop wired

    pump.start()
    await waitFor(() => spool.count() === 0)
    await pump.stop()

    assert.equal(spool.count(), 0, 'unrecoverable batch skipped even without onDrop')
  })

  it('start is idempotent and stop is safe to call without start', async () => {
    const spool = new MemorySpoolStore()
    const { fn } = stubFetch(() => 200)
    const pump = makePump(spool, fn)
    await pump.stop() // no-op before start
    pump.start()
    pump.start() // second start ignored
    await pump.stop()
    assert.ok(true)
  })
})

describe('batchKey', () => {
  it('is deterministic and order-independent', () => {
    assert.equal(batchKey(['a', 'b', 'c']), batchKey(['c', 'b', 'a']))
    assert.notEqual(batchKey(['a']), batchKey(['a', 'b']))
  })
})

describe('defaultSleep', () => {
  it('removes its abort listener on the normal path (no leak across ticks)', async () => {
    const ctrl = new AbortController()
    for (let i = 0; i < 5; i++) await defaultSleep(0, ctrl.signal)
    assert.equal(
      getEventListeners(ctrl.signal, 'abort').length,
      0,
      'no abort listeners accumulate on a long-lived signal',
    )
  })

  it('resolves promptly when the signal aborts mid-sleep', async () => {
    const ctrl = new AbortController()
    const p = defaultSleep(10_000, ctrl.signal)
    ctrl.abort()
    await p // would hang on the 10s timer if abort were not honored
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
  })
})
