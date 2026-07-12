import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { rateLimited } from '../errors.js'
import { getTenantId } from './auth.js'

export interface ConcurrentQueryGuardOptions {
  maxConcurrent: number
}

/**
 * Middleware that limits concurrent in-flight requests per tenant.
 * Prevents one tenant's LLM from starving ClickHouse for others.
 * Returns 429 if the tenant has too many concurrent requests.
 * Releases the slot when the response finishes or the connection closes.
 */
export function createConcurrentQueryGuard(options: ConcurrentQueryGuardOptions): RequestHandler {
  const activeCounts = new Map<string, number>()

  return (_req: Request, res: Response, next: NextFunction): void => {
    const tenantId = getTenantId(res)
    const current = activeCounts.get(tenantId) ?? 0

    if (current >= options.maxConcurrent) {
      next(
        rateLimited(
          `Too many concurrent queries (limit: ${options.maxConcurrent}). Try again shortly.`,
        ),
      )
      return
    }

    activeCounts.set(tenantId, current + 1)

    let released = false
    function release() {
      if (released) return
      released = true
      const count = activeCounts.get(tenantId) ?? 1
      if (count <= 1) {
        activeCounts.delete(tenantId)
      } else {
        activeCounts.set(tenantId, count - 1)
      }
    }

    res.on('finish', release)
    res.on('close', release)

    next()
  }
}
