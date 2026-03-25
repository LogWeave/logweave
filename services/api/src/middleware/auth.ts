import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { SessionValidationCache } from '../auth/session-cache.js'
import type { SessionProvider } from '../auth/session.js'
import { SESSION_COOKIE_NAME } from '../auth/session.js'
import type { UserStore } from '../auth/user-store.js'
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
 * Create auth middleware that validates Bearer tokens and session cookies.
 * Auth priority: Bearer header → session cookie → api_key query param → 401.
 * Accepts either a KeyStore (hot-reloadable) or a static Map (legacy).
 */
export function createAuthMiddleware(
  source: KeyStore | Map<string, string>,
  sessionProvider?: SessionProvider,
  sessionCache?: SessionValidationCache,
  userStore?: UserStore,
): RequestHandler {
  const store = source instanceof KeyStore ? source : new KeyStore(source)

  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Bearer token (API keys, MCP, SDK)
    const header = req.get('authorization')
    if (header) {
      if (!header.startsWith('Bearer ')) {
        next(unauthorized('Authorization must use Bearer scheme'))
        return
      }
      const token = header.slice(7).trim()
      if (token.length > 0) {
        const result = store.validate(token)
        if (result) {
          res.locals[TENANT_ID_KEY] = result.tenantId
          res.locals[KEY_ID_KEY] = result.keyId
          next()
          return
        }
        next(unauthorized('Invalid API key'))
        return
      }
    }

    // 2. Session cookie (dashboard) — validates HMAC + checks session version
    if (sessionProvider) {
      const cookieValue = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE_NAME]
      if (cookieValue) {
        const session = sessionProvider.validateSession(cookieValue)
        if (session) {
          // Check session version against cache/DB to catch deleted/changed users
          if (sessionCache && userStore) {
            let cached = sessionCache.get(session.userId)
            if (!cached) {
              // Cache miss — query DB (async, but we need to await)
              // Fire-and-forget populate cache; for this request, trust the signed cookie
              userStore.findById(session.userId).then((user) => {
                sessionCache.set(
                  session.userId,
                  user?.sessionVersion ?? 0,
                  !user,
                )
              }).catch(() => {})
            } else if (cached.isDeleted || cached.sessionVersion !== session.sessionVersion) {
              // User deleted or session version mismatch — reject
              next(unauthorized('Session expired'))
              return
            }
          }
          res.locals[TENANT_ID_KEY] = session.tenantId
          res.locals[KEY_ID_KEY] = `session:${session.userId}`
          next()
          return
        }
      }
    }

    // 3. Query param fallback (legacy SSE, deprecated)
    const queryKey = req.query.api_key
    if (typeof queryKey === 'string' && queryKey.length > 0) {
      const result = store.validate(queryKey.trim())
      if (result) {
        res.locals[TENANT_ID_KEY] = result.tenantId
        res.locals[KEY_ID_KEY] = result.keyId
        next()
        return
      }
    }

    next(unauthorized('Missing or invalid authentication'))
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
