import type { DbClient } from '../client.js'
import { clamp, DEFAULT_HOURS, MAX_HOURS, type PaginationOptions, tenantQuery } from '../queries.js'

export interface ClusteringHealthSnapshotRow {
  total_events: number | string
  clustered_events: number | string
  unclustered_events: number | string
  unique_templates: number | string
}

interface ClusteringHealthTrendRow {
  interval_start: string
  total: number
  unclustered: number
}

/**
 * Clustering health snapshot from log_metadata (single row).
 * Shows total vs clustered vs unclustered events.
 */
export async function queryClusteringHealthSnapshot(
  db: DbClient,
  tenantId: string,
  options?: Pick<PaginationOptions, 'hours'> & { level?: string[] },
): Promise<ClusteringHealthSnapshotRow> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const levels = options?.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
/* @query: clusteringHealthSnapshot */
SELECT
    count()                                         AS total_events,
    countIf(template_id != '0')                     AS clustered_events,
    countIf(template_id = '0')                      AS unclustered_events,
    uniqIf(template_id, template_id != '0')         AS unique_templates
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
  ${levelFilter}`

  const params: Record<string, unknown> = { hours }
  if (levels?.length) params.levels = levels

  const rows = await db.query<ClusteringHealthSnapshotRow>(tenantQuery(query, tenantId, params))
  return (
    rows[0] ?? { total_events: 0, clustered_events: 0, unclustered_events: 0, unique_templates: 0 }
  )
}

/**
 * Clustering health over time from log_metadata.
 * Returns hourly buckets of total and unclustered event counts.
 */
export async function queryClusteringHealthTrend(
  db: DbClient,
  tenantId: string,
  options?: Pick<PaginationOptions, 'hours'> & { level?: string[] },
): Promise<ClusteringHealthTrendRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const levels = options?.level

  const levelFilter = levels?.length ? 'AND level IN ({levels:Array(String)})' : ''

  const query = `
/* @query: clusteringHealthTrend */
SELECT
    toStartOfHour(timestamp)    AS interval_start,
    count()                     AS total,
    countIf(template_id = '0')  AS unclustered
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
  ${levelFilter}
GROUP BY interval_start
ORDER BY interval_start ASC`

  const params: Record<string, unknown> = { hours }
  if (levels?.length) params.levels = levels

  return db.query<ClusteringHealthTrendRow>(tenantQuery(query, tenantId, params))
}
