/**
 * Pure helpers for the "What Changed?" panel. The spike/new/resolved detection
 * itself is computed server-side; what lives client-side is the spike severity
 * threshold and the "baseline not ready yet" ETA copy — both extracted here so
 * they can be unit-tested without the panel.
 */

export type SpikeSeverity = 'danger' | 'warning' | 'normal'

/**
 * Severity bucket for a spike ratio, driving its colour. A 50x+ jump is
 * critical, 10x–50x is a warning, anything lower is unremarkable.
 */
export function spikeRatioSeverity(ratio: number): SpikeSeverity {
  if (ratio >= 50) return 'danger'
  if (ratio >= 10) return 'warning'
  return 'normal'
}

/**
 * How long until change detection has enough history. Detection compares the
 * current N-hour window against the prior N-hour window, so it needs 2N hours
 * of ingestion since the tenant's first event. Returns a human ETA string, or
 * null when the inputs are unknown or the window is already ready.
 */
export function baselineEtaMessage(
  windowHours: number | undefined,
  tenantFirstSeenAt: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!windowHours || !tenantFirstSeenAt) return null

  const requiredMs = windowHours * 2 * 60 * 60 * 1000
  const elapsedMs = nowMs - new Date(tenantFirstSeenAt).getTime()
  const remainingMs = requiredMs - elapsedMs
  if (remainingMs <= 0) return null

  const minutes = Math.ceil(remainingMs / 60_000)
  if (minutes < 60) return `Comparison available in ~${minutes} min.`
  const hours = Math.ceil(minutes / 60)
  return `Comparison available in ~${hours}h.`
}
