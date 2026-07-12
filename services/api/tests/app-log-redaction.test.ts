import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { redactRequestHeaders, redactUrl } from '../src/app.js'

// The pino request serializer spread all headers, logging the
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

// The tail SSE token is a live credential passed as ?token=<uuid>; it must not
// land in request-log URLs in the clear, mirroring the header redaction above.
describe('redactUrl', () => {
  it('redacts the short-lived tail SSE token', () => {
    const out = redactUrl('/v1/tail?level=WARN&token=3f9c1e2a-7b0d-4c5e-9a1f-2b3c4d5e6f70')
    assert.equal(out, '/v1/tail?level=WARN&token=[REDACTED]')
  })

  it('redacts the legacy api_key param (case-insensitive)', () => {
    assert.equal(redactUrl('/v1/tail?API_KEY=sk-live-123'), '/v1/tail?API_KEY=[REDACTED]')
  })

  it('preserves non-sensitive params verbatim', () => {
    assert.equal(redactUrl('/v1/tail?level=WARN&service=api'), '/v1/tail?level=WARN&service=api')
  })

  it('leaves a URL without a query string untouched', () => {
    assert.equal(redactUrl('/v1/overview'), '/v1/overview')
  })

  it('tolerates undefined', () => {
    assert.equal(redactUrl(undefined), undefined)
  })
})
