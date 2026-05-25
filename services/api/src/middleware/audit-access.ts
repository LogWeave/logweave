import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type pino from 'pino'
import { insertAuditEvent } from '../db/audit-queries.js'
import type { DbClient } from '../db/client.js'
import { getKeyId, getTenantId } from './auth.js'

/**
 * Middleware that audits data access operations (not just auth events).
 * Logs: settings changes, connector CRUD, alert rule changes, deploy markers.
 * Does NOT audit read-only GET requests (too noisy).
 */
export function createAccessAuditMiddleware(deps: {
  db: DbClient
  logger: pino.Logger
}): RequestHandler {
  const AUDITED_PATTERNS: Array<{ method: string; pattern: RegExp; action: string }> = [
    { method: 'POST', pattern: /\/v1\/ingest/, action: 'ingest' },
    { method: 'PUT', pattern: /\/v1\/settings/, action: 'settings.update' },
    { method: 'POST', pattern: /\/v1\/settings/, action: 'settings.update' },
    { method: 'POST', pattern: /\/v1\/connectors/, action: 'connector.create' },
    { method: 'DELETE', pattern: /\/v1\/connectors/, action: 'connector.delete' },
    { method: 'POST', pattern: /\/v1\/watches\/rules/, action: 'rule.create' },
    { method: 'PUT', pattern: /\/v1\/watches\/rules/, action: 'rule.update' },
    { method: 'DELETE', pattern: /\/v1\/watches\/rules/, action: 'rule.delete' },
    { method: 'POST', pattern: /\/v1\/deploys/, action: 'deploy.create' },
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

      const match = AUDITED_PATTERNS.find(
        (p) => p.method === req.method && p.pattern.test(req.path),
      )
      if (!match) return

      try {
        const tenantId = getTenantId(res)
        const keyId = getKeyId(res)
        const sourceIp = req.ip ?? req.socket.remoteAddress ?? ''

        insertAuditEvent(deps.db, tenantId, {
          keyId,
          action: match.action,
          sourceIp,
          details: `${req.method} ${req.path}`,
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
