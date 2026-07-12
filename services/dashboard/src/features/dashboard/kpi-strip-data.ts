/**
 * Pure helpers for the KPI strip, extracted so the trend math and the spike
 * count can be tested without rendering the cards.
 */

/**
 * Period-over-period change as a percentage. Returns undefined when there is no
 * comparable baseline — an absent previous value, or a previous of 0 (which
 * would make every change an infinite jump). The KPI card renders "no trend"
 * for undefined rather than a misleading arrow.
 */
export function trendPercent(current: number, previous?: number): number | undefined {
  if (previous === undefined || previous === 0) return undefined
  return ((current - previous) / previous) * 100
}

/** Anomaly score above which a template counts as an active spike. */
export const SPIKE_ANOMALY_THRESHOLD = 1.0

/** Number of templates currently spiking (anomaly score over the threshold). */
export function countSpikes(templates: { maxAnomalyScore: number }[]): number {
  return templates.filter((t) => t.maxAnomalyScore > SPIKE_ANOMALY_THRESHOLD).length
}
