import { Router } from 'express'
import { forwardToArchive } from '../archive/forward-or-throw.js'
import { validationError } from '../errors.js'
import { HttpStatus } from '../http-status.js'
import { MAX_BATCH_SIZE } from '../lib/constants.js'
import type { IngestDeps } from '../lib/ingest-deps.js'
import { getTenantId } from '../middleware/auth.js'
import { ingestBatch } from '../pipeline/ingest.js'
import { GenericLogParser } from '../pipeline/parse-generic.js'

const genericParser = new GenericLogParser()

export function genericIngestRoutes(deps: IngestDeps): Router {
  const router = Router()

  router.post('/ingest/logs', async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body

      // Normalize: single event → array
      const events: unknown[] = Array.isArray(body) ? body : [body]

      if (events.length === 0) {
        throw validationError('At least one event required')
      }

      if (events.length > MAX_BATCH_SIZE) {
        throw validationError(`Batch size ${events.length} exceeds maximum of ${MAX_BATCH_SIZE}`)
      }

      if (deps.vectorArchiveUrl) {
        await forwardToArchive(deps, events, { tenantId })
        res.status(HttpStatus.ACCEPTED).json({ accepted: events.length, status: 'pending' })
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
        { sourceType: 'http', idempotencyKey: req.header('Idempotency-Key') },
        genericParser,
      )

      res.status(HttpStatus.OK).json(result)
    } catch (err) {
      next(err)
    }
  })

  return router
}
