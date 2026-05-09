import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { rateLimited } from '../errors.js'

interface WindowEntry {
  count: number
  resetAt: number
}

const WINDOW_MS = 60_000
const CLEANUP_INTERVAL_MS = 60_000

function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0]
    if (first) return first.trim()
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}

/**
 * Per-IP rate limiter for unauthenticated endpoints (login, etc.).
 * Independent of the per-key/per-tenant limiter that applies to authenticated traffic.
 */
export function createIpRateLimiter(rpm: number): RequestHandler {
  const windows = new Map<string, WindowEntry>()

  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [k, entry] of windows) {
      if (now >= entry.resetAt) windows.delete(k)
    }
  }, CLEANUP_INTERVAL_MS)
  cleanup.unref()

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = clientIp(req)
    const now = Date.now()
    let entry = windows.get(ip)
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS }
      windows.set(ip, entry)
    }

    if (entry.count >= rpm) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      res.setHeader('Retry-After', retryAfter)
      next(rateLimited(`Too many requests from this IP. Retry after ${retryAfter} seconds.`))
      return
    }

    entry.count++
    next()
  }
}
