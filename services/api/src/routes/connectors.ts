import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { buildQuickCreateUrl, generateExternalId } from '../connectors/s3-cfn-url.js'
import { defaultAllowedHosts, isBlockedHostname } from '../connectors/safe-fetch.js'
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
  /** Required: connectors encrypt/decrypt their stored config with this key. */
  encryptionKey: string
  /** LogWeave's AWS account ID (the trusted principal in CFN trust policies). */
  awsAccountId?: string
  /** Public HTTPS URL of the S3 connector CFN template. */
  s3CfnTemplateUrl?: string
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

// SSRF prevention (create-time, host-string check). Fast feedback only; for the
// Loki/Elasticsearch URLs the authoritative guard runs at fetch-time in
// safe-fetch.ts, which resolves DNS and re-validates every redirect against the
// resolved IP. Internal targets are blocked unless explicitly allowlisted via
// LOGWEAVE_CONNECTOR_ALLOWED_HOSTS — there is no NODE_ENV bypass. The S3
// `endpoint` reuses this create-time check AND, because it reaches S3 through
// the AWS SDK (its own DNS), is additionally guarded at connect time via
// connectors/guarded-s3.ts — the same resolved-IP rebinding guard as the Loki/ES
// fetch path (#286). Production should still use IAM AssumeRole (no endpoint).
function externalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (defaultAllowedHosts().has(u.hostname.toLowerCase())) return true
    return !isBlockedHostname(u.hostname)
  } catch {
    return false
  }
}

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
      .regex(
        /^arn:(aws|aws-cn|aws-us-gov):iam::\d{12}:role\/[\w+=,.@\-/]+$/,
        'roleArn must be a valid IAM role ARN',
      )
      .max(2048)
      .optional(),
    externalId: z.string().min(16).max(256).optional(),
    // endpoint, forcePathStyle, accessKeyId, secretAccessKey — for pointing at
    // an S3-compatible emulator like Floci/MinIO. The endpoint host is
    // SSRF-validated (same check as the Loki/ES URLs) rather than gated on
    // NODE_ENV: an unset NODE_ENV under the base docker-compose used to let
    // internal targets through (LW-281 F2). Production normally uses IAM
    // AssumeRole (no endpoint) — see ADR-010.
    endpoint: z
      .string()
      .url()
      .max(1024)
      .refine(externalUrl, {
        message:
          'endpoint must point to an external host. Loopback, link-local, and private ranges are ' +
          'blocked (SSRF prevention); allowlist a host with LOGWEAVE_CONNECTOR_ALLOWED_HOSTS for ' +
          'local development (e.g. a Floci/MinIO emulator).',
      })
      .optional(),
    forcePathStyle: z.boolean().optional(),
    accessKeyId: z.string().max(128).optional(),
    secretAccessKey: z.string().max(128).optional(),
  })
  .refine(
    (c) => {
      // secretAccessKey only allowed with endpoint (dev mode)
      if (c.secretAccessKey && !c.endpoint) return false
      return true
    },
    { message: 'secretAccessKey is only allowed with endpoint (dev mode)' },
  )
  .refine(
    (c) => {
      // accessKeyId only allowed with endpoint
      if (c.accessKeyId && !c.endpoint) return false
      return true
    },
    { message: 'accessKeyId is only allowed with endpoint (dev mode)' },
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
      // roleArn and endpoint are mutually exclusive (AssumeRole vs dev endpoint)
      if (c.roleArn && c.endpoint) return false
      return true
    },
    { message: 'roleArn and endpoint are mutually exclusive — use one or the other' },
  )

const externalUrlSchema = z
  .string()
  .url()
  .max(1024)
  .refine(externalUrl, {
    message:
      'URL must point to an external host. Loopback, link-local, and private ranges are blocked ' +
      '(SSRF prevention); allowlist a host with LOGWEAVE_CONNECTOR_ALLOWED_HOSTS for local development.',
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

// A LogQL stream selector is `{label=~"value", ...}` with one or more label
// matchers. Validating the grammar (rather than just a length cap) stops a
// crafted selector from appending arbitrary LogQL — the selector is
// string-interpolated into the query, so `{app="x"} |~ "..."` must not pass.
const LOKI_LABEL_MATCHER = '[a-zA-Z_][a-zA-Z0-9_]*\\s*(?:=~|!~|=|!=)\\s*"(?:[^"\\\\]|\\\\.)*"'
const LOKI_STREAM_SELECTOR = new RegExp(
  `^\\{\\s*${LOKI_LABEL_MATCHER}(?:\\s*,\\s*${LOKI_LABEL_MATCHER})*\\s*\\}$`,
)

const lokiConfigSchema = z.object({
  type: z.literal('loki'),
  url: externalUrlSchema,
  streamSelector: z
    .string()
    .min(1)
    .max(1024)
    .refine((s) => LOKI_STREAM_SELECTOR.test(s), {
      message:
        'streamSelector must be a LogQL stream selector of label matchers, ' +
        'e.g. {app="payments", env=~"prod|staging"}.',
    }),
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

/**
 * Secrets that should never be returned in API responses. externalId is the
 * second factor in the IAM trust policy — combined with roleArn it lets the
 * holder assume the role, so we redact it from list/echo responses.
 */
const SECRET_KEYS = new Set(['secretAccessKey', 'accessKeyId', 'password', 'apiKey', 'externalId'])

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
  router.post('/connectors/:id/test', requireAdmin, async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const connectorId = req.params.id as string
      const row = await getConnector(deps.db, tenantId, connectorId)

      if (!row) {
        throw notFound('Connector not found')
      }

      const config = JSON.parse(await decrypt(row.config, deps.encryptionKey)) as ConnectorConfig
      const adapter = getAdapter(config.type)
      const result = await adapter.testConnection(config, {
        tenantId,
        connectorId,
        sessionNameSecret: deps.encryptionKey,
      })

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
