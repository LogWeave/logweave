import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractTimestamp } from '../../src/pipeline/ingest.js'

describe('extractTimestamp', () => {
  it('returns timestamp field when valid ISO 8601', () => {
    const result = extractTimestamp({ timestamp: '2026-01-01T00:00:00Z' })
    assert.equal(result, '2026-01-01T00:00:00Z')
  })

  it('returns @timestamp field when timestamp is absent', () => {
    const result = extractTimestamp({ '@timestamp': '2026-01-01T00:00:00Z' })
    assert.equal(result, '2026-01-01T00:00:00Z')
  })

  it('returns time field when timestamp and @timestamp are absent', () => {
    const result = extractTimestamp({ time: '2026-01-01T00:00:00Z' })
    assert.equal(result, '2026-01-01T00:00:00Z')
  })

  it('prefers timestamp over @timestamp over time', () => {
    const result = extractTimestamp({
      timestamp: '2026-01-01T00:00:00Z',
      '@timestamp': '2026-02-01T00:00:00Z',
      time: '2026-03-01T00:00:00Z',
    })
    assert.equal(result, '2026-01-01T00:00:00Z')
  })

  it('returns undefined for invalid date strings', () => {
    assert.equal(extractTimestamp({ timestamp: 'not-a-date' }), undefined)
    assert.equal(extractTimestamp({ timestamp: '' }), undefined)
  })

  it('returns undefined for numeric timestamps (not string)', () => {
    assert.equal(extractTimestamp({ timestamp: 1710000000000 }), undefined)
  })

  it('returns undefined for non-object events', () => {
    assert.equal(extractTimestamp(null), undefined)
    assert.equal(extractTimestamp(undefined), undefined)
    assert.equal(extractTimestamp('string'), undefined)
    assert.equal(extractTimestamp(42), undefined)
  })

  it('returns undefined when no timestamp fields exist', () => {
    assert.equal(extractTimestamp({ message: 'hello' }), undefined)
  })

  it('skips invalid field and falls through to next valid one', () => {
    const result = extractTimestamp({
      timestamp: 'garbage',
      '@timestamp': '2026-01-01T00:00:00Z',
    })
    assert.equal(result, '2026-01-01T00:00:00Z')
  })
})
