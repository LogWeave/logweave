import { Router } from 'express'
import { z } from 'zod'
import { HttpStatus } from '../http-status.js'
import type { IngestDeps } from '../lib/ingest-deps.js'
import { getTenantId } from '../middleware/auth.js'
import { validateBody } from '../middleware/validate.js'
import { ingestBatch } from '../pipeline/ingest.js'

const ingestBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(1000),
  service: z.string().optional(),
  environment: z.string().optional(),
  neverExtract: z.array(z.string()).optional(),
  source_type: z.string().max(64).optional(),
  source_ref: z.string().max(1024).optional(),
})

export function ingestRoutes(deps: IngestDeps): Router {
  const router = Router()

  router.post('/ingest/batch', validateBody(ingestBatchSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as z.infer<typeof ingestBatchSchema>

      const result = await ingestBatch(
        {
          clusterClient: deps.clusterClient,
          db: deps.db,
          logger: deps.logger,
          anomalyScorer: deps.anomalyScorer,
          tailBuffer: deps.tailBuffer,
          settingsStore: deps.settingsStore,
          eventBus: deps.eventBus,
        },
        tenantId,
        body.events,
        {
          service: body.service,
          environment: body.environment,
          neverExtract: body.neverExtract ? new Set(body.neverExtract) : undefined,
          sourceType: body.source_type,
          sourceRef: body.source_ref,
        },
      )

      res.status(HttpStatus.OK).json(result)
    } catch (err) {
      next(err)
    }
  })

  return router
}
