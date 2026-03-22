import type pino from 'pino'
import {
  type AlertEvent,
  type AlertObserver,
  type TemplateAlertEvent,
  type ThresholdAlertEvent,
  isTemplateAlert,
} from './alert-observer.js'
import type { TenantSettingsStore } from './tenant-settings.js'

const MAX_RETRIES = 3
const BACKOFF_BASE_MS = 2000
const MIN_SEND_INTERVAL_MS = 1000

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\u2026` : s
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface SlackObserverOptions {
  settingsStore: TenantSettingsStore
  dashboardBaseUrl?: string
  logger: pino.Logger
}

/**
 * Delivers alert notifications to Slack via incoming webhooks.
 *
 * Per-tenant webhook URLs are read from the TenantSettingsStore at delivery time.
 * If no webhook is configured for a tenant, the notification is silently skipped.
 *
 * Rate limiting: max 1 message per webhook URL per second.
 * Retry: up to 3 attempts with exponential backoff. Permanent Slack errors are not retried.
 */
export class SlackObserver implements AlertObserver {
  private readonly settingsStore: TenantSettingsStore
  private readonly dashboardBaseUrl: string | undefined
  private readonly logger: pino.Logger

  /** Track last send time per webhook URL for rate limiting. */
  private readonly lastSendTime = new Map<string, number>()

  /** Serialize deliveries per webhook URL to enforce rate limit ordering. */
  private readonly deliveryQueues = new Map<string, Promise<void>>()

  constructor(options: SlackObserverOptions) {
    this.settingsStore = options.settingsStore
    this.dashboardBaseUrl = options.dashboardBaseUrl
    this.logger = options.logger
  }

  async notify(alert: AlertEvent): Promise<void> {
    // Threshold alerts may specify per-rule channels; fall back to tenant default
    const webhookUrls: string[] = []
    if (!isTemplateAlert(alert) && alert.channels.length > 0) {
      webhookUrls.push(...alert.channels)
    } else {
      const tenantUrl = this.settingsStore.getSlackUrl(alert.tenantId)
      if (tenantUrl) webhookUrls.push(tenantUrl)
    }

    if (webhookUrls.length === 0) {
      this.logger.debug({ tenantId: alert.tenantId }, 'Slack: no webhook configured, skipping')
      return
    }

    const alertId = isTemplateAlert(alert) ? alert.templateId : alert.ruleId
    this.logger.debug(
      { tenantId: alert.tenantId, alertId, alertType: alert.type },
      'Slack: queuing alert delivery',
    )

    const payload = this.buildPayload(alert)

    for (const webhookUrl of webhookUrls) {
      // Chain onto the per-URL queue — non-blocking, fire-and-forget
      const previous = this.deliveryQueues.get(webhookUrl) ?? Promise.resolve()
      const next = previous
        .then(async () => {
          await this.enforceRateLimit(webhookUrl)
          await this.deliver(webhookUrl, payload, 0, alert)
        })
        .catch((err) => {
          this.logger.error({ err, tenantId: alert.tenantId }, 'Slack delivery queue error')
        })
      this.deliveryQueues.set(webhookUrl, next)
    }
  }

  private async enforceRateLimit(url: string): Promise<void> {
    const last = this.lastSendTime.get(url)
    if (last !== undefined) {
      const elapsed = Date.now() - last
      if (elapsed < MIN_SEND_INTERVAL_MS) {
        await sleep(MIN_SEND_INTERVAL_MS - elapsed)
      }
    }
  }

  private async deliver(
    url: string,
    payload: object,
    attempt = 0,
    alert?: AlertEvent,
  ): Promise<void> {
    const permanentErrors = [
      'channel_is_archived',
      'channel_not_found',
      'invalid_payload',
      'no_service',
      'action_prohibited',
    ]
    const alertId = alert ? (isTemplateAlert(alert) ? alert.templateId : alert.ruleId) : undefined
    const ctx = { attempt, alertId, tenantId: alert?.tenantId }

    try {
      this.logger.debug(ctx, 'Slack: sending webhook request')

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      })

      this.lastSendTime.set(url, Date.now())

      if (resp.ok) {
        this.logger.debug(ctx, 'Slack: delivered successfully')
        return
      }

      const body = await resp.text()

      // Permanent errors — don't retry
      if (permanentErrors.includes(body)) {
        this.logger.error(
          { ...ctx, status: resp.status, slackError: body },
          'Slack delivery failed (permanent — will not retry)',
        )
        return
      }

      // Rate limited — retry with Retry-After
      if (resp.status === 429) {
        const rawRetryAfter = Number(resp.headers.get('Retry-After') ?? 5)
        const retryAfter = Number.isFinite(rawRetryAfter) ? Math.min(Math.max(rawRetryAfter, 1), 60) : 5
        if (attempt < MAX_RETRIES) {
          this.logger.debug({ ...ctx, retryAfterSec: retryAfter }, 'Slack: rate limited, retrying')
          await sleep(retryAfter * 1000)
          return this.deliver(url, payload, attempt + 1, alert)
        }
      }

      // Other errors — retry with backoff
      if (attempt < MAX_RETRIES) {
        const backoffMs = BACKOFF_BASE_MS * 2 ** attempt
        this.logger.debug({ ...ctx, status: resp.status, backoffMs }, 'Slack: error, retrying')
        await sleep(backoffMs)
        return this.deliver(url, payload, attempt + 1, alert)
      }

      this.logger.error(
        { ...ctx, status: resp.status, slackError: body },
        'Slack delivery failed after all retries',
      )
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const backoffMs = BACKOFF_BASE_MS * 2 ** attempt
        this.logger.debug({ ...ctx, err, backoffMs }, 'Slack: network error, retrying')
        await sleep(backoffMs)
        return this.deliver(url, payload, attempt + 1, alert)
      }
      this.logger.error({ ...ctx, err }, 'Slack delivery failed (network) after all retries')
    }
  }

  private buildPayload(alert: AlertEvent): object {
    if (isTemplateAlert(alert)) {
      return this.buildTemplatePayload(alert)
    }
    return this.buildThresholdPayload(alert)
  }

  private buildTemplatePayload(alert: TemplateAlertEvent): object {
    const emoji = alert.type === 'spike' ? '\uD83D\uDD34' : '\uD83D\uDFE1'
    const title = alert.type === 'spike' ? 'Spike Alert' : 'New Burst Alert'
    const dashboardUrl = this.dashboardBaseUrl
      ? `${this.dashboardBaseUrl}/?template=${alert.templateId}`
      : undefined

    return {
      unfurl_links: false,
      unfurl_media: false,
      text: `${emoji} ${title}: "${alert.templateText}" in ${alert.service} (${alert.score.toFixed(1)}x baseline)`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${emoji} ${title}` } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Pattern*\n\`${truncate(alert.templateText, 150)}\`` },
            { type: 'mrkdwn', text: `*Service*\n${alert.service}` },
            { type: 'mrkdwn', text: `*Score*\n${alert.score.toFixed(1)}x baseline` },
            {
              type: 'mrkdwn',
              text: `*Events*\n${alert.currentCount.toLocaleString()} (baseline: ${alert.baselineCount.toLocaleString()})`,
            },
            { type: 'mrkdwn', text: `*Triggered*\n${new Date(alert.triggeredAt).toUTCString()}` },
          ],
        },
        ...(dashboardUrl
          ? [
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: 'View in Dashboard' },
                    url: dashboardUrl,
                  },
                ],
              },
            ]
          : []),
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `LogWeave Alert \u2022 ${alert.tenantId} \u2022 ${alert.triggeredAt}` }],
        },
      ],
    }
  }

  private buildThresholdPayload(alert: ThresholdAlertEvent): object {
    const emoji = '\uD83D\uDD14'
    const title = 'Threshold Alert'
    const dashboardUrl = this.dashboardBaseUrl
      ? `${this.dashboardBaseUrl}/?service=${alert.service}`
      : undefined

    return {
      unfurl_links: false,
      unfurl_media: false,
      text: `${emoji} ${title}: "${alert.ruleName}" — ${alert.metric} ${alert.operator} ${alert.thresholdValue} (actual: ${alert.metricValue})`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${emoji} ${title}` } },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Rule*\n${truncate(alert.ruleName, 150)}` },
            { type: 'mrkdwn', text: `*Service*\n${alert.service}` },
            { type: 'mrkdwn', text: `*Metric*\n${alert.metric} ${alert.operator} ${alert.thresholdValue}` },
            { type: 'mrkdwn', text: `*Actual Value*\n${alert.metricValue.toLocaleString()}` },
            { type: 'mrkdwn', text: `*Window*\n${alert.windowMinutes}min` },
            { type: 'mrkdwn', text: `*Triggered*\n${new Date(alert.triggeredAt).toUTCString()}` },
          ],
        },
        ...(dashboardUrl
          ? [
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: { type: 'plain_text', text: 'View in Dashboard' },
                    url: dashboardUrl,
                  },
                ],
              },
            ]
          : []),
        {
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `LogWeave Alert \u2022 ${alert.tenantId} \u2022 ${alert.triggeredAt}` }],
        },
      ],
    }
  }
}

/**
 * Send a test message to verify a Slack webhook URL is working.
 * Used by the settings test endpoint.
 */
export async function sendSlackTestMessage(
  webhookUrl: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: '\u2705 LogWeave test message \u2014 Slack integration is working!',
        unfurl_links: false,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (resp.ok) return { success: true }
    const body = await resp.text()
    return { success: false, error: body }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
