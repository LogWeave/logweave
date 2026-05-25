import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DATA_RETENTION, formatTimeRange, truncateTemplateText } from '../src/format.js'

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
    assert.ok(result.includes('T')) // ISO timestamp
  })
})

describe('DATA_RETENTION', () => {
  it('describes 30-day retention', () => {
    assert.ok(DATA_RETENTION.includes('30'))
  })
})
