import type pino from 'pino'
import type { AnomalyScorer } from '../pipeline/anomaly-scorer.js'
import type { AlertDispatcher } from './alert-observer.js'
import type { TenantSettingsStore } from './tenant-settings.js'

const DEFAULT_EVALUATION_INTERVAL_MS = 60_000
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000
const D = '\0'

export interface SilenceEvaluatorOptions {
  scorer: AnomalyScorer
  dispatcher: AlertDispatcher
  logger: pino.Logger
  settingsStore?: TenantSettingsStore
  evaluationIntervalMs?: number
  cooldownMs?: number
  now?: () => number
}

/**
 * Background loop that evaluates service-level silence/drop detection —
 * automatic for every tenant, no watch or rule configuration required.
 * Runs every 60 seconds (configurable), pulling from AnomalyScorer's
 * in-memory baseline/counter maps (no ClickHouse query). Fires
 * 'service_silent' when a service's actual count drops far below its
 * expected baseline, and 'service_silence_resolved' once it recovers.
 *
 * Shares the AlertDispatcher, cooldown, and firing-state pattern with
 * ThresholdEvaluator and AlertEvaluator.
 */
export class SilenceEvaluator {
  private readonly scorer: AnomalyScorer
  private readonly dispatcher: AlertDispatcher
  private readonly logger: pino.Logger
  private readonly settingsStore?: TenantSettingsStore
  private readonly evaluationIntervalMs: number
  private readonly cooldownMs: number
  private readonly now: () => number

  /** Cooldown tracker: `{tenantId}\0{service}` -> last alerted epoch ms */
  private readonly cooldowns = new Map<string, number>()
  /** Services currently in a firing (silent) state — for resolve detection */
  private readonly firingServices = new Set<string>()
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(options: SilenceEvaluatorOptions) {
    this.scorer = options.scorer
    this.dispatcher = options.dispatcher
    this.logger = options.logger
    this.settingsStore = options.settingsStore
    this.evaluationIntervalMs = options.evaluationIntervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.now = options.now ?? Date.now
  }

  /** Start periodic evaluation. */
  start(): void {
    if (this.intervalHandle) return
    this.intervalHandle = setInterval(async () => {
      try {
        await this.evaluate()
      } catch (err) {
        this.logger.error({ err }, 'Silence evaluation failed')
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
   * Evaluate silence for all active tenants and fire alerts for newly-silent
   * services (and resolves for recovered ones). Returns the number of
   * 'service_silent' alerts dispatched (resolves are not counted).
   */
  async evaluate(): Promise<number> {
    let alertCount = 0
    const currentTime = this.now()
    const tenants = this.scorer.getActiveTenants()
    const activeTenantSet = new Set(tenants)

    for (const tenantId of tenants) {
      if (this.settingsStore?.isInMaintenance(tenantId)) continue

      let scores: ReturnType<AnomalyScorer['getServiceSilenceScores']>
      try {
        scores = this.scorer.getServiceSilenceScores(tenantId)
      } catch (err) {
        this.logger.error({ err, tenantId }, 'Failed to get service silence scores for tenant')
        continue
      }

      const trackedServices = this.scorer.getTrackedServices(tenantId)
      const tenantPrefix = `${tenantId}${D}`
      const silentNow = new Set(scores.map((s) => `${tenantId}${D}${s.service}`))

      // Resolve: services that were firing but are no longer in the silent set —
      // but only if the scorer still tracks them. A service the scorer has
      // forgotten (pruned after 2h of total inactivity — see
      // AnomalyScorer.pruneOldCounters) never recovered; it just dropped out
      // of tracking while still silent, and must not be reported as resolved.
      for (const key of [...this.firingServices]) {
        if (!key.startsWith(tenantPrefix)) continue
        if (silentNow.has(key)) continue
        this.firingServices.delete(key)
        const service = key.slice(tenantPrefix.length)
        if (!trackedServices.has(service)) continue
        await this.dispatcher.dispatch({
          type: 'service_silence_resolved',
          tenantId,
          service,
          resolvedAt: new Date(currentTime).toISOString(),
        })
      }

      for (const entry of scores) {
        const key = `${tenantId}${D}${entry.service}`
        this.firingServices.add(key)

        const lastAlerted = this.cooldowns.get(key)
        if (lastAlerted !== undefined && currentTime - lastAlerted < this.cooldownMs) continue

        await this.dispatcher.dispatch({
          type: 'service_silent',
          tenantId,
          service: entry.service,
          expectedCount: entry.expectedCount,
          actualCount: entry.actualCount,
          triggeredAt: new Date(currentTime).toISOString(),
        })

        this.cooldowns.set(key, currentTime)
        alertCount++
      }
    }

    // Drop firing entries for tenants the scorer no longer tracks at all
    // (every service under them pruned) — without claiming they recovered.
    for (const key of [...this.firingServices]) {
      const tenantId = key.slice(0, key.indexOf(D))
      if (!activeTenantSet.has(tenantId)) {
        this.firingServices.delete(key)
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
