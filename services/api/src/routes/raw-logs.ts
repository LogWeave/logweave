import { type Response, Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { S3Adapter } from '../connectors/s3-adapter.js'
import type { ConnectorConfig } from '../connectors/types.js'
import { SCAN_DEFAULTS } from '../connectors/types.js'
import type { DbClient } from '../db/client.js'
import { getConnector, listConnectors } from '../db/connector-queries.js'
import { DATA_RETENTION, formatTimeRange } from '../format.js'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'
import type { ApiResponse } from './dashboard-types.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface RawLogsDeps {
  db: DbClient
  logger: pino.Logger
}

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

const rawLogsQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(SCAN_DEFAULTS.maxHours).default(SCAN_DEFAULTS.defaultHours),
  limit: z.coerce.number().int().min(1).max(SCAN_DEFAULTS.maxLimit).default(SCAN_DEFAULTS.defaultLimit),
  service: z.string().min(1),
  connector_id: z.string().optional(),
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
// Response helper
// ---------------------------------------------------------------------------

function respond<T>(
  res: Response,
  data: T,
  meta: Omit<ApiResponse<T>['meta'], 'fetchedAt' | 'timeRange' | 'dataRetention'>,
): void {
  const body: ApiResponse<T> = {
    data,
    meta: {
      ...meta,
      fetchedAt: new Date().toISOString(),
      timeRange: formatTimeRange(meta.hours),
      dataRetention: DATA_RETENTION,
    },
  }
  res.status(HttpStatus.OK).json(body)
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

const s3Adapter = new S3Adapter()

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
  router.get('/templates/:id/raw-logs', validateQuery(rawLogsQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const templateId = req.params.id as string
      const params = getQuery<z.infer<typeof rawLogsQuerySchema>>(req)

      // Resolve connector
      let connectorConfig: ConnectorConfig | undefined

      if (params.connector_id) {
        const row = await getConnector(deps.db, tenantId, params.connector_id)
        if (!row) {
          res.status(HttpStatus.NOT_FOUND).json({
            error: { code: 'NOT_FOUND', message: 'Connector not found' },
          })
          return
        }
        connectorConfig = JSON.parse(row.config) as ConnectorConfig
      } else {
        // Use first connector for tenant (default)
        const connectors = await listConnectors(deps.db, tenantId)
        const first = connectors[0]
        if (first) {
          connectorConfig = JSON.parse(first.config) as ConnectorConfig
        }
      }

      // Graceful degradation when no connector configured
      if (!connectorConfig) {
        respond(res, {
          lines: [],
          filesScanned: 0,
          bytesScanned: 0,
          truncated: false,
        } as RawLogsData, {
          hours: params.hours,
          count: 0,
          message: 'No log source connector configured. Set up an S3 connector via POST /v1/connectors to enable raw log drill-down.',
        })
        return
      }

      // Look up template text
      const templateText = await getTemplateText(deps.db, tenantId, templateId)
      if (!templateText) {
        res.status(HttpStatus.NOT_FOUND).json({
          error: { code: 'NOT_FOUND', message: `Template ${templateId} not found` },
        })
        return
      }

      // Fetch raw logs
      const now = new Date()
      const start = new Date(now.getTime() - params.hours * 3_600_000)

      const result = await s3Adapter.fetchRawLogs({
        config: connectorConfig,
        templateText,
        service: params.service,
        timeRange: { start, end: now },
        limit: params.limit,
      })

      const data: RawLogsData = {
        lines: result.lines,
        filesScanned: result.filesScanned,
        bytesScanned: result.bytesScanned,
        truncated: result.truncated,
        truncatedReason: result.truncatedReason,
      }

      const meta: Omit<ApiResponse<RawLogsData>['meta'], 'fetchedAt' | 'timeRange' | 'dataRetention'> = {
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
  })

  return router
}
