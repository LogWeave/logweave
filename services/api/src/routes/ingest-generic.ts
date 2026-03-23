import { Router } from 'express'
import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import type { EventBus } from '../events/event-bus.js'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import type { AnomalyScorer } from '../pipeline/anomaly-scorer.js'
import type { ClusterClient } from '../pipeline/cluster-client.js'
import { ingestBatch } from '../pipeline/ingest.js'
import { GenericLogParser } from '../pipeline/parse-generic.js'
import type { TailBuffer } from '../tail/buffer.js'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'

export interface GenericIngestDeps {
  clusterClient: ClusterClient
  db: DbClient
  logger: pino.Logger
  anomalyScorer: AnomalyScorer
  tailBuffer?: TailBuffer
  settingsStore?: TenantSettingsStore
  eventBus?: EventBus
}

const MAX_BATCH_SIZE = 1000
const genericParser = new GenericLogParser()

export function genericIngestRoutes(deps: GenericIngestDeps): Router {
  const router = Router()

  router.post('/ingest/logs', async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body

      // Normalize: single event → array
      const events: unknown[] = Array.isArray(body) ? body : [body]

      if (events.length === 0) {
        res.status(HttpStatus.BAD_REQUEST).json({
          error: { code: 'VALIDATION_ERROR', message: 'At least one event required' },
        })
        return
      }

      if (events.length > MAX_BATCH_SIZE) {
        res.status(HttpStatus.BAD_REQUEST).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `Batch size ${events.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
          },
        })
        return
      }

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
        events,
        { sourceType: 'http' },
        genericParser,
      )

      res.status(HttpStatus.OK).json(result)
    } catch (err) {
      next(err)
    }
  })

  return router
}
