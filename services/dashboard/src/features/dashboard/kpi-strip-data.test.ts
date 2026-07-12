import { describe, expect, it } from 'vitest'
import { countSpikes, trendPercent } from './kpi-strip-data'

describe('trendPercent', () => {
  it('computes a positive change', () => {
    expect(trendPercent(150, 100)).toBe(50)
  })

  it('computes a negative change', () => {
    expect(trendPercent(80, 100)).toBeCloseTo(-20)
  })

  it('is zero when nothing changed', () => {
    expect(trendPercent(100, 100)).toBe(0)
  })

  it('returns undefined when there is no previous value', () => {
    expect(trendPercent(100)).toBeUndefined()
    expect(trendPercent(100, undefined)).toBeUndefined()
  })

  it('returns undefined when the previous value is zero (no infinite jump)', () => {
    expect(trendPercent(100, 0)).toBeUndefined()
  })
})

describe('countSpikes', () => {
  it('counts templates strictly above the anomaly threshold', () => {
    const templates = [{ maxAnomalyScore: 1.5 }, { maxAnomalyScore: 0.5 }, { maxAnomalyScore: 3.0 }]
    expect(countSpikes(templates)).toBe(2)
  })

  it('excludes a template exactly at the threshold', () => {
    expect(countSpikes([{ maxAnomalyScore: 1.0 }])).toBe(0)
  })

  it('is zero for an empty list', () => {
    expect(countSpikes([])).toBe(0)
  })
})
