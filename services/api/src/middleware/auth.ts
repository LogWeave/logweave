import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { unauthorized } from '../errors.js'

const TENANT_ID_KEY = 'tenantId'
const KEY_ID_KEY = 'keyId'

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * Create auth middleware that validates Bearer tokens against a key map.
 * Uses SHA-256 hashing + crypto.timingSafeEqual for constant-time comparison.
 * Resolved tenant_id is stored in res.locals.tenantId.
 */
export function createAuthMiddleware(keyMap: Map<string, string>): RequestHandler {
  // Pre-hash all keys at startup for constant-time comparison
  const hashedKeys: Array<{ hash: Buffer; tenantId: string }> = []
  for (const [key, tenantId] of keyMap) {
    hashedKeys.push({ hash: sha256(key), tenantId })
  }

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

    const tokenHash = sha256(token)
    let matchedTenantId: string | undefined
    for (const entry of hashedKeys) {
      if (timingSafeEqual(tokenHash, entry.hash)) {
        matchedTenantId = entry.tenantId
      }
    }

    if (!matchedTenantId) {
      next(unauthorized('Invalid API key'))
      return
    }

    res.locals[TENANT_ID_KEY] = matchedTenantId
    res.locals[KEY_ID_KEY] = tokenHash.toString('hex').slice(0, 16)
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

export function getKeyId(res: Response): string {
  const keyId = res.locals[KEY_ID_KEY]
  if (typeof keyId !== 'string' || keyId.length === 0) {
    throw new Error('getKeyId called without auth middleware — programming error')
  }
  return keyId
}
