import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { buildQuickCreateUrl, generateExternalId } from '../connectors/s3-cfn-url.js'
import { getAdapter } from '../connectors/shared.js'
import type { ConnectorConfig } from '../connectors/types.js'
import { decrypt, encrypt } from '../crypto.js'
import type { DbClient } from '../db/client.js'
import {
  deleteConnector,
  getConnector,
  insertConnector,
  listConnectors,
} from '../db/connector-queries.js'
import { notFound, validationError } from '../errors.js'
import { HttpStatus } from '../http-status.js'
import { respond } from '../lib/respond.js'
import { getTenantId, requireAdmin } from '../middleware/auth.js'
import { validateBody } from '../middleware/validate.js'
import { uuidv7 } from '../uuid.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ConnectorDeps {
  db: DbClient
  logger: pino.Logger
  encryptionKey?: string
  /** LogWeave's AWS account ID (the trusted principal in CFN trust policies). */
  awsAccountId?: string
  /** Public HTTPS URL of the S3 connector CFN template. */
  s3CfnTemplateUrl?: string
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
    // Cross-account AssumeRole (production path). Set together with externalId.
    roleArn: z
      .string()
      .regex(/^arn:aws:iam::\d{12}:role\/[\w+=,.@\-/]+$/, 'roleArn must be a valid IAM role ARN')
      .max(2048)
      .optional(),
    externalId: z.string().min(16).max(256).optional(),
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
    {
      message:
        'Custom endpoint is not allowed in production (SSRF risk). Use IAM AssumeRole instead.',
    },
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
  .refine(
    (c) => {
      // roleArn and externalId must be set together
      if ((c.roleArn && !c.externalId) || (!c.roleArn && c.externalId)) return false
      return true
    },
    { message: 'roleArn and externalId must be set together' },
  )
  .refine(
    (c) => {
      // roleArn and endpoint are mutually exclusive (AssumeRole vs MinIO)
      if (c.roleArn && c.endpoint) return false
      return true
    },
    { message: 'roleArn and endpoint are mutually exclusive — use one or the other' },
  )

// SSRF prevention — blocks loopback, link-local (incl. AWS/GCP metadata at
// 169.254.169.254), and RFC1918 private ranges in production. Dev allows them
// so users can point at local Elasticsearch/Loki on localhost.
function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true
  // IPv4 octet check
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const o = m.slice(1).map(Number)
    const [a, b] = o as [number, number, number, number]
    if (a === 127) return true // loopback
    if (a === 10) return true // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 169 && b === 254) return true // link-local incl. metadata
    if (a === 0) return true // 0.0.0.0/8
  }
  // IPv6 loopback / link-local / unique-local
  if (h === '::1' || h === '[::1]') return true
  if (h.startsWith('fe80:') || h.startsWith('[fe80:')) return true
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('[fc') || h.startsWith('[fd'))
    return true
  return false
}

function externalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (process.env.NODE_ENV !== 'production') return true
    return !isInternalHost(u.hostname)
  } catch {
    return false
  }
}

const externalUrlSchema = z.string().url().max(1024).refine(externalUrl, {
  message:
    'URL must point to an external host (loopback, link-local, and RFC1918 ranges are blocked in production — SSRF prevention).',
})

const elasticsearchConfigSchema = z.object({
  type: z.literal('elasticsearch'),
  url: externalUrlSchema,
  index: z.string().min(1).max(256),
  username: z.string().max(128).optional(),
  password: z.string().max(256).optional(),
  apiKey: z.string().max(512).optional(),
  messageField: z.string().max(128).optional(),
  timestampField: z.string().max(128).optional(),
})

const lokiConfigSchema = z.object({
  type: z.literal('loki'),
  url: externalUrlSchema,
  streamSelector: z.string().min(1).max(1024),
  orgId: z.string().max(128).optional(),
  username: z.string().max(128).optional(),
  password: z.string().max(256).optional(),
})

const filesystemConfigSchema = z.object({
  type: z.literal('filesystem'),
  basePath: z.string().min(1).max(4096),
  filePattern: z.string().min(1).max(256),
  logFormat: z.enum(['jsonl', 'text']),
})

