import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { LogWeaveTransport } from '../src/transport.js'
import { mockFetch } from './helpers.js'

/** Log one event through the transport and resolve when Winston's callback fires. */
function logEvent(t: LogWeaveTransport, message: string): Promise<void> {
  return new Promise((resolve) => {
    t.log({ level: 'info', message }, resolve)
  })
}

async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('LogWeaveTransport durable mode (#282)', () => {
  let dir: string
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'lw-durable-'))
  })
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('delivers spooled events to the API and drains the spool', async () => {
    const { fetch, calls } = mockFetch(200)
    const t = new LogWeaveTransport({
      apiKey: 'k',
      service: 'svc-deliver',
      endpoint: 'http://test/v1/ingest/batch',
      durable: true,
      spoolPath: join(dir, 'deliver.db'),
      fetch,
    })

    await logEvent(t, 'a')
    await logEvent(t, 'b')
    await waitFor(() => t.getStats().bufferedEvents === 0)
    await t.closeAsync()

    assert.ok(calls.length >= 1, 'pump POSTed at least one batch')
    const body = JSON.parse(calls[0]?.init?.body as string) as {
      service: string
      events: Array<{ event_id: string }>
    }
    assert.equal(body.service, 'svc-deliver')
    assert.ok(body.events[0]?.event_id, 'events carry a source-assigned event_id')
    const headers = calls[0]?.init?.headers as Record<string, string>
    assert.ok(headers['Idempotency-Key'], 'batch sent with an Idempotency-Key')
  })

  it('retains events on disk when the server is down (nothing lost)', async () => {
    const { fetch, calls } = mockFetch(503)
    const t = new LogWeaveTransport({
      apiKey: 'k',
      service: 'svc-down',
      endpoint: 'http://test/v1/ingest/batch',
      durable: true,
      spoolPath: join(dir, 'down.db'),
      fetch,
    })

    await logEvent(t, 'a')
    await logEvent(t, 'b')
    await waitFor(() => calls.length >= 1) // pump attempted delivery
    assert.equal(t.getStats().bufferedEvents, 2, 'events retained on a 5xx, not dropped')
    await t.closeAsync()
  })

  it('recovers spooled events across a restart (crash durability)', async () => {
    const spoolPath = join(dir, 'recover.db')

    // Instance A: server is down — events are spooled to disk and not delivered.
    const a = mockFetch(503)
    const tA = new LogWeaveTransport({
      apiKey: 'k',
      service: 'svc-recover',
      endpoint: 'http://test/v1/ingest/batch',
      durable: true,
      spoolPath,
      fetch: a.fetch,
    })
    await logEvent(tA, 'one')
    await logEvent(tA, 'two')
    await waitFor(() => a.calls.length >= 1)
    assert.equal(tA.getStats().bufferedEvents, 2)
    await tA.closeAsync() // events persist on disk

    // Instance B: same spool path, server now up — it must deliver the events
    // A never managed to send.
    const b = mockFetch(200)
    const tB = new LogWeaveTransport({
      apiKey: 'k',
      service: 'svc-recover',
      endpoint: 'http://test/v1/ingest/batch',
      durable: true,
      spoolPath,
      fetch: b.fetch,
    })
    await waitFor(() => tB.getStats().bufferedEvents === 0)
    await tB.closeAsync()

    assert.ok(b.calls.length >= 1, 'restarted instance drained the persisted spool')
    const delivered = b.calls.flatMap(
      (c) => (JSON.parse(c.init?.body as string) as { events: unknown[] }).events,
    )
    assert.equal(delivered.length, 2, 'both events from before the restart were delivered')
  })
})
