import type pino from 'pino'

export interface AlertEvent {
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
          { err, alertType: alert.type, templateId: alert.templateId },
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
  }
}
