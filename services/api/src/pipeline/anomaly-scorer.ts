import type pino from 'pino'
import { BASELINE_ROW_WARN_THRESHOLD, queryAnomalyBaselines } from '../db/anomaly-queries.js'
import type { DbClient } from '../db/client.js'

const FIVE_MINUTES_MS = 5 * 60 * 1000
const TEN_MINUTES_MS = 10 * 60 * 1000
const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const DEFAULT_COLD_START_MS = 10 * 60 * 1000
const DEFAULT_WARMUP_MS = 60 * 60 * 1000
const DEFAULT_BASELINE_REFRESH_MS = 60 * 1000
const DEFAULT_WARMUP_THRESHOLD = 10
const DEFAULT_STEADY_THRESHOLD = 3
// Cold-start scoring policy: a never-before-seen template fires an anomaly
// only if it occurs >20 times in the current 5-minute interval. Below that,
// it's treated as routine first-occurrence noise rather than a spike.
const DEFAULT_NEW_TEMPLATE_THRESHOLD = 20

// Null byte delimiter — cannot appear in user-supplied strings (tenantId, service, templateId).
// Prevents key collision when identifiers contain colons or other common delimiters.
const D = '\0'

/**
 * Test-only templateId. Lets tests initialise the warmup tracker for a
 * tenant+service at a chosen historical clock without polluting the live
 * counter map. Real ingest never produces this id (Drain3 emits UUIDv7s).
 *
 * The string is exported so tests can import the canonical constant rather
 * than duplicating the literal — keeps the contract in one place.
 */
export const WARMUP_SENTINEL_TEMPLATE_ID = '__warmup_sentinel__'

export interface WatchedScore {
  templateId: string
  service: string
  score: number
  currentCount: number
  baselineCount: number
}

export interface AnomalyScorerOptions {
  db: DbClient
  logger: pino.Logger
  baselineRefreshMs?: number
  coldStartMs?: number
  warmupMs?: number
  warmupThreshold?: number
  steadyThreshold?: number
  newTemplateThreshold?: number
  now?: () => number
}

/**
 * In-memory anomaly scorer for the ingest pipeline.
 *
 * Compares current 5-minute interval event counts against a 7-day baseline
 * matched by hour-of-day (UTC). See ADR-014. Uses graduated thresholds: 10x
 * during warmup (first 60 minutes), 3x in steady state.
 *
 * All scoring is pure arithmetic against cached maps — no ClickHouse queries
 * in the hot path. Baselines are refreshed asynchronously every 60 seconds.
 *
 * Known limitation: after server restart, scoring returns 0 for ~60 seconds
 * until the first baseline refresh completes. This is accepted for MVP.
 */
export class AnomalyScorer {
  private readonly db: DbClient
  private readonly logger: pino.Logger
  private readonly coldStartMs: number
  private readonly warmupMs: number
  private readonly warmupThreshold: number
  private readonly steadyThreshold: number
  private readonly newTemplateThreshold: number
  private readonly baselineRefreshMs: number
  private readonly now: () => number

  /** Current interval event counts: `{tenant}\0{service}\0{templateId}\0{intervalStart}` → count */
  private readonly intervalCounters = new Map<string, number>()
  /**
   * Per-hour baseline: `{tenant}\0{service}\0{templateId}\0{hourOfDay}` → avgCount.
   * Looked up at scoring time using the current UTC hour. Missing entries
   * deliberately fall through to the new-template absolute-threshold path —
   * NOT to a cross-hour mean. A cross-hour mean would re-introduce diurnal
   * blindness for peaky templates (e.g. a busy-day / quiet-night template
   * whose cross-hour mean is dominated by daytime traffic would mask quiet-
   * hour anomalies). See ADR-014.
   */
  private readonly baselineByHour = new Map<string, number>()
  /** First-seen time per tenant+service: `{tenant}\0{service}` → { firstSeen, lastSeen } */
  private readonly warmupTracker = new Map<string, { firstSeen: number; lastSeen: number }>()

  private intervalHandle: ReturnType<typeof setTimeout> | null = null
  private refreshRunning = false
  private stopped = false

