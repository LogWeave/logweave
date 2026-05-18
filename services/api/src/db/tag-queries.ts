import type { DbClient } from './client.js'
import { tenantQuery } from './queries.js'

interface EventTagRow {
  event_id: string
  template_id: string
  service: string
  level: string
  timestamp: string
  tag_key: string
  tag_value: string
}

export async function queryEventsByTag(
  db: DbClient,
  tenantId: string,
  options: { key: string; value: string; hours?: number; limit?: number },
): Promise<EventTagRow[]> {
  const hours = Math.min(Math.max(1, options.hours ?? 24), 720)
  const limit = Math.min(Math.max(1, options.limit ?? 50), 200)

  const query = `
SELECT event_id, template_id, service, level, timestamp, tag_key, tag_value
FROM logweave.event_tags
WHERE tenant_id = {tenant_id:String}
  AND tag_key = {tag_key:String}
  AND tag_value = {tag_value:String}
  AND timestamp > now64(3) - toIntervalHour({hours:UInt32})
ORDER BY timestamp DESC
LIMIT {limit:UInt32}`

  return db.query<EventTagRow>(
    tenantQuery(query, tenantId, { tag_key: options.key, tag_value: options.value, hours, limit }),
  )
}
