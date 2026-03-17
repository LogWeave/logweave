import { Router, type Response } from 'express'
import type pino from 'pino'
import type { ZodType } from 'zod'
import { HttpStatus } from '../http-status.js'
import { getTenantId } from '../middleware/auth.js'
import { validateQuery, getQuery } from '../middleware/validate-query.js'
import type { DbClient } from '../db/client.js'
import {
  queryDashboardTemplates,
  queryNewTodayIds,
  queryDashboardServices,
  queryDashboardVolume,
  queryDashboardOverviewAggregates,
  queryDashboardOverviewCounts,
  queryTemplateSparklines,
  queryClusteringHealthSnapshot,
  queryClusteringHealthTrend,
} from '../db/dashboard-queries.js'
import {
  type ApiResponse,
  type TemplateRow,
  type ServiceRow,
  type VolumePoint,
  type VolumeData,
  type OverviewData,
  type SparklineData,
  type ClusteringHealthData,
  type TemplatesQuery,
  type ServicesQuery,
  type VolumeQuery,
  type OverviewQuery,
  type SparklineQuery,
  type ClusteringHealthQuery,
  templatesQuerySchema,
  servicesQuerySchema,
  volumeQuerySchema,
  overviewQuerySchema,
  sparklineQuerySchema,
  clusteringHealthQuerySchema,
} from './dashboard-types.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  db: DbClient
  logger: pino.Logger
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

function respond<T>(res: Response, data: T, meta: Omit<ApiResponse<T>['meta'], 'fetchedAt'>): void {
  const body: ApiResponse<T> = {
    data,
    meta: { ...meta, fetchedAt: new Date().toISOString() },
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
          }),
          queryNewTodayIds(deps.db, tenantId),
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
  router.get(
    '/dashboard/services',
    validateQuery(servicesQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<ServicesQuery>(req)

        const rows = await queryDashboardServices(deps.db, tenantId, {
          hours: params.hours,
          limit: params.limit,
        })

        const data = mapServiceRows(toRawRows(rows))

        respond(res, data, { hours: params.hours, limit: params.limit, count: data.length })
      } catch (err) {
        next(err)
      }
    },
  )

  // 3. GET /dashboard/volume
  router.get(
    '/dashboard/volume',
    validateQuery(volumeQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<VolumeQuery>(req)

        const currentPromise = queryDashboardVolume(deps.db, tenantId, {
          hours: params.hours,
          service: params.service,
        })

        const previousPromise =
          params.offset > 0
            ? queryDashboardVolume(deps.db, tenantId, {
                hours: params.hours,
                service: params.service,
                offset: params.offset,
              })
            : undefined

        const [currentRows, previousRows] = await Promise.all([
          currentPromise,
          previousPromise,
        ])

        const data: VolumeData = {
          current: mapVolumeRows(toRawRows(currentRows)),
          ...(previousRows ? { previous: mapVolumeRows(toRawRows(previousRows)) } : {}),
        }

        respond(res, data, { hours: params.hours, count: data.current.length })
      } catch (err) {
        next(err)
      }
    },
  )

  // 4. GET /dashboard/overview
  router.get(
    '/dashboard/overview',
    validateQuery(overviewQuerySchema),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<OverviewQuery>(req)

        const [aggRaw, countsRaw] = await Promise.all([
          queryDashboardOverviewAggregates(deps.db, tenantId, { hours: params.hours }),
          queryDashboardOverviewCounts(deps.db, tenantId, { hours: params.hours }),
        ])

        const agg = aggRaw as unknown as RawRow
        const counts = countsRaw as unknown as RawRow
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

        respond(res, data, { hours: params.hours, count: 1 })
      } catch (err) {
        next(err)
      }
    },
  )

  // 5. GET /dashboard/template-sparklines
  router.get(
    '/dashboard/template-sparklines',
    validateQuery(sparklineQuerySchema as unknown as ZodType<SparklineQuery>),
    async (req, res, next) => {
      try {
        const tenantId = getTenantId(res)
        const params = getQuery<SparklineQuery>(req)

        const rows = await queryTemplateSparklines(deps.db, tenantId, {
          hours: params.hours,
          templateIds: params.template_ids,
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
          queryClusteringHealthSnapshot(deps.db, tenantId, { hours: params.hours }),
          queryClusteringHealthTrend(deps.db, tenantId, { hours: params.hours }),
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

  return router
}
