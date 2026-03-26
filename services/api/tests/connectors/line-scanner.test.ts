import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, it } from 'node:test'
import { extractJsonFields, scanStream } from '../../src/connectors/line-scanner.js'

// ---------------------------------------------------------------------------
// extractJsonFields
// ---------------------------------------------------------------------------

describe('extractJsonFields', () => {
  it('extracts message and timestamp from standard fields', () => {
    const line = JSON.stringify({ message: 'hello', timestamp: '2026-01-01T00:00:00Z' })
    const result = extractJsonFields(line)
    assert.equal(result?.message, 'hello')
    assert.equal(result?.timestamp, '2026-01-01T00:00:00Z')
  })

  it('extracts msg (pino/bunyan style)', () => {
    const line = JSON.stringify({ msg: 'pino message', time: '2026-01-01T00:00:00Z' })
    const result = extractJsonFields(line)
    assert.equal(result?.message, 'pino message')
    assert.equal(result?.timestamp, '2026-01-01T00:00:00Z')
  })

  it('extracts @timestamp (ECS style)', () => {
    const line = JSON.stringify({ message: 'ecs line', '@timestamp': '2026-01-01T00:00:00Z' })
    const result = extractJsonFields(line)
    assert.equal(result?.message, 'ecs line')
    assert.equal(result?.timestamp, '2026-01-01T00:00:00Z')
  })

  it('returns undefined for invalid JSON', () => {
    const result = extractJsonFields('not json at all')
    assert.equal(result, undefined)
  })

  it('returns undefined fields when keys are missing', () => {
    const line = JSON.stringify({ level: 'info' })
    const result = extractJsonFields(line)
    assert.equal(result?.message, undefined)
    assert.equal(result?.timestamp, undefined)
  })
})

// ---------------------------------------------------------------------------
// scanStream
// ---------------------------------------------------------------------------

function toReadable(lines: string[]): Readable {
  return Readable.from(lines.map((l) => `${l}\n`).join(''))
}

describe('scanStream', () => {
  it('matches plain text lines against regex', async () => {
    const stream = toReadable([
      'Connection from 10.0.0.1 timed out',
      'User logged in',
      'Connection from 192.168.1.5 timed out',
    ])

    const result = await scanStream({
      stream,
      regex: /Connection from .+ timed out/,
      logFormat: 'text',
      remaining: 10,
    })

    assert.equal(result.matches.length, 2)
    assert.ok(result.matches[0]?.message.includes('10.0.0.1'))
    assert.ok(result.matches[1]?.message.includes('192.168.1.5'))
    assert.ok(result.bytesRead > 0)
  })

  it('respects remaining limit', async () => {
    const stream = toReadable([
      'match line 1',
      'match line 2',
      'match line 3',
    ])

    const result = await scanStream({
      stream,
      regex: /match/,
      logFormat: 'text',
      remaining: 2,
    })

    assert.equal(result.matches.length, 2)
  })

  it('extracts message and timestamp from JSONL format', async () => {
    const stream = toReadable([
      JSON.stringify({ message: 'error occurred', timestamp: '2026-01-01T12:00:00Z', level: 'error' }),
      JSON.stringify({ message: 'info line', timestamp: '2026-01-01T12:01:00Z', level: 'info' }),
    ])

    const result = await scanStream({
      stream,
      regex: /error occurred/,
      logFormat: 'jsonl',
      remaining: 10,
    })

    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0]?.message, 'error occurred')
    assert.equal(result.matches[0]?.timestamp, '2026-01-01T12:00:00Z')
  })

  it('skips invalid JSON lines in JSONL mode', async () => {
    const stream = toReadable([
      'not json',
      JSON.stringify({ message: 'valid line' }),
    ])

    const result = await scanStream({
      stream,
      regex: /valid/,
      logFormat: 'jsonl',
      remaining: 10,
    })

    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0]?.message, 'valid line')
  })

  it('returns empty matches when nothing matches', async () => {
    const stream = toReadable(['foo', 'bar', 'baz'])

    const result = await scanStream({
      stream,
      regex: /NOMATCH/,
      logFormat: 'text',
      remaining: 10,
    })

    assert.equal(result.matches.length, 0)
    assert.ok(result.bytesRead > 0)
  })

  it('handles empty stream', async () => {
    const stream = toReadable([])

    const result = await scanStream({
      stream,
      regex: /anything/,
      logFormat: 'text',
      remaining: 10,
    })

    assert.equal(result.matches.length, 0)
    assert.equal(result.bytesRead, 0)
  })
})
