import type pino from 'pino'

export type ThresholdOperator = '>' | '>=' | '<' | '<='

export interface TemplateAlertEvent {
  type: 'spike' | 'new_burst'
  tenantId: string
  service: string
  templateId: string
  templateText: string
  currentCount: number
  baselineCount: number
  score: number
  triggeredAt: string
}

export interface ThresholdAlertEvent {
  type: 'threshold_breach'
  tenantId: string
  service: string
  environment?: string
  ruleId: string
  ruleName: string
  metric: string
  metricValue: number
  thresholdValue: number
  operator: ThresholdOperator
  windowMinutes: number
  triggeredAt: string
  channels: string[]
}

export interface ThresholdResolvedEvent {
  type: 'threshold_resolved'
  tenantId: string
  service: string
  environment?: string
  ruleId: string
  ruleName: string
  metric: string
  channels: string[]
  resolvedAt: string
}

export type AlertEvent = TemplateAlertEvent | ThresholdAlertEvent | ThresholdResolvedEvent

export function isTemplateAlert(e: AlertEvent): e is TemplateAlertEvent {
  return e.type === 'spike' || e.type === 'new_burst'
}

export function isResolvedAlert(e: AlertEvent): e is ThresholdResolvedEvent {
  return e.type === 'threshold_resolved'
}

export function isThresholdBreach(e: AlertEvent): e is ThresholdAlertEvent {
  return e.type === 'threshold_breach'
}

export interface AlertObserver {
  notify(alert: AlertEvent): Promise<void>
}

/**
 * Dispatches alerts to all registered observers.
 * Individual observer failures are caught and logged — one failing observer
 * does not prevent others from receiving the alert.
 */
export class AlertDispatcher {
  private readonly observers: AlertObserver[] = []
  private readonly logger: pino.Logger

  constructor(logger: pino.Logger) {
    this.logger = logger
  }

  register(observer: AlertObserver): void {
    this.observers.push(observer)
  }

  async dispatch(alert: AlertEvent): Promise<void> {
    // Fire-and-forget: observers run in parallel, never block the evaluator
    for (const observer of this.observers) {
      observer.notify(alert).catch((err) => {
        this.logger.error(
          { err, alertType: alert.type, tenantId: alert.tenantId },
          'Observer failed to process alert',
        )
      })
    }
  }
}

/**
 * Logs alerts to the console via pino at WARN level.
 * MVP observer — proves the pipeline works end-to-end.
 */
export class ConsoleObserver implements AlertObserver {
  private readonly logger: pino.Logger

  constructor(logger: pino.Logger) {
    this.logger = logger
  }

  async notify(alert: AlertEvent): Promise<void> {
    if (isResolvedAlert(alert)) {
      this.logger.info(
        { alertType: 'resolved', tenantId: alert.tenantId, ruleId: alert.ruleId, service: alert.service },
        `RESOLVED: "${alert.ruleName}" in ${alert.service}`,
      )
      return
    }
    if (isTemplateAlert(alert)) {
      this.logger.warn(
        {
          alertType: alert.type,
          tenantId: alert.tenantId,
          service: alert.service,
          templateId: alert.templateId,
          score: alert.score,
          currentCount: alert.currentCount,
          baselineCount: alert.baselineCount,
        },
        `ALERT: "${alert.templateText}" is at ${alert.score.toFixed(1)}x threshold in ${alert.service}`,
      )
    } else {
      this.logger.warn(
        {
          alertType: alert.type,
          tenantId: alert.tenantId,
          service: alert.service,
          environment: alert.environment,
          ruleId: alert.ruleId,
          metric: alert.metric,
          metricValue: alert.metricValue,
          thresholdValue: alert.thresholdValue,
        },
        `ALERT: "${alert.ruleName}" — ${alert.metric} ${alert.operator} ${alert.thresholdValue} (actual: ${alert.metricValue})`,
      )
    }
  }
}
