import type pino from 'pino'
import {
  type AlertEvent,
  type AlertObserver,
  hasChannels,
  isResolvedAlert,
  isServiceSilenceResolved,
  isServiceSilent,
  isTemplateAlert,
} from './alert-observer.js'
import type { TenantSettingsStore } from './tenant-settings.js'

const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue'
const PAGERDUTY_PREFIX = 'pagerduty://'
const SLACK_HOST = 'hooks.slack.com'
const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 2000

function isSlackUrl(url: string): boolean {
  return url.includes(SLACK_HOST)
}

function isPagerDutyChannel(channel: string): boolean {
  return channel.startsWith(PAGERDUTY_PREFIX)
}

function extractPagerDutyKey(channel: string): string {
  return channel.slice(PAGERDUTY_PREFIX.length)
}

// Generic webhook URLs may carry tokens in path or query string.
// Log only the scheme+host so we can correlate failures without leaking secrets.
function redactWebhookUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return '[invalid-url]'
  }
}

import { sleep } from '../lib/sleep.js'

export interface WebhookObserverOptions {
  settingsStore: TenantSettingsStore
  dashboardBaseUrl?: string
  logger: pino.Logger
  /** Override sleep for testing (default: real sleep). */
  sleepFn?: (ms: number) => Promise<void>
}

/**
 * Delivers alert notifications via generic webhooks and PagerDuty Events API v2.
 *
 * Handles all non-Slack channels from alert rules:
 * - `pagerduty://{routing_key}` → PagerDuty Events API v2
 * - `https://...` (non-Slack) → generic JSON webhook POST
 * - Slack URLs are skipped (SlackObserver handles those)
 *
 * Retry: up to 3 attempts with exponential backoff.
 */
export class WebhookObserver implements AlertObserver {
  private readonly settingsStore: TenantSettingsStore
  private readonly dashboardBaseUrl: string | undefined
  private readonly logger: pino.Logger
  private readonly sleepFn: (ms: number) => Promise<void>

  constructor(options: WebhookObserverOptions) {
    this.settingsStore = options.settingsStore
    this.dashboardBaseUrl = options.dashboardBaseUrl
    this.logger = options.logger
    this.sleepFn = options.sleepFn ?? sleep
  }

  async notify(alert: AlertEvent): Promise<void> {
    const channels = this.getChannels(alert)
    const nonSlackChannels = channels.filter((ch) => !isSlackUrl(ch) || isPagerDutyChannel(ch))

    if (nonSlackChannels.length === 0) return

    for (const channel of nonSlackChannels) {
      try {
        if (isPagerDutyChannel(channel)) {
          await this.deliverPagerDuty(channel, alert)
        } else {
          await this.deliverWebhook(channel, alert)
        }
      } catch (err) {
        const safeChannel = isPagerDutyChannel(channel)
          ? `pagerduty://***${channel.slice(-4)}`
          : redactWebhookUrl(channel)
        this.logger.error(
          { err, tenantId: alert.tenantId, channel: safeChannel },
          'Webhook delivery failed after all retries',
        )
      }
    }
  }

  private getChannels(alert: AlertEvent): string[] {
    if (hasChannels(alert) && alert.channels.length > 0) {
      return alert.channels
    }
    const tenantUrl = this.settingsStore.getSlackUrl(alert.tenantId)
    return tenantUrl ? [tenantUrl] : []
  }

  private async deliverWebhook(url: string, alert: AlertEvent): Promise<void> {
    const payload = this.buildGenericPayload(alert)
    await this.post(url, payload)
  }

  private async deliverPagerDuty(channel: string, alert: AlertEvent): Promise<void> {
    const routingKey = extractPagerDutyKey(channel)
    const payload = this.buildPagerDutyPayload(routingKey, alert)
    await this.post(PAGERDUTY_EVENTS_URL, payload)
  }

