import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LocalEventBus } from '../../src/events/local-bus.js'
import type { TailBuffer } from '../../src/tail/buffer.js'
import type { TailEvent } from '../../src/tail/types.js'
import type { TenantSettingsStore } from '../../src/watches/tenant-settings.js'

function createMockTailBuffer(): { buffer: TailBuffer; pushed: Array<{ tenantId: string; event: Omit<TailEvent, 'seq'> }> } {
  const pushed: Array<{ tenantId: string; event: Omit<TailEvent, 'seq'> }> = []
  const buffer = {
    push(tenantId: string, event: Omit<TailEvent, 'seq'>) {
      pushed.push({ tenantId, event })
    },
  } as unknown as TailBuffer
  return { buffer, pushed }
}

function createMockSettingsStore(tailMode: string): TenantSettingsStore {
  return {
    get: () => ({ tailMode }),
  } as unknown as TenantSettingsStore
}

const SAMPLE_EVENT: Omit<TailEvent, 'seq'> = {
  timestamp: '2026-03-22T00:00:00.000Z',
  service: 'api',
  level: 'ERROR',
  templateId: 'tmpl-1',
  templateText: 'Connection to <*> timed out',
  preProcessedMessage: 'Connection to 10.0.0.1 timed out',
  anomalyScore: 0.8,
  statusCode: 503,
  durationMs: 1200,
  traceId: 'trace-1',
  route: '/api/v1/charge',
}

describe('LocalEventBus', () => {
  it('pushes events to TailBuffer when tailMode is metadata', () => {
    const { buffer, pushed } = createMockTailBuffer()
    const store = createMockSettingsStore('metadata')
    const bus = new LocalEventBus(buffer, store)

    bus.publishTailEvent('tenant-a', SAMPLE_EVENT)

    assert.equal(pushed.length, 1)
    assert.equal(pushed[0].tenantId, 'tenant-a')
    assert.equal(pushed[0].event.preProcessedMessage, undefined)
  })

  it('includes preProcessedMessage when tailMode is preprocessed', () => {
    const { buffer, pushed } = createMockTailBuffer()
    const store = createMockSettingsStore('preprocessed')
    const bus = new LocalEventBus(buffer, store)

    bus.publishTailEvent('tenant-a', SAMPLE_EVENT)

    assert.equal(pushed.length, 1)
    assert.equal(pushed[0].event.preProcessedMessage, 'Connection to 10.0.0.1 timed out')
  })

  it('does not push when tailMode is disabled', () => {
    const { buffer, pushed } = createMockTailBuffer()
    const store = createMockSettingsStore('disabled')
    const bus = new LocalEventBus(buffer, store)

    bus.publishTailEvent('tenant-a', SAMPLE_EVENT)

    assert.equal(pushed.length, 0)
  })

  it('does not push when tailMode is undefined', () => {
    const { buffer, pushed } = createMockTailBuffer()
    const store = { get: () => ({}) } as unknown as TenantSettingsStore
    const bus = new LocalEventBus(buffer, store)

    bus.publishTailEvent('tenant-a', SAMPLE_EVENT)

    assert.equal(pushed.length, 0)
  })

  it('isConnected returns true', () => {
    const { buffer } = createMockTailBuffer()
    const store = createMockSettingsStore('metadata')
    const bus = new LocalEventBus(buffer, store)

    assert.equal(bus.isConnected(), true)
  })

  it('close resolves immediately', async () => {
    const { buffer } = createMockTailBuffer()
    const store = createMockSettingsStore('metadata')
    const bus = new LocalEventBus(buffer, store)

    await bus.close()
  })
})
