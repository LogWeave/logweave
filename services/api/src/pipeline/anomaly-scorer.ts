import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import { queryAnomalyBaselines } from '../db/anomaly-queries.js'

const FIVE_MINUTES_MS = 5 * 60 * 1000
const TEN_MINUTES_MS = 10 * 60 * 1000
const DEFAULT_COLD_START_MS = 10 * 60 * 1000
const DEFAULT_WARMUP_MS = 60 * 60 * 1000
const DEFAULT_BASELINE_REFRESH_MS = 60 * 1000
const DEFAULT_WARMUP_THRESHOLD = 10
const DEFAULT_STEADY_THRESHOLD = 3
const DEFAULT_NEW_TEMPLATE_THRESHOLD = 20

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
 * Compares current 5-minute interval event counts against a rolling 1-hour
 * baseline from template_stats. Uses graduated thresholds: 10x during warmup
 * (first 60 minutes), 3x in steady state.
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

  /** Current interval event counts: `{tenant}:{service}:{templateId}:{intervalStart}` → count */
  private readonly intervalCounters = new Map<string, number>()
  /** Baseline avg count per 5-min interval: `{tenant}:{service}:{templateId}` → avgCount */
  private readonly baselineCache = new Map<string, number>()
  /** First-seen time per tenant+service: `{tenant}:{service}` → epoch ms */
  private readonly warmupTracker = new Map<string, number>()

  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private refreshRunning = false

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

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Start periodic baseline refresh + counter pruning. */
  start(): void {
    this.intervalHandle = setInterval(async () => {
      await this.refreshBaselines()
      this.pruneOldCounters()
    }, this.baselineRefreshMs)
    this.intervalHandle.unref()
  }

  /** Stop periodic refresh. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  // ---------------------------------------------------------------------------
  // Scoring (hot path — pure arithmetic, no I/O)
  // ---------------------------------------------------------------------------

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
    const warmupKey = `${tenantId}:${service}`
    const firstSeen = this.warmupTracker.get(warmupKey)
    if (firstSeen === undefined) {
      this.warmupTracker.set(warmupKey, currentTime)
      return 0 // First event for this tenant+service — cold start
    }

    // Cold start check
    const age = currentTime - firstSeen
    if (age < this.coldStartMs) return 0

    // Increment interval counter
    const intervalStart = currentTime - (currentTime % FIVE_MINUTES_MS)
    const counterKey = `${tenantId}:${service}:${templateId}:${intervalStart}`
    const count = (this.intervalCounters.get(counterKey) ?? 0) + 1
    this.intervalCounters.set(counterKey, count)

    // Get baseline
    const baselineKey = `${tenantId}:${service}:${templateId}`
    const baseline = this.baselineCache.get(baselineKey)

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

  // ---------------------------------------------------------------------------
  // Baseline refresh (background — async I/O)
  // ---------------------------------------------------------------------------

  /** Refresh baselines for all active tenants. Catches all errors. */
  async refreshBaselines(): Promise<void> {
    if (this.refreshRunning) return
    this.refreshRunning = true

    try {
      // Derive active tenants from warmup tracker
      const tenants = new Set<string>()
      for (const key of this.warmupTracker.keys()) {
        const tenantId = key.split(':')[0]
        if (tenantId) tenants.add(tenantId)
      }

      for (const tenantId of tenants) {
        try {
          const rows = await queryAnomalyBaselines(this.db, tenantId)
          for (const row of rows) {
            const key = `${tenantId}:${row.service}:${row.template_id}`
            this.baselineCache.set(key, Number(row.avg_count_per_interval))
          }
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

  // ---------------------------------------------------------------------------
  // Counter pruning
  // ---------------------------------------------------------------------------

  /** Remove interval counters older than 10 minutes. */
  private pruneOldCounters(): void {
    const cutoff = this.now() - TEN_MINUTES_MS
    for (const key of this.intervalCounters.keys()) {
      const parts = key.split(':')
      const intervalStart = Number(parts[parts.length - 1])
      if (intervalStart < cutoff) {
        this.intervalCounters.delete(key)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Test helpers — allow tests to pre-populate state without exposing internals
  // ---------------------------------------------------------------------------

  /** Set baseline for a specific template (for testing). */
  setBaseline(tenantId: string, service: string, templateId: string, avgCount: number): void {
    this.baselineCache.set(`${tenantId}:${service}:${templateId}`, avgCount)
  }

  /** Set warmup first-seen time for a tenant+service (for testing). */
  setWarmup(tenantId: string, service: string, firstSeenMs: number): void {
    this.warmupTracker.set(`${tenantId}:${service}`, firstSeenMs)
  }
}
