import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import pino from 'pino'
import type { AlertEvent, ThresholdAlertEvent } from '../../src/watches/alert-observer.js'
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

let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []
let fetchResponse = { ok: true, status: 200, text: async () => 'ok' }

beforeEach(() => {
  fetchCalls = []
  fetchResponse = { ok: true, status: 200, text: async () => 'ok' }
  mock.method(globalThis, 'fetch', async (url: string, opts: RequestInit) => {
    fetchCalls.push({ url, body: JSON.parse(opts.body as string) })
    return fetchResponse
  })
})

afterEach(() => {
  mock.restoreAll()
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
    const observer = new WebhookObserver({ settingsStore: store, logger })

    await observer.notify(alert)

    assert.equal(fetchCalls.length, 0, 'should skip Slack URLs')
  })

  it('delivers generic webhook for https:// URLs', async () => {
    const alert: ThresholdAlertEvent = {
      ...THRESHOLD_ALERT,
      channels: ['https://my-webhook.example.com/alerts'],
    }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({ settingsStore: store, logger })

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
    const observer = new WebhookObserver({ settingsStore: store, logger })

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
    const observer = new WebhookObserver({ settingsStore: store, logger })

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
    const observer = new WebhookObserver({ settingsStore: store, logger })

    await observer.notify(alert)

    assert.equal(fetchCalls.length, 2, 'should deliver to webhook + pagerduty, skip Slack')
    const urls = fetchCalls.map((c) => c.url)
    assert.ok(urls.includes('https://my-webhook.example.com/alerts'))
    assert.ok(urls.includes('https://events.pagerduty.com/v2/enqueue'))
  })

  it('does nothing when no channels configured', async () => {
    const alert: ThresholdAlertEvent = { ...THRESHOLD_ALERT, channels: [] }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({ settingsStore: store, logger })

    await observer.notify(alert)

    assert.equal(fetchCalls.length, 0)
  })

  it('handles fetch errors gracefully', async () => {
    fetchResponse = { ok: false, status: 500, text: async () => 'Internal Server Error' }
    const alert: ThresholdAlertEvent = {
      ...THRESHOLD_ALERT,
      channels: ['https://my-webhook.example.com/alerts'],
    }
    const store = new TenantSettingsStore()
    const observer = new WebhookObserver({ settingsStore: store, logger })

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
    const observer = new WebhookObserver({ settingsStore: store, logger })

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
    const observer = new WebhookObserver({ settingsStore: store, logger })

    await observer.notify(alert)

    const payload = fetchCalls[0].body
    assert.equal(payload.dedup_key, 'logweave-rule-1-tenant-a')
  })
})
