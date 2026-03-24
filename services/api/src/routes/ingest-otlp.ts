import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import express, { Router } from 'express'
import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import type { EventBus } from '../events/event-bus.js'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import type { AnomalyScorer } from '../pipeline/anomaly-scorer.js'
import type { ClusterClient } from '../pipeline/cluster-client.js'
import { ingestBatch } from '../pipeline/ingest.js'
import { otlpToEvents } from '../pipeline/parse-otlp.js'
import type { TailBuffer } from '../tail/buffer.js'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'

export interface OtlpIngestDeps {
  clusterClient: ClusterClient
  db: DbClient
  logger: pino.Logger
  anomalyScorer: AnomalyScorer
  tailBuffer?: TailBuffer
  settingsStore?: TenantSettingsStore
  eventBus?: EventBus
}

import { MAX_BATCH_SIZE } from '../lib/constants.js'

const MAX_BODY_BYTES = 5 * 1024 * 1024 // 5MB

/**
 * Middleware to decompress gzip request bodies.
 * OTel Collectors send gzip by default.
 */
async function decompressGzip(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  if (req.body) {
    next()
    return
  }
  const encoding = req.headers['content-encoding']
  if (encoding !== 'gzip') {
    next()
    return
  }

  try {
    const chunks: Buffer[] = []
    let totalBytes = 0
    const gunzip = createGunzip()

    gunzip.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > MAX_BODY_BYTES) {
        gunzip.destroy(new Error('Decompressed body exceeds size limit'))
        return
      }
      chunks.push(chunk)
    })

    await pipeline(Readable.from(req), gunzip)

    const decompressed = Buffer.concat(chunks)
    req.body = JSON.parse(decompressed.toString('utf-8'))
    // Remove content-encoding so Express doesn't try to decompress again
    delete req.headers['content-encoding']
    next()
  } catch {
    res.status(HttpStatus.BAD_REQUEST).json({
      error: { code: 'DECOMPRESSION_ERROR', message: 'Failed to decompress gzip body' },
    })
  }
}

export function otlpIngestRoutes(deps: OtlpIngestDeps): Router {
  const router = Router()

  router.post(
    '/logs',
    // Content-type guard — reject protobuf with actionable error
    (req, res, next) => {
      const ct = req.headers['content-type'] ?? ''
      if (ct.includes('protobuf') || ct.includes('x-protobuf')) {
        res.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).json({
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message:
              'OTLP protobuf encoding not supported. Configure your OTel Collector with: encoding: json',
          },
        })
        return
      }
      next()
    },
    // Gzip decompression (before JSON parsing)
    decompressGzip,
    // JSON parsing with 5MB limit (only if not already parsed by gzip middleware)
    (req, res, next) => {
      if (req.body) {
        next()
        return
      }
      express.json({ limit: '5mb' })(req, res, next)
    },
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)

        // Flatten OTLP structure into flat events
        const flatEvents = otlpToEvents(req.body)

        if (flatEvents.length > MAX_BATCH_SIZE) {
          res.status(HttpStatus.BAD_REQUEST).json({
            partialSuccess: {
              rejectedLogRecords: flatEvents.length,
              errorMessage: `Batch size ${flatEvents.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
            },
          })
          return
        }

        if (flatEvents.length === 0) {
          res.status(HttpStatus.OK).json({
            partialSuccess: { rejectedLogRecords: 0, errorMessage: '' },
          })
          return
        }

        // Convert flat events to the shape ingestBatch expects
        // OtlpFlatEvent already has all fields extracted — pass as-is
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
          flatEvents,
          { sourceType: 'otlp' },
        )

        // Return OTLP-spec response format
        const rejected = flatEvents.length - result.accepted
        res.status(HttpStatus.OK).json({
          partialSuccess: {
            rejectedLogRecords: rejected,
            errorMessage: rejected > 0 ? `${rejected} log records could not be parsed` : '',
          },
        })
      } catch (err) {
        next(err)
      }
    },
  )

  return router
}
