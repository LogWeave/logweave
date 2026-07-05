import { describe, expect, it } from 'vitest'
import { buildUrlParams, parseUrlParams, type UrlSyncState } from './url-sync'

function state(overrides: Partial<UrlSyncState> = {}): UrlSyncState {
  return {
    timeRange: '24h',
    serviceFilter: null,
    levelFilters: [],
    selectedTemplateId: null,
    ...overrides,
  }
}

describe('parseUrlParams', () => {
  it('reads every supported param', () => {
    const parsed = parseUrlParams(
      new URLSearchParams('range=1h&service=api&level=ERROR,WARN&template=t42'),
    )
    expect(parsed).toEqual({
      range: '1h',
      service: 'api',
      levels: ['ERROR', 'WARN'],
      template: 't42',
    })
  })

  it('returns undefined for absent params (so the store keeps its defaults)', () => {
    expect(parseUrlParams(new URLSearchParams())).toEqual({
      range: undefined,
      service: undefined,
      levels: undefined,
      template: undefined,
    })
  })

  it('drops an invalid range rather than passing it through', () => {
    expect(parseUrlParams(new URLSearchParams('range=99y')).range).toBeUndefined()
  })

  it.each(['1h', '6h', '24h', '7d'])('accepts the valid range %s', (range) => {
    expect(parseUrlParams(new URLSearchParams(`range=${range}`)).range).toBe(range)
  })

  it('discards empty segments in the level list', () => {
    expect(parseUrlParams(new URLSearchParams('level=ERROR,,WARN,')).levels).toEqual([
      'ERROR',
      'WARN',
    ])
  })

  it('treats an empty service string as absent', () => {
    expect(parseUrlParams(new URLSearchParams('service=')).service).toBeUndefined()
  })
})

describe('buildUrlParams', () => {
  it('omits the default range so an untouched dashboard has a bare URL', () => {
    expect(buildUrlParams(state({ timeRange: '24h' })).toString()).toBe('')
  })

  it('includes a non-default range', () => {
    expect(buildUrlParams(state({ timeRange: '7d' })).get('range')).toBe('7d')
  })

  it('joins level filters into a comma list', () => {
    expect(buildUrlParams(state({ levelFilters: ['ERROR', 'WARN'] })).get('level')).toBe(
      'ERROR,WARN',
    )
  })

  it('omits empty/null filters', () => {
    const params = buildUrlParams(state({ serviceFilter: null, levelFilters: [] }))
    expect(params.has('service')).toBe(false)
    expect(params.has('level')).toBe(false)
    expect(params.has('template')).toBe(false)
  })

  it('serializes service and template when set', () => {
    const params = buildUrlParams(state({ serviceFilter: 'auth', selectedTemplateId: 't7' }))
    expect(params.get('service')).toBe('auth')
    expect(params.get('template')).toBe('t7')
  })
})

describe('round-trip', () => {
  it('build -> parse preserves non-default state', () => {
    const original = state({
      timeRange: '6h',
      serviceFilter: 'api',
      levelFilters: ['ERROR'],
      selectedTemplateId: 't1',
    })
    const parsed = parseUrlParams(buildUrlParams(original))
    expect(parsed).toEqual({
      range: '6h',
      service: 'api',
      levels: ['ERROR'],
      template: 't1',
    })
  })
})
