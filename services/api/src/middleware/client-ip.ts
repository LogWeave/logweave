import type { Request } from 'express'

/**
 * The single source of truth for a request's client IP. Relies on Express's
 * `trust proxy` setting (configured from LOGWEAVE_TRUST_PROXY in app.ts): when
 * trust proxy is off, `req.ip` is the socket peer and spoofed X-Forwarded-For
 * headers are ignored; when it is on, `req.ip` is the real client as seen by the
 * trusted proxy. Every IP-aware site (rate-limit, lockout, audit) must use this
 * so behaviour is consistent and not separately spoofable.
 */
export function getClientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown'
}
