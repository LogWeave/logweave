import type { Response } from 'express'
import { DATA_RETENTION, formatTimeRange } from '../format.js'
import { HttpStatus } from '../http-status.js'

interface ApiResponse<T> {
  data: T
  meta: Record<string, unknown>
}

/**
 * Standard API response helper with retention metadata.
 * Emits `timeRange` only when `hours` is supplied — non-time-windowed routes
 * (settings, deploys, watches, rules, connectors, tail) should omit it.
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
      ...(meta.hours !== undefined ? { timeRange: formatTimeRange(meta.hours) } : {}),
      dataRetention: DATA_RETENTION,
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