  constructor(options: AnomalyScorerOptions) {
    this.db = options.db
    this.logger = options.logger
    this.coldStartMs = options.coldStartMs ?? DEFAULT_COLD_START_MS
    this.warmupMs = options.warmupMs ?? DEFAULT_WARMUP_MS
    this.warmupThreshold = options.warmupThreshold ?? DEFAULT_WARMUP_THRESHOLD
    this.steadyThreshold = options.steadyThreshold ?? DEFAULT_STEADY_THRESHOLD
    this.newTemplateThreshold = options.newTemplateThreshold ?? DEFAULT_NEW_TEMPLATE_THRESHOLD
    this.baselineRefreshMs = options.baselineRefreshMs ?? DEFAULT_BASELINE_REFRESH_MS
    this.now = options.now ?? Date.now
  }

  /** Start periodic baseline refresh + counter pruning. */
  start(): void {
    if (this.intervalHandle || this.stopped) return // already started or stopped
    const tick = async () => {
      await this.refreshBaselines()
      this.pruneOldCounters()
      if (this.stopped) return
      this.intervalHandle = setTimeout(tick, this.baselineRefreshMs)
      this.intervalHandle.unref()
    }
    this.intervalHandle = setTimeout(tick, this.baselineRefreshMs)
    this.intervalHandle.unref()
  }

