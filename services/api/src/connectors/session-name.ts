import { createHmac } from 'node:crypto'

/**
 * Build the `RoleSessionName` used in AWS STS AssumeRole. The name appears
 * verbatim in the customer's CloudTrail logs, so it must:
 *
 * - Be stable per (tenant, connector) so the customer can pivot audit logs
 *   by tenant or connector.
 * - NOT leak tenant_id, which is internal LogWeave PII. We HMAC the tenant
 *   with the server's encryption key (domain-separated) so the mapping is
 *   not reversible from CloudTrail alone — only LogWeave operators with
 *   the encryption key can correlate a session name to a tenant.
 * - Fit the AWS constraints: 2–64 chars, `[\w+=,.@-]+` only.
 *
 * Format: `logweave-<tenantHash[0:12]>-<connectorIdSuffix[0:8]>`
 *
 * The tenant hash is the first 12 chars of a base32-ish encoding of the
 * HMAC digest (lowercase alphanumeric only — safe under the AWS charset).
 * 12 chars of 32-symbol base ≈ 60 bits of entropy, far more than enough
 * to disambiguate any plausible tenant set.
 */
export function buildRoleSessionName(args: {
  tenantId: string
  connectorId: string
  secret: string
}): string {
  const { tenantId, connectorId, secret } = args
  if (!tenantId) throw new Error('buildRoleSessionName: tenantId required')
  if (!connectorId) throw new Error('buildRoleSessionName: connectorId required')
  if (!secret) throw new Error('buildRoleSessionName: secret required')

  // Domain-separate the HMAC so this hash is never the same as any other
  // HMAC LogWeave computes with the same key.
  const tenantHash = createHmac('sha256', secret).update(`session-name:${tenantId}`).digest()

  // base32-ish lowercase alphanumeric. AWS allows more characters but
  // restricting the output keeps the format predictable across SDK versions
  // and customer log parsers.
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
  let encoded = ''
  for (let i = 0; i < 8 && encoded.length < 12; i++) {
    // Pull two characters per byte for the first few bytes — plenty of room.
    const b = tenantHash[i] ?? 0
    encoded += ALPHABET[b & 0x1f]
    encoded += ALPHABET[(b >> 3) & 0x1f]
  }
  const tenantPart = encoded.slice(0, 12)

  // ConnectorId is usually a UUID; first 8 chars give enough disambiguation
  // and keep the overall session name comfortably under the 64-char cap.
  // Sanitize aggressively in case future IDs include non-AWS-safe chars.
  const connectorPart = connectorId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'unknown'

  return `logweave-${tenantPart}-${connectorPart}`
}
