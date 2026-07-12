import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { templateToRegex } from '../../src/connectors/template-regex.js'

describe('templateToRegex', () => {
  it('matches exact literal text (no placeholders)', () => {
    const regex = templateToRegex('User logged in successfully')
    assert.ok(regex.test('User logged in successfully'))
    assert.ok(!regex.test('User logged out'))
  })

  it('matches <UUID> placeholder', () => {
    const regex = templateToRegex('Request <UUID> completed')
    assert.ok(regex.test('Request a1b2c3d4-e5f6-7890-abcd-ef1234567890 completed'))
    assert.ok(!regex.test('Request not-a-uuid completed'))
  })

  it('matches <IP> placeholder', () => {
    const regex = templateToRegex('Connection from <IP> refused')
    assert.ok(regex.test('Connection from 192.168.1.100 refused'))
    assert.ok(regex.test('Connection from 10.0.0.1 refused'))
  })

  it('matches <ID> placeholder (6+ digits)', () => {
    const regex = templateToRegex('Order <ID> processed')
    assert.ok(regex.test('Order 123456 processed'))
    assert.ok(regex.test('Order 9999999 processed'))
    assert.ok(!regex.test('Order 12345 processed')) // only 5 digits
  })

  it('matches <EMAIL> placeholder', () => {
    const regex = templateToRegex('Sent notification to <EMAIL>')
    assert.ok(regex.test('Sent notification to user@example.com'))
  })

  it('matches <TS> placeholder', () => {
    const regex = templateToRegex('Event at <TS>')
    assert.ok(regex.test('Event at 2026-03-21T14:30:00.000Z'))
  })

  it('matches <HEX> placeholder', () => {
    const regex = templateToRegex('Session <HEX> expired')
    assert.ok(regex.test('Session a1b2c3d4e5f6a7b8c9d0e1f2 expired'))
    assert.ok(!regex.test('Session abc expired')) // too short
  })

  it('matches <*> Drain3 wildcard', () => {
    const regex = templateToRegex('Connection to <*> timed out after <*>ms')
    assert.ok(regex.test('Connection to database-primary timed out after 5000ms'))
    assert.ok(regex.test('Connection to redis-cache timed out after 100ms'))
  })

  it('handles multiple mixed placeholders', () => {
    const regex = templateToRegex('User <EMAIL> from <IP> requested order <ID>')
    assert.ok(regex.test('User admin@corp.io from 10.0.0.5 requested order 789012'))
  })

  it('escapes special regex characters in literal text', () => {
    const regex = templateToRegex('Error (code: <ID>) at [service]')
    assert.ok(regex.test('Error (code: 500001) at [service]'))
  })

  it('handles empty template', () => {
    const regex = templateToRegex('')
    assert.ok(regex.test(''))
  })

  it('handles template that is purely <*>', () => {
    const regex = templateToRegex('<*>')
    assert.ok(regex.test('anything goes here'))
    assert.ok(regex.test(''))
  })

  it('is case-insensitive for hex patterns', () => {
    const regex = templateToRegex('Token <UUID>')
    assert.ok(regex.test('Token A1B2C3D4-E5F6-7890-ABCD-EF1234567890'))
  })

  it('round-trips: preprocessed message produces matching regex', () => {
    // Original log line:
    const original = 'Connection from 192.168.1.50 failed for user admin@corp.com after 1234567ms'
    // After preprocessing, this becomes a template like:
    const template = 'Connection from <IP> failed for user <EMAIL> after <ID>ms'
    const regex = templateToRegex(template)
    assert.ok(regex.test(original))
  })

  it('caps the number of compiled wildcards (ReDoS guard)', () => {
    // Far more <*> than the budget; excess must not become more `.*?` runs.
    const template = '<*>'.repeat(500)
    const regex = templateToRegex(template)
    const lazyRuns = (regex.source.match(/\.\*\?/g) ?? []).length
    assert.ok(lazyRuns <= 64, `expected <=64 lazy runs, got ${lazyRuns}`)
  })

  it('caps template length before compiling', () => {
    const template = `${'a'.repeat(10_000)}<*>`
    const regex = templateToRegex(template)
    assert.ok(regex.source.length <= 4200, 'compiled source should be bounded')
  })

  it('still compiles to a valid regex after capping (excess wildcards go literal)', () => {
    // A hostile template with hundreds of wildcards must still compile without
    // throwing; excess `<*>` past the budget are emitted as literal text, which
    // only makes matching stricter (safe degradation), never a ReDoS.
    const regex = templateToRegex(`prefix ${'<*>'.repeat(200)} suffix`)
    assert.ok(regex instanceof RegExp)
    // The first 64 wildcards still match; a normal template is unaffected.
    const normal = templateToRegex('user <*> did <*>')
    assert.ok(normal.test('user alice did login'))
  })
})
