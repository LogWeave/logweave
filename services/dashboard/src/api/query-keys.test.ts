import { describe, expect, it } from 'vitest'
import { levelApiParam, levelParam, queryKeys } from './query-keys'

describe('queryKeys', () => {
  it('produces stable keys for identical inputs', () => {
    expect(queryKeys.volume(24, 'api', 'ERROR')).toEqual(queryKeys.volume(24, 'api', 'ERROR'))
  })

  it('varies the key when any parameter changes', () => {
    const base = queryKeys.volume(24, 'api', 'ERROR')
    expect(queryKeys.volume(6, 'api', 'ERROR')).not.toEqual(base)
    expect(queryKeys.volume(24, 'web', 'ERROR')).not.toEqual(base)
    expect(queryKeys.volume(24, 'api', 'WARN')).not.toEqual(base)
  })

  it('distinguishes a null service filter from a named one', () => {
    expect(queryKeys.templates(24, null, '')).not.toEqual(queryKeys.templates(24, 'api', ''))
  })

  it('namespaces dashboard vs cost keys', () => {
    expect(queryKeys.overview(24, '')[0]).toBe('dashboard')
    expect(queryKeys.costAnalysis(24, null, '')[0]).toBe('cost')
  })

  it('keeps the same shape across hooks that share parameters', () => {
    // overview/services/clusteringHealth all take (hours, levels) and must
    // remain distinguishable by their type segment.
    expect(queryKeys.overview(24, '')[1]).toBe('overview')
    expect(queryKeys.services(24, '')[1]).toBe('services')
    expect(queryKeys.clusteringHealth(24, '')[1]).toBe('clustering-health')
  })
})

describe('levelParam', () => {
  it('joins filters with commas', () => {
    expect(levelParam(['ERROR', 'WARN'])).toBe('ERROR,WARN')
  })

  it('returns an empty string for no filters (stable cache key)', () => {
    expect(levelParam([])).toBe('')
  })
})

describe('levelApiParam', () => {
  it('joins filters with commas', () => {
    expect(levelApiParam(['ERROR', 'WARN'])).toBe('ERROR,WARN')
  })

  it('returns undefined for no filters (omits the param)', () => {
    expect(levelApiParam([])).toBeUndefined()
  })

  it('differs from levelParam on the empty case', () => {
    // levelParam -> '' (cache key), levelApiParam -> undefined (query param).
    expect(levelParam([])).toBe('')
    expect(levelApiParam([])).toBeUndefined()
  })
})
