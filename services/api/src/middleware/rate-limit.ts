import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { rateLimited } from '../errors.js'
import { getKeyId, getTenantId } from './auth.js'

export interface RateLimitOptions {
  /** Requests per minute per API key (default routes) */
  keyRpm: number
  /** Requests per minute per tenant (ceiling across all keys) */
  tenantRpm: number
  /** Requests per minute per API key for ingest routes */
  ingestKeyRpm: number
  /** Requests per minute per API key for raw-logs routes (S3 I/O is expensive) */
  rawLogsKeyRpm?: number
}

interface WindowEntry {
  count: number
  resetAt: number
}

const WINDOW_MS = 60_000
const CLEANUP_INTERVAL_MS = 60_000

function getOrResetWindow(windows: Map<string, WindowEntry>, key: string, now: number): WindowEntry {
  let entry = windows.get(key)
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS }
    windows.set(key, entry)
  }
  return entry
}

/**
 * Creates rate limiting middleware with per-key and per-tenant limits.
 * Ingest routes (`/ingest/` prefix) use a separate higher per-key limit.
 * Sets X-RateLimit-* headers on every response.
 * Returns 429 with Retry-After when limits are exceeded.
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  const keyWindows = new Map<string, WindowEntry>()
  const tenantWindows = new Map<string, WindowEntry>()

  // Periodic cleanup of expired entries to prevent memory growth
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of keyWindows) {
      if (now >= entry.resetAt) keyWindows.delete(key)
    }
    for (const [key, entry] of tenantWindows) {
      if (now >= entry.resetAt) tenantWindows.delete(key)
    }
  }, CLEANUP_INTERVAL_MS)
  cleanup.unref()

  return (req: Request, res: Response, next: NextFunction): void => {
    const keyId = getKeyId(res)
    const tenantId = getTenantId(res)
    const now = Date.now()

    // Determine per-key limit based on route
    const isIngest = req.path.startsWith('/ingest/')
    const isRawLogs = req.path.includes('/raw-logs')
    const keyRpm = isIngest
      ? options.ingestKeyRpm
      : isRawLogs
        ? (options.rawLogsKeyRpm ?? 10)
        : options.keyRpm
    const bucketLabel = isIngest ? 'ingest' : isRawLogs ? 'raw-logs' : 'default'
    const bucketKey = `${keyId}:${bucketLabel}`

    const keyWindow = getOrResetWindow(keyWindows, bucketKey, now)
    const tenantWindow = getOrResetWindow(tenantWindows, tenantId, now)

    // Check limits — is there room for this request?
    const keyOver = keyWindow.count >= keyRpm
    const tenantOver = tenantWindow.count >= options.tenantRpm
    const effectiveLimit = Math.min(keyRpm, options.tenantRpm)

    // Pick the stricter reset time
    const resetEpochSeconds = Math.ceil(
      Math.min(keyWindow.resetAt, tenantWindow.resetAt) / 1000,
    )

    if (keyOver || tenantOver) {
      const retryAfterSeconds = Math.max(1, Math.ceil((Math.min(keyWindow.resetAt, tenantWindow.resetAt) - now) / 1000))
      res.setHeader('X-RateLimit-Limit', effectiveLimit)
      res.setHeader('X-RateLimit-Remaining', 0)
      res.setHeader('X-RateLimit-Reset', resetEpochSeconds)
      res.setHeader('Retry-After', retryAfterSeconds)

      const source = keyOver ? 'per-key' : 'per-tenant'
      next(rateLimited(`Rate limit exceeded (${source}). Retry after ${retryAfterSeconds} seconds.`))
      return
    }

    // Increment counters BEFORE setting remaining (so remaining reflects post-request state)
    keyWindow.count++
    tenantWindow.count++

    const keyRemaining = Math.max(0, keyRpm - keyWindow.count)
    const tenantRemaining = Math.max(0, options.tenantRpm - tenantWindow.count)

    res.setHeader('X-RateLimit-Limit', effectiveLimit)
    res.setHeader('X-RateLimit-Remaining', Math.min(keyRemaining, tenantRemaining))
    res.setHeader('X-RateLimit-Reset', resetEpochSeconds)

    next()
  }
}
