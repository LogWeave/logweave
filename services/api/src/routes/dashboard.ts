import { Router } from 'express'
import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import {
  type ClusteringHealthSnapshotRow,
  queryClusteringHealthSnapshot,
  queryClusteringHealthTrend,
} from '../db/dashboard/clustering.js'
import { queryLevelDistribution } from '../db/dashboard/levels.js'
import {
  type OverviewAggregatesRow,
  type OverviewCountsRow,
  queryDashboardOverviewAggregates,
  queryDashboardOverviewCounts,
} from '../db/dashboard/overview.js'
import { querySemanticSearch, queryTemplateSearch } from '../db/dashboard/search.js'
import { queryDashboardServices } from '../db/dashboard/services.js'
import { queryTemplateStatusCodes } from '../db/dashboard/status-codes.js'
import { queryTemplateEvents } from '../db/dashboard/template-events.js'
import { queryTemplateTrend } from '../db/dashboard/template-trend.js'
import {
  queryDashboardTemplates,
  queryNewTodayIds,
  queryTemplateSparklines,
} from '../db/dashboard/templates.js'
import { queryDashboardVolume } from '../db/dashboard/volume.js'
import {
  queryBaselineSnapshot,
  queryNewTemplates,
  queryResolvedTemplates,
  queryTemplateSpikes,
} from '../db/dashboard-changes-queries.js'
import { queryDeployById } from '../db/deploy-queries.js'
import { notFound } from '../errors.js'
import { truncateTemplateText } from '../format.js'
import { isoTimestamp, respond } from '../lib/respond.js'
import { getTenantId } from '../middleware/auth.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'
import {
  type ChangeEvent,
  type ChangesQuery,
  type ClusteringHealthData,
  type ClusteringHealthQuery,
  type CrossServiceTemplate,
  changesQuerySchema,
  clusteringHealthQuerySchema,
  type LevelCount,
  type LevelsQuery,
  levelsQuerySchema,
  type OverviewData,
  type OverviewQuery,
  overviewQuerySchema,
  type ServiceRow,
  type ServicesQuery,
  type SparklineData,
  type SparklineQuery,
  type StatusCodeCount,
  servicesQuerySchema,
  sparklineQuerySchema,
  type TemplateEventsQuery,
  type TemplateRow,
  type TemplateSearchQuery,
  type TemplateStatusCodesQuery,
  type TemplatesQuery,
  type TemplateTrendQuery,
  templateEventsSchema,
  templateSearchSchema,
  templateStatusCodesQuerySchema,
  templatesQuerySchema,
  templateTrendSchema,
  type VolumeData,
  type VolumePoint,
  type VolumeQuery,
  volumeQuerySchema,
} from './dashboard-types.js'

export interface DashboardDeps {
  db: DbClient
  logger: pino.Logger
  clusterClient?: import('../pipeline/cluster-client.js').ClusterClient
  anomalyScorer?: import('../pipeline/anomaly-scorer.js').AnomalyScorer
}

// ClickHouse JSONEachRow returns numbers as strings. The DB layer types them
// as `number` for convenience, but we must call Number() on every numeric
// field to coerce correctly. Using `as unknown as Record<string, unknown>`
// once per result set lets the mapping helpers access raw string values safely.

export type RawRow = Record<string, unknown>

export function toRawRows(rows: unknown[]): RawRow[] {
  return rows as RawRow[]
}

/**
 * Map cross-service template rows with LLM-friendly formatting:
 * - Truncate template text to 200 chars
 * - Add trend text (rising/falling/stable/new)
 */
