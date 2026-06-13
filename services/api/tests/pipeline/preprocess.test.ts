import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  PREPROCESSING_VERSION,
  preprocessMessage,
  processEvent,
} from '../../src/pipeline/preprocess.js'
import { MAX_MESSAGE_LENGTH } from '../../src/pipeline/parse.js'
import type { ParsedEvent } from '../../src/pipeline/types.js'

describe('preprocessMessage', () => {
  // -- Core patterns --

  it('replaces UUID with <UUID>', () => {
    const input = 'User 550e8400-e29b-41d4-a716-446655440000 logged in'
    assert.equal(preprocessMessage(input), 'User <UUID> logged in')
  })

  it('replaces ISO timestamp with <TS>', () => {
    const input = 'Event at 2026-03-14T12:00:00.123Z completed'
    assert.equal(preprocessMessage(input), 'Event at <TS> completed')
  })

  it('replaces ISO timestamp with timezone offset', () => {
    const input = 'Started at 2026-03-14T12:00:00+05:30 ok'
    assert.equal(preprocessMessage(input), 'Started at <TS> ok')
  })

  it('replaces email with <EMAIL>', () => {
    const input = 'Sent to user@example.com successfully'
    assert.equal(preprocessMessage(input), 'Sent to <EMAIL> successfully')
  })

  it('replaces uppercase email with <EMAIL>', () => {
    const input = 'Contact Admin@Company.IO now'
    assert.equal(preprocessMessage(input), 'Contact <EMAIL> now')
  })

  it('replaces IPv4 with <IP>', () => {
    const input = 'Connection from 192.168.1.1 established'
    assert.equal(preprocessMessage(input), 'Connection from <IP> established')
  })

  it('replaces long hex (16+ chars) with <HEX>', () => {
    const input = 'Session a1b2c3d4e5f6a7b8c9d0 expired'
    assert.equal(preprocessMessage(input), 'Session <HEX> expired')
  })

  it('replaces large numeric ID (6+ digits) with <ID>', () => {
    const input = 'Order 123456789 processed'
    assert.equal(preprocessMessage(input), 'Order <ID> processed')
  })

  // -- Ordering / interaction --

  it('preserves port numbers and HTTP status codes', () => {
    const input = 'Server on port 8080 returned 404'
    assert.equal(preprocessMessage(input), 'Server on port 8080 returned 404')
  })

  it('preserves 3-digit and 4-digit numbers', () => {
    const input = 'Response 200 in 1500ms from port 443'
    assert.equal(preprocessMessage(input), 'Response 200 in 1500ms from port 443')
  })

  it('replaces UUID atomically without hex/id mangling', () => {
    const input = 'Request 550e8400-e29b-41d4-a716-446655440000 on port 8080'
    assert.equal(preprocessMessage(input), 'Request <UUID> on port 8080')
  })

  it('replaces multiple patterns in one message', () => {
    const input =
      'Request 550e8400-e29b-41d4-a716-446655440000 from 10.0.0.1 at 2026-03-14T12:00:00Z took 123456 ms'
    assert.equal(preprocessMessage(input), 'Request <UUID> from <IP> at <TS> took <ID> ms')
  })

  it('preserves partial/truncated UUID', () => {
    const input = 'Partial 550e8400-e29b-41d4 remains intact'
    assert.equal(preprocessMessage(input), 'Partial 550e8400-e29b-41d4 remains intact')
  })

  it('replaces dehyphenated UUID (32 hex chars) as <HEX>', () => {
    const input = 'Trace 550e8400e29b41d4a716446655440000 recorded'
    assert.equal(preprocessMessage(input), 'Trace <HEX> recorded')
  })

  // -- Defensive edge cases --

  it('handles empty string', () => {
    assert.equal(preprocessMessage(''), '')
  })

  it('is idempotent on already-preprocessed input', () => {
    const input = 'Request <UUID> from <IP> at <TS>'
    assert.equal(preprocessMessage(input), 'Request <UUID> from <IP> at <TS>')
  })

  it('preserves unicode and emoji characters', () => {
    const input = 'Error in \u6D4B\u8BD5\u670D\u52A1 \uD83D\uDE80 module at 192.168.1.1'
    assert.equal(
      preprocessMessage(input),
      'Error in \u6D4B\u8BD5\u670D\u52A1 \uD83D\uDE80 module at <IP>',
    )
  })

  it('handles very long messages without catastrophic backtracking', () => {
    // 100KB+ message with repeated patterns
    const segment = 'Request from 192.168.1.1 order 123456789 '
    const input = segment.repeat(2500) // ~100KB
    const result = preprocessMessage(input)
    // Should complete (not timeout) and replace all patterns
    assert.ok(result.includes('<IP>'))
    assert.ok(result.includes('<ID>'))
    assert.ok(!result.includes('192.168.1.1'))
    assert.ok(!result.includes('123456789'))
  })

  it('does not backtrack super-linearly on the EMAIL ReDoS payload', () => {
    // `digit.digit` repeated with no '@' is the pathological input that made
    // the unbounded email regex block the event loop for ~10s at 128KB. With
    // bounded quantifiers a full 32KB message must process in well under 50ms.
    const input = '1.'.repeat(MAX_MESSAGE_LENGTH / 2) // 32KB, no '@'
    const start = performance.now()
    const result = preprocessMessage(input)
    const elapsed = performance.now() - start
    assert.ok(
      elapsed < 50,
      `preprocessMessage took ${elapsed.toFixed(1)}ms on a 32KB payload (expected <50ms)`,
    )
    // No email present, so nothing should be replaced with <EMAIL>.
    assert.ok(!result.includes('<EMAIL>'))
  })
})

describe('PREPROCESSING_VERSION', () => {
  it('is 2 for current pattern set', () => {
    assert.equal(PREPROCESSING_VERSION, 2)
  })
})

describe('processEvent', () => {
  it('composes ParsedEvent into ProcessedEvent with preprocessing', () => {
    const parsed: ParsedEvent = {
      message: 'User 550e8400-e29b-41d4-a716-446655440000 logged in from 10.0.0.1',
      service: 'auth',
      level: 'INFO',
      environment: 'prod',
      statusCode: 200,
    }
    const result = processEvent(parsed)
    assert.equal(result.preProcessedMessage, 'User <UUID> logged in from <IP>')
    assert.equal(result.preprocessingVersion, PREPROCESSING_VERSION)
    assert.equal(result.service, 'auth')
    assert.equal(result.level, 'INFO')
    assert.equal(result.environment, 'prod')
    assert.equal(result.statusCode, 200)
  })

  it('passes through all optional fields', () => {
    const parsed: ParsedEvent = {
      message: 'request handled',
      service: 'api',
      level: 'WARN',
      environment: 'staging',
      durationMs: 42.5,
      traceId: 'abc-123',
      route: '/users',
    }
    const result = processEvent(parsed)
    assert.equal(result.durationMs, 42.5)
    assert.equal(result.traceId, 'abc-123')
    assert.equal(result.route, '/users')
  })
})
