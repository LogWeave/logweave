import type { Response } from 'express'
import { DATA_RETENTION, formatTimeRange } from '../format.js'
import { HttpStatus } from '../http-status.js'

interface ApiResponse<T> {
  data: T
  meta: Record<string, unknown>
}

/**
 * Standard API response helper. Always emits `fetchedAt`.
 * Emits both `timeRange` and `dataRetention` only when `hours` is supplied —
 * non-time-windowed routes (settings, watches, rules, connectors, tail token,
 * etc.) shouldn't advertise retention because their payload isn't bounded by
 * a time window.
 */
export function respond<T>(
  res: Response,
  data: T,
  meta: Record<string, unknown> & { hours?: number } = {},
): void {
  const body: ApiResponse<T> = {
    data,
    meta: {
      ...meta,
      fetchedAt: new Date().toISOString(),
      ...(meta.hours !== undefined
        ? { timeRange: formatTimeRange(meta.hours), dataRetention: DATA_RETENTION }
        : {}),
    },
  }
  res.status(HttpStatus.OK).json(body)
}

/**
 * Normalize timestamps (ClickHouse 'YYYY-MM-DD HH:MM:SS.SSS' or Date) to ISO 8601 with Z.
 */
export function isoTimestamp(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}
