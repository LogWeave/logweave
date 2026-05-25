import type { DbClient } from './client.js'
import { tenantQuery } from './queries.js'

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

export interface AuditEventRow {
  timestamp: string
  tenant_id: string
  key_id: string
  action: string
  source_ip: string
  details: string
  duration_ms: string
  events_streamed: string
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

const INSERT_AUDIT = `
INSERT INTO logweave.audit_log
  (tenant_id, key_id, action, source_ip, details, duration_ms, events_streamed)
VALUES
  ({tenant_id:String}, {key_id:String}, {action:String}, {source_ip:String}, {details:String}, {duration_ms:UInt64}, {events_streamed:UInt64})`

export async function insertAuditEvent(
  db: DbClient,
  tenantId: string,
  params: {
    keyId: string
    action: string
    sourceIp?: string
    details?: string
    durationMs?: number
    eventsStreamed?: number
  },
): Promise<void> {
  await db.command(
    tenantQuery(INSERT_AUDIT, tenantId, {
      key_id: params.keyId,
      action: params.action,
      source_ip: params.sourceIp ?? '',
      details: params.details ?? '',
      duration_ms: params.durationMs ?? 0,
      events_streamed: params.eventsStreamed ?? 0,
    }),
  )
}
