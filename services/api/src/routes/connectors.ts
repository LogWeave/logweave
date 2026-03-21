import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import type { DbClient } from '../db/client.js'
import {
  deleteConnector,
  getConnector,
  insertConnector,
  listConnectors,
} from '../db/connector-queries.js'
import { S3Adapter } from '../connectors/s3-adapter.js'
import type { ConnectorConfig } from '../connectors/types.js'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import { validateBody } from '../middleware/validate.js'
import { uuidv7 } from '../uuid.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ConnectorDeps {
  db: DbClient
  logger: pino.Logger
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const s3ConfigSchema = z
  .object({
    type: z.literal('s3'),
    bucket: z.string().min(3).max(63),
    prefix: z.string().max(1024).default(''),
    pathPattern: z.string().min(1).max(1024),
    region: z.string().min(1).max(64),
    logFormat: z.enum(['jsonl', 'text']),
    compression: z.enum(['none', 'gzip']),
    // endpoint, forcePathStyle, accessKeyId, secretAccessKey — dev/MinIO only.
    // SSRF note: endpoint allows arbitrary URLs. In production, reject configs with
    // endpoint set (AssumeRole doesn't need it). Currently allowed for local dev with MinIO.
    endpoint: z.string().url().optional(),
    forcePathStyle: z.boolean().optional(),
    accessKeyId: z.string().max(128).optional(),
    secretAccessKey: z.string().max(128).optional(),
  })
  .refine(
    (c) => {
      // endpoint only allowed in dev mode (SSRF prevention — see ADR-010)
      if (c.endpoint && process.env.NODE_ENV === 'production') return false
      return true
    },
    { message: 'Custom endpoint is not allowed in production (SSRF risk). Use IAM AssumeRole instead.' },
  )
  .refine(
    (c) => {
      // secretAccessKey only allowed with endpoint (MinIO mode)
      if (c.secretAccessKey && !c.endpoint) return false
      return true
    },
    { message: 'secretAccessKey is only allowed with endpoint (MinIO/dev mode)' },
  )
  .refine(
    (c) => {
      // accessKeyId only allowed with endpoint
      if (c.accessKeyId && !c.endpoint) return false
      return true
    },
    { message: 'accessKeyId is only allowed with endpoint (MinIO/dev mode)' },
  )

const createConnectorSchema = z.object({
  name: z.string().min(1).max(128),
  config: s3ConfigSchema,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redactConfig(configJson: string): Record<string, unknown> {
  try {
    const config = JSON.parse(configJson) as Record<string, unknown>
    if (config.secretAccessKey) config.secretAccessKey = '***'
    if (config.accessKeyId) config.accessKeyId = '***'
    return config
  } catch {
    return {}
  }
}

const s3Adapter = new S3Adapter()

function getAdapter(_type: string): S3Adapter {
  return s3Adapter
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function connectorRoutes(deps: ConnectorDeps): Router {
  const router = Router()

  // POST /connectors — create a connector
  router.post('/connectors', validateBody(createConnectorSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const body = req.body as z.infer<typeof createConnectorSchema>
      const connectorId = uuidv7()

      await insertConnector(deps.db, tenantId, {
        connectorId,
        name: body.name,
        type: body.config.type,
        config: JSON.stringify(body.config),
      })

      res.status(HttpStatus.CREATED).json({
        data: {
          connectorId,
          name: body.name,
          type: body.config.type,
          config: redactConfig(JSON.stringify(body.config)),
        },
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // GET /connectors — list connectors for tenant
  router.get('/connectors', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const rows = await listConnectors(deps.db, tenantId)

      const data = rows.map((r) => ({
        connectorId: r.connector_id,
        name: r.name,
        type: r.type,
        config: redactConfig(r.config),
        createdAt: r.created_at,
      }))

      res.status(HttpStatus.OK).json({
        data,
        meta: { count: data.length, fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // POST /connectors/:id/test — test connection
  router.post('/connectors/:id/test', async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const connectorId = req.params.id as string
      const row = await getConnector(deps.db, tenantId, connectorId)

      if (!row) {
        res.status(HttpStatus.NOT_FOUND).json({
          error: { code: 'NOT_FOUND', message: 'Connector not found' },
        })
        return
      }

      const config = JSON.parse(row.config) as ConnectorConfig
      const adapter = getAdapter(config.type)
      const result = await adapter.testConnection(config)

      res.status(HttpStatus.OK).json({
        data: result,
        meta: { fetchedAt: new Date().toISOString() },
      })
    } catch (err) {
      next(err)
    }
  })

  // DELETE /connectors/:id — remove connector
  router.delete('/connectors/:id', async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const connectorId = req.params.id as string

      const row = await getConnector(deps.db, tenantId, connectorId)
      if (!row) {
        res.status(HttpStatus.NOT_FOUND).json({
          error: { code: 'NOT_FOUND', message: 'Connector not found' },
        })
        return
      }

      await deleteConnector(deps.db, tenantId, connectorId)
      res.status(HttpStatus.NO_CONTENT).send()
    } catch (err) {
      next(err)
    }
  })

  return router
}
