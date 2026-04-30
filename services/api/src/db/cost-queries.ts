import type { DbClient } from './client.js'
import { DEFAULT_HOURS, MAX_HOURS, clamp, tenantQuery } from './queries.js'

export interface CostAnalysisRow {
  template_id: string
  template_text: string
  service: string
  level: string
  count: string
  service_total: string
}

export interface CostAnalysisOptions {
  hours?: number
  service?: string
}

const COST_ANALYSIS_QUERY = `
SELECT
    template_id,
    template_text,
    service,
    level,
    countMerge(occurrence_count) AS count,
    sum(countMerge(occurrence_count)) OVER (PARTITION BY service) AS service_total
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
GROUP BY service, template_id, template_text, level
ORDER BY count DESC`

const COST_ANALYSIS_SERVICE_QUERY = `
SELECT
    template_id,
    template_text,
    service,
    level,
    countMerge(occurrence_count) AS count,
    sum(countMerge(occurrence_count)) OVER (PARTITION BY service) AS service_total
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})
  AND service = {service:String}
GROUP BY service, template_id, template_text, level
ORDER BY count DESC`

export async function queryCostAnalysis(
  db: DbClient,
  tenantId: string,
  options?: CostAnalysisOptions,
): Promise<CostAnalysisRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)

  if (options?.service) {
    return db.query<CostAnalysisRow>(
      tenantQuery(COST_ANALYSIS_SERVICE_QUERY, tenantId, { hours, service: options.service }),
    )
  }

  return db.query<CostAnalysisRow>(tenantQuery(COST_ANALYSIS_QUERY, tenantId, { hours }))
}
