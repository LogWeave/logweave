import { queryAnomalyBaselines } from '../db/anomaly-queries.js'
import type { DbClient } from '../db/client.js'

/**
 * A single baseline cache entry produced by a strategy's baseline model.
 * The scorer plumbing caches these keyed by (tenant, service, template, hour)
 * and resolves the one matching the current UTC hour at scoring time.
 */
export interface BaselineEntry {
  service: string
  templateId: string
  /** UTC hour-of-day [0,23] this baseline applies to. */
  hourOfDay: number
  /** The "normal" value the scoring policy compares the current count against. */
  baseline: number
}

/** Inputs to a pure scoring decision. */
export interface ScoreInput {
  /** Event count in the current 5-minute interval. */
  count: number
  /** Resolved baseline for the current context, or undefined if none exists. */
  baseline: number | undefined
  /** True while the tenant+service is still inside its warmup window. */
  inWarmup: boolean
}

/**
 * The swappable anomaly algorithm.
 *
 * Separates the two parts that *define* an algorithm — how "normal" is computed
 * (`fetchBaselines`) and how a current observation is judged against it
 * (`score`) — from the {@link AnomalyScorer} plumbing (interval counters,
 * refresh loop, warmup tracking, pruning, alert wiring). Swapping to a
 * different algorithm (EWMA, robust/MAD z-score, Poisson, ...) means a new
 * implementation of this interface; the scorer and the alert path are
 * untouched. See ADR-014 and docs/specs/chunk-5-anomaly-correlation-math-design.md.
 */
export interface AnomalyStrategy {
  /** The baseline model: fetch the "what is normal" rows for a tenant. */
  fetchBaselines(db: DbClient, tenantId: string): Promise<BaselineEntry[]>
  /** Pure scoring policy: 0 = normal, >= 1.0 = anomalous (higher = more so). */
  score(input: ScoreInput): number
}

export interface RatioThresholdOptions {
  warmupThreshold: number
  steadyThreshold: number
  newTemplateThreshold: number
}

/**
 * Default strategy. Baseline model: 7-day, hour-of-day-matched per-interval
 * rate (see anomaly-queries.ts). Scoring policy: ratio of current count to the
 * baseline against a graduated threshold (warmup vs steady), with an absolute
 * fallback for templates that have no baseline yet.
 *
 * This is the behaviour ADR-014 records — the first concrete strategy behind
 * the seam.
 */
export class RatioThresholdStrategy implements AnomalyStrategy {
  constructor(private readonly opts: RatioThresholdOptions) {}

  async fetchBaselines(db: DbClient, tenantId: string): Promise<BaselineEntry[]> {
    const rows = await queryAnomalyBaselines(db, tenantId)
    return rows.map((r) => ({
      service: r.service,
      templateId: r.template_id,
      hourOfDay: Number(r.hour_of_day),
      baseline: Number(r.avg_count_per_interval),
    }))
  }

  score({ count, baseline, inWarmup }: ScoreInput): number {
    // No baseline (or baseline=0) → absolute threshold for new templates.
    if (baseline === undefined || baseline <= 0) {
      if (count > this.opts.newTemplateThreshold) {
        return count / this.opts.newTemplateThreshold
      }
      return 0
    }

    const threshold = inWarmup ? this.opts.warmupThreshold : this.opts.steadyThreshold
    // Floor baseline at 1.0 to prevent false positives on rare templates.
    const effectiveBaseline = Math.max(baseline, 1.0)
    const score = count / effectiveBaseline / threshold
    return score >= 1.0 ? score : 0
  }
}
