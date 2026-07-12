import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime, formatTimeOfDay } from './format-time'

describe('formatRelativeTime', () => {
  beforeEach(() => {
    // Freeze "now" so relative buckets are deterministic.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-03T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports "just now" under a minute', () => {
    expect(formatRelativeTime('2026-07-03T11:59:30Z').relative).toBe('just now')
  })

  it.each([
    ['2026-07-03T11:55:00Z', '5m ago'],
    ['2026-07-03T09:00:00Z', '3h ago'],
    ['2026-07-01T12:00:00Z', '2d ago'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatRelativeTime(input).relative).toBe(expected)
  })

  it('emits an unambiguous UTC iso string for the tooltip', () => {
    const { iso } = formatRelativeTime('2026-07-03T09:30:00Z')
    expect(iso).toBe('2026-07-03 09:30:00 UTC')
  })
})

describe('formatTimeOfDay', () => {
  it('formats UTC mode independent of the host timezone', () => {
    const { primary } = formatTimeOfDay('2026-07-03T08:05:09Z', 'utc')
    expect(primary).toBe('08:05:09')
  })

  it('zero-pads single-digit hours, minutes, seconds', () => {
    const { primary } = formatTimeOfDay('2026-07-03T01:02:03Z', 'utc')
    expect(primary).toBe('01:02:03')
  })

  it('utc mode alternate carries a numeric offset, not a locale string', () => {
    const { alternate } = formatTimeOfDay('2026-07-03T08:05:09Z', 'utc')
    // Format: "YYYY-MM-DD HH:MM:SS UTC±HH:MM" — never a locale-formatted date.
    expect(alternate).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/)
  })

  it('local mode alternate is an ISO-style UTC string', () => {
    const { alternate } = formatTimeOfDay('2026-07-03T08:05:09Z', 'local')
    expect(alternate).toBe('2026-07-03 08:05:09 UTC')
  })
})
