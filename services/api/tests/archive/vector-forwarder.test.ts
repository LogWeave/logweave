import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { forwardToVector, VectorForwardError } from '../../src/archive/vector-forwarder.js'

const URL = 'http://vector:8686/v1/archive'
const UUID = '0190b3a0-0000-7000-8000-000000000001'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  /** Parsed NDJSON lines. */
  lines: Record<string, unknown>[]
  raw: string
}

function captureFetch(status = 200): { fetchFn: typeof globalThis.fetch; captured: Captured[] } {
  const captured: Captured[] = []
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const raw = String(init?.body ?? '')
    captured.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      raw,
      lines: raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    })
    return new Response(null, { status })
  }) as unknown as typeof globalThis.fetch
  return { fetchFn, captured }
}

describe('forwardToVector', () => {
  it('POSTs one NDJSON line per event to the Vector URL', async () => {
    const { fetchFn, captured } = captureFetch(200)
    await forwardToVector(
      { url: URL, fetchFn },
      [{ message: 'a' }, { message: 'b' }, { message: 'c' }],
      { tenantId: 'tenant-1' },
    )
    assert.equal(captured.length, 1)
    assert.equal(captured[0]?.url, URL)
    assert.equal(captured[0]?.method, 'POST')
    assert.equal(captured[0]?.lines.length, 3)
    // NDJSON: no trailing newline-only blank lines mis-parsed
    assert.equal(captured[0]?.lines[0]?.message, 'a')
    assert.equal(captured[0]?.lines[2]?.message, 'c')
  })

  it('injects tenant_id server-side, overriding any client-supplied value', async () => {
    const { fetchFn, captured } = captureFetch(200)
    await forwardToVector({ url: URL, fetchFn }, [{ message: 'a', tenant_id: 'attacker-tenant' }], {
      tenantId: 'tenant-1',
    })
    assert.equal(captured[0]?.lines[0]?.tenant_id, 'tenant-1')
  })

  it('preserves a well-formed source event_id and generates one when missing', async () => {
    const { fetchFn, captured } = captureFetch(200)
    await forwardToVector(
      { url: URL, fetchFn },
      [
        { message: 'has-id', event_id: UUID },
        { message: 'no-id' },
        { message: 'bad-id', event_id: 'nope' },
      ],
      { tenantId: 'tenant-1' },
    )
    const lines = captured[0]?.lines ?? []
    assert.equal(lines[0]?.event_id, UUID)
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    assert.match(String(lines[1]?.event_id), uuidRe)
    // A malformed client event_id is replaced (would poison the UUID column)
    assert.match(String(lines[2]?.event_id), uuidRe)
    assert.notEqual(lines[2]?.event_id, 'nope')
  })

  it('fills service/environment from batch defaults, event-level wins', async () => {
    const { fetchFn, captured } = captureFetch(200)
    await forwardToVector(
      { url: URL, fetchFn },
      [{ message: 'a' }, { message: 'b', service: 'own-svc' }],
      { tenantId: 'tenant-1', service: 'batch-svc', environment: 'prod' },
    )
    const lines = captured[0]?.lines ?? []
    assert.equal(lines[0]?.service, 'batch-svc')
    assert.equal(lines[0]?.environment, 'prod')
    assert.equal(lines[1]?.service, 'own-svc')
  })

  it('resolves on a 2xx (S3-durable gated ack)', async () => {
    const { fetchFn } = captureFetch(200)
    await assert.doesNotReject(
      forwardToVector({ url: URL, fetchFn }, [{ message: 'a' }], { tenantId: 'tenant-1' }),
    )
  })

  it('throws VectorForwardError on a non-2xx', async () => {
    const { fetchFn } = captureFetch(503)
    await assert.rejects(
      forwardToVector({ url: URL, fetchFn }, [{ message: 'a' }], { tenantId: 'tenant-1' }),
      (err: unknown) => err instanceof VectorForwardError,
    )
  })

  it('throws VectorForwardError on a network error / timeout', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    await assert.rejects(
      forwardToVector({ url: URL, fetchFn }, [{ message: 'a' }], { tenantId: 'tenant-1' }),
      (err: unknown) => err instanceof VectorForwardError,
    )
  })
})
