import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DATA_RETENTION, formatTimeRange, trendText, truncateTemplateText } from '../src/format.js'

describe('trendText', () => {
  it('rising when current > 1.5x previous', () => {
    assert.equal(trendText(300, 100), 'rising 3.0x')
    assert.equal(trendText(160, 100), 'rising 1.6x')
  })

  it('falling when current < 0.67x previous', () => {
    assert.equal(trendText(50, 100), 'falling 0.5x')
    assert.equal(trendText(60, 100), 'falling 0.6x')
  })

  it('stable when between thresholds', () => {
    assert.equal(trendText(100, 100), 'stable')
    assert.equal(trendText(140, 100), 'stable')
    assert.equal(trendText(70, 100), 'stable')
  })

  it('new when no previous data and current > 0', () => {
    assert.equal(trendText(50, 0), 'new')
  })

  it('stable when both zero', () => {
    assert.equal(trendText(0, 0), 'stable')
  })
})

describe('truncateTemplateText', () => {
  it('does not truncate short text', () => {
    const result = truncateTemplateText('Connection to <IP> timed out')
    assert.equal(result.text, 'Connection to <IP> timed out')
    assert.equal(result.truncated, false)
  })

  it('truncates text longer than 200 chars', () => {
    const longText = 'A'.repeat(250)
    const result = truncateTemplateText(longText)
    assert.equal(result.text.length, 203) // 200 + "..."
    assert.ok(result.text.endsWith('...'))
    assert.equal(result.truncated, true)
  })

  it('does not truncate exactly 200 chars', () => {
    const exactText = 'B'.repeat(200)
    const result = truncateTemplateText(exactText)
    assert.equal(result.text, exactText)
    assert.equal(result.truncated, false)
  })
})

describe('formatTimeRange', () => {
  it('includes hours and ISO timestamps', () => {
    const result = formatTimeRange(24)
    assert.ok(result.includes('24 hours'))
    assert.ok(result.includes('T'))  // ISO timestamp
  })
})

describe('DATA_RETENTION', () => {
  it('describes 30-day retention', () => {
    assert.ok(DATA_RETENTION.includes('30'))
  })
})
