import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { SESSION_COOKIE_NAME } from '../auth/session.js'

const CSRF_HEADER = 'x-csrf-token'
const CSRF_COOKIE = 'logweave_csrf'
const TOKEN_BYTES = 32

/**
 * CSRF protection middleware using double-submit cookie pattern.
 *
 * How it works:
 * 1. On every response, sets a signed CSRF cookie (readable by JS, NOT httpOnly)
 * 2. State-changing requests (POST/PUT/DELETE) with session auth must include
 *    the token in the X-CSRF-Token header
 * 3. API key requests (Bearer auth) skip CSRF — they're not vulnerable
 * 4. GET/HEAD/OPTIONS skip CSRF — they're safe methods
 *
 * Swappable: replace this middleware for a synchronizer token pattern if needed.
 */
export function createCsrfMiddleware(signingKey: Buffer, options: { isProduction: boolean } = { isProduction: false }): {
  tokenSetter: RequestHandler
  tokenValidator: RequestHandler
} {
  function signToken(token: string): string {
    return createHmac('sha256', signingKey).update(token).digest('base64url')
  }

  /** Set CSRF cookie on every response (JS-readable, not httpOnly) */
  const tokenSetter: RequestHandler = (_req: Request, res: Response, next: NextFunction): void => {
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const sig = signToken(token)
    res.cookie(CSRF_COOKIE, `${token}.${sig}`, {
      httpOnly: false, // Must be readable by frontend JS
      sameSite: 'lax',
      secure: options.isProduction, // mirror session cookie — HTTPS-only in prod
      path: '/',
      maxAge: 8 * 60 * 60 * 1000, // match session TTL
    })
    next()
  }

  /** Validate CSRF token on state-changing requests with session auth */
  const tokenValidator: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    // Safe methods don't need CSRF
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next()
      return
    }

    // API key auth (Bearer) doesn't need CSRF — not cookie-based
    const authHeader = req.get('authorization')
    if (authHeader?.startsWith('Bearer ')) {
      next()
      return
    }

    // No session cookie = no CSRF needed (request will fail auth anyway)
    const cookies = (req as Request & { cookies?: Record<string, string> }).cookies
    if (!cookies?.[SESSION_COOKIE_NAME]) {
      next()
      return
    }

    // Validate: header token must match cookie token
    const headerToken = req.get(CSRF_HEADER)
    if (!headerToken) {
      res.status(403).json({ error: { code: 'CSRF_MISSING', message: 'Missing CSRF token' } })
      return
    }

    const cookieValue = cookies[CSRF_COOKIE]
    if (!cookieValue) {
      res.status(403).json({ error: { code: 'CSRF_MISSING', message: 'Missing CSRF cookie' } })
      return
    }

    // Verify cookie signature
    const dotIndex = cookieValue.indexOf('.')
    if (dotIndex === -1) {
      res.status(403).json({ error: { code: 'CSRF_INVALID', message: 'Invalid CSRF token' } })
      return
    }

    const cookieToken = cookieValue.slice(0, dotIndex)
    const cookieSig = cookieValue.slice(dotIndex + 1)
    const expectedSig = signToken(cookieToken)

    if (cookieSig.length !== expectedSig.length ||
        !timingSafeEqual(Buffer.from(cookieSig), Buffer.from(expectedSig))) {
      res.status(403).json({ error: { code: 'CSRF_INVALID', message: 'Invalid CSRF token' } })
      return
    }

    // Verify header matches cookie token
    if (headerToken !== cookieToken) {
      res.status(403).json({ error: { code: 'CSRF_MISMATCH', message: 'CSRF token mismatch' } })
      return
    }

    next()
  }

  return { tokenSetter, tokenValidator }
}