// z.union (not z.discriminatedUnion) because s3ConfigSchema uses .refine()
const connectorConfigSchema = z.union([
  s3ConfigSchema,
  elasticsearchConfigSchema,
  lokiConfigSchema,
  filesystemConfigSchema,
])

const createConnectorSchema = z.object({
  name: z.string().min(1).max(128),
  config: connectorConfigSchema,
})

const quickCreateUrlSchema = z.object({
  bucket: z.string().min(3).max(63),
  prefix: z.string().max(1024).default(''),
  region: z.string().min(1).max(64).default('us-east-1'),
  roleName: z.string().min(1).max(64).optional(),
  stackName: z.string().min(1).max(128).optional(),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Secrets that should never be returned in API responses. */
const SECRET_KEYS = new Set(['secretAccessKey', 'accessKeyId', 'password', 'apiKey'])

function redactConfig(configJson: string): Record<string, unknown> {
  try {
    const config = JSON.parse(configJson) as Record<string, unknown>
    for (const key of SECRET_KEYS) {
      if (config[key]) config[key] = '***'
    }
    return config
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function connectorRoutes(deps: ConnectorDeps): Router {
  const router = Router()

  // POST /connectors/s3/quick-create-url — generate a CloudFormation
  // quick-create-stack URL with parameters pre-filled. Returns the URL plus a
  // newly-generated externalId; the client stores the externalId and uses it
  // when later creating the connector with the resulting Role ARN.
  router.post(
    '/connectors/s3/quick-create-url',
    requireAdmin,
    validateBody(quickCreateUrlSchema),
    (req, res, next) => {
      try {
        if (!deps.awsAccountId || !deps.s3CfnTemplateUrl) {
          throw validationError(
            'CloudFormation quick-create is not configured on this server. ' +
              'Set LOGWEAVE_AWS_ACCOUNT_ID and LOGWEAVE_S3_CFN_TEMPLATE_URL.',
          )
        }
        const body = req.body as z.infer<typeof quickCreateUrlSchema>
        const externalId = generateExternalId()
        const url = buildQuickCreateUrl({
          logweaveAccountId: deps.awsAccountId,
          templateUrl: deps.s3CfnTemplateUrl,
          bucket: body.bucket,
          prefix: body.prefix,
          region: body.region,
          externalId,
          roleName: body.roleName,
          stackName: body.stackName,
        })
        respond(res, { url, externalId, region: body.region })
      } catch (err) {
        next(err)
      }
    },
  )

  // POST /connectors — create a connector
  router.post(
    '/connectors',
    requireAdmin,
    validateBody(createConnectorSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const body = req.body as z.infer<typeof createConnectorSchema>
        const connectorId = uuidv7()

        await insertConnector(deps.db, tenantId, {
          connectorId,
          name: body.name,
          type: body.config.type,
          config: await encrypt(JSON.stringify(body.config), deps.encryptionKey),
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
    },
  )

  // GET /connectors — list connectors for tenant
  router.get('/connectors', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const rows = await listConnectors(deps.db, tenantId)

      const data = await Promise.all(
        rows.map(async (r) => ({
          connectorId: r.connector_id,
          name: r.name,
          type: r.type,
          config: redactConfig(await decrypt(r.config, deps.encryptionKey)),
          createdAt: r.created_at,
        })),
      )

      respond(res, data, { count: data.length })
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
        throw notFound('Connector not found')
      }

      const config = JSON.parse(await decrypt(row.config, deps.encryptionKey)) as ConnectorConfig
      const adapter = getAdapter(config.type)
      const result = await adapter.testConnection(config)

      respond(res, result)
    } catch (err) {
      next(err)
    }
  })

  // DELETE /connectors/:id — remove connector
  router.delete('/connectors/:id', requireAdmin, async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const connectorId = req.params.id as string

      const row = await getConnector(deps.db, tenantId, connectorId)
      if (!row) {
        throw notFound('Connector not found')
      }

      await deleteConnector(deps.db, tenantId, connectorId)
      res.status(HttpStatus.NO_CONTENT).send()
    } catch (err) {
      next(err)
    }
  })

  return router
}
