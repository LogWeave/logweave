import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { getAdapter } from '../connectors/shared.js'
import type { ConnectorConfig } from '../connectors/types.js'
import { SCAN_DEFAULTS } from '../connectors/types.js'
import { decrypt } from '../crypto.js'
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

        // Resolve connector
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

        // Graceful degradation when no connector configured
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
                'Raw log drill-down unavailable — no connector configured. Connect a log source in Settings > Connectors to enable.',
            },
          )
          return
        }

        // Look up template text
        const templateText = await getTemplateText(deps.db, tenantId, templateId)
        if (!templateText) {
          throw notFound(`Template ${templateId} not found`)
        }

        // Fetch raw logs
        const now = new Date()
        const start = new Date(now.getTime() - params.hours * 3_600_000)

        const adapter = getAdapter(connectorConfig.type)
        const result = await adapter.fetchRawLogs({
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
