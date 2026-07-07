import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactRequestHeaders } from '../src/app.js'

// #294 Phase 1: the pino request serializer spread all headers, logging the
// Cookie header (the live `logweave_session` credential) and x-csrf-token in
// full on every request. These pin the redaction so a future header addition
// can't silently start leaking again.

describe('redactRequestHeaders', () => {
  it('redacts the Cookie header (the live session credential)', () => {
    const out = redactRequestHeaders({ cookie: 'logweave_session=abc123; other=1' })
    assert.equal(out.cookie, '[REDACTED]')
  })

  it('redacts x-csrf-token, authorization, and x-internal-secret', () => {
    const out = redactRequestHeaders({
      authorization: 'Bearer secret',
      'x-internal-secret': 'internal',
      'x-csrf-token': 'csrf',
    })
    assert.equal(out.authorization, '[REDACTED]')
    assert.equal(out['x-internal-secret'], '[REDACTED]')
    assert.equal(out['x-csrf-token'], '[REDACTED]')
  })

  it('preserves non-sensitive headers verbatim', () => {
    const out = redactRequestHeaders({ 'content-type': 'application/json', 'user-agent': 'curl/8' })
    assert.equal(out['content-type'], 'application/json')
    assert.equal(out['user-agent'], 'curl/8')
  })

  it('does not fabricate credential headers that were absent', () => {
    const out = redactRequestHeaders({ 'content-type': 'application/json' })
    // Absent credential headers stay undefined (omitted by pino), not "[REDACTED]".
    assert.equal(out.cookie, undefined)
    assert.equal(out.authorization, undefined)
    assert.equal(out['x-csrf-token'], undefined)
  })

  it('tolerates undefined headers', () => {
    const out = redactRequestHeaders(undefined)
    assert.equal(out.cookie, undefined)
    assert.equal(out.authorization, undefined)
  })
})