  private async post(url: string, payload: object, attempt = 0): Promise<void> {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })

      if (resp.ok) return

      if (attempt < MAX_RETRIES) {
        const backoffMs = BACKOFF_BASE_MS * 2 ** attempt
        await this.sleepFn(backoffMs)
        return this.post(url, payload, attempt + 1)
      }

      const body = await resp.text()
      this.logger.error(
        { url: redactWebhookUrl(url), status: resp.status, body: body.slice(0, 200) },
        'Webhook POST failed after retries',
      )
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const backoffMs = BACKOFF_BASE_MS * 2 ** attempt
        await this.sleepFn(backoffMs)
        return this.post(url, payload, attempt + 1)
      }
      throw err
    }
  }

  private buildGenericPayload(alert: AlertEvent): object {
    if (isTemplateAlert(alert)) {
      return {
        source: 'logweave',
        timestamp: alert.triggeredAt,
        severity: 'warning',
        title: alert.templateText,
        service: alert.service,
        templateId: alert.templateId,
        currentCount: alert.currentCount,
        baselineCount: alert.baselineCount,
        score: alert.score,
        tenantId: alert.tenantId,
        dashboardUrl: this.dashboardBaseUrl
          ? `${this.dashboardBaseUrl}/?template=${alert.templateId}`
          : undefined,
      }
    }
    if (isResolvedAlert(alert)) {
      return {
        source: 'logweave',
        type: 'resolved',
        ruleId: alert.ruleId,
        ruleName: alert.ruleName,
        service: alert.service,
        environment: alert.environment,
        tenantId: alert.tenantId,
        resolvedAt: alert.resolvedAt,
      }
    }
    if (isServiceSilenceResolved(alert)) {
      return {
        source: 'logweave',
        type: 'resolved',
        service: alert.service,
        tenantId: alert.tenantId,
        resolvedAt: alert.resolvedAt,
      }
    }
    if (isServiceSilent(alert)) {
      return {
        source: 'logweave',
        timestamp: alert.triggeredAt,
        severity: 'critical',
        title: `${alert.service} has gone silent`,
        service: alert.service,
        expectedCount: alert.expectedCount,
        actualCount: alert.actualCount,
        tenantId: alert.tenantId,
        dashboardUrl: this.dashboardBaseUrl
          ? `${this.dashboardBaseUrl}/?service=${alert.service}`
          : undefined,
      }
    }
    return {
      source: 'logweave',
      timestamp: alert.triggeredAt,
      severity: 'critical',
      title: alert.ruleName,
      service: alert.service,
      environment: alert.environment,
      ruleId: alert.ruleId,
      ruleName: alert.ruleName,
      metric: alert.metric,
      metricValue: alert.metricValue,
      thresholdValue: alert.thresholdValue,
      operator: alert.operator,
      windowMinutes: alert.windowMinutes,
      tenantId: alert.tenantId,
      dashboardUrl: this.dashboardBaseUrl
        ? `${this.dashboardBaseUrl}/?service=${alert.service}`
        : undefined,
    }
  }

  private buildPagerDutyPayload(routingKey: string, alert: AlertEvent): object {
    const alertId = isTemplateAlert(alert)
      ? alert.templateId
      : isServiceSilent(alert) || isServiceSilenceResolved(alert)
        ? `service_silent-${alert.service}`
        : alert.ruleId

    // Resolve events — minimal payload, just routing key + dedup key
    if (isResolvedAlert(alert)) {
      return {
        routing_key: routingKey,
        event_action: 'resolve',
        dedup_key: `logweave-${alert.ruleId}-${alert.tenantId}`,
      }
    }
    if (isServiceSilenceResolved(alert)) {
      return {
        routing_key: routingKey,
        event_action: 'resolve',
        dedup_key: `logweave-service_silent-${alert.service}-${alert.tenantId}`,
      }
    }

    const rawSummary = isTemplateAlert(alert)
      ? `LogWeave: "${alert.templateText}" spike in ${alert.service} (${alert.score.toFixed(1)}x baseline)`
      : isServiceSilent(alert)
        ? `LogWeave: ${alert.service} has gone silent (${alert.actualCount} events, expected ~${alert.expectedCount})`
        : `LogWeave: ${alert.ruleName} — ${alert.metric} ${alert.operator} ${alert.thresholdValue} (actual: ${alert.metricValue})`
    const summary = rawSummary.slice(0, 1024)

    return {
      routing_key: routingKey,
      event_action: 'trigger',
      dedup_key: `logweave-${alertId}-${alert.tenantId}`,
      payload: {
        summary,
        severity: isTemplateAlert(alert) ? 'warning' : 'critical',
        source: 'logweave',
        component: alert.service,
        group: alert.tenantId,
        custom_details: isTemplateAlert(alert)
          ? {
              templateId: alert.templateId,
              currentCount: alert.currentCount,
              baselineCount: alert.baselineCount,
              score: alert.score,
            }
          : isServiceSilent(alert)
            ? {
                expectedCount: alert.expectedCount,
                actualCount: alert.actualCount,
              }
            : {
                ruleId: alert.ruleId,
                metric: alert.metric,
                metricValue: alert.metricValue,
                thresholdValue: alert.thresholdValue,
                operator: alert.operator,
                windowMinutes: alert.windowMinutes,
                environment: alert.environment,
              },
      },
      ...(this.dashboardBaseUrl
        ? {
            links: [
              {
                href: isTemplateAlert(alert)
                  ? `${this.dashboardBaseUrl}/?template=${alert.templateId}`
                  : `${this.dashboardBaseUrl}/?service=${alert.service}`,
                text: 'View in LogWeave Dashboard',
              },
            ],
          }
        : {}),
    }
  }
}