export function mapCrossServiceTemplates(rows: RawRow[]): CrossServiceTemplate[] {
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
      errorRate: logCount > 0 ? Math.round((errorCount / logCount) * 10000) / 10000 : 0,
      warnRate: logCount > 0 ? Math.round((warnCount / logCount) * 10000) / 10000 : 0,
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

function mapNewEvents(rows: RawRow[]): ChangeEvent[] {
  return rows.map((r) => ({
    type: 'new' as const,
    templateId: r.template_id as string,
    templateText: r.template_text as string,
    service: r.service as string,
    currentCount: Number(r.occurrence_count),
    previousCount: 0,
    ratio: 0,
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

export function dashboardRoutes(deps: DashboardDeps): Router {
  const router = Router()

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

  router.get('/dashboard/overview', validateQuery(overviewQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<OverviewQuery>(req)
      const queryOpts = { hours: params.hours, level: params.level }

      const [agg, counts, prevAgg, prevCounts] = await Promise.all([
        queryDashboardOverviewAggregates(deps.db, tenantId, queryOpts),
        queryDashboardOverviewCounts(deps.db, tenantId, queryOpts),
        params.compare
          ? queryDashboardOverviewAggregates(deps.db, tenantId, {
              ...queryOpts,
              offsetHours: params.hours,
            })
          : (Promise.resolve(undefined) as Promise<OverviewAggregatesRow | undefined>),
        params.compare
          ? queryDashboardOverviewCounts(deps.db, tenantId, {
              ...queryOpts,
              offsetHours: params.hours,
            })
          : (Promise.resolve(undefined) as Promise<OverviewCountsRow | undefined>),
      ])

      const totalEvents = Number(agg.total_events)
      const errorCount = Number(agg.error_count)

      const data: OverviewData = {
        totalEvents,
        totalTemplates: Number(counts.unique_templates),
        newTemplatesToday: Number(agg.new_template_count),
        unclusteredCount: Number(counts.unclustered_count),
        errorRate: totalEvents > 0 ? Math.round((errorCount / totalEvents) * 10000) / 10000 : 0,
        serviceCount: Number(counts.service_count),
      }

      if (prevAgg && prevCounts) {
        const prevTotalEvents = Number(prevAgg.total_events)
        const prevErrorCount = Number(prevAgg.error_count)

        data.previous = {
          totalEvents: prevTotalEvents,
          totalTemplates: Number(prevCounts.unique_templates),
          newTemplatesToday: Number(prevAgg.new_template_count),
          unclusteredCount: Number(prevCounts.unclustered_count),
          errorRate:
            prevTotalEvents > 0
              ? Math.round((prevErrorCount / prevTotalEvents) * 10000) / 10000
              : 0,
          serviceCount: Number(prevCounts.service_count),
        }
      }

      respond(res, data, { hours: params.hours, count: 1 })
    } catch (err) {
      next(err)
    }
  })

  router.get(
    '/dashboard/template-sparklines',
    validateQuery(sparklineQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<SparklineQuery>(req)

        const rows = await queryTemplateSparklines(deps.db, tenantId, {
          hours: params.hours,
          templateIds: params.templateIds,
          level: params.level,
        })

        const data = mapSparklineRows(toRawRows(rows))

        respond(res, data, { hours: params.hours, count: Object.keys(data).length })
      } catch (err) {
        next(err)
      }
    },
  )

  router.get(
    '/dashboard/clustering-health',
    validateQuery(clusteringHealthQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<ClusteringHealthQuery>(req)

        const [snapshot, trendRows]: [ClusteringHealthSnapshotRow, unknown[]] = await Promise.all([
          queryClusteringHealthSnapshot(deps.db, tenantId, {
            hours: params.hours,
            level: params.level,
          }),
          queryClusteringHealthTrend(deps.db, tenantId, {
            hours: params.hours,
            level: params.level,
          }),
        ])

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

  router.get('/dashboard/changes', validateQuery(changesQuerySchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<ChangesQuery>(req)

      // Resolve deployId to since timestamp if provided
      let since = params.since
      if (params.deployId) {
        const deploy = await queryDeployById(deps.db, tenantId, params.deployId)
        if (!deploy) {
          throw notFound(`Deploy ${params.deployId} not found`)
        }
        since = deploy.timestamp
      }

      // Build query options with resolved since
      const queryOpts = since ? { ...params, since } : params

      // When since is provided, compute equivalent hours for meta
      const hours = since
        ? Math.ceil((Date.now() - new Date(since).getTime()) / 3_600_000)
        : params.hours

      const [newRows, spikeRows, resolvedRows, baseline] = await Promise.all([
        queryNewTemplates(deps.db, tenantId, queryOpts),
        queryTemplateSpikes(deps.db, tenantId, queryOpts),
        queryResolvedTemplates(deps.db, tenantId, queryOpts),
        queryBaselineSnapshot(deps.db, tenantId, queryOpts),
      ])

      const newEvents = mapNewEvents(toRawRows(newRows))
      const spikeEvents = mapSpikeEvents(toRawRows(spikeRows))
      const resolvedEvents = mapResolvedEvents(toRawRows(resolvedRows))

      respond(
        res,
        {
          new: newEvents,
          spike: spikeEvents,
          resolved: resolvedEvents,
        },
        {
          hours,
          limit: params.limit,
          count: newEvents.length + spikeEvents.length + resolvedEvents.length,
          baselineStatus: baseline.status,
          previousWindowEvents: baseline.previousWindowEvents,
          tenantFirstSeenAt: baseline.tenantFirstSeenAt,
          ...(since ? { since } : {}),
        },
      )
    } catch (err) {
      next(err)
    }
  })

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

  router.get(
    '/dashboard/template-status-codes',
    validateQuery(templateStatusCodesQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<TemplateStatusCodesQuery>(req)
        const rows = await queryTemplateStatusCodes(deps.db, tenantId, {
          hours: params.hours,
          templateId: params.templateId,
          since: params.since,
          until: params.until,
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

  // supports mode=substring (default) and mode=semantic
  router.get('/templates/search', validateQuery(templateSearchSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<TemplateSearchQuery>(req)

      let rows: Awaited<ReturnType<typeof queryTemplateSearch>>

      if (params.mode === 'semantic' && deps.clusterClient) {
        const embeddings = await deps.clusterClient.embed([params.q])
        if (embeddings?.[0]) {
          rows = await querySemanticSearch(deps.db, tenantId, {
            embedding: embeddings[0],
            hours: params.hours,
            limit: params.limit,
            level: params.level,
          })
        } else {
          deps.logger.warn(
            { query: params.q },
            'Semantic search fell back to substring (embed failed)',
          )
          rows = await queryTemplateSearch(deps.db, tenantId, {
            q: params.q,
            hours: params.hours,
            limit: params.limit,
            level: params.level,
          })
        }
      } else {
        rows = await queryTemplateSearch(deps.db, tenantId, {
          q: params.q,
          hours: params.hours,
          limit: params.limit,
          level: params.level,
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

  // 10c. GET /templates/:id/events — individual log events for drill-down
  router.get(
    '/templates/:id/events',
    validateQuery(templateEventsSchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<TemplateEventsQuery>(req)
        const templateId = req.params.id as string

        const rows = await queryTemplateEvents(deps.db, tenantId, {
          templateId,
          statusCode: params.statusCode,
          since: params.since,
          until: params.until,
          hours: params.hours,
          limit: params.limit,
        })

        const data = rows.map((r) => ({
          timestamp: isoTimestamp(r.timestamp) ?? r.timestamp,
          traceId: r.trace_id,
          route: r.route,
          durationMs: Number(r.duration_ms),
          level: r.level,
          service: r.service,
          statusCode: Number(r.status_code),
        }))

        respond(res, data, { hours: params.hours, count: data.length })
      } catch (err) {
        next(err)
      }
    },
  )

  /**
   * GET /dashboard/anomaly-state
   *
   * Returns the anomaly scorer's warmup state for the current tenant. Used by
   * the dashboard to show a "warming up" banner so users don't think anomaly
   * detection is broken during the cold-start + warmup window (10 min + 60 min
   * after the first event for a tenant+service pair). See ADR-014.
   */
  router.get('/dashboard/anomaly-state', async (_req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      if (!deps.anomalyScorer) {
        respond(
          res,
          { phase: 'unknown' as const, warmupRemainingMs: 0, coldStartMs: 0, warmupMs: 0 },
          { count: 1 },
        )
        return
      }
      const state = deps.anomalyScorer.getTenantWarmupState(tenantId)
      respond(res, state, { count: 1 })
    } catch (err) {
      next(err)
    }
  })

  return router
}
