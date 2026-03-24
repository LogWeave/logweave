import { Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import type { DbClient } from '../db/client.js'
import {
  queryCorrelations,
  queryRelatedPatterns,
  queryServiceOutlier,
  queryTraceDetails,
} from '../db/correlation-queries.js'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import { respond } from '../lib/respond.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface CorrelationDeps {
  db: DbClient
  logger: pino.Logger
}

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const traceQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
})

const relatedQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

const correlationQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

const outlierQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).default(1),
})

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface TraceEvent {
  service: string
  templateId: string
  templateText: string
  level: string
  timestamp: string
  statusCode: number
  durationMs: number
  route: string
}

export interface RelatedPattern {
  templateId: string
  templateText: string
  service: string
  coOccurrenceCount: number
}

export interface Correlation {
  templateId: string
  templateText: string
  coefficient: number
  direction: 'positive' | 'negative'
  occurrenceCount: number
}

export interface ServiceOutlier {
  service: string
  currentRate: number
  currentErrors: number
  currentLogs: number
  baselineMean: number
  baselineStddev: number
  zScore: number
  verdict: 'normal' | 'elevated' | 'outlier'
  dataPoints: number
  warning?: string
}

// ---------------------------------------------------------------------------
// Z-score computation
// ---------------------------------------------------------------------------

const MIN_DATA_POINTS = 168

function computeOutlier(
  service: string,
  row: { data_points: string; baseline_mean: string; baseline_stddev: string; current_rate: string; current_errors: string; current_logs: string },
): ServiceOutlier {
  const dataPoints = Number(row.data_points) || 0
  const baselineMean = Number(row.baseline_mean) || 0
  const baselineStddev = Number(row.baseline_stddev) || 0
  const currentRate = Number(row.current_rate) || 0
  const currentErrors = Number(row.current_errors) || 0
  const currentLogs = Number(row.current_logs) || 0

  let zScore = 0
  if (baselineStddev > 0) {
    zScore = (currentRate - baselineMean) / baselineStddev
  }

  let verdict: 'normal' | 'elevated' | 'outlier' = 'normal'
  if (zScore > 2.0) verdict = 'outlier'
  else if (zScore > 1.5) verdict = 'elevated'

  const result: ServiceOutlier = {
    service,
    currentRate: Math.round(currentRate * 100) / 100,
    currentErrors,
    currentLogs,
    baselineMean: Math.round(baselineMean * 100) / 100,
    baselineStddev: Math.round(baselineStddev * 100) / 100,
    zScore: Math.round(zScore * 100) / 100,
    verdict,
    dataPoints,
  }

  if (dataPoints < MIN_DATA_POINTS) {
    result.warning = `Only ${dataPoints} hourly data points available (${MIN_DATA_POINTS} recommended for reliable z-score)`
  }

  return result
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function correlationRoutes(deps: CorrelationDeps): Router {
  const router = Router()

  // GET /traces/:traceId — events sharing a trace_id
  router.get('/traces/:traceId', validateQuery(traceQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const traceId = (req.params.traceId as string)?.trim()
      if (!traceId) {
        res.status(HttpStatus.BAD_REQUEST).json({
          error: { code: 'BAD_REQUEST', message: 'traceId parameter is required' },
        })
        return
      }

      const { hours } = getQuery<z.infer<typeof traceQuerySchema>>(req)
      const rows = await queryTraceDetails(deps.db, tenantId, { traceId, hours })

      if (rows.length === 0) {
        res.status(HttpStatus.NOT_FOUND).json({
          error: {
            code: 'NOT_FOUND',
            message: `Trace ${traceId} not found in the last ${hours} hours`,
          },
        })
        return
      }

      const data: TraceEvent[] = rows.map((r) => ({
        service: r.service,
        templateId: r.template_id,
        templateText: r.template_text,
        level: r.level,
        timestamp: r.timestamp,
        statusCode: Number(r.status_code) || 0,
        durationMs: Number(r.duration_ms) || 0,
        route: r.route,
      }))

      respond(res, data, { hours, count: data.length })
    } catch (err) {
      next(err)
    }
  })

  // GET /templates/:id/related — co-occurring templates in same traces
  router.get('/templates/:id/related', validateQuery(relatedQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const templateId = req.params.id as string
      const { hours, limit } = getQuery<z.infer<typeof relatedQuerySchema>>(req)

      const rows = await queryRelatedPatterns(deps.db, tenantId, {
        templateId,
        hours,
        limit,
      })

      const data: RelatedPattern[] = rows.map((r) => ({
        templateId: r.template_id,
        templateText: r.template_text,
        service: r.service,
        coOccurrenceCount: Number(r.co_occurrence_count) || 0,
      }))

      respond(res, data, { hours, limit, count: data.length })
    } catch (err) {
      next(err)
    }
  })

  // GET /templates/:id/correlations — Pearson correlation with top templates
  router.get('/templates/:id/correlations', validateQuery(correlationQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const templateId = req.params.id as string
      const { hours, limit } = getQuery<z.infer<typeof correlationQuerySchema>>(req)

      const rows = await queryCorrelations(deps.db, tenantId, {
        templateId,
        hours,
        limit,
      })

      const data: Correlation[] = rows.map((r) => {
        const coefficient = Number(r.coefficient) || 0
        return {
          templateId: r.template_id,
          templateText: r.template_text,
          coefficient: Math.round(coefficient * 1000) / 1000,
          direction: coefficient >= 0 ? 'positive' : 'negative',
          occurrenceCount: Number(r.occurrence_count) || 0,
        }
      })

      respond(res, data, { hours, limit, count: data.length })
    } catch (err) {
      next(err)
    }
  })

  // GET /services/:name/outlier — z-score of current error rate vs baseline
  router.get('/services/:name/outlier', validateQuery(outlierQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const service = req.params.name as string
      const { hours } = getQuery<z.infer<typeof outlierQuerySchema>>(req)

      const rows = await queryServiceOutlier(deps.db, tenantId, { service, hours })

      const row = rows[0]
      const data = row
        ? computeOutlier(service, row)
        : computeOutlier(service, {
            data_points: '0',
            baseline_mean: '0',
            baseline_stddev: '0',
            current_rate: '0',
            current_errors: '0',
            current_logs: '0',
          })

      respond(res, data, { hours, count: 1 })
    } catch (err) {
      next(err)
    }
  })

  return router
}
