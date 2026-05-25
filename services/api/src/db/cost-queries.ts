import type { DbClient } from './client.js'
import { clamp, DEFAULT_HOURS, MAX_HOURS, tenantQuery } from './queries.js'

export interface CostAnalysisRow {
  template_id: string
  template_text: string
  service: string
  level: string
  count: string
  service_total: string
}

interface CostAnalysisOptions {
  hours?: number
  service?: string
  level?: string[]
}

const BASE_COST_QUERY = `
SELECT
    template_id,
    template_text,
    service,
    level,
    countMerge(occurrence_count) AS count,
    sum(countMerge(occurrence_count)) OVER (PARTITION BY service) AS service_total
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour({hours:UInt32})`

export async function queryCostAnalysis(
  db: DbClient,
  tenantId: string,
  options?: CostAnalysisOptions,
): Promise<CostAnalysisRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const serviceFilter = options?.service ? 'AND service = {service:String}' : ''
  const levelFilter = options?.level?.length ? 'AND level IN ({levels:Array(String)})' : ''

  // Hard cap — cost analysis presents top-N results in the UI; no caller
  // needs more than ~10k templates and unbounded result sets are a DoS shape.
  const query = `${BASE_COST_QUERY}
  ${serviceFilter}
  ${levelFilter}
GROUP BY service, template_id, template_text, level
ORDER BY count DESC
LIMIT 10000`

  const params: Record<string, unknown> = { hours }
  if (options?.service) params.service = options.service
  if (options?.level?.length) params.levels = options.level

  return db.query<CostAnalysisRow>(tenantQuery(query, tenantId, params))
}
