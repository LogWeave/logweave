import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import { forbidden, serviceUnavailable, unauthorized } from '../errors.js'

const HEADER = 'x-internal-secret'

/**
 * Guard for internal service-to-service endpoints (e.g. the archive notify
 * endpoint, #276) that are NOT tenant-authenticated — the tenant comes from the
 * request body, and the caller is trusted internal infrastructure (Vector) on
 * the private network, identified by the shared internal secret.
 *
 * Fails CLOSED: if no internal secret is configured, every request is rejected
 * (503) rather than left open. The comparison is constant-time.
 */
export function createInternalAuthMiddleware(secret: string | undefined) {
  const expected = secret ? Buffer.from(secret) : undefined

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!expected) {
      next(serviceUnavailable('Internal endpoint disabled — no internal secret configured'))
      return
    }
    const provided = req.header(HEADER)
    if (!provided) {
      next(unauthorized('Missing internal secret'))
      return
    }
    const got = Buffer.from(provided)
    if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
      next(forbidden('Invalid internal secret'))
      return
    }
    next()
  }
}
