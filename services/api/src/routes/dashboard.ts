import { type Response, Router } from 'express'
import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import {
  queryNewTemplates,
  queryResolvedTemplates,
  queryTemplateSpikes,
} from '../db/dashboard-changes-queries.js'
import { queryDeployById } from '../db/deploy-queries.js'
import { DATA_RETENTION, formatTimeRange, truncateTemplateText } from '../format.js'
import {
  queryClusteringHealthSnapshot,
  queryClusteringHealthTrend,
  queryDashboardOverviewAggregates,
  queryDashboardOverviewCounts,
  queryDashboardServices,
  queryDashboardTemplates,
  queryDashboardVolume,
  queryLevelDistribution,
  queryNewTodayIds,
  querySemanticSearch,
  queryTemplateTrend,
  queryTemplateSearch,
  queryTemplateSparklines,
  queryTemplateStatusCodes,
  queryTemplatesAcrossServices,
} from '../db/dashboard-queries.js'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'
import {
  type ApiResponse,
  type ChangeEvent,
  type ChangesQuery,
  type ClusteringHealthData,
  type ClusteringHealthQuery,
  type LevelCount,
  type LevelsQuery,
  type StatusCodeCount,
  type TemplateStatusCodesQuery,
  changesQuerySchema,
  clusteringHealthQuerySchema,
  levelsQuerySchema,
  type OverviewData,
  type OverviewQuery,
  overviewQuerySchema,
  type ServiceRow,
  type ServicesQuery,
  type SparklineData,
  type SparklineQuery,
  servicesQuerySchema,
  sparklineQuerySchema,
  type CompositeTimeQuery,
  type CrossServiceTemplate,
  type OverviewCompositeData,
  type ServiceHealthData,
  type TemplateDetailData,
  type TemplateRow,
  type TemplateSearchQuery,
  type TemplateTrendQuery,
  type TemplatesQuery,
  compositeTimeSchema,
  templateSearchSchema,
  templateTrendSchema,
  templateStatusCodesQuerySchema,
  templatesQuerySchema,
  type VolumeData,
  type VolumePoint,
  type VolumeQuery,
  volumeQuerySchema,
} from './dashboard-types.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  db: DbClient
  logger: pino.Logger
  clusterClient?: import('../pipeline/cluster-client.js').ClusterClient
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function respond<T>(res: Response, data: T, meta: Omit<ApiResponse<T>['meta'], 'fetchedAt' | 'timeRange' | 'dataRetention'>): void {
  const hours = meta.hours
  const body: ApiResponse<T> = {
    data,
    meta: {
      ...meta,
      fetchedAt: new Date().toISOString(),
      timeRange: formatTimeRange(hours),
      dataRetention: DATA_RETENTION,
    },
  }
  res.status(HttpStatus.OK).json(body)
}

// ---------------------------------------------------------------------------
// ClickHouse row casting
// ---------------------------------------------------------------------------

// ClickHouse JSONEachRow returns numbers as strings. The DB layer types them
// as `number` for convenience, but we must call Number() on every numeric
// field to coerce correctly. Using `as unknown as Record<string, unknown>`
// once per result set lets the mapping helpers access raw string values safely.

type RawRow = Record<string, unknown>

function toRawRows(rows: unknown[]): RawRow[] {
  return rows as RawRow[]
}

/**
 * Map cross-service template rows with LLM-friendly formatting:
 * - Truncate template text to 200 chars
 * - Add trend text (rising/falling/stable/new)
 */
