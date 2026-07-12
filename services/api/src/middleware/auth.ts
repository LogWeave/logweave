import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type pino from 'pino'
import type { ApiKeyStore } from '../auth/api-key-store.js'
import type { SessionProvider } from '../auth/session.js'
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from '../auth/session.js'
import type { SessionValidationCache } from '../auth/session-cache.js'
import type { UserStore } from '../auth/user-store.js'
import { forbidden, unauthorized } from '../errors.js'
import { getInternalEvents } from '../internal-events/emitter.js'

const TENANT_ID_KEY = 'tenantId'
const KEY_ID_KEY = 'keyId'
const ROLE_KEY = 'role'

interface HashedKey {
  hash: Buffer
  tenantId: string
}

/**
 * Mutable key store that supports hot-reload without server restart.
 * Auth middleware references this store on every request.
 *
 * Keys are hashed with domain-separated HMAC-SHA256 (`env-key:` prefix) keyed
 * by the encryption key, mirroring ApiKeyStore so env and DB keys share the same
 * posture. When no encryption key is configured (Bearer-only, keyless deploys)
 * it falls back to bare SHA-256 — bootstrap-only, no server-side secret exists.
 */
export class KeyStore {
  private keys: HashedKey[] = []
  private readonly hmacSecret: string

  constructor(keyMap: Map<string, string>, hmacSecret?: string) {
    this.hmacSecret = hmacSecret ?? ''
    this.loadKeys(keyMap)
  }

  /** Hash a key/token. HMAC when a secret is configured, else bare SHA-256. */
  private hash(value: string): Buffer {
    return this.hmacSecret
      ? createHmac('sha256', this.hmacSecret).update(`env-key:${value}`).digest()
      : createHash('sha256').update(value).digest()
  }

  /** Replace all keys with a new set. Thread-safe (atomic reference swap). */
  loadKeys(keyMap: Map<string, string>): void {
    const newKeys: HashedKey[] = []
    for (const [key, tenantId] of keyMap) {
      newKeys.push({ hash: this.hash(key), tenantId })
    }
    this.keys = newKeys
  }

  /** Clear plaintext keys from a Map after loading (caller should discard the Map). */
  static fromMapAndClear(keyMap: Map<string, string>, hmacSecret?: string): KeyStore {
    const store = new KeyStore(keyMap, hmacSecret)
    keyMap.clear()
    return store
  }

