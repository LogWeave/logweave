import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { retryFetch } from '../src/retry.js'
import { immediateSleep, mockFetch, mockFetchSequence } from './helpers.js'

describe('retryFetch', () => {
  it('retries on 5xx and succeeds after recovery (4 total attempts: 1 initial + 3 retries)', async () => {
    const mock = mockFetchSequence([
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 200 },
    ])

    const result = await retryFetch(
      'http://test/v1/ingest/batch',
      { method: 'POST' },
      {
        maxRetries: 3,
        timeoutMs: 2000,
        fetchFn: mock.fetch,
        sleepFn: immediateSleep,
      },
    )

    assert.equal(mock.calls.length, 4, 'should make 4 total attempts (1 initial + 3 retries)')
    assert.notEqual(result, null, 'should return the successful response')
    assert.equal(result!.status, 200)
  })

  it('does not retry on 4xx and warns once', async () => {
    const mock = mockFetch(400, { error: 'bad request' })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '))
    }

    try {
      const result = await retryFetch(
        'http://test/v1/ingest/batch',
        { method: 'POST' },
        {
          maxRetries: 3,
          timeoutMs: 2000,
          fetchFn: mock.fetch,
          sleepFn: immediateSleep,
        },
      )

      assert.equal(mock.calls.length, 1, 'should NOT retry on 4xx')
      assert.equal(result, null, 'should return null on 4xx')
      assert.ok(warnings.length >= 1, 'should warn at least once')
      assert.ok(
        warnings.some((w) => w.includes('4')),
        'warning should mention the status code',
      )
    } finally {
      console.warn = originalWarn
    }
  })

  it('drops batch after exhausting all retries and warns', async () => {
    const mock = mockFetch(500)
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '))
    }

    try {
      const result = await retryFetch(
        'http://test/v1/ingest/batch',
        { method: 'POST' },
        {
          maxRetries: 3,
          timeoutMs: 2000,
          fetchFn: mock.fetch,
          sleepFn: immediateSleep,
        },
      )

      assert.equal(mock.calls.length, 4, 'should make 4 total attempts (1 initial + 3 retries)')
      assert.equal(result, null, 'should return null after exhausting retries')
      assert.ok(
        warnings.some((w) => w.includes('drop') || w.includes('exhaust') || w.includes('failed')),
        'should warn about dropped batch',
      )
    } finally {
      console.warn = originalWarn
    }
  })

  it('applies jitter so delays vary between attempts', async () => {
    const mock = mockFetchSequence([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 200 },
    ])
    const delays: number[] = []
    const trackingSleep = async (ms: number): Promise<void> => {
      delays.push(ms)
    }

    await retryFetch(
      'http://test/v1/ingest/batch',
      { method: 'POST' },
      {
        maxRetries: 3,
        timeoutMs: 2000,
        fetchFn: mock.fetch,
        sleepFn: trackingSleep,
      },
    )

    assert.equal(delays.length, 3, 'should sleep 3 times (before each retry)')
    // With jitter, each delay should be between 0 and (1000 * 2^attempt)
    assert.ok(delays[0]! >= 0 && delays[0]! <= 1000, `delay 0 (${delays[0]}) should be 0-1000ms`)
    assert.ok(delays[1]! >= 0 && delays[1]! <= 2000, `delay 1 (${delays[1]}) should be 0-2000ms`)
    assert.ok(delays[2]! >= 0 && delays[2]! <= 4000, `delay 2 (${delays[2]}) should be 0-4000ms`)
  })

  it('respects abort signal and stops retrying', async () => {
    const mock = mockFetch(500)
    const controller = new AbortController()

    // Abort after first call
    const sleepFn = async (_ms: number): Promise<void> => {
      controller.abort()
    }

    const result = await retryFetch(
      'http://test/v1/ingest/batch',
      { method: 'POST' },
      {
        maxRetries: 3,
        timeoutMs: 2000,
        fetchFn: mock.fetch,
        sleepFn,
        signal: controller.signal,
      },
    )

    assert.ok(mock.calls.length < 4, 'should stop retrying when aborted')
    assert.equal(result, null, 'should return null when aborted')
  })
})
