import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { unauthorized } from '../errors.js'

const TENANT_ID_KEY = 'tenantId'
const KEY_ID_KEY = 'keyId'

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

interface HashedKey {
  hash: Buffer
  tenantId: string
}

/**
 * Mutable key store that supports hot-reload without server restart.
 * Auth middleware references this store on every request.
 */
export class KeyStore {
  private keys: HashedKey[] = []

  constructor(keyMap: Map<string, string>) {
    this.loadKeys(keyMap)
  }

  /** Replace all keys with a new set. Thread-safe (atomic reference swap). */
  loadKeys(keyMap: Map<string, string>): void {
    const newKeys: HashedKey[] = []
    for (const [key, tenantId] of keyMap) {
      newKeys.push({ hash: sha256(key), tenantId })
    }
    this.keys = newKeys
  }

  /** Clear plaintext keys from a Map after loading (caller should discard the Map). */
  static fromMapAndClear(keyMap: Map<string, string>): KeyStore {
    const store = new KeyStore(keyMap)
    keyMap.clear()
    return store
  }

  /** Validate a token. Returns tenantId if valid, undefined if not. */
  validate(token: string): { tenantId: string; keyId: string } | undefined {
    const tokenHash = sha256(token)
    for (const entry of this.keys) {
      if (timingSafeEqual(tokenHash, entry.hash)) {
        return {
          tenantId: entry.tenantId,
          keyId: tokenHash.toString('hex').slice(0, 16),
        }
      }
    }
    return undefined
  }

  get keyCount(): number {
    return this.keys.length
  }
}

/**
 * Create auth middleware that validates Bearer tokens.
 * Uses SHA-256 hashing + crypto.timingSafeEqual for constant-time comparison.
 * Accepts either a KeyStore (hot-reloadable) or a static Map (legacy).
 */
export function createAuthMiddleware(source: KeyStore | Map<string, string>): RequestHandler {
  const store = source instanceof KeyStore ? source : new KeyStore(source)

  return (req: Request, res: Response, next: NextFunction): void => {
    // Extract token from Authorization header or query param (for SSE/EventSource)
    let token: string | undefined
    const header = req.get('authorization')

    if (header) {
      if (!header.startsWith('Bearer ')) {
        next(unauthorized('Authorization must use Bearer scheme'))
        return
      }
      token = header.slice(7).trim()
    } else {
      // Fallback: ?api_key= query param (required for EventSource which can't set headers)
      const queryKey = req.query.api_key
      if (typeof queryKey === 'string') {
        token = queryKey.trim()
      }
    }

    if (!token || token.length === 0) {
      next(unauthorized('Missing Authorization header or api_key query parameter'))
      return
    }

    const result = store.validate(token)
    if (!result) {
      next(unauthorized('Invalid API key'))
      return
    }

    res.locals[TENANT_ID_KEY] = result.tenantId
    res.locals[KEY_ID_KEY] = result.keyId
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
