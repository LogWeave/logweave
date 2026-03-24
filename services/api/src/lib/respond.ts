import type { Response } from 'express'
import { DATA_RETENTION, formatTimeRange } from '../format.js'
import { HttpStatus } from '../http-status.js'

interface ApiResponse<T> {
  data: T
  meta: Record<string, unknown>
}

/**
 * Standard API response helper with time range and retention metadata.
 * Shared across dashboard, correlation, and raw-logs routes.
 */
export function respond<T>(
  res: Response,
  data: T,
  meta: Record<string, unknown> & { hours: number },
): void {
  const body: ApiResponse<T> = {
    data,
    meta: {
      ...meta,
      fetchedAt: new Date().toISOString(),
      timeRange: formatTimeRange(meta.hours),
      dataRetention: DATA_RETENTION,
    },
  }
  res.status(HttpStatus.OK).json(body)
}
