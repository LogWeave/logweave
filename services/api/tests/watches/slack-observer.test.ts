import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import {
  type SafeFetchFn,
  type SafeResponse,
  SsrfBlockedError,
  safeFetch,
} from '../../src/connectors/safe-fetch.js'
import type { ThresholdAlertEvent } from '../../src/watches/alert-observer.js'
import { SlackObserver } from '../../src/watches/slack-observer.js'
import { TenantSettingsStore } from '../../src/watches/tenant-settings.js'

const logger = pino({ level: 'silent' })

const THRESHOLD_ALERT: ThresholdAlertEvent = {
  type: 'threshold_breach',
  tenantId: 'tenant-a',
  service: 'payment-service',
  ruleId: 'rule-1',
  ruleName: 'High error rate',
  metric: 'error_count',
  metricValue: 15,
  thresholdValue: 10,
  operator: '>',
  windowMinutes: 5,
  triggeredAt: '2026-03-23T10:00:00.000Z',
  channels: [],
}

function okResponse(): SafeResponse {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {},
    text: async () => 'ok',
    json: async () => ({}),
  }
}

// notify() schedules delivery on a per-URL queue and returns; await that queued
// promise (it has a .catch, so it always resolves) to observe the delivery.
async function flush(observer: SlackObserver, url: string): Promise<void> {
  const queues = (observer as unknown as { deliveryQueues: Map<string, Promise<void>> })
    .deliveryQueues
  await queues.get(url)
}

describe('SlackObserver — SSRF guard on per-rule channels', () => {
  it('delivers a normal channel through the injected (safe) fetch', async () => {
    const calls: string[] = []
    const fetchFn: SafeFetchFn = async (target) => {
      calls.push(String(target))
      return okResponse()
    }
    const url = 'https://hooks.slack.com/services/T00/B00/xxx'
    const observer = new SlackObserver({
      settingsStore: new TenantSettingsStore(),
      logger,
      fetchFn,
    })

    await observer.notify({ ...THRESHOLD_ALERT, channels: [url] })
    await flush(observer, url)

    assert.deepEqual(calls, [url])
  })

  it('blocks an internal-IP channel via safeFetch — no delivery, no throw, no retry storm', async () => {
    const attempts: string[] = []
    let blocked: unknown
    const fetchFn: SafeFetchFn = async (target, init) => {
      attempts.push(String(target))
      try {
        return await safeFetch(target, init)
      } catch (err) {
        blocked = err
        throw err
      }
    }
    const url = 'https://169.254.169.254/latest/meta-data/'
    const observer = new SlackObserver({
      settingsStore: new TenantSettingsStore(),
      logger,
      fetchFn,
    })

    await observer.notify({ ...THRESHOLD_ALERT, channels: [url] })
    await flush(observer, url)

    assert.equal(attempts.length, 1, 'should attempt exactly once — no retries on a blocked host')
    assert.ok(blocked instanceof SsrfBlockedError, 'safeFetch must block the internal target')
  })
})
