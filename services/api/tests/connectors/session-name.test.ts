import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildRoleSessionName } from '../../src/connectors/session-name.js'

const SECRET = 'a'.repeat(32)
const T1 = 'tenant-acme-corp'
const C1 = '01972a8e-5b6f-7a1b-9c4d-1234567890ab'

describe('buildRoleSessionName', () => {
  it('matches AWS RoleSessionName format (2-64 chars, [\\w+=,.@-])', () => {
    const name = buildRoleSessionName({ tenantId: T1, connectorId: C1, secret: SECRET })
    assert.ok(name.length >= 2 && name.length <= 64, `length out of bounds: ${name.length}`)
    assert.match(name, /^[\w+=,.@-]+$/, `name violates AWS charset: ${name}`)
  })

  it('starts with the literal "logweave-" so CloudTrail filters can target it', () => {
    const name = buildRoleSessionName({ tenantId: T1, connectorId: C1, secret: SECRET })
    assert.ok(name.startsWith('logweave-'), `expected logweave- prefix, got ${name}`)
  })

  it('is deterministic — same (tenant, connector, secret) yields same name', () => {
    const a = buildRoleSessionName({ tenantId: T1, connectorId: C1, secret: SECRET })
    const b = buildRoleSessionName({ tenantId: T1, connectorId: C1, secret: SECRET })
    assert.equal(a, b)
  })

  it('does NOT contain the raw tenantId (PII protection)', () => {
    const name = buildRoleSessionName({ tenantId: T1, connectorId: C1, secret: SECRET })
    assert.ok(!name.includes(T1), `session name leaked tenantId: ${name}`)
    // Also no fragments
    assert.ok(!name.toLowerCase().includes('acme'))
  })

  it('different tenants produce different names', () => {
    const a = buildRoleSessionName({ tenantId: 'tenant-a', connectorId: C1, secret: SECRET })
    const b = buildRoleSessionName({ tenantId: 'tenant-b', connectorId: C1, secret: SECRET })
    assert.notEqual(a, b)
  })

  it('different connectors for the same tenant produce different names', () => {
    const a = buildRoleSessionName({ tenantId: T1, connectorId: C1, secret: SECRET })
    const b = buildRoleSessionName({
      tenantId: T1,
      connectorId: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      secret: SECRET,
    })
    assert.notEqual(a, b)
  })

  it('different secrets produce different names (so CloudTrail is not a leak)', () => {
    const a = buildRoleSessionName({ tenantId: T1, connectorId: C1, secret: SECRET })
    const b = buildRoleSessionName({
      tenantId: T1,
      connectorId: C1,
      secret: 'different-secret-x'.repeat(2),
    })
    assert.notEqual(a, b)
  })

  it('strips non-AWS-safe characters from connectorId', () => {
    // Synthetic connectorId with characters that would violate the AWS charset
    const name = buildRoleSessionName({
      tenantId: T1,
      connectorId: 'abc!@#$%^&*()def',
      secret: SECRET,
    })
    assert.match(name, /^[\w+=,.@-]+$/)
  })

  it('produces a name short enough for AWS (deterministic length under 64)', () => {
    const name = buildRoleSessionName({
      tenantId: 'x'.repeat(200),
      connectorId: 'y'.repeat(200),
      secret: SECRET,
    })
    assert.ok(name.length <= 64, `name too long: ${name.length}`)
  })

  it('throws when required args are missing — fail loud, not silently wrong', () => {
    assert.throws(() => buildRoleSessionName({ tenantId: '', connectorId: C1, secret: SECRET }))
    assert.throws(() => buildRoleSessionName({ tenantId: T1, connectorId: '', secret: SECRET }))
    assert.throws(() => buildRoleSessionName({ tenantId: T1, connectorId: C1, secret: '' }))
  })
})
