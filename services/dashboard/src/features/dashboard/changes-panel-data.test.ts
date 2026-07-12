import { describe, expect, it } from 'vitest'
import { baselineEtaMessage, spikeRatioSeverity } from './changes-panel-data'

describe('spikeRatioSeverity', () => {
  it.each([
    [100, 'danger'],
    [50, 'danger'],
    [49.9, 'warning'],
    [10, 'warning'],
    [9.9, 'normal'],
    [1, 'normal'],
    [0, 'normal'],
  ] as const)('ratio %f -> %s', (ratio, expected) => {
    expect(spikeRatioSeverity(ratio)).toBe(expected)
  })
})

describe('baselineEtaMessage', () => {
  const now = new Date('2026-07-03T12:00:00Z').getTime()

  it('returns null when the window size is unknown', () => {
    expect(baselineEtaMessage(undefined, '2026-07-03T11:00:00Z', now)).toBeNull()
  })

  it('returns null when the tenant first-seen time is unknown', () => {
    expect(baselineEtaMessage(24, undefined, now)).toBeNull()
    expect(baselineEtaMessage(24, null, now)).toBeNull()
  })

  it('returns null once enough history has accrued (2N hours elapsed)', () => {
    // 1h window needs 2h of history; tenant started 3h ago -> ready.
    expect(baselineEtaMessage(1, '2026-07-03T09:00:00Z', now)).toBeNull()
  })

  it('reports a minutes ETA when under an hour remains', () => {
    // 1h window needs 2h; started 90 min ago -> 30 min remain.
    const firstSeen = new Date(now - 90 * 60_000).toISOString()
    expect(baselineEtaMessage(1, firstSeen, now)).toBe('Comparison available in ~30 min.')
  })

  it('rounds partial minutes up', () => {
    // 29.5 min remaining -> ceil to 30.
    const firstSeen = new Date(now - (120 - 29.5) * 60_000).toISOString()
    expect(baselineEtaMessage(1, firstSeen, now)).toBe('Comparison available in ~30 min.')
  })

  it('reports an hours ETA when at least an hour remains', () => {
    // 24h window needs 48h; started 1h ago -> 47h remain.
    const firstSeen = new Date(now - 60 * 60_000).toISOString()
    expect(baselineEtaMessage(24, firstSeen, now)).toBe('Comparison available in ~47h.')
  })

  it('crosses from minutes to hours at exactly 60 minutes remaining', () => {
    // Exactly 60 min remaining -> hours branch (~1h), not "60 min".
    const firstSeen = new Date(now - (120 - 60) * 60_000).toISOString()
    expect(baselineEtaMessage(1, firstSeen, now)).toBe('Comparison available in ~1h.')
  })
})
