import type pino from 'pino'
import { insertAuditEvent } from '../db/audit-queries.js'
import type { DbClient } from '../db/client.js'
import { getInternalEvents } from '../internal-events/emitter.js'

/**
 * Record a state-change audit event for the SOC2 audit trail.
 *
 * Fire-and-forget but visible: a failed insert is reported to two sinks (the
 * structured logger and the internal-events bus) so an operator investigating
 * an audit gap still sees the failure even if the logger is the thing being
 * audited. Mirrors the pattern used for api-key auditing.
 *
 * Call this explicitly from the route handler after the mutation succeeds —
 * per-route calls are robust where path-regex middleware is fragile.
 */
export function recordAuditEvent(
  deps: { db: DbClient; logger: pino.Logger },
  params: { tenantId: string; keyId: string; action: string; sourceIp?: string; details?: string },
): void {
  insertAuditEvent(deps.db, params.tenantId, {
    keyId: params.keyId,
    action: params.action,
    sourceIp: params.sourceIp,
    details: params.details,
  }).catch((err) => {
    deps.logger.warn({ err, action: params.action }, `${params.action} audit insert failed`)
    getInternalEvents().emit({
      event: 'audit.insert_failed',
      severity: 'error',
      code: 'AUDIT_INSERT_FAILED',
      summary: 'audit row could not be inserted',
      fields: { action: params.action, tenant_id: params.tenantId },
    })
  })
}
