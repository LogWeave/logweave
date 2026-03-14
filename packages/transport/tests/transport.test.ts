import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { LogWeaveTransport } from '../src/transport.js'
import { mockFetch } from './helpers.js'

describe('LogWeaveTransport', () => {
  let transport: LogWeaveTransport | undefined

  afterEach(async () => {
    if (transport) {
      await transport.closeAsync()
      transport = undefined
    }
  })

  it('log() calls callback synchronously and never blocks', () => {
    const mock = mockFetch(200)
    transport = new LogWeaveTransport({
      apiKey: 'test-key',
      service: 'test-service',
      bufferSize: 100,
      flushIntervalMs: 60_000,
      fetch: mock.fetch,
    })

    let callbackCalled = false
    transport.log({ level: 'info', message: 'hello world', [Symbol.for('level')]: 'info' }, () => {
      callbackCalled = true
    })

    // Callback must have been called synchronously (before any async work)
    assert.equal(callbackCalled, true, 'callback must be called synchronously')
  })

  it('close() flushes remaining events', async () => {
    const mock = mockFetch(200)
    transport = new LogWeaveTransport({
      apiKey: 'test-key',
      service: 'test-service',
      bufferSize: 100,
      flushIntervalMs: 60_000,
      fetch: mock.fetch,
    })

    // Push some events (below buffer capacity, so no auto-flush)
    transport.log({ level: 'info', message: 'event 1', [Symbol.for('level')]: 'info' }, () => {})
    transport.log({ level: 'warn', message: 'event 2', [Symbol.for('level')]: 'warn' }, () => {})

    await transport.closeAsync()
    transport = undefined // prevent double-close in afterEach

    assert.equal(mock.calls.length, 1, 'should have flushed once on close')
    const body = JSON.parse(mock.calls[0]!.init?.body as string)
    assert.equal(body.events.length, 2, 'should have flushed 2 events')
  })

  it('close() times out after 2s if flush hangs', async () => {
    // Create a fetch that never resolves
    const neverResolve: typeof globalThis.fetch = () => new Promise(() => {})

    transport = new LogWeaveTransport({
      apiKey: 'test-key',
      service: 'test-service',
      bufferSize: 100,
      flushIntervalMs: 60_000,
      timeoutMs: 2000,
      fetch: neverResolve,
    })

    transport.log({ level: 'info', message: 'will hang', [Symbol.for('level')]: 'info' }, () => {})

    const start = Date.now()
    await transport.closeAsync()
    transport = undefined
    const elapsed = Date.now() - start

    // Should complete within ~2.5s (2s timeout + some margin)
    assert.ok(elapsed < 5000, `close() should time out within 5s, took ${elapsed}ms`)
  })

  it('payload shape matches contract (service/env at batch level, events flat)', async () => {
    const mock = mockFetch(200)
    transport = new LogWeaveTransport({
      apiKey: 'test-key',
      service: 'payment-service',
      environment: 'staging',
      bufferSize: 2,
      flushIntervalMs: 60_000,
      fetch: mock.fetch,
    })

    // Wait for the flush to complete after pushing 2 events
    const flushed = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (mock.calls.length > 0) {
          clearInterval(check)
          resolve()
        }
      }, 10)
      check.unref()
    })

    transport.log(
      {
        level: 'error',
        message: 'something broke',
        requestId: 'abc-123',
        userId: 42,
        [Symbol.for('level')]: 'error',
      },
      () => {},
    )
    transport.log(
      {
        level: 'info',
        message: 'recovered',
        [Symbol.for('level')]: 'info',
      },
      () => {},
    )

    await flushed

    const body = JSON.parse(mock.calls[0]!.init?.body as string)

    // Batch-level fields
    assert.equal(body.service, 'payment-service')
    assert.equal(body.environment, 'staging')
    assert.ok(Array.isArray(body.events), 'events should be an array')
    assert.equal(body.events.length, 2)

    // Event-level fields — flat, NOT wrapped in meta
    const event0 = body.events[0]
    assert.equal(event0.level, 'error')
    assert.equal(event0.message, 'something broke')
    assert.equal(event0.requestId, 'abc-123')
    assert.equal(event0.userId, 42)
    assert.ok(event0.timestamp, 'event should have a timestamp')
    assert.equal(event0.meta, undefined, 'meta should NOT be a wrapper — fields are flat')

    const event1 = body.events[1]
    assert.equal(event1.level, 'info')
    assert.equal(event1.message, 'recovered')
  })

  it('Authorization header set correctly', async () => {
    const mock = mockFetch(200)
    transport = new LogWeaveTransport({
      apiKey: 'my-secret-key-123',
      service: 'test-service',
      bufferSize: 1,
      flushIntervalMs: 60_000,
      fetch: mock.fetch,
    })

    const flushed = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (mock.calls.length > 0) {
          clearInterval(check)
          resolve()
        }
      }, 10)
      check.unref()
    })

    transport.log({ level: 'info', message: 'test', [Symbol.for('level')]: 'info' }, () => {})

    await flushed

    const headers = mock.calls[0]!.init?.headers as Record<string, string>
    assert.equal(
      headers.Authorization,
      'Bearer my-secret-key-123',
      'should send API key as Bearer token',
    )
    assert.equal(headers['Content-Type'], 'application/json', 'should set content type to JSON')
  })

  it('throws if apiKey is missing', () => {
    assert.throws(
      () =>
        new LogWeaveTransport({
          apiKey: '',
          service: 'test',
        } as never),
      (err: unknown) => err instanceof Error && err.message.includes('apiKey'),
    )
  })

  it('throws if service is missing', () => {
    assert.throws(
      () =>
        new LogWeaveTransport({
          apiKey: 'key',
          service: '',
        } as never),
      (err: unknown) => err instanceof Error && err.message.includes('service'),
    )
  })

  it('calls onDrop when batch is dropped after retry exhaustion', async () => {
    const droppedBatches: { events: unknown[]; error: Error }[] = []
    const mock = mockFetch(500)

    transport = new LogWeaveTransport({
      apiKey: 'test-key',
      service: 'test-service',
      bufferSize: 1,
      flushIntervalMs: 60_000,
      maxRetries: 0,
      fetch: mock.fetch,
      onDrop: (events, error) => {
        droppedBatches.push({ events: [...events], error })
      },
    })

    transport.log(
      { level: 'info', message: 'will be dropped', [Symbol.for('level')]: 'info' },
      () => {},
    )

    // Wait for flush + retry to complete
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.equal(droppedBatches.length, 1, 'onDrop should be called once')
    assert.equal(droppedBatches[0]!.events.length, 1)
    assert.ok(droppedBatches[0]!.error instanceof Error)
  })

  it('closeAsync awaits in-flight flush before draining', async () => {
    let flushCount = 0
    let resolveFirstFlush: (() => void) | undefined
    const flushedBatches: unknown[][] = []

    const slowFetch: typeof globalThis.fetch = async (_url, init) => {
      flushCount++
      if (flushCount === 1) {
        await new Promise<void>((r) => {
          resolveFirstFlush = r
        })
      }
      const body = JSON.parse(init?.body as string)
      flushedBatches.push(body.events)
      return new Response(null, { status: 200 })
    }

    transport = new LogWeaveTransport({
      apiKey: 'test-key',
      service: 'test-service',
      bufferSize: 2,
      flushIntervalMs: 60_000,
      fetch: slowFetch,
    })

    // Push 2 events to trigger auto-flush (in-flight)
    transport.log({ level: 'info', message: 'batch-1-a', [Symbol.for('level')]: 'info' }, () => {})
    transport.log({ level: 'info', message: 'batch-1-b', [Symbol.for('level')]: 'info' }, () => {})

    // Push 1 more into fresh buffer (not yet flushed)
    transport.log({ level: 'info', message: 'batch-2-a', [Symbol.for('level')]: 'info' }, () => {})

    // Start closeAsync — should wait for in-flight, then flush remaining
    const closePromise = transport.closeAsync()
    transport = undefined // prevent double-close in afterEach

    // Release first flush after short delay
    setTimeout(() => resolveFirstFlush!(), 50)

    await closePromise

    assert.equal(flushedBatches.length, 2, 'should flush both in-flight and remaining')
    assert.equal(flushedBatches[0]!.length, 2, 'first batch (in-flight) should have 2 events')
    assert.equal(flushedBatches[1]!.length, 1, 'second batch (drain) should have 1 event')
  })

  it('does not call onDrop when batch succeeds', async () => {
    let dropCalled = false
    const mock = mockFetch(200)

    transport = new LogWeaveTransport({
      apiKey: 'test-key',
      service: 'test-service',
      bufferSize: 1,
      flushIntervalMs: 60_000,
      fetch: mock.fetch,
      onDrop: () => {
        dropCalled = true
      },
    })

    transport.log({ level: 'info', message: 'ok', [Symbol.for('level')]: 'info' }, () => {})
    await new Promise((resolve) => setTimeout(resolve, 200))

    assert.equal(dropCalled, false, 'onDrop should not be called on success')
  })

  it('does not call onDrop during close timeout (close-abort is not data loss)', async () => {
    let dropCalled = false
    const neverResolve: typeof globalThis.fetch = () => new Promise(() => {})

    transport = new LogWeaveTransport({
      apiKey: 'test-key',
      service: 'test-service',
      bufferSize: 100,
      flushIntervalMs: 60_000,
      fetch: neverResolve,
      onDrop: () => {
        dropCalled = true
      },
    })

    transport.log(
      { level: 'info', message: 'will timeout', [Symbol.for('level')]: 'info' },
      () => {},
    )

    await transport.closeAsync()
    transport = undefined

    assert.equal(dropCalled, false, 'onDrop should not fire during close timeout')
  })

  it('double closeAsync is safe — second call is a no-op', async () => {
    const mock = mockFetch(200)
    transport = new LogWeaveTransport({
      apiKey: 'test-key',
      service: 'test-service',
      bufferSize: 100,
      flushIntervalMs: 60_000,
      fetch: mock.fetch,
    })

    transport.log({ level: 'info', message: 'event', [Symbol.for('level')]: 'info' }, () => {})

    // Call closeAsync twice — second should be a no-op
    await Promise.all([transport.closeAsync(), transport.closeAsync()])
    transport = undefined

    assert.equal(mock.calls.length, 1, 'should flush exactly once despite double close')
  })
})
