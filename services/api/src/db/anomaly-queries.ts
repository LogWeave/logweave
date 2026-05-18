import type { DbClient } from './client.js'
import { tenantQuery } from './queries.js'

interface BaselineRow {
  template_id: string
  service: string
  avg_count_per_interval: number
}

// Hard cap on the (template_id, service) cardinality returned. Anomaly
// scoring is per-template, so a tenant with millions of templates can grow
// the result set unboundedly. 50k covers all realistic deployments.
const BASELINE_QUERY = `
SELECT
  template_id,
  service,
  countMerge(occurrence_count) / uniq(interval_start) AS avg_count_per_interval
FROM logweave.template_stats
WHERE tenant_id = {tenant_id:String}
  AND interval_start > now64(3) - toIntervalHour(1)
GROUP BY template_id, service
LIMIT 50000`

/**
 * Fetch rolling 1-hour baseline averages for all templates belonging to a tenant.
 * Returns avg 5-minute occurrence count per (template_id, service).
 * Uses uniq(interval_start) instead of count() to handle unmerged AggregatingMergeTree rows.
 *
 * No FINAL needed: -Merge combinators re-aggregate partial states from unmerged parts,
 * and GROUP BY template_id,service collapses them correctly. Adding FINAL would hurt
 * performance with no correctness benefit on AggregatingMergeTree.
 */
export async function queryAnomalyBaselines(
  db: DbClient,
  tenantId: string,
): Promise<BaselineRow[]> {
  return db.query<BaselineRow>(tenantQuery(BASELINE_QUERY, tenantId))
}