function mapCrossServiceTemplates(rows: RawRow[]): CrossServiceTemplate[] {
  return rows.map((r) => {
    const { text, truncated } = truncateTemplateText(r.template_text as string)
    return {
      templateId: r.template_id as string,
      templateText: text,
      truncated,
      servicesAffected: r.services_affected as string[],
      occurrenceCount: Number(r.occurrence_count),
      errorCount: Number(r.error_count),
      avgDurationMs: Number(r.avg_duration_ms),
      maxAnomalyScore: Number(r.max_anomaly_score),
      firstSeen: r.first_seen as string,
      lastSeen: r.last_seen as string,
    }
  })
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function mapTemplateRows(rows: RawRow[], newTodayIds: Set<string>): TemplateRow[] {
  return rows.map((r) => ({
    templateId: r.template_id as string,
    templateText: r.template_text as string,
    service: r.service as string,
    occurrenceCount: Number(r.occurrence_count),
    errorCount: Number(r.error_count),
    avgDurationMs: Number(r.avg_duration_ms),
    maxAnomalyScore: Number(r.max_anomaly_score),
    isNewToday: newTodayIds.has(r.template_id as string),
    firstSeen: r.first_seen as string,
    lastSeen: r.last_seen as string,
  }))
}

function mapServiceRows(rows: RawRow[]): ServiceRow[] {
  return rows.map((r) => {
    const logCount = Number(r.log_count)
    const errorCount = Number(r.error_count)
    const warnCount = Number(r.warn_count)
    return {
      service: r.service as string,
      logCount,
      errorCount,
      warnCount,
      errorRate: logCount > 0 ? (errorCount / logCount) * 100 : 0,
      warnRate: logCount > 0 ? (warnCount / logCount) * 100 : 0,
      newTemplateCount: Number(r.new_template_count),
      avgAnomalyScore: Number(r.avg_anomaly_score),
    }
  })
}

function mapVolumeRows(rows: RawRow[]): VolumePoint[] {
  return rows.map((r) => ({
    intervalStart: r.interval_start as string,
    service: r.service as string,
    logCount: Number(r.log_count),
    errorCount: Number(r.error_count),
  }))
}

function mapSparklineRows(rows: RawRow[]): SparklineData {
  const result: SparklineData = {}
  for (const r of rows) {
    const templateId = r.template_id as string
    if (!result[templateId]) {
      result[templateId] = []
    }
    result[templateId].push({
      intervalStart: r.interval_start as string,
      count: Number(r.count),
    })
  }
  return result
}

// ---------------------------------------------------------------------------
// Change event mapping helpers
// ---------------------------------------------------------------------------

function mapNewEvents(rows: RawRow[]): ChangeEvent[] {
  return rows.map((r) => ({
    type: 'new' as const,
    templateId: r.template_id as string,
    templateText: r.template_text as string,
    service: r.service as string,
    currentCount: Number(r.occurrence_count),
    previousCount: 0,
    ratio: 999,
    firstSeen: r.first_seen as string,
  }))
}

function mapSpikeEvents(rows: RawRow[]): ChangeEvent[] {
  return rows.map((r) => ({
    type: 'spike' as const,
    templateId: r.template_id as string,
    templateText: r.template_text as string,
    service: r.service as string,
    currentCount: Number(r.current_count),
    previousCount: Number(r.previous_count),
    ratio: Number(r.spike_ratio),
  }))
}

function mapResolvedEvents(rows: RawRow[]): ChangeEvent[] {
  return rows.map((r) => ({
    type: 'resolved' as const,
    templateId: r.template_id as string,
    templateText: r.template_text as string,
    service: r.service as string,
    currentCount: 0,
    previousCount: Number(r.prev_count),
    ratio: 0,
    lastSeen: r.last_seen as string,
  }))
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function dashboardRoutes(deps: DashboardDeps): Router {
  const router = Router()

  // 1. GET /dashboard/templates
  router.get(
    '/dashboard/templates',
    validateQuery(templatesQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<TemplatesQuery>(req)

        const [rows, newTodayIdList] = await Promise.all([
          queryDashboardTemplates(deps.db, tenantId, {
            hours: params.hours,
            limit: params.limit,
            service: params.service,
            level: params.level,
          }),
          queryNewTodayIds(deps.db, tenantId, { level: params.level }),
        ])

        const newTodayIds = new Set(newTodayIdList)
        const data = mapTemplateRows(toRawRows(rows), newTodayIds)

        respond(res, data, { hours: params.hours, limit: params.limit, count: data.length })
      } catch (err) {
        next(err)
      }
    },
  )

  // 2. GET /dashboard/services
  router.get('/dashboard/services', validateQuery(servicesQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<ServicesQuery>(req)

      const rows = await queryDashboardServices(deps.db, tenantId, {
        hours: params.hours,
        limit: params.limit,
        level: params.level,
      })

      const data = mapServiceRows(toRawRows(rows))

      respond(res, data, { hours: params.hours, limit: params.limit, count: data.length })
    } catch (err) {
      next(err)
    }
  })

  // 3. GET /dashboard/volume
  router.get('/dashboard/volume', validateQuery(volumeQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<VolumeQuery>(req)

      const currentPromise = queryDashboardVolume(deps.db, tenantId, {
        hours: params.hours,
        service: params.service,
        level: params.level,
      })

      const previousPromise =
        params.offset > 0
          ? queryDashboardVolume(deps.db, tenantId, {
              hours: params.hours,
              service: params.service,
              offset: params.offset,
              level: params.level,
            })
          : undefined

      const [currentRows, previousRows] = await Promise.all([currentPromise, previousPromise])

      const data: VolumeData = {
        current: mapVolumeRows(toRawRows(currentRows)),
        ...(previousRows ? { previous: mapVolumeRows(toRawRows(previousRows)) } : {}),
      }

      respond(res, data, { hours: params.hours, count: data.current.length })
    } catch (err) {
      next(err)
    }
  })

  // 4. GET /dashboard/overview
  router.get('/dashboard/overview', validateQuery(overviewQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<OverviewQuery>(req)
      const queryOpts = { hours: params.hours, level: params.level }

      const queries: Promise<unknown>[] = [
        queryDashboardOverviewAggregates(deps.db, tenantId, queryOpts),
        queryDashboardOverviewCounts(deps.db, tenantId, queryOpts),
      ]

      if (params.compare) {
        const prevOpts = { ...queryOpts, offsetHours: params.hours }
        queries.push(
          queryDashboardOverviewAggregates(deps.db, tenantId, prevOpts),
          queryDashboardOverviewCounts(deps.db, tenantId, prevOpts),
        )
      }

      const results = await Promise.all(queries)

      const agg = results[0] as unknown as RawRow
      const counts = results[1] as unknown as RawRow
      const totalEvents = Number(agg.total_events)
      const errorCount = Number(agg.error_count)

      const data: OverviewData = {
        totalEvents,
        totalTemplates: Number(counts.unique_templates),
        newTemplatesToday: Number(agg.new_template_count),
        unclusteredCount: Number(counts.unclustered_count),
        errorRate: totalEvents > 0 ? (errorCount / totalEvents) * 100 : 0,
        serviceCount: Number(counts.service_count),
      }

      if (params.compare && results.length === 4) {
        const prevAgg = results[2] as unknown as RawRow
        const prevCounts = results[3] as unknown as RawRow
        const prevTotalEvents = Number(prevAgg.total_events)
        const prevErrorCount = Number(prevAgg.error_count)

        data.previous = {
          totalEvents: prevTotalEvents,
          totalTemplates: Number(prevCounts.unique_templates),
          newTemplatesToday: Number(prevAgg.new_template_count),
          unclusteredCount: Number(prevCounts.unclustered_count),
          errorRate: prevTotalEvents > 0 ? (prevErrorCount / prevTotalEvents) * 100 : 0,
          serviceCount: Number(prevCounts.service_count),
        }
      }

      respond(res, data, { hours: params.hours, count: 1 })
    } catch (err) {
      next(err)
    }
  })

  // 5. GET /dashboard/template-sparklines
  router.get(
    '/dashboard/template-sparklines',
    validateQuery(sparklineQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<SparklineQuery>(req)

        const rows = await queryTemplateSparklines(deps.db, tenantId, {
          hours: params.hours,
          templateIds: params.template_ids,
          level: params.level,
        })

        const data = mapSparklineRows(toRawRows(rows))

        respond(res, data, { hours: params.hours, count: Object.keys(data).length })
      } catch (err) {
        next(err)
      }
    },
  )

  // 6. GET /dashboard/clustering-health
  router.get(
    '/dashboard/clustering-health',
    validateQuery(clusteringHealthQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<ClusteringHealthQuery>(req)

        const [snapshotRaw, trendRows] = await Promise.all([
          queryClusteringHealthSnapshot(deps.db, tenantId, { hours: params.hours, level: params.level }),
          queryClusteringHealthTrend(deps.db, tenantId, { hours: params.hours, level: params.level }),
        ])

        const snapshot = snapshotRaw as unknown as RawRow
        const totalEvents = Number(snapshot.total_events)
        const uniqueTemplates = Number(snapshot.unique_templates)

        const data: ClusteringHealthData = {
          totalEvents,
          clusteredEvents: Number(snapshot.clustered_events),
          unclusteredEvents: Number(snapshot.unclustered_events),
          uniqueTemplates,
          compressionRatio: totalEvents > 0 ? uniqueTemplates / totalEvents : 0,
          trend: toRawRows(trendRows).map((r) => {
            const total = Number(r.total)
            const unclustered = Number(r.unclustered)
            return {
              intervalStart: r.interval_start as string,
              total,
              unclustered,
              ratio: total > 0 ? unclustered / total : 0,
            }
          }),
        }

        respond(res, data, { hours: params.hours, count: data.trend.length })
      } catch (err) {
        next(err)
      }
    },
  )

  // 7. GET /dashboard/changes
  router.get('/dashboard/changes', validateQuery(changesQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<ChangesQuery>(req)

      // Resolve deploy_id to since timestamp if provided
      let since = params.since
      if (params.deploy_id) {
        const deploy = await queryDeployById(deps.db, tenantId, params.deploy_id)
        if (!deploy) {
          res.status(HttpStatus.NOT_FOUND).json({
            error: { code: 'NOT_FOUND', message: `Deploy ${params.deploy_id} not found` },
          })
          return
        }
        since = deploy.timestamp
      }

      // Build query options with resolved since
      const queryOpts = since ? { ...params, since } : params

      // When since is provided, compute equivalent hours for meta
      const hours = since
        ? Math.ceil((Date.now() - new Date(since).getTime()) / 3_600_000)
        : params.hours

      const [newRows, spikeRows, resolvedRows] = await Promise.all([
        queryNewTemplates(deps.db, tenantId, queryOpts),
        queryTemplateSpikes(deps.db, tenantId, queryOpts),
        queryResolvedTemplates(deps.db, tenantId, queryOpts),
      ])

      const events: ChangeEvent[] = [
        ...mapNewEvents(toRawRows(newRows)),
        ...mapSpikeEvents(toRawRows(spikeRows)),
        ...mapResolvedEvents(toRawRows(resolvedRows)),
      ]

      // Sort by ratio descending (spikes first), then new, then resolved
      events.sort((a, b) => b.ratio - a.ratio)

      respond(res, events, {
        hours,
        limit: params.limit,
        count: events.length,
        ...(since ? { since } : {}),
      })
    } catch (err) {
      next(err)
    }
  })

  // 8. GET /dashboard/levels
  router.get('/dashboard/levels', validateQuery(levelsQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<LevelsQuery>(req)

      const rows = await queryLevelDistribution(deps.db, tenantId, {
        hours: params.hours,
        service: params.service,
      })

      const data: LevelCount[] = toRawRows(rows).map((r) => ({
        level: r.level as string,
        count: Number(r.count),
      }))

      respond(res, data, { hours: params.hours, count: data.length })
    } catch (err) {
      next(err)
    }
  })

  // 9. GET /dashboard/template-status-codes
  router.get(
    '/dashboard/template-status-codes',
    validateQuery(templateStatusCodesQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<TemplateStatusCodesQuery>(req)
        const rows = await queryTemplateStatusCodes(deps.db, tenantId, {
          hours: params.hours,
          templateId: params.template_id,
        })
        const data: StatusCodeCount[] = toRawRows(rows).map((r) => ({
          statusCode: Number(r.status_code),
          count: Number(r.count),
        }))
        respond(res, data, { hours: params.hours, count: data.length })
      } catch (err) {
        next(err)
      }
    },
  )

  // 10. GET /templates/search — supports mode=substring (default) and mode=semantic
  router.get('/templates/search', validateQuery(templateSearchSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<TemplateSearchQuery>(req)

      let rows: Awaited<ReturnType<typeof queryTemplateSearch>>

      if (params.mode === 'semantic' && deps.clusterClient) {
        const embeddings = await deps.clusterClient.embed([params.q])
        if (embeddings && embeddings[0]) {
          rows = await querySemanticSearch(deps.db, tenantId, {
            embedding: embeddings[0],
            hours: params.hours,
            limit: params.limit,
            level: params.level,
          })
        } else {
          deps.logger.warn({ query: params.q }, 'Semantic search fell back to substring (embed failed)')
          rows = await queryTemplateSearch(deps.db, tenantId, {
            q: params.q, hours: params.hours, limit: params.limit, level: params.level,
          })
        }
      } else {
        rows = await queryTemplateSearch(deps.db, tenantId, {
          q: params.q, hours: params.hours, limit: params.limit, level: params.level,
        })
      }

      const data = toRawRows(rows).map((r) => ({
        templateId: r.template_id as string,
        templateText: r.template_text as string,
        servicesAffected: r.services_affected as string[],
        occurrenceCount: Number(r.occurrence_count),
        errorCount: Number(r.error_count),
        avgDurationMs: Number(r.avg_duration_ms),
        maxAnomalyScore: Number(r.max_anomaly_score),
        firstSeen: r.first_seen as string,
        lastSeen: r.last_seen as string,
      }))

      respond(res, data, { hours: params.hours, limit: params.limit, count: data.length })
    } catch (err) {
      next(err)
    }
  })

  // 10b. GET /templates/:id/trend — 365-day daily trend
  router.get('/templates/:id/trend', validateQuery(templateTrendSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<TemplateTrendQuery>(req)
      const templateId = req.params.id as string

      const rows = await queryTemplateTrend(deps.db, tenantId, {
        templateId,
        days: params.days,
      })

      const data = rows.map((r) => ({
        day: r.day,
        occurrenceCount: Number(r.occurrence_count),
        errorCount: Number(r.error_count),
        avgDurationMs: Number(r.avg_duration_ms),
        maxAnomalyScore: Number(r.max_anomaly_score),
      }))

      respond(res, data, { hours: params.days * 24, count: data.length })
    } catch (err) {
      next(err)
    }
  })

  // ---------------------------------------------------------------------------
  // Composite endpoints — for MCP / external API consumers
  // ---------------------------------------------------------------------------

  // 11. GET /templates/:id/detail
  router.get('/templates/:id/detail', validateQuery(compositeTimeSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<CompositeTimeQuery>(req)
      const templateId = req.params.id as string
      const levels = params.level as string[] | undefined

      const [templateRows, sparklineRows, statusCodeRows] = await Promise.all([
        queryTemplatesAcrossServices(deps.db, tenantId, {
          hours: params.hours,
          level: levels,
          limit: 1000,
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
        res.status(HttpStatus.NOT_FOUND).json({
          error: { code: 'NOT_FOUND', message: `Template ${templateId} not found in the last ${params.hours} hours` },
        })
        return
      }

      const { text: truncatedText, truncated } = truncateTemplateText(match.template_text as string)
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
  })

  // 12. GET /services/:name/health
  router.get('/services/:name/health', validateQuery(compositeTimeSchema), async (req, res, next) => {
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
          level: levels ? [...levels, 'ERROR'] : ['ERROR'],
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
        res.status(HttpStatus.NOT_FOUND).json({
          error: { code: 'NOT_FOUND', message: `Service ${serviceName} not found in the last ${params.hours} hours` },
        })
        return
      }

      const logCount = Number(match.log_count)
      const errorCount = Number(match.error_count)
      const warnCount = Number(match.warn_count)

      const data: ServiceHealthData = {
        service: serviceName,
        logCount,
        errorCount,
        warnCount,
        errorRate: logCount > 0 ? errorCount / logCount : 0,
        warnRate: logCount > 0 ? warnCount / logCount : 0,
        topErrorPatterns: mapCrossServiceTemplates(toRawRows(templateRows)),
        volumeTrend: toRawRows(volumeRows).map((r) => ({
          intervalStart: r.interval_start as string,
          logCount: Number(r.log_count),
          errorCount: Number(r.error_count),
        })),
      }

      respond(res, data, { hours: params.hours, count: 1 })
    } catch (err) {
      next(err)
    }
  })

  // 13. GET /overview
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
          level: levels ? [...levels, 'ERROR'] : ['ERROR'],
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
        errorRate: totalEvents > 0 ? errorCount / totalEvents : 0,
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
