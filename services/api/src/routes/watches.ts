import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import type { DbClient } from '../db/client.js'
import { AppError } from '../errors.js'
import { HttpStatus } from '../http-status.js'
import { recordAuditEvent } from '../lib/audit.js'
import { respond } from '../lib/respond.js'
import { getKeyId, getTenantId, requireAdmin } from '../middleware/auth.js'
import { getClientIp } from '../middleware/client-ip.js'
import { validateBody } from '../middleware/validate.js'
import type { WatchStore } from '../watches/watch-store.js'

export interface WatchDeps {
  watchStore: WatchStore
  db: DbClient
  logger: pino.Logger
}

const createWatchSchema = z.object({
  templateId: z.string().min(1),
  templateText: z.string().max(2000).optional(),
})

export function watchRoutes(deps: WatchDeps): Router {
  const router = Router()

  // Creating and removing watches is admin-only; viewers keep read access to
  // GET /watches. The guard is applied per write route rather than via
  // `router.use`, because this router is mounted path-less under /v1 — a
  // router-level guard would run for every /v1 request, not just these routes
  // (LW-281 F1).

  // POST /watches — create a watch
  router.post('/watches', requireAdmin, validateBody(createWatchSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as z.infer<typeof createWatchSchema>

      const result = await deps.watchStore.add(tenantId, body.templateId, body.templateText)
      if (result === 'limit_exceeded') {
        throw new AppError(
          HttpStatus.BAD_REQUEST,
          'WATCH_LIMIT_EXCEEDED',
          'Maximum 100 watches per tenant',
        )
      }

      recordAuditEvent(deps, {
        tenantId,
        keyId: getKeyId(res),
        action: 'watch.create',
        sourceIp: getClientIp(req),
        details: JSON.stringify({ templateId: body.templateId }),
      })

      res.status(HttpStatus.CREATED).json({
        data: { templateId: body.templateId },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // DELETE /watches/:templateId — remove a watch
  router.delete('/watches/:templateId', requireAdmin, async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const templateId = req.params.templateId as string
      if (templateId) {
        // Only record the audit event when a watch was actually removed —
        // a no-op delete (unknown id) must not forge a deletion entry in the
        // SOC2 audit trail (LW-281 F6).
        const removed = await deps.watchStore.remove(tenantId, templateId)
        if (removed) {
          recordAuditEvent(deps, {
            tenantId,
            keyId: getKeyId(res),
            action: 'watch.delete',
            sourceIp: getClientIp(req),
            details: JSON.stringify({ templateId }),
          })
        }
      }
      res.status(HttpStatus.NO_CONTENT).end()
    } catch (err) {
      next(err)
    }
  })

  // GET /watches — list watched templateIds
  router.get('/watches', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const watchedIds = deps.watchStore.list(tenantId)
      const data = watchedIds.map((templateId) => ({ templateId }))

      respond(res, data, { count: data.length })
    } catch (err) {
      next(err)
    }
  })

  return router
}
