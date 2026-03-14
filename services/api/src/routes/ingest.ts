import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import { validateBody } from '../middleware/validate.js'
import { ingestBatch } from '../pipeline/ingest.js'
import type { ClusterClient } from '../pipeline/cluster-client.js'
import type { ClickHouseClient } from '../types.js'

export interface IngestDeps {
  clusterClient: ClusterClient
  clickhouse: ClickHouseClient
  logger: pino.Logger
}

const ingestBatchSchema = z.object({
  events: z.array(z.record(z.unknown())).min(1).max(1000),
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
            clickhouse: deps.clickhouse,
            logger: deps.logger,
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
