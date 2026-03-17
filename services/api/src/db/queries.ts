import type { DbClient } from './client.js'

interface QueryWithParams {
  query: string
  query_params: Record<string, unknown>
}

export interface PaginationOptions {
  limit?: number
  hours?: number
}

/**
 * Binds tenant_id to a pre-written parameterized SQL string.
 * Does NOT modify SQL — the query must already contain {tenant_id:String}.
 */
export function tenantQuery(
  query: string,
  tenantId: string,
  extraParams?: Record<string, unknown>,
): QueryWithParams {
  return {
    query,
    query_params: { tenant_id: tenantId, ...extraParams },
  }
}

// -- Pre-written parameterized queries --

const TEMPLATE_STATS_QUERY = `
SELECT
    tenant_id, service, template_id, template_text, interval_start,
    countMerge(occurrence_count)        AS occurrence_count,
    countIfMerge(error_count)           AS error_count,
    avgMerge(avg_duration_ms)           AS avg_duration_ms,
    maxMerge(max_anomaly_score)         AS max_anomaly_score
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
GROUP BY tenant_id, service, template_id, template_text, interval_start
ORDER BY interval_start DESC
LIMIT {limit:UInt32}`

const SERVICE_STATS_QUERY = `
SELECT
    tenant_id, service, interval_start,
    countMerge(log_count)               AS log_count,
    countIfMerge(error_count)           AS error_count,
    countIfMerge(warn_count)            AS warn_count,
    countIfMerge(new_template_count)    AS new_template_count,
    avgMerge(avg_anomaly_score)         AS avg_anomaly_score
FROM logweave.service_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
GROUP BY tenant_id, service, interval_start
ORDER BY interval_start DESC
LIMIT {limit:UInt32}`

const LOG_METADATA_BY_TENANT_QUERY = `
SELECT *
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
ORDER BY timestamp DESC
LIMIT {limit:UInt32}`

export const DEFAULT_STATS_LIMIT = 100
export const DEFAULT_METADATA_LIMIT = 500
export const DEFAULT_HOURS = 24
export const MAX_STATS_LIMIT = 1000
export const MAX_METADATA_LIMIT = 5000
export const MAX_HOURS = 168

export function clamp(value: number, max: number): number {
  return Math.min(Math.max(1, Math.round(value)), max)
}

export async function queryTemplateStats(
  db: DbClient,
  tenantId: string,
  options?: PaginationOptions,
): Promise<unknown[]> {
  const limit = clamp(options?.limit ?? DEFAULT_STATS_LIMIT, MAX_STATS_LIMIT)
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  return db.query(tenantQuery(TEMPLATE_STATS_QUERY, tenantId, { limit, hours }))
}

export async function queryServiceStats(
  db: DbClient,
  tenantId: string,
  options?: PaginationOptions,
): Promise<unknown[]> {
  const limit = clamp(options?.limit ?? DEFAULT_STATS_LIMIT, MAX_STATS_LIMIT)
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  return db.query(tenantQuery(SERVICE_STATS_QUERY, tenantId, { limit, hours }))
}

export async function queryLogMetadata(
  db: DbClient,
  tenantId: string,
  options?: PaginationOptions,
): Promise<unknown[]> {
  const limit = clamp(options?.limit ?? DEFAULT_METADATA_LIMIT, MAX_METADATA_LIMIT)
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  return db.query(tenantQuery(LOG_METADATA_BY_TENANT_QUERY, tenantId, { limit, hours }))
}

/**
 * Wraps a query with EXPLAIN indexes=1 for test verification.
 * Returns the EXPLAIN output as rows.
 */
export async function explainQuery(
  db: DbClient,
  query: string,
  params: Record<string, unknown>,
): Promise<unknown[]> {
  return db.query({
    query: `EXPLAIN indexes = 1 ${query}`,
    query_params: params,
  })
}
