import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { getAdapter } from '../connectors/shared.js'
import type { ConnectorConfig, RawLogResult, S3ConnectorConfig } from '../connectors/types.js'
import { SCAN_DEFAULTS } from '../connectors/types.js'
import { decrypt } from '../crypto.js'
import { getArchiveSourceRefs } from '../db/archive-queries.js'
import type { DbClient } from '../db/client.js'
import { getConnector, listConnectors } from '../db/connector-queries.js'
import { notFound } from '../errors.js'
import { respond } from '../lib/respond.js'
import { getTenantId } from '../middleware/auth.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface RawLogsDeps {
  db: DbClient
  logger: pino.Logger
  encryptionKey?: string
  /**
   * The customer's durable-archive bucket (epic #265). When set, drill-down
   * reads archived objects by source_ref before falling back to connectors.
   */
  archiveConfig?: S3ConnectorConfig
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

const rawLogsQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .min(1)
    .max(SCAN_DEFAULTS.maxHours)
    .default(SCAN_DEFAULTS.defaultHours),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SCAN_DEFAULTS.maxLimit)
    .default(SCAN_DEFAULTS.defaultLimit),
  service: z.string().min(1),
  connectorId: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface RawLogEntry {
  message: string
  timestamp?: string
  source: string
  sourceUrl?: string
}

interface RawLogsData {
  lines: RawLogEntry[]
  filesScanned: number
  bytesScanned: number
  truncated: boolean
  truncatedReason?: string
}

// ---------------------------------------------------------------------------
// Template text lookup
// ---------------------------------------------------------------------------

const TEMPLATE_TEXT_QUERY = `
SELECT template_text
FROM logweave.template_registry FINAL
WHERE tenant_id = {tenant_id:String}
  AND template_id = {template_id:String}
LIMIT 1`

async function getTemplateText(
  db: DbClient,
  tenantId: string,
  templateId: string,
): Promise<string | undefined> {
  const rows = await db.query<{ template_text: string }>({
    query: TEMPLATE_TEXT_QUERY,
    query_params: { tenant_id: tenantId, template_id: templateId },
  })
  return rows[0]?.template_text
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function rawLogsRoutes(deps: RawLogsDeps): Router {
  const router = Router()

  // GET /templates/:id/raw-logs — fetch raw log lines matching a template
  router.get(
    '/templates/:id/raw-logs',
    validateQuery(rawLogsQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const templateId = req.params.id as string
        const params = getQuery<z.infer<typeof rawLogsQuerySchema>>(req)

        // Look up template text (needed by both the archive and connector paths).
        const templateText = await getTemplateText(deps.db, tenantId, templateId)
        if (!templateText) {
          throw notFound(`Template ${templateId} not found`)
        }

        const now = new Date()
        const start = new Date(now.getTime() - params.hours * 3_600_000)

        let result: RawLogResult | undefined

        // 1. Durable archive (epic #265): the customer's own S3 bucket is the
        // system of record. Drill down by the exact source_ref keys recorded in
        // log_metadata — no connector setup required.
        if (deps.archiveConfig) {
          const sourceRefs = await getArchiveSourceRefs(deps.db, tenantId, {
            templateId,
            service: params.service,
            hours: params.hours,
            maxFiles: SCAN_DEFAULTS.maxFiles,
          })
          if (sourceRefs.length > 0) {
            result = await getAdapter('s3').fetchRawLogs({
              config: deps.archiveConfig,
              templateText,
              service: params.service,
              timeRange: { start, end: now },
              limit: params.limit,
              sourceRefs,
            })
          }
        }

        // 2. Fall back to a user-configured external connector (ADR-010).
        if (!result) {
          let connectorConfig: ConnectorConfig | undefined
          let resolvedConnectorId: string | undefined

          if (params.connectorId) {
            const row = await getConnector(deps.db, tenantId, params.connectorId)
            if (!row) {
              throw notFound('Connector not found')
            }
            connectorConfig = JSON.parse(
              await decrypt(row.config, deps.encryptionKey),
            ) as ConnectorConfig
            resolvedConnectorId = params.connectorId
          } else {
            // Use first connector for tenant (default)
            const connectors = await listConnectors(deps.db, tenantId)
            const first = connectors[0]
            if (first) {
              connectorConfig = JSON.parse(
                await decrypt(first.config, deps.encryptionKey),
              ) as ConnectorConfig
              resolvedConnectorId = first.connector_id
            }
          }

          // Graceful degradation when neither archive nor a connector applies.
          if (!connectorConfig) {
            respond(
              res,
              {
                lines: [],
                filesScanned: 0,
                bytesScanned: 0,
                truncated: false,
              } as RawLogsData,
              {
                hours: params.hours,
                count: 0,
                message:
                  'Raw log drill-down unavailable — no archived logs for this template yet and no connector configured. Connect a log source in Settings > Connectors, or wait for logs to land in the archive.',
              },
            )
            return
          }

          result = await getAdapter(connectorConfig.type).fetchRawLogs({
            config: connectorConfig,
            templateText,
            service: params.service,
            timeRange: { start, end: now },
            limit: params.limit,
            auditContext:
              resolvedConnectorId && deps.encryptionKey
                ? {
                    tenantId,
                    connectorId: resolvedConnectorId,
                    sessionNameSecret: deps.encryptionKey,
                  }
                : undefined,
          })
        }

        const data: RawLogsData = {
          lines: result.lines,
          filesScanned: result.filesScanned,
          bytesScanned: result.bytesScanned,
          truncated: result.truncated,
          truncatedReason: result.truncatedReason,
        }

        const meta: Record<string, unknown> & { hours: number } = {
          hours: params.hours,
          limit: params.limit,
          count: result.lines.length,
        }

        if (result.truncated) {
          meta.message = `Scan stopped after ${result.filesScanned} files (${result.truncatedReason}). Narrow your time window for more complete results.`
        }

        respond(res, data, meta)
      } catch (err) {
        next(err)
      }
    },
  )

  return router
}
