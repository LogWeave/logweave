import type { DbClient } from './client.js'
import { tenantQuery } from './queries.js'

export interface AlertHistoryRow {
  alert_id: string
  tenant_id: string
  rule_id: string
  rule_type: string
  rule_name: string
  fired_at: string
  metric_value: number
  threshold_value: number
  details: string
  channels_notified: string
}

export async function queryAlertHistory(
  db: DbClient,
  tenantId: string,
  options?: { hours?: number; ruleId?: string; service?: string; limit?: number },
): Promise<AlertHistoryRow[]> {
  const hours = Math.min(Math.max(1, options?.hours ?? 24), 720)
  const limit = Math.min(Math.max(1, options?.limit ?? 100), 500)
  const ruleId = options?.ruleId
  const service = options?.service

  const ruleIdFilter = ruleId ? 'AND rule_id = {rule_id:String}' : ''
  const serviceFilter = service
    ? "AND JSONExtractString(details, 'service') = {service:String}"
    : ''

  const query = `
SELECT alert_id, tenant_id, rule_id, rule_type, rule_name, fired_at,
       metric_value, threshold_value, details, channels_notified
FROM logweave.alert_history
WHERE tenant_id = {tenant_id:String}
  AND fired_at > now64(3) - toIntervalHour({hours:UInt32})
  ${ruleIdFilter}
  ${serviceFilter}
ORDER BY fired_at DESC
LIMIT {limit:UInt32}`

  const params: Record<string, unknown> = { hours, limit }
  if (ruleId) params.rule_id = ruleId
  if (service) params.service = service

  return db.query<AlertHistoryRow>(tenantQuery(query, tenantId, params))
}
