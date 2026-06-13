import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  JsonLogParser,
  MAX_MESSAGE_LENGTH,
  parseBatch,
  parseEvent,
} from '../../src/pipeline/parse.js'

describe('parseEvent', () => {
  // -- Core extraction --

  it('extracts fields from valid JSON event', () => {
    const raw = {
      message: 'User logged in',
      service: 'auth-api',
      level: 'INFO',
      environment: 'production',
      status_code: 200,
      duration_ms: 42.5,
      trace_id: 'abc-123',
      route: '/login',
    }
    const result = parseEvent(raw, 0)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.message, 'User logged in')
    assert.equal(result.event.service, 'auth-api')
    assert.equal(result.event.level, 'INFO')
    assert.equal(result.event.environment, 'production')
    assert.equal(result.event.statusCode, 200)
    assert.equal(result.event.durationMs, 42.5)
    assert.equal(result.event.traceId, 'abc-123')
    assert.equal(result.event.route, '/login')
  })

  it('falls back to msg field when message is absent', () => {
    const raw = { msg: 'pino-style message', level: 'INFO' }
    const result = parseEvent(raw, 0)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.message, 'pino-style message')
  })

  it('never_extract prevents field from appearing in output', () => {
    const raw = {
      message: 'hello',
      service: 'api',
      level: 'INFO',
      environment: 'prod',
      status_code: 200,
      trace_id: 'secret-trace',
    }
    const result = parseEvent(raw, 0, {
      neverExtract: new Set(['status_code', 'trace_id']),
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.statusCode, undefined)
    assert.equal(result.event.traceId, undefined)
    assert.equal(result.event.service, 'api')
  })

  it('applies batch-level service/environment as fallbacks', () => {
    const raw = { message: 'hello', level: 'DEBUG' }
    const result = parseEvent(raw, 0, {
      service: 'batch-svc',
      environment: 'staging',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.service, 'batch-svc')
    assert.equal(result.event.environment, 'staging')
  })

  it('event-level fields override batch-level defaults', () => {
    const raw = {
      message: 'hello',
      service: 'event-svc',
      level: 'WARN',
      environment: 'prod',
    }
    const result = parseEvent(raw, 0, {
      service: 'batch-svc',
      environment: 'staging',
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.service, 'event-svc')
    assert.equal(result.event.environment, 'prod')
  })

  it('extracts fields from nested fields sub-object', () => {
    const raw = {
      message: 'request handled',
      service: 'api',
      level: 'INFO',
      fields: {
        status_code: 404,
        duration_ms: 120,
        route: '/users/:id',
      },
    }
    const result = parseEvent(raw, 0)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.statusCode, 404)
    assert.equal(result.event.durationMs, 120)
    assert.equal(result.event.route, '/users/:id')
  })

  it('never_extract blocks nested fields via fields.X syntax', () => {
    const raw = {
      message: 'hello',
      level: 'INFO',
      fields: { status_code: 500, route: '/api' },
    }
    const result = parseEvent(raw, 0, {
      neverExtract: new Set(['fields.status_code']),
    })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.statusCode, undefined)
    assert.equal(result.event.route, '/api')
  })

  it('treats null field values as missing', () => {
    const raw = {
      message: 'hello',
      service: null,
      level: 'INFO',
      status_code: null,
    }
    const result = parseEvent(raw, 0, { service: 'fallback-svc' })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.service, 'fallback-svc')
    assert.equal(result.event.statusCode, undefined)
  })

  // -- Defensive edge cases --

  it('returns error for plain string input', () => {
    const result = parseEvent('not an object' as unknown, 3)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.index, 3)
    assert.ok(result.error.length > 0)
  })

  it('returns error for empty object (no message)', () => {
    const result = parseEvent({}, 0)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.error.includes('message'))
  })

  it('returns error when message is a number', () => {
    const result = parseEvent({ message: 42 }, 0)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.ok(result.error.includes('message'))
  })

  it('returns error when message is null', () => {
    const result = parseEvent({ message: null }, 0)
    assert.equal(result.ok, false)
  })

  it('succeeds with empty string message', () => {
    const raw = { message: '', level: 'INFO' }
    const result = parseEvent(raw, 0)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.message, '')
  })

  it('returns error for array input', () => {
    const result = parseEvent([1, 2, 3] as unknown, 5)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.index, 5)
  })

  it('succeeds with a message exactly at the length cap', () => {
    const raw = { message: 'x'.repeat(MAX_MESSAGE_LENGTH), level: 'ERROR' }
    const result = parseEvent(raw, 0)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.event.message.length, MAX_MESSAGE_LENGTH)
  })

  it('rejects a message that exceeds the length cap', () => {
    const raw = { message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1), level: 'ERROR' }
    const result = parseEvent(raw, 7)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.index, 7)
    assert.ok(result.error.includes('exceeds'))
  })
})

describe('parseBatch', () => {
  it('returns empty results for empty array', () => {
    const { parsed, errors } = parseBatch([])
    assert.equal(parsed.length, 0)
    assert.equal(errors.length, 0)
  })

  it('separates valid and invalid events with correct indices', () => {
    const events = [
      { message: 'good1', level: 'INFO' },
      'bad',
      { message: 'good2', level: 'WARN' },
      42,
      { message: 'good3', level: 'ERROR' },
    ]
    const { parsed, errors } = parseBatch(events)
    assert.equal(parsed.length, 3)
    assert.equal(errors.length, 2)
    assert.equal(parsed[0]?.message, 'good1')
    assert.equal(parsed[1]?.message, 'good2')
    assert.equal(parsed[2]?.message, 'good3')
    // Errors carry the original indices
    const errorIndices = errors.map((e) => (e.ok === false ? e.index : -1))
    assert.deepEqual(errorIndices, [1, 3])
  })
})

describe('JsonLogParser', () => {
  const parser = new JsonLogParser()

  it('extractMessage returns message field', () => {
    assert.equal(parser.extractMessage({ message: 'hello' }), 'hello')
  })

  it('extractMessage falls back to msg field', () => {
    assert.equal(parser.extractMessage({ msg: 'fallback' }), 'fallback')
  })

  it('extractMessage returns undefined when neither field exists', () => {
    assert.equal(parser.extractMessage({ text: 'nope' }), undefined)
  })
})
