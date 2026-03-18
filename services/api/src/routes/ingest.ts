import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import { validateBody } from '../middleware/validate.js'
import { ingestBatch } from '../pipeline/ingest.js'
import type { DbClient } from '../db/client.js'
import type { AnomalyScorer } from '../pipeline/anomaly-scorer.js'
import type { ClusterClient } from '../pipeline/cluster-client.js'

export interface IngestDeps {
  clusterClient: ClusterClient
  db: DbClient
  logger: pino.Logger
  anomalyScorer: AnomalyScorer
}

const ingestBatchSchema = z.object({
  events: z.array(z.unknown()).min(1).max(1000),
  service: z.string().optional(),
  environment: z.string().optional(),
  neverExtract: z.array(z.string()).optional(),
})

export function ingestRoutes(deps: IngestDeps): Router {
  const router = Router()

  router.post(
    '/ingest/batch',
    validateBody(ingestBatchSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const body = req.body as z.infer<typeof ingestBatchSchema>

        const result = await ingestBatch(
          {
            clusterClient: deps.clusterClient,
            db: deps.db,
            logger: deps.logger,
            anomalyScorer: deps.anomalyScorer,
          },
          tenantId,
          body.events,
          {
            service: body.service,
            environment: body.environment,
            neverExtract: body.neverExtract
              ? new Set(body.neverExtract)
              : undefined,
          },
        )

        res.status(HttpStatus.OK).json(result)
      } catch (err) {
        next(err)
      }
    },
  )

  return router
}
