import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import type { AlertDispatcher, ThresholdOperator } from './alert-observer.js'
import type { AlertRule, ThresholdConfig } from './rule-store.js'
import type { RuleStore } from './rule-store.js'
import type { TenantSettingsStore } from './tenant-settings.js'

const DEFAULT_EVALUATION_INTERVAL_MS = 60_000
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000

/** Hardcoded metric → SQL column map. Never interpolate user input. */
const METRIC_COLUMNS: Record<string, string> = {
  error_count: 'countMerge(error_count)',
  warn_count: 'countMerge(warn_count)',
  log_count: 'countMerge(log_count)',
}

export interface ThresholdEvaluatorOptions {
  ruleStore: RuleStore
  dispatcher: AlertDispatcher
  db: DbClient
  logger: pino.Logger
  settingsStore?: TenantSettingsStore
  evaluationIntervalMs?: number
  cooldownMs?: number
  now?: () => number
}

function evaluateThreshold(value: number, operator: ThresholdOperator, threshold: number): boolean {
  switch (operator) {
    case '>':
      return value > threshold
    case '>=':
      return value >= threshold
    case '<':
      return value < threshold
    case '<=':
      return value <= threshold
  }
}

/**
 * Background loop that evaluates threshold rules against service_stats_5m.
 * Runs every 60 seconds (configurable). Groups rules by (tenantId, metric, windowMinutes,
 * environment) for batched ClickHouse queries.
 *
 * Shares the AlertDispatcher and cooldown pattern with AlertEvaluator.
 */
export class ThresholdEvaluator {
  private readonly ruleStore: RuleStore
  private readonly dispatcher: AlertDispatcher
  private readonly db: DbClient
  private readonly logger: pino.Logger
  private readonly settingsStore?: TenantSettingsStore
  private readonly evaluationIntervalMs: number
  private readonly cooldownMs: number
  private readonly now: () => number

  /** Cooldown tracker: `{tenantId}:{ruleId}` → last alerted epoch ms */
  private readonly cooldowns = new Map<string, number>()
  /** Rules currently in firing state — for resolve detection */
  private readonly firingRules = new Set<string>()
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(options: ThresholdEvaluatorOptions) {
    this.ruleStore = options.ruleStore
    this.dispatcher = options.dispatcher
    this.db = options.db
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
        this.logger.error({ err }, 'Threshold evaluation failed')
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
   * Evaluate all enabled threshold rules and fire alerts for breaches.
   * Returns the number of alerts dispatched.
   */
  async evaluate(): Promise<number> {
    const rules = this.ruleStore.getEnabledByType('threshold')
    if (rules.length === 0) return 0

    // Group rules by (tenantId, metric, windowMinutes, environment) for batched queries
    const groups = new Map<string, AlertRule[]>()
    for (const rule of rules) {
      const config = rule.config as ThresholdConfig
      const env = config.environment ?? ''
      const key = `${rule.tenantId}\0${config.metric}\0${config.windowMinutes}\0${env}`
      const group = groups.get(key)
      if (group) group.push(rule)
      else groups.set(key, [rule])
    }

    let alertCount = 0
    const currentTime = this.now()

    for (const [groupKey, groupRules] of groups) {
      const parts = groupKey.split('\0')
      const tenantId = parts[0] ?? ''
      const metric = parts[1] ?? ''
      const windowMinutes = Number(parts[2])
      const environment = parts[3] ?? ''

      // Skip tenants in maintenance window
      if (this.settingsStore?.isInMaintenance(tenantId)) continue

      // Collect distinct services for this group
      const services = [...new Set(groupRules.map((r) => (r.config as ThresholdConfig).service))]

      let results: Map<string, number>
      try {
        results = await this.queryMetric(tenantId, metric, services, windowMinutes, environment)
      } catch (err) {
        this.logger.error({ err, tenantId, metric }, 'Threshold query failed')
        continue
      }

      for (const rule of groupRules) {
        const config = rule.config as ThresholdConfig
        const metricValue = results.get(config.service) ?? 0
        const firingKey = `${rule.tenantId}:${rule.ruleId}`

        if (!evaluateThreshold(metricValue, config.operator, config.value)) {
          // Rule not breaching — send resolve if it was previously firing
          if (this.firingRules.has(firingKey)) {
            this.firingRules.delete(firingKey)
            await this.dispatcher.dispatch({
              type: 'threshold_resolved',
              tenantId: rule.tenantId,
              service: config.service,
              environment: config.environment,
              ruleId: rule.ruleId,
              ruleName: rule.name,
              metric: config.metric,
              channels: rule.channels,
              resolvedAt: new Date(currentTime).toISOString(),
            })
          }
          continue
        }

        // Mark as firing
        this.firingRules.add(firingKey)

        // Check cooldown — per-rule if configured, else global default
        const cooldownKey = firingKey
        const lastAlerted = this.cooldowns.get(cooldownKey)
        const ruleCooldownMs = rule.cooldownMinutes
          ? rule.cooldownMinutes * 60_000
          : this.cooldownMs
        if (lastAlerted !== undefined && currentTime - lastAlerted < ruleCooldownMs) continue

        await this.dispatcher.dispatch({
          type: 'threshold_breach',
          tenantId: rule.tenantId,
          service: config.service,
          environment: config.environment,
          ruleId: rule.ruleId,
          ruleName: rule.name,
          metric: config.metric,
          metricValue,
          thresholdValue: config.value,
          operator: config.operator,
          windowMinutes: config.windowMinutes,
          triggeredAt: new Date(currentTime).toISOString(),
          channels: rule.channels,
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

  /**
   * Query service_stats_5m for a specific metric across services.
   * Returns a Map of service → aggregated metric value.
   * When environment is non-empty, filters to that specific environment.
   */
  private async queryMetric(
    tenantId: string,
    metric: string,
    services: string[],
    windowMinutes: number,
    environment: string,
  ): Promise<Map<string, number>> {
    const column = METRIC_COLUMNS[metric]
    if (!column) {
      this.logger.warn({ metric }, 'Unknown metric in threshold rule')
      return new Map()
    }

    const envFilter = environment ? '\n                  AND environment = {environment:String}' : ''

    // Query per-service to avoid Array param compatibility issues
    const results = new Map<string, number>()
    for (const service of services) {
      const queryParams: Record<string, unknown> = {
        tenant_id: tenantId,
        service,
        window: windowMinutes,
      }
      if (environment) {
        queryParams.environment = environment
      }
      const rows = await this.db.query<{ value: number }>({
        query: `SELECT ${column} AS value
                FROM logweave.service_stats_5m
                WHERE tenant_id = {tenant_id:String}
                  AND service = {service:String}
                  AND interval_start >= now64(3) - toIntervalMinute({window:UInt32})${envFilter}`,
        query_params: queryParams,
      })
      const first = rows[0]
      if (first) {
        results.set(service, Number(first.value))
      }
    }
    return results
  }
}
