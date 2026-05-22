import type { DbClient } from '../client.js'
import {
  clamp,
  DEFAULT_HOURS,
  MAX_HOURS,
  type PaginationOptions,
  tenantQuery,
} from '../queries.js'

interface LevelDistributionRow {
  level: string
  count: number
}

/**
 * Level distribution from log_metadata.
 * Returns count of events per level for the given time window.
 */
export async function queryLevelDistribution(
  db: DbClient,
  tenantId: string,
  options?: Pick<PaginationOptions, 'hours'> & { service?: string },
): Promise<LevelDistributionRow[]> {
  const hours = clamp(options?.hours ?? DEFAULT_HOURS, MAX_HOURS)
  const service = options?.service

  const serviceFilter = service ? 'AND service = {service:String}' : ''

  const query = `
SELECT
    level,
    count() AS count
FROM logweave.log_metadata
WHERE tenant_id = {tenant_id:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
  ${serviceFilter}
GROUP BY level
ORDER BY count DESC`

  const params: Record<string, unknown> = { hours }
  if (service) params.service = service

  return db.query<LevelDistributionRow>(tenantQuery(query, tenantId, params))
}
