/**
 * Pure data transforms for the Log Volume chart. Extracted from the component
 * so the timestamp bucketing, overlay alignment, deploy-marker placement, and
 * axis labelling can be unit-tested without rendering ECharts.
 */
import type { VolumePoint } from '../../api/types'
import type { TimeRange } from '../../stores/dashboard-store'

export interface ServiceMap {
  /** Per-service series of { time, count }, in insertion order of the input. */
  serviceMap: Map<string, Array<{ time: string; count: number }>>
  /** The distinct interval-start timestamps seen across all points. */
  timestamps: Set<string>
}

/** Group volume points by service and collect the set of distinct timestamps. */
export function buildServiceMap(points: VolumePoint[]): ServiceMap {
  const serviceMap = new Map<string, Array<{ time: string; count: number }>>()
  const timestamps = new Set<string>()

  for (const point of points) {
    timestamps.add(point.intervalStart)
    if (!serviceMap.has(point.service)) {
      serviceMap.set(point.service, [])
    }
    serviceMap.get(point.service)?.push({ time: point.intervalStart, count: point.logCount })
  }

  return { serviceMap, timestamps }
}

/** Sum log counts across all services, keyed by interval-start timestamp. */
export function sumCountsByTimestamp(points: VolumePoint[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const point of points) {
    totals.set(point.intervalStart, (totals.get(point.intervalStart) ?? 0) + point.logCount)
  }
  return totals
}

/**
 * Index of the timestamp closest to a target epoch-ms, used to anchor a deploy
 * marker onto the category x-axis. Returns 0 for an empty axis. Ties resolve to
 * the earliest (lowest) index since the scan keeps the first strict minimum.
 */
export function findClosestTimestampIndex(sortedTimestamps: string[], targetMs: number): number {
  let closestIdx = 0
  let closestDiff = Number.POSITIVE_INFINITY
  for (let i = 0; i < sortedTimestamps.length; i++) {
    const ts = sortedTimestamps[i]
    if (!ts) continue
    const diff = Math.abs(new Date(ts).getTime() - targetMs)
    if (diff < closestDiff) {
      closestDiff = diff
      closestIdx = i
    }
  }
  return closestIdx
}

/**
 * Format an interval-start timestamp for the x-axis. The shape varies by range:
 * 7d prefixes the weekday, 24h prefixes DD/MM, shorter ranges show HH:MM only.
 * Unparseable input falls back to the raw string rather than "Invalid Date".
 */
export function formatVolumeAxisLabel(timestamp: string, timeRange: TimeRange): string {
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return String(timestamp)

  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const hhmm = `${hh}:${mm}`

  if (timeRange === '7d') {
    const day = d.toLocaleDateString('en-US', { weekday: 'short' })
    return `${day} ${hhmm}`
  }
  if (timeRange === '24h') {
    const dd = d.getDate().toString().padStart(2, '0')
    const mo = (d.getMonth() + 1).toString().padStart(2, '0')
    return `${dd}/${mo} ${hhmm}`
  }
  return hhmm
}

/**
 * Align a previous-period series onto the current period's x-axis positions.
 * The compare overlay reuses the current timestamps' index slots, padding with
 * 0 where the previous period had fewer buckets.
 */
export function alignToCurrentAxis(
  prevPoints: Array<{ time: string; count: number }>,
  currentLength: number,
): number[] {
  const sortedPrev = [...prevPoints].sort((a, b) =>
    a.time < b.time ? -1 : a.time > b.time ? 1 : 0,
  )
  return Array.from({ length: currentLength }, (_, i) => sortedPrev[i]?.count ?? 0)
}
