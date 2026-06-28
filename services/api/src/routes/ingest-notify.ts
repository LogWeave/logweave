import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import type { ArchiveNotifyQueue } from '../archive/notify-queue.js'
import { HttpStatus } from '../http-status.js'
import { createInternalAuthMiddleware } from '../middleware/internal-auth.js'
import { validateBody } from '../middleware/validate.js'

export interface IngestNotifyDeps {
  queue: ArchiveNotifyQueue
  logger: pino.Logger
  /** Shared internal-services secret; the endpoint fails closed without it. */
  internalSecret?: string
}

/**
 * One "raw landed at source_ref" envelope (epic #265, seam C). Keys-only — no
 * raw bytes. `source_ref` MUST live under the envelope's own tenant prefix
 * (Vector writes keys as `tenant={tenant_id}/…`); this rejects malformed or
 * cross-tenant refs at the door, before the consumer (#277) GETs the object.
 */
const envelopeSchema = z
  .object({
    tenant_id: z.string().min(1).max(256),
    source_ref: z.string().min(1).max(1024),
    source_type: z.literal('s3'),
    service: z.string().max(256).optional(),
    event_count: z.number().int().nonnegative().optional(),
    byte_size: z.number().int().nonnegative().optional(),
    landed_at: z.string().max(64).optional(),
  })
  .refine((e) => e.source_ref.startsWith(`tenant=${e.tenant_id}/`), {
    message: 'source_ref must be under the tenant prefix (tenant=<tenant_id>/…)',
    path: ['source_ref'],
  })

// Accept a single envelope or a batch (Vector may coalesce).
const notifyBodySchema = z.union([envelopeSchema, z.array(envelopeSchema).min(1).max(1000)])

/**
 * POST /v1/ingest/notify — internal endpoint (see createInternalAuthMiddleware)
 * that accepts keys-only archive notifications and enqueues them for the async
 * consumer (#277). Idempotent on `source_ref` while pending; best-effort (the
 * reconciliation sweep #279 backfills drops). Returns 202 with counts.
 */
export function ingestNotifyRoutes(deps: IngestNotifyDeps): Router {
  const router = Router()
  const internalAuth = createInternalAuthMiddleware(deps.internalSecret)

  router.post('/v1/ingest/notify', internalAuth, validateBody(notifyBodySchema), (req, res) => {
    const body = req.body as z.infer<typeof notifyBodySchema>
    const envelopes = Array.isArray(body) ? body : [body]

    let enqueued = 0
    for (const e of envelopes) {
      if (
        deps.queue.enqueue({ tenantId: e.tenant_id, sourceRef: e.source_ref, service: e.service })
      ) {
        enqueued++
      }
    }

    res.status(HttpStatus.ACCEPTED).json({ received: envelopes.length, enqueued })
  })

  return router
}
