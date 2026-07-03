import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import { uuidv7 } from '../uuid.js'
import {
  type AlertEvent,
  type AlertObserver,
  isResolvedAlert,
  isServiceSilenceResolved,
  isServiceSilent,
  isTemplateAlert,
  type ServiceSilentEvent,
  type TemplateAlertEvent,
  type ThresholdAlertEvent,
} from './alert-observer.js'

export interface HistoryObserverOptions {
  db: DbClient
  logger: pino.Logger
}

/**
 * Logs every fired alert to the alert_history table in ClickHouse.
 * Best-effort: DB errors are caught and logged, never blocking alert dispatch.
 */
export class HistoryObserver implements AlertObserver {
  private readonly db: DbClient
  private readonly logger: pino.Logger

  constructor(options: HistoryObserverOptions) {
    this.db = options.db
    this.logger = options.logger
  }

  async notify(alert: AlertEvent): Promise<void> {
    // Resolve events are not logged to history — they're only for PagerDuty
    if (isResolvedAlert(alert) || isServiceSilenceResolved(alert)) return
    const row = this.toHistoryRow(alert)
    try {
      await this.db.insert({
        table: 'logweave.alert_history',
        values: [row],
        format: 'JSONEachRow',
      })
    } catch (err) {
      this.logger.error({ err, alertType: alert.type }, 'Failed to insert alert history')
    }
  }

  private toHistoryRow(
    alert: TemplateAlertEvent | ThresholdAlertEvent | ServiceSilentEvent,
  ): Record<string, unknown> {
    if (isTemplateAlert(alert)) {
      return {
        alert_id: uuidv7(),
        tenant_id: alert.tenantId,
        rule_id: alert.templateId,
        rule_type: alert.type,
        rule_name: alert.templateText,
        metric_value: alert.score,
        threshold_value: 1.0,
        details: JSON.stringify({
          service: alert.service,
          currentCount: alert.currentCount,
          baselineCount: alert.baselineCount,
        }),
        channels_notified: '[]',
      }
    }
    if (isServiceSilent(alert)) {
      return {
        alert_id: uuidv7(),
        tenant_id: alert.tenantId,
        rule_id: alert.service,
        rule_type: 'service_silent',
        rule_name: `${alert.service} silence detection`,
        metric_value: alert.actualCount,
        threshold_value: alert.expectedCount,
        details: JSON.stringify({
          service: alert.service,
          expectedCount: alert.expectedCount,
          actualCount: alert.actualCount,
        }),
        channels_notified: '[]',
      }
    }
    return {
      alert_id: uuidv7(),
      tenant_id: alert.tenantId,
      rule_id: alert.ruleId,
      rule_type: 'threshold',
      rule_name: alert.ruleName,
      metric_value: alert.metricValue,
      threshold_value: alert.thresholdValue,
      details: JSON.stringify({
        service: alert.service,
        environment: alert.environment,
        metric: alert.metric,
        operator: alert.operator,
        windowMinutes: alert.windowMinutes,
      }),
      channels_notified: JSON.stringify(alert.channels),
    }
  }
}
