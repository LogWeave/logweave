import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import pino from 'pino'
import {
  type SafeFetchFn,
  type SafeResponse,
  SsrfBlockedError,
  safeFetch,
} from '../../src/connectors/safe-fetch.js'
import type {
  AlertEvent,
  ServiceSilenceResolvedEvent,
  ServiceSilentEvent,
  ThresholdAlertEvent,
} from '../../src/watches/alert-observer.js'
import { TenantSettingsStore } from '../../src/watches/tenant-settings.js'
import { WebhookObserver } from '../../src/watches/webhook-observer.js'

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

const TEMPLATE_ALERT: AlertEvent = {
  type: 'spike',
  tenantId: 'tenant-a',
  service: 'payment-service',
  templateId: 'tmpl-1',
  templateText: 'Connection to <*> timed out',
  currentCount: 42,
  baselineCount: 12,
  score: 3.5,
  triggeredAt: '2026-03-23T10:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Capture fetch calls
// ---------------------------------------------------------------------------

function makeResponse(ok: boolean, status: number, body = 'ok'): SafeResponse {
  return {
    ok,
    status,
    statusText: '',
    headers: {},
    text: async () => body,
    json: async () => ({}),
  }
}

let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []
let fetchResponse: SafeResponse = makeResponse(true, 200)

// Observers default to the SSRF-guarded safeFetch; inject a stub so unit tests
// don't hit the network and we can assert on the URLs/payloads delivered.
const mockFetch: SafeFetchFn = async (target, init) => {
  fetchCalls.push({ url: String(target), body: JSON.parse((init?.body as string) ?? '{}') })
  return fetchResponse
}

beforeEach(() => {
  fetchCalls = []
  fetchResponse = makeResponse(true, 200)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebhookObserver', () => {
  it('skips Slack webhook URLs', async () => {
    const alert: ThresholdAlertEvent = {
      ...THRESHOLD_ALERT,
      channels: ['https://hooks.slack.com/services/T00/B00/xxx'],
    }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)

    assert.equal(fetchCalls.length, 0, 'should skip Slack URLs')
  })

  it('delivers generic webhook for https:// URLs', async () => {
    const alert: ThresholdAlertEvent = {
      ...THRESHOLD_ALERT,
      channels: ['https://my-webhook.example.com/alerts'],
    }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)

    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, 'https://my-webhook.example.com/alerts')
    const payload = fetchCalls[0].body
    assert.equal(payload.source, 'logweave')
    assert.equal(payload.title, 'High error rate')
    assert.equal(payload.service, 'payment-service')
    assert.equal(payload.metricValue, 15)
  })

  it('delivers PagerDuty payload for pagerduty:// channels', async () => {
    const alert: ThresholdAlertEvent = {
      ...THRESHOLD_ALERT,
      channels: ['pagerduty://abc123def456'],
    }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)

    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, 'https://events.pagerduty.com/v2/enqueue')
    const payload = fetchCalls[0].body
    assert.equal(payload.routing_key, 'abc123def456')
    assert.equal(payload.event_action, 'trigger')
    const pd = payload.payload as Record<string, unknown>
    assert.equal(pd.severity, 'critical')
    assert.equal(pd.component, 'payment-service')
    assert.ok((pd.summary as string).includes('High error rate'))
  })

  it('skips template alerts when tenant default is Slack', async () => {
    const alert: AlertEvent = { ...TEMPLATE_ALERT }
    const store = new TenantSettingsStore()
    store.set('tenant-a', { slackWebhookUrl: 'https://hooks.slack.com/services/T00/B00/xxx' })
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)
    assert.equal(fetchCalls.length, 0, 'should skip — SlackObserver handles Slack URLs')
  })

  it('delivers to multiple non-Slack channels', async () => {
    const alert: ThresholdAlertEvent = {
      ...THRESHOLD_ALERT,
      channels: [
        'https://hooks.slack.com/services/T00/B00/xxx',
        'https://my-webhook.example.com/alerts',
        'pagerduty://routing-key-123',
      ],
    }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)

    assert.equal(fetchCalls.length, 2, 'should deliver to webhook + pagerduty, skip Slack')
    const urls = fetchCalls.map((c) => c.url)
    assert.ok(urls.includes('https://my-webhook.example.com/alerts'))
    assert.ok(urls.includes('https://events.pagerduty.com/v2/enqueue'))
  })

  it('does nothing when no channels configured', async () => {
    const alert: ThresholdAlertEvent = { ...THRESHOLD_ALERT, channels: [] }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)

    assert.equal(fetchCalls.length, 0)
  })

  it('handles fetch errors gracefully', async () => {
    fetchResponse = makeResponse(false, 500, 'Internal Server Error')
    const alert: ThresholdAlertEvent = {
      ...THRESHOLD_ALERT,
      channels: ['https://my-webhook.example.com/alerts'],
    }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    // Should not throw
    await observer.notify(alert)
    assert.ok(fetchCalls.length >= 1)
  })

  it('generic webhook payload has correct structure for template alerts', async () => {
    const alert: AlertEvent = {
      ...TEMPLATE_ALERT,
    }
    // Override: give it a non-Slack channel via threshold channels
    // Template alerts don't have channels, so use a non-Slack tenant default
    const store = new TenantSettingsStore()
    store.set('tenant-a', { slackWebhookUrl: 'https://generic-webhook.example.com/hook' })
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    // Actually this is a generic URL, not Slack — WebhookObserver should handle it
    // But wait, the tenant default is checked via settingsStore.getSlackUrl which is
    // specifically for Slack. The WebhookObserver needs a different approach for tenant defaults.
    // For now, template alerts with no per-rule channels fall back to tenant's Slack URL.
    // The WebhookObserver should check if that URL is Slack and skip it.
    // This is correct — a tenant's "Slack webhook" that's actually a generic URL is an edge case.

    // Let me test with a non-Slack URL stored as the "slack" webhook
    await observer.notify(alert)
    // This URL doesn't start with hooks.slack.com, so WebhookObserver will deliver it
    assert.equal(fetchCalls.length, 1)
    const payload = fetchCalls[0].body
    assert.equal(payload.source, 'logweave')
    assert.equal(payload.severity, 'warning')
    assert.ok((payload.title as string).includes('Connection to'))
  })

  it('PagerDuty dedup_key includes ruleId and tenantId', async () => {
    const alert: ThresholdAlertEvent = {
      ...THRESHOLD_ALERT,
      channels: ['pagerduty://my-key'],
    }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)

    const payload = fetchCalls[0].body
    assert.equal(payload.dedup_key, 'logweave-rule-1-tenant-a')
  })

  it('delivers service_silent via generic webhook using tenant default', async () => {
    const alert: ServiceSilentEvent = {
      type: 'service_silent',
      tenantId: 'tenant-a',
      service: 'checkout',
      expectedCount: 20,
      actualCount: 0,
      triggeredAt: '2026-03-23T10:00:00.000Z',
    }
    const store = new TenantSettingsStore()
    store.set('tenant-a', { slackWebhookUrl: 'https://generic-webhook.example.com/hook' })
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)

    assert.equal(fetchCalls.length, 1)
    const payload = fetchCalls[0].body
    assert.equal(payload.source, 'logweave')
    assert.equal(payload.severity, 'critical')
    assert.equal(payload.service, 'checkout')
    assert.equal(payload.expectedCount, 20)
    assert.equal(payload.actualCount, 0)
  })

  it('delivers service_silent PagerDuty trigger with a stable dedup_key', async () => {
    const alert: ServiceSilentEvent = {
      type: 'service_silent',
      tenantId: 'tenant-a',
      service: 'checkout',
      expectedCount: 20,
      actualCount: 0,
      triggeredAt: '2026-03-23T10:00:00.000Z',
    }
    const store = new TenantSettingsStore()
    store.set('tenant-a', { slackWebhookUrl: 'pagerduty://my-key' })
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)

    const payload = fetchCalls[0].body
    assert.equal(payload.event_action, 'trigger')
    assert.equal(payload.dedup_key, 'logweave-service_silent-checkout-tenant-a')
    const pd = payload.payload as Record<string, unknown>
    assert.equal(pd.severity, 'critical')
    assert.ok((pd.summary as string).includes('checkout'))
  })

  it('resolves service_silence_resolved via PagerDuty with a matching dedup_key', async () => {
    const alert: ServiceSilenceResolvedEvent = {
      type: 'service_silence_resolved',
      tenantId: 'tenant-a',
      service: 'checkout',
      resolvedAt: '2026-03-23T10:05:00.000Z',
    }
    const store = new TenantSettingsStore()
    store.set('tenant-a', { slackWebhookUrl: 'pagerduty://my-key' })
    const observer = new WebhookObserver({
      settingsStore: store,
      logger,
      sleepFn: async () => {},
      fetchFn: mockFetch,
    })

    await observer.notify(alert)

    const payload = fetchCalls[0].body
    assert.equal(payload.event_action, 'resolve')
    assert.equal(payload.dedup_key, 'logweave-service_silent-checkout-tenant-a')
  })

  // SSRF: a webhook channel is fetched server-side when the rule fires. The
  // default fetch is the real safeFetch, which must refuse an internal/metadata
  // target — and the observer must not burn its retry budget on a blocked host.
  it('does not deliver to an internal-IP channel (safeFetch blocks it, no retries)', async () => {
    const attempts: string[] = []
    let blocked: unknown
    const observer = new WebhookObserver({
      settingsStore: new TenantSettingsStore(),
      logger,
      sleepFn: async () => {},
      // Real SSRF guard, wrapped so the test can see it fire.
      fetchFn: async (target, init) => {
        attempts.push(String(target))
        try {
          return await safeFetch(target, init)
        } catch (err) {
          blocked = err
          throw err
        }
      },
    })
    const alert: ThresholdAlertEvent = {
      ...THRESHOLD_ALERT,
      channels: ['https://169.254.169.254/latest/meta-data/iam/security-credentials/'],
    }

    // notify must swallow the SSRF error (logged), not throw.
    await observer.notify(alert)

    assert.equal(attempts.length, 1, 'should attempt exactly once — no retries on a blocked host')
    assert.ok(blocked instanceof SsrfBlockedError, 'safeFetch must block the internal target')
  })
})
