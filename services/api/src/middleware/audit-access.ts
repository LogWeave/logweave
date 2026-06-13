import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type pino from 'pino'
import { insertAuditEvent } from '../db/audit-queries.js'
import type { DbClient } from '../db/client.js'
import { getKeyId, getTenantId } from './auth.js'
import { getClientIp } from './client-ip.js'

/**
 * Middleware that audits data access operations (not just auth events).
 * Logs: settings changes, connector CRUD, deploy markers.
 *
 * Alert-rule and watch mutations are audited explicitly in their route handlers
 * (rules.ts / watches.ts) — per-route calls are robust where path matching is
 * fragile. Does NOT audit read-only GET requests (too noisy).
 *
 * Matching uses req.originalUrl: this middleware runs inside the router mounted
 * at /v1, so req.path is mount-relative (e.g. "/settings") and would never match
 * a "/v1/..." pattern.
 */
export function createAccessAuditMiddleware(deps: {
  db: DbClient
  logger: pino.Logger
}): RequestHandler {
  // Anchored so a future sibling route (e.g. /v1/settings-export) can't inherit
  // the wrong action via a substring match. Each pattern ends at a path boundary.
  const AUDITED_PATTERNS: Array<{ method: string; pattern: RegExp; action: string }> = [
    { method: 'POST', pattern: /^\/v1\/ingest(\/|$)/, action: 'ingest' },
    { method: 'PUT', pattern: /^\/v1\/settings(\/|$)/, action: 'settings.update' },
    { method: 'POST', pattern: /^\/v1\/settings(\/|$)/, action: 'settings.update' },
    { method: 'POST', pattern: /^\/v1\/connectors(\/|$)/, action: 'connector.create' },
    { method: 'DELETE', pattern: /^\/v1\/connectors(\/|$)/, action: 'connector.delete' },
    { method: 'POST', pattern: /^\/v1\/deploys(\/|$)/, action: 'deploy.create' },
  ]

  return (req: Request, res: Response, next: NextFunction): void => {
    // Only audit state-changing operations
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      next()
      return
    }

    // Fire audit after response completes
    res.on('finish', () => {
      // Only audit successful operations
      if (res.statusCode >= 400) return

      // req.path is mount-relative inside /v1; match the full path.
      const reqPath = req.originalUrl.split('?')[0] ?? ''
      // Connection/notification test endpoints (…/test) are not mutations.
      if (reqPath.endsWith('/test')) return
      const match = AUDITED_PATTERNS.find((p) => p.method === req.method && p.pattern.test(reqPath))
      if (!match) return

      try {
        const tenantId = getTenantId(res)
        const keyId = getKeyId(res)
        const sourceIp = getClientIp(req)

        insertAuditEvent(deps.db, tenantId, {
          keyId,
          action: match.action,
          sourceIp,
          details: `${req.method} ${reqPath}`,
        }).catch((err) => {
          deps.logger.warn({ err, action: match.action }, 'Failed to write access audit event')
        })
      } catch {
        // getTenantId may throw if auth didn't run — skip silently
      }
    })

    next()
  }
}
