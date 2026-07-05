import { describe, expect, it } from 'vitest'
import { appendCapped, buildTailParams, tailFiltersKey } from './tail-data'
import type { TailEvent, TailFilters } from './use-tail'

function evt(seq: number): TailEvent {
  return {
    seq,
    timestamp: '2026-07-05T00:00:00Z',
    service: 'api',
    level: 'INFO',
    templateId: 't1',
    templateText: 'hello',
    anomalyScore: 0,
    statusCode: 200,
    durationMs: 5,
    traceId: 'trace',
    route: '/',
  }
}

describe('appendCapped', () => {
  it('appends when under the cap', () => {
    const result = appendCapped([evt(1)], evt(2), 500)
    expect(result.map((e) => e.seq)).toEqual([1, 2])
  })

  it('drops the oldest events once the cap is exceeded', () => {
    const full = [evt(1), evt(2), evt(3)]
    // cap of 3: adding a 4th should drop seq 1 and keep the newest 3
    expect(appendCapped(full, evt(4), 3).map((e) => e.seq)).toEqual([2, 3, 4])
  })

  it('keeps only the newest events for a large backlog', () => {
    const many = Array.from({ length: 500 }, (_, i) => evt(i))
    const result = appendCapped(many, evt(999), 500)
    expect(result).toHaveLength(500)
    expect(result.at(0)?.seq).toBe(1) // seq 0 dropped
    expect(result.at(-1)?.seq).toBe(999)
  })

  it('does not mutate the input buffer', () => {
    const input = [evt(1)]
    appendCapped(input, evt(2), 500)
    expect(input.map((e) => e.seq)).toEqual([1])
  })
})

describe('buildTailParams', () => {
  it('always includes the token', () => {
    expect(buildTailParams({}, 'tok').get('token')).toBe('tok')
  })

  it('omits unset filters so the server streams everything', () => {
    const params = buildTailParams({}, 'tok')
    expect(params.has('service')).toBe(false)
    expect(params.has('level')).toBe(false)
    expect(params.has('templateId')).toBe(false)
    expect(params.has('minAnomaly')).toBe(false)
  })

  it('serializes every set filter', () => {
    const filters: TailFilters = {
      service: 'auth',
      level: 'ERROR',
      templateId: 't42',
      minAnomaly: 0.8,
    }
    const params = buildTailParams(filters, 'tok')
    expect(params.get('service')).toBe('auth')
    expect(params.get('level')).toBe('ERROR')
    expect(params.get('templateId')).toBe('t42')
    expect(params.get('minAnomaly')).toBe('0.8')
  })

  it('includes minAnomaly of 0 (a real threshold, not "unset")', () => {
    expect(buildTailParams({ minAnomaly: 0 }, 'tok').get('minAnomaly')).toBe('0')
  })
})

describe('tailFiltersKey', () => {
  it('is stable for the same filters', () => {
    const f: TailFilters = { service: 'api', level: 'WARN', templateId: 't1' }
    expect(tailFiltersKey(f)).toBe(tailFiltersKey({ ...f }))
  })

  it('changes when a reconnect-worthy filter changes', () => {
    const base: TailFilters = { service: 'api' }
    expect(tailFiltersKey(base)).not.toBe(tailFiltersKey({ service: 'web' }))
  })

  it('treats undefined filters as empty segments', () => {
    expect(tailFiltersKey({})).toBe('||')
  })

  // Documents current behaviour, NOT an endorsement: minAnomaly is excluded from
  // the reconnect key, so changing it mid-stream does not re-subscribe. Flagged
  // as a likely bug — the slider is sent as a server param but never triggers a
  // reconnect. If fixed, update this test.
  it('does NOT change when only minAnomaly changes (known gap)', () => {
    expect(tailFiltersKey({ minAnomaly: 0.1 })).toBe(tailFiltersKey({ minAnomaly: 0.9 }))
  })
})
