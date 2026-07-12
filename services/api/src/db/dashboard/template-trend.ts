import type { DbClient } from '../client.js'
import { tenantQuery } from '../queries.js'

export interface TemplateTrendRow {
  day: string
  occurrence_count: string
  error_count: string
  avg_duration_ms: string
  max_anomaly_score: string
}

const MAX_TREND_DAYS = 365

/**
 * Daily trend for a single template over N days.
 * Uses template_daily_summary (365-day TTL) for long-range trend analysis.
 */
export async function queryTemplateTrend(
  db: DbClient,
  tenantId: string,
  options: { templateId: string; days?: number },
): Promise<TemplateTrendRow[]> {
  const days = Math.min(Math.max(options.days ?? 90, 1), MAX_TREND_DAYS)

  const query = `
/* @query: templateTrend */
SELECT
    day,
    countMerge(occurrence_count)      AS occurrence_count,
    countMerge(error_count)         AS error_count,
    avgMerge(avg_duration_ms)         AS avg_duration_ms,
    maxMerge(max_anomaly_score)       AS max_anomaly_score
FROM logweave.template_daily_summary
WHERE tenant_id = {tenant_id:String}
  AND template_id = {template_id:String}
  AND day >= today() - {days:UInt32}
GROUP BY day
ORDER BY day ASC`

  return db.query<TemplateTrendRow>(
    tenantQuery(query, tenantId, { template_id: options.templateId, days }),
  )
}