  /** Stop periodic refresh. */
  stop(): void {
    this.stopped = true
    if (this.intervalHandle) {
      clearTimeout(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  // Hot path: pure arithmetic, no I/O.
  /**
   * Record an event and return its anomaly score.
   * Called once per event during ingest Phase 3 (enrich).
   *
   * @returns 0 if normal, >1.0 if anomalous (higher = more anomalous)
   */
  recordAndScore(tenantId: string, service: string, templateId: string): number {
    // Skip unclustered events
    if (templateId === '0') return 0

    const currentTime = this.now()

    // Track warmup
    const warmupKey = `${tenantId}${D}${service}`
    const entry = this.warmupTracker.get(warmupKey)
    if (entry === undefined) {
      this.warmupTracker.set(warmupKey, { firstSeen: currentTime, lastSeen: currentTime })
      return 0 // First event for this tenant+service — cold start
    }
    entry.lastSeen = currentTime

    // Test sentinel: lets tests rewind the clock and call recordAndScore() to
    // initialise the warmup tracker without leaking counter state. Once the
    // tracker entry exists (handled above), subsequent sentinel calls are no-ops
    // — keeps the test helper idempotent.
    if (templateId === WARMUP_SENTINEL_TEMPLATE_ID) return 0

    // Cold start check
    const age = currentTime - entry.firstSeen
    if (age < this.coldStartMs) return 0

    // Increment interval counter
    const intervalStart = this.currentIntervalStart()
    const counterKey = `${tenantId}${D}${service}${D}${templateId}${D}${intervalStart}`
    const count = (this.intervalCounters.get(counterKey) ?? 0) + 1
    this.intervalCounters.set(counterKey, count)

    return this.computeScore(tenantId, service, templateId, count, age)
  }

  /**
   * Read-only scoring for watched templates. Does NOT increment counters.
   * Returns entries only for templates with active counters in the current interval.
   * Used by AlertEvaluator to check anomaly status of watched templates.
   */
  getWatchedScores(tenantId: string, templateIds: Set<string>): WatchedScore[] {
    if (templateIds.size === 0) return []

    const results: WatchedScore[] = []
    const currentInterval = this.currentIntervalStart()
    const prefix = `${tenantId}${D}`

    for (const [key, count] of this.intervalCounters) {
      if (!key.startsWith(prefix)) continue
      // Parse: {tenant}\0{service}\0{templateId}\0{intervalStart}
      const parts = key.split(D)
      const intervalStart = Number(parts[parts.length - 1])
      if (intervalStart !== currentInterval) continue
      const templateId = parts[parts.length - 2]
      const service = parts[parts.length - 3]
      if (!templateId || !service || !templateIds.has(templateId)) continue

      // Look up warmup age for this tenant+service
      const warmupEntry = this.warmupTracker.get(`${tenantId}${D}${service}`)
      if (!warmupEntry) continue
      const age = this.now() - warmupEntry.firstSeen
      if (age < this.coldStartMs) continue

      const score = this.computeScore(tenantId, service, templateId, count, age)
      if (score > 0) {
        results.push({
          templateId,
          service,
          score,
          currentCount: count,
          baselineCount: this.lookupBaseline(tenantId, service, templateId) ?? 0,
        })
      }
    }
    return results
  }

  /**
   * Pure scoring arithmetic — no side effects, no counter mutation.
   * Shared by recordAndScore (hot path) and getWatchedScores (evaluator).
   */
  private computeScore(
    tenantId: string,
    service: string,
    templateId: string,
    count: number,
    age: number,
  ): number {
    const baseline = this.lookupBaseline(tenantId, service, templateId)

    // No baseline or baseline=0 → use absolute threshold for new templates
    if (baseline === undefined || baseline <= 0) {
      if (count > this.newTemplateThreshold) {
        return count / this.newTemplateThreshold
      }
      return 0
    }

    // Graduated threshold
    const threshold = age < this.warmupMs ? this.warmupThreshold : this.steadyThreshold

    // Floor baseline at 1.0 to prevent false positives on rare templates
    const effectiveBaseline = Math.max(baseline, 1.0)
    const score = count / effectiveBaseline / threshold

    return score >= 1.0 ? score : 0
  }

  /**
   * Resolve the baseline for the current UTC hour. Returns `undefined` if no
   * hour-specific entry exists, which routes scoring to the new-template
   * absolute-threshold path. See ADR-014 for why we deliberately do NOT fall
   * back to a cross-hour mean.
   */
  private lookupBaseline(
    tenantId: string,
    service: string,
    templateId: string,
  ): number | undefined {
    const hourOfDay = new Date(this.now()).getUTCHours()
    const hourKey = `${tenantId}${D}${service}${D}${templateId}${D}${hourOfDay}`
    return this.baselineByHour.get(hourKey)
  }

  private currentIntervalStart(): number {
    const now = this.now()
    return now - (now % FIVE_MINUTES_MS)
  }

  // Baseline refresh runs in the background — async I/O.
  /** Refresh baselines for all active tenants. Catches all errors. */
  async refreshBaselines(): Promise<void> {
    if (this.refreshRunning) return
    this.refreshRunning = true

    try {
      // Derive active tenants from warmup tracker
      const tenants = new Set<string>()
      for (const key of this.warmupTracker.keys()) {
        const tenantId = key.split(D)[0]
        if (tenantId) tenants.add(tenantId)
      }

      for (const tenantId of tenants) {
        const startMs = this.now()
        try {
          const rows = await queryAnomalyBaselines(this.db, tenantId)
          // Clear-and-replace: remove stale entries for this tenant, then add fresh ones
          const prefix = `${tenantId}${D}`
          for (const key of this.baselineByHour.keys()) {
            if (key.startsWith(prefix)) this.baselineByHour.delete(key)
          }
          for (const row of rows) {
            const hourKey = `${tenantId}${D}${row.service}${D}${row.template_id}${D}${Number(row.hour_of_day)}`
            this.baselineByHour.set(hourKey, Number(row.avg_count_per_interval))
          }
          if (rows.length >= BASELINE_ROW_WARN_THRESHOLD) {
            this.logger.warn(
              { tenantId, rows: rows.length, threshold: BASELINE_ROW_WARN_THRESHOLD },
              'Anomaly baseline row count is unusually high — investigate template cardinality',
            )
          }
          this.logger.debug(
            { tenantId, rows: rows.length, durationMs: this.now() - startMs },
            'Baseline refresh completed for tenant',
          )
        } catch (err) {
          this.logger.warn({ err, tenantId }, 'Baseline refresh failed for tenant')
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Baseline refresh failed')
    } finally {
      this.refreshRunning = false
    }
  }

  /** Remove stale interval counters and warmup entries for inactive tenants. */
  private pruneOldCounters(): void {
    const currentTime = this.now()
    const counterCutoff = currentTime - TEN_MINUTES_MS
    for (const key of this.intervalCounters.keys()) {
      const parts = key.split(D)
      const intervalStart = Number(parts[parts.length - 1])
      if (intervalStart < counterCutoff) {
        this.intervalCounters.delete(key)
      }
    }

    // Prune warmup entries for tenant+service pairs inactive for 2+ hours
    const warmupCutoff = currentTime - TWO_HOURS_MS
    for (const [key, entry] of this.warmupTracker) {
      if (entry.lastSeen < warmupCutoff) {
        this.warmupTracker.delete(key)
      }
    }
  }
}
