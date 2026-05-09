/**
 * Simple in-memory metrics counters for operational visibility.
 * Global counters only — no per-tenant data (exposed on unauthenticated /readyz).
 * Resets on server restart. Full Prometheus can replace this later.
 */

const counters = new Map<string, number>()

export function increment(name: string, delta = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + delta)
}

export function get(name: string): number {
  return counters.get(name) ?? 0
}

export function snapshot(): Record<string, number> {
  const result: Record<string, number> = {}
  for (const [key, value] of counters) {
    result[key] = value
  }
  return result
}

// Counter names — use these constants to avoid typos
export const EVENTS_INGESTED = 'events_ingested'
export const EVENTS_DROPPED = 'events_dropped'
export const EVENTS_CLUSTERED = 'events_clustered'
export const EVENTS_UNCLUSTERED = 'events_unclustered'
export const NEW_TEMPLATES = 'new_templates'
export const RECOVERY_RECOVERED = 'recovery_recovered'
export const RECOVERY_FAILED = 'recovery_failed'
export const INSERT_LATENCY_MS_TOTAL = 'insert_latency_ms_total'
export const INSERT_COUNT = 'insert_count'
export const BATCH_SIZE_TOTAL = 'batch_size_total'
export const ANOMALY_SCORED = 'anomaly_scored'
export const TAG_INSERT_FAILED = 'tag_insert_failed'
