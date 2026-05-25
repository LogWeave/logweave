import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import type { DbClient } from '../db/client.js'
import { insertDeploy, queryDeploys } from '../db/deploy-queries.js'
import { HttpStatus } from '../http-status.js'
import { isoTimestamp, respond } from '../lib/respond.js'
import { getTenantId } from '../middleware/auth.js'
import { validateBody } from '../middleware/validate.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'
import { uuidv7 } from '../uuid.js'

export interface DeploysDeps {
  db: DbClient
  logger: pino.Logger
}

const createDeploySchema = z.object({
  service: z.string().min(1).max(128),
  version: z.string().max(256).optional(),
  commitSha: z.string().max(64).optional(),
  timestamp: z.string().datetime({ offset: true }).optional(),
})

const listDeploysSchema = z.object({
  service: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

export function deployRoutes(deps: DeploysDeps): Router {
  const router = Router()

  // POST /deploys — create a deploy marker
  router.post('/deploys', validateBody(createDeploySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as z.infer<typeof createDeploySchema>
      const deployId = uuidv7()
      const timestamp = body.timestamp ?? new Date().toISOString()

      await insertDeploy(deps.db, {
        deployId,
        tenantId,
        service: body.service,
        version: body.version,
        commitSha: body.commitSha,
        timestamp,
      })

      res.status(HttpStatus.CREATED).json({
        data: {
          deployId,
          service: body.service,
          version: body.version ?? null,
          commitSha: body.commitSha ?? null,
          timestamp,
        },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // GET /deploys — list recent deploys
  router.get('/deploys', validateQuery(listDeploysSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<z.infer<typeof listDeploysSchema>>(req)

      const rows = await queryDeploys(deps.db, tenantId, {
        service: params.service,
        limit: params.limit,
      })

      const data = rows.map((r) => ({
        deployId: r.deploy_id,
        service: r.service,
        version: r.version,
        commitSha: r.commit_sha,
        timestamp: isoTimestamp(r.timestamp) ?? r.timestamp,
      }))

      respond(res, data, { count: data.length, limit: params.limit })
    } catch (err) {
      next(err)
    }
  })

  return router
}
