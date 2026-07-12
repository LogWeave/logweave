/**
 * Pure URL <-> dashboard-store mapping, extracted from useUrlSync so the
 * deep-link contract (which params are valid, which round-trip, which default
 * is omitted) can be unit-tested without a router.
 */
import type { TimeRange } from '../stores/dashboard-store'

export const VALID_TIME_RANGES: readonly TimeRange[] = ['1h', '6h', '24h', '7d']

/** The default range is left out of the URL to keep shared links clean. */
export const DEFAULT_TIME_RANGE: TimeRange = '24h'

/** Dashboard filter state that participates in the URL. */
export interface UrlSyncState {
  timeRange: TimeRange
  serviceFilter: string | null
  levelFilters: string[]
  selectedTemplateId: string | null
}

/** Parsed, validated view of the incoming URL. Absent params are undefined. */
export interface ParsedUrlParams {
  range: TimeRange | undefined
  service: string | undefined
  levels: string[] | undefined
  template: string | undefined
}

function isTimeRange(value: string): value is TimeRange {
  return (VALID_TIME_RANGES as readonly string[]).includes(value)
}

/**
 * Read the deep-link params off the URL. An unknown `range` is dropped (so a
 * hand-edited or stale link can't put the store in an invalid state); `level`
 * is a comma list with empty segments discarded.
 */
export function parseUrlParams(params: URLSearchParams): ParsedUrlParams {
  const range = params.get('range')
  const level = params.get('level')
  return {
    range: range && isTimeRange(range) ? range : undefined,
    service: params.get('service') || undefined,
    levels: level ? level.split(',').filter(Boolean) : undefined,
    template: params.get('template') || undefined,
  }
}

/**
 * Serialize store state to URL params. The default range and any empty/absent
 * filter are omitted so an untouched dashboard has a bare URL.
 */
export function buildUrlParams(state: UrlSyncState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.timeRange !== DEFAULT_TIME_RANGE) params.set('range', state.timeRange)
  if (state.serviceFilter) params.set('service', state.serviceFilter)
  if (state.levelFilters.length > 0) params.set('level', state.levelFilters.join(','))
  if (state.selectedTemplateId) params.set('template', state.selectedTemplateId)
  return params
}
