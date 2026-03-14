import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { unauthorized } from '../errors.js'

const TENANT_ID_KEY = 'tenantId'

/**
 * Create auth middleware that validates Bearer tokens against a key map.
 * Resolved tenant_id is stored in res.locals.tenantId.
 */
export function createAuthMiddleware(keyMap: Map<string, string>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.get('authorization')
    if (!header) {
      next(unauthorized('Missing Authorization header'))
      return
    }

    if (!header.startsWith('Bearer ')) {
      next(unauthorized('Authorization must use Bearer scheme'))
      return
    }

    const token = header.slice(7).trim()
    if (token.length === 0) {
      next(unauthorized('Bearer token is empty'))
      return
    }

    const tenantId = keyMap.get(token)
    if (!tenantId) {
      next(unauthorized('Invalid API key'))
      return
    }

    res.locals[TENANT_ID_KEY] = tenantId
    next()
  }
}

/**
 * Read the authenticated tenant_id from res.locals.
 * Throws if auth middleware has not run (programming error).
 */
export function getTenantId(res: Response): string {
  const tenantId = res.locals[TENANT_ID_KEY]
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('getTenantId called without auth middleware — programming error')
  }
  return tenantId
}