  /** Validate a token. Returns tenantId if valid, undefined if not. */
  validate(token: string): { tenantId: string; keyId: string } | undefined {
    const tokenHash = this.hash(token)
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

export interface AuthMiddlewareOpts {
  /** Static env-loaded keys (bootstrap). Optional once apiKeyStore has data. */
  envKeys?: KeyStore | Map<string, string>
  /** DB-managed, runtime-mutable keys. Consulted after envKeys. */
  apiKeyStore?: ApiKeyStore
  sessionProvider?: SessionProvider
  sessionCache?: SessionValidationCache
  userStore?: UserStore
  logger?: pino.Logger
}

/**
 * Create auth middleware that validates Bearer tokens and session cookies.
 * Auth priority: Bearer header (env keys → DB keys) → session cookie → 401.
 *
 * Two-arg legacy form is preserved so existing tests don't break: pass a
 * `KeyStore` or `Map` as the first arg. New callers should pass an options
 * object so the DB-managed `apiKeyStore` can be wired in.
 */
export function createAuthMiddleware(
  sourceOrOpts: KeyStore | Map<string, string> | AuthMiddlewareOpts,
  sessionProvider?: SessionProvider,
  sessionCache?: SessionValidationCache,
  userStore?: UserStore,
  logger?: pino.Logger,
): RequestHandler {
  const opts: AuthMiddlewareOpts =
    sourceOrOpts instanceof KeyStore || sourceOrOpts instanceof Map
      ? { envKeys: sourceOrOpts, sessionProvider, sessionCache, userStore, logger }
      : sourceOrOpts

  const envStore =
    opts.envKeys instanceof KeyStore
      ? opts.envKeys
      : opts.envKeys
        ? new KeyStore(opts.envKeys)
        : undefined
  const apiKeyStore = opts.apiKeyStore
  const sp = opts.sessionProvider
  const sc = opts.sessionCache
  const us = opts.userStore
  const log = opts.logger

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // 1. Bearer token (API keys, MCP, SDK)
    const header = req.get('authorization')
    if (header) {
      if (!header.startsWith('Bearer ')) {
        next(unauthorized('Authorization must use Bearer scheme'))
        return
      }
      const token = header.slice(7).trim()
      if (token.length > 0) {
        // Env keys first — small, deterministic, set at boot. DB keys are
        // the runtime-managed pool; checked second.
        const result = envStore?.validate(token) ?? apiKeyStore?.validate(token)
        if (result) {
          res.locals[TENANT_ID_KEY] = result.tenantId
          res.locals[KEY_ID_KEY] = result.keyId
          res.locals[ROLE_KEY] = 'admin'
          next()
          return
        }
        getInternalEvents().emit({
          event: 'auth.key_invalid',
          severity: 'warn',
          code: 'KEY_INVALID',
          summary: 'invalid bearer token',
          fields: {
            // sampled emitter coalesces by tenant_id; we don't know the tenant
            // for an unknown key, so bucket by route instead
            tenant_id: '_unknown',
            route: req.path,
            key_prefix: token.slice(0, 6),
          },
        })
        next(unauthorized('Invalid API key'))
        return
      }
    }

    // 2. Session cookie (dashboard) — validates HMAC + checks session version
    if (sp) {
      const cookieValue = (req as Request & { cookies?: Record<string, string> }).cookies?.[
        SESSION_COOKIE_NAME
      ]
      if (cookieValue) {
        const session = sp.validateSession(cookieValue)
        if (session) {
          // Check session version against cache/DB to catch deleted/changed users
          if (sc && us) {
            const cached = sc.get(session.userId)
            if (!cached) {
              // Cold cache: await the DB lookup before authorizing so a deleted
              // or version-bumped user is rejected immediately, not after the
              // cache eventually populates. One round-trip per uncached user.
              let user: Awaited<ReturnType<typeof us.findById>>
              try {
                user = await us.findById(session.userId)
              } catch (err) {
                // Fail closed: if we can't verify the session against the DB,
                // don't authorize. Log so DB outages are observable.
                log?.warn({ err, userId: session.userId }, 'Session validation DB lookup failed')
                next(unauthorized('Session validation unavailable'))
                return
              }
              sc.set(session.userId, user?.sessionVersion ?? 0, !user)
              if (!user || user.sessionVersion !== session.sessionVersion) {
                // User deleted or session version bumped — reject
                next(unauthorized('Session expired'))
                return
              }
            } else if (cached.isDeleted || cached.sessionVersion !== session.sessionVersion) {
              // User deleted or session version mismatch — reject
              next(unauthorized('Session expired'))
              return
            }
          }
          res.locals[TENANT_ID_KEY] = session.tenantId
          res.locals[KEY_ID_KEY] = `session:${session.userId}`
          res.locals[ROLE_KEY] = session.role
          // Refresh cookie to extend idle timeout (preserves absolute exp).
          const refreshed = sp.refreshSession(session)
          res.cookie(SESSION_COOKIE_NAME, refreshed, SESSION_COOKIE_OPTIONS)
          next()
          return
        }
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

/** Read the authenticated role from res.locals. Returns 'admin' for API key auth. */
export function getRole(res: Response): string {
  return typeof res.locals[ROLE_KEY] === 'string' ? (res.locals[ROLE_KEY] as string) : 'viewer'
}

/**
 * Middleware: rejects non-admin sessions with 403. API keys are always admin.
 *
 * Apply this per write route (POST/PUT/DELETE). The routers in this service are
 * mounted path-less under /v1, so a router-level `router.use(requireAdmin…)`
 * would run for every /v1 request, not just the router's own routes. Per-route
 * guards keep the admin gate scoped correctly.
 */
export const requireAdmin: RequestHandler = (_req, res, next): void => {
  if (getRole(res) !== 'admin') {
    next(forbidden('Admin role required'))
    return
  }
  next()
}
