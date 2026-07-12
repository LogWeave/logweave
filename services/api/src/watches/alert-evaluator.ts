import type pino from 'pino'
import type { AnomalyScorer } from '../pipeline/anomaly-scorer.js'
import type { AlertDispatcher } from './alert-observer.js'
import type { WatchStore } from './watch-store.js'

const DEFAULT_EVALUATION_INTERVAL_MS = 60_000
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000
const DEFAULT_SCORE_THRESHOLD = 1.0

export interface AlertEvaluatorOptions {
  watchStore: WatchStore
  anomalyScorer: AnomalyScorer
  dispatcher: AlertDispatcher
  logger: pino.Logger
  evaluationIntervalMs?: number
  cooldownMs?: number
  scoreThreshold?: number
  now?: () => number
}

/**
 * Background loop that evaluates watched templates against anomaly scores.
 * Runs every 60 seconds (configurable). Fires alerts to the dispatcher
 * when a watched template's score exceeds the threshold.
 *
 * Cooldown: max 1 alert per template per 30 minutes to prevent fatigue.
 */
export class AlertEvaluator {
  private readonly watchStore: WatchStore
  private readonly scorer: AnomalyScorer
  private readonly dispatcher: AlertDispatcher
  private readonly logger: pino.Logger
  private readonly evaluationIntervalMs: number
  private readonly cooldownMs: number
  private readonly scoreThreshold: number
  private readonly now: () => number

  /** Cooldown tracker: `{tenant}:{templateId}` → last alerted epoch ms */
  private readonly cooldowns = new Map<string, number>()
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(options: AlertEvaluatorOptions) {
    this.watchStore = options.watchStore
    this.scorer = options.anomalyScorer
    this.dispatcher = options.dispatcher
    this.logger = options.logger
    this.evaluationIntervalMs = options.evaluationIntervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.scoreThreshold = options.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD
    this.now = options.now ?? Date.now
  }

  /** Start periodic evaluation. Must be called AFTER anomalyScorer.start(). */
  start(): void {
    if (this.intervalHandle) return
    this.intervalHandle = setInterval(async () => {
      try {
        await this.evaluate()
      } catch (err) {
        this.logger.error({ err }, 'Alert evaluation failed')
      }
    }, this.evaluationIntervalMs)
    this.intervalHandle.unref()
  }

  /** Stop periodic evaluation. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  /**
   * Evaluate all watched templates and fire alerts for anomalous ones.
   * Returns the number of alerts dispatched.
   */
  async evaluate(): Promise<number> {
    const watchedByTenant = this.watchStore.getWatchedByTenant()
    let alertCount = 0
    const currentTime = this.now()

    for (const [tenantId, templateIds] of watchedByTenant) {
      let scores: ReturnType<typeof this.scorer.getWatchedScores>
      try {
        scores = this.scorer.getWatchedScores(tenantId, templateIds)
      } catch (err) {
        this.logger.error({ err, tenantId }, 'Failed to get watched scores for tenant')
        continue
      }

      for (const entry of scores) {
        if (entry.score < this.scoreThreshold) continue

        // Check cooldown
        const cooldownKey = `${tenantId}:${entry.templateId}`
        const lastAlerted = this.cooldowns.get(cooldownKey)
        if (lastAlerted !== undefined && currentTime - lastAlerted < this.cooldownMs) continue

        // Fire alert
        const templateText = this.watchStore.getTemplateText(tenantId, entry.templateId)
        await this.dispatcher.dispatch({
          type: entry.baselineCount > 0 ? 'spike' : 'new_burst',
          tenantId,
          service: entry.service,
          templateId: entry.templateId,
          templateText,
          currentCount: entry.currentCount,
          baselineCount: entry.baselineCount,
          score: entry.score,
          triggeredAt: new Date(currentTime).toISOString(),
        })

        this.cooldowns.set(cooldownKey, currentTime)
        alertCount++
      }
    }

    // Prune stale cooldown entries (older than 2x cooldown period)
    const cooldownCutoff = currentTime - this.cooldownMs * 2
    for (const [key, lastAlerted] of this.cooldowns) {
      if (lastAlerted < cooldownCutoff) this.cooldowns.delete(key)
    }

    return alertCount
  }
}
