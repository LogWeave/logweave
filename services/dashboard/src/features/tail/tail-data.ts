/**
 * Pure helpers for the Live Tail hook, extracted so the ring-buffer cap, the
 * filter→query serialization, and the reconnect key can be unit-tested without
 * standing up an EventSource. useTail wires these into its SSE lifecycle.
 */
import type { TailEvent, TailFilters } from './use-tail'

/**
 * Append an event to the buffer, keeping at most `maxEvents` by dropping the
 * oldest. Live Tail is a bounded window, not a full history — this cap is what
 * keeps the DOM and memory flat during a high-rate stream.
 */
export function appendCapped(
  events: TailEvent[],
  event: TailEvent,
  maxEvents: number,
): TailEvent[] {
  const next = [...events, event]
  return next.length > maxEvents ? next.slice(-maxEvents) : next
}

/**
 * Serialize the active filters (plus the SSE token) into the query string the
 * `/v1/tail` endpoint expects. Only set filters are included so the server sees
 * an unfiltered stream when nothing is selected.
 */
export function buildTailParams(filters: TailFilters, token: string): URLSearchParams {
  const params = new URLSearchParams()
  if (filters.service) params.set('service', filters.service)
  if (filters.level) params.set('level', filters.level)
  if (filters.templateId) params.set('templateId', filters.templateId)
  if (filters.minAnomaly !== undefined) params.set('minAnomaly', String(filters.minAnomaly))
  params.set('token', token)
  return params
}

/**
 * Stable key over the filters that require a fresh subscription when they change
 * mid-stream. All four filters are server-side params, so all four must be in the
 * key — otherwise the stream keeps using the old filter until a manual reconnect.
 */
export function tailFiltersKey(filters: TailFilters): string {
  return `${filters.service ?? ''}|${filters.level ?? ''}|${filters.templateId ?? ''}|${filters.minAnomaly ?? ''}`
}
