/**
 * Composite API endpoints — designed for MCP server and external API consumers.
 * Each endpoint combines multiple ClickHouse queries into a single response,
 * reducing round-trips for LLM tool calls.
 */

import { Router } from 'express'
import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import {
  queryDashboardOverviewAggregates,
  queryDashboardOverviewCounts,
} from '../db/dashboard/overview.js'
import { queryDashboardServices } from '../db/dashboard/services.js'
import { queryTemplateStatusCodes } from '../db/dashboard/status-codes.js'
import { queryTemplateSparklines, queryTemplatesAcrossServices } from '../db/dashboard/templates.js'
import { queryDashboardVolume } from '../db/dashboard/volume.js'
import { notFound } from '../errors.js'
import { truncateTemplateText } from '../format.js'
import { respond } from '../lib/respond.js'
import { getTenantId } from '../middleware/auth.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'
import { mapCrossServiceTemplates, toRawRows } from './dashboard.js'
import {
  type CompositeTimeQuery,
  compositeTimeSchema,
  type OverviewCompositeData,
  type ServiceHealthData,
  type TemplateDetailData,
} from './dashboard-types.js'

export interface CompositeDeps {
  db: DbClient
  logger: pino.Logger
  anomalyScorer?: import('../pipeline/anomaly-scorer.js').AnomalyScorer
}

export function compositeRoutes(deps: CompositeDeps): Router {
  const router = Router()

  // GET /templates/:id/detail
  router.get(
    '/templates/:id/detail',
    validateQuery(compositeTimeSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<CompositeTimeQuery>(req)
        const templateId = req.params.id as string
        const levels = params.level as string[] | undefined

        const [templateRows, sparklineRows, statusCodeRows] = await Promise.all([
          queryTemplatesAcrossServices(deps.db, tenantId, {
            hours: params.hours,
            level: levels,
            templateId,
            limit: 1,
          }),
          queryTemplateSparklines(deps.db, tenantId, {
            hours: params.hours,
            templateIds: [templateId],
            level: levels,
          }),
          queryTemplateStatusCodes(deps.db, tenantId, {
            hours: params.hours,
            templateId,
          }),
        ])

        const rawTemplates = toRawRows(templateRows)
        const match = rawTemplates.find((r) => r.template_id === templateId)

        if (!match) {
          throw notFound(`Template ${templateId} not found in the last ${params.hours} hours`)
        }

        const { text: truncatedText, truncated } = truncateTemplateText(
          match.template_text as string,
        )
        const data: TemplateDetailData = {
          templateId: match.template_id as string,
          templateText: truncatedText,
          truncated,
          servicesAffected: match.services_affected as string[],
          occurrenceCount: Number(match.occurrence_count),
          errorCount: Number(match.error_count),
          avgDurationMs: Number(match.avg_duration_ms),
          maxAnomalyScore: Number(match.max_anomaly_score),
          firstSeen: match.first_seen as string,
          lastSeen: match.last_seen as string,
          sparkline: toRawRows(sparklineRows).map((r) => ({
            intervalStart: r.interval_start as string,
            count: Number(r.count),
          })),
          statusCodes: toRawRows(statusCodeRows).map((r) => ({
            statusCode: Number(r.status_code),
            count: Number(r.count),
          })),
        }

        respond(res, data, { hours: params.hours, count: 1 })
      } catch (err) {
        next(err)
      }
    },
  )

  // GET /services/:name/health
  router.get(
    '/services/:name/health',
    validateQuery(compositeTimeSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<CompositeTimeQuery>(req)
        const serviceName = req.params.name as string
        const levels = params.level as string[] | undefined

        const [serviceRows, templateRows, volumeRows] = await Promise.all([
          queryDashboardServices(deps.db, tenantId, {
            hours: params.hours,
            limit: 100,
            level: levels,
          }),
          queryTemplatesAcrossServices(deps.db, tenantId, {
            hours: params.hours,
            service: serviceName,
            level: ['ERROR'],
            limit: 5,
          }),
          queryDashboardVolume(deps.db, tenantId, {
            hours: params.hours,
            service: serviceName,
            level: levels,
          }),
        ])

        const rawServices = toRawRows(serviceRows)
        const match = rawServices.find((r) => r.service === serviceName)

        if (!match) {
          throw notFound(`Service ${serviceName} not found in the last ${params.hours} hours`)
        }

        const logCount = Number(match.log_count)
        const errorCount = Number(match.error_count)
        const warnCount = Number(match.warn_count)
        const silent = deps.anomalyScorer
          ? deps.anomalyScorer
              .getServiceSilenceScores(tenantId)
              .some((s) => s.service === serviceName)
          : false

        const data: ServiceHealthData = {
          service: serviceName,
          logCount,
          errorCount,
          warnCount,
          errorRate: logCount > 0 ? Math.round((errorCount / logCount) * 10000) / 10000 : 0,
          warnRate: logCount > 0 ? Math.round((warnCount / logCount) * 10000) / 10000 : 0,
          topErrorPatterns: mapCrossServiceTemplates(toRawRows(templateRows)),
          volumeTrend: toRawRows(volumeRows).map((r) => ({
            intervalStart: r.interval_start as string,
            logCount: Number(r.log_count),
            errorCount: Number(r.error_count),
          })),
          silent,
        }

        respond(res, data, { hours: params.hours, count: 1 })
      } catch (err) {
        next(err)
      }
    },
  )

  // GET /overview
  router.get('/overview', validateQuery(compositeTimeSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<CompositeTimeQuery>(req)
      const levels = params.level as string[] | undefined

      const [aggregates, counts, topPatterns] = await Promise.all([
        queryDashboardOverviewAggregates(deps.db, tenantId, {
          hours: params.hours,
          level: levels,
        }),
        queryDashboardOverviewCounts(deps.db, tenantId, {
          hours: params.hours,
          level: levels,
        }),
        queryTemplatesAcrossServices(deps.db, tenantId, {
          hours: params.hours,
          level: ['ERROR'],
          limit: 5,
        }),
      ])

      const rawAgg = toRawRows([aggregates])[0] ?? {}
      const rawCounts = toRawRows([counts])[0] ?? {}
      const totalEvents = Number(rawAgg.total_events ?? 0)
      const errorCount = Number(rawAgg.error_count ?? 0)

      const data: OverviewCompositeData = {
        totalEvents,
        totalTemplates: Number(rawCounts.unique_templates ?? 0),
        newTemplatesToday: Number(rawAgg.new_template_count ?? 0),
        unclusteredCount: Number(rawCounts.unclustered_count ?? 0),
        errorRate: totalEvents > 0 ? Math.round((errorCount / totalEvents) * 10000) / 10000 : 0,
        serviceCount: Number(rawCounts.service_count ?? 0),
        topErrorPatterns: mapCrossServiceTemplates(toRawRows(topPatterns)),
      }

      respond(res, data, { hours: params.hours, count: 1 })
    } catch (err) {
      next(err)
    }
  })

  return router
}
