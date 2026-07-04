import { describe, expect, it } from 'vitest'
import type { VolumePoint } from '../../api/types'
import {
  alignToCurrentAxis,
  buildServiceMap,
  findClosestTimestampIndex,
  formatVolumeAxisLabel,
  sumCountsByTimestamp,
} from './volume-chart-data'

function pt(service: string, intervalStart: string, logCount: number): VolumePoint {
  return { service, intervalStart, logCount, errorCount: 0 }
}

describe('buildServiceMap', () => {
  it('groups points by service and collects distinct timestamps', () => {
    const { serviceMap, timestamps } = buildServiceMap([
      pt('api', '2026-07-03T00:00:00Z', 10),
      pt('web', '2026-07-03T00:00:00Z', 5),
      pt('api', '2026-07-03T01:00:00Z', 20),
    ])
    expect([...serviceMap.keys()]).toEqual(['api', 'web'])
    expect(serviceMap.get('api')).toEqual([
      { time: '2026-07-03T00:00:00Z', count: 10 },
      { time: '2026-07-03T01:00:00Z', count: 20 },
    ])
    expect([...timestamps]).toEqual(['2026-07-03T00:00:00Z', '2026-07-03T01:00:00Z'])
  })

  it('handles unordered input without losing points', () => {
    const { serviceMap } = buildServiceMap([
      pt('api', '2026-07-03T02:00:00Z', 3),
      pt('api', '2026-07-03T00:00:00Z', 1),
      pt('api', '2026-07-03T01:00:00Z', 2),
    ])
    // Insertion order is preserved; sorting is the caller's job.
    expect(serviceMap.get('api')?.map((p) => p.count)).toEqual([3, 1, 2])
  })

  it('returns empty structures for no points', () => {
    const { serviceMap, timestamps } = buildServiceMap([])
    expect(serviceMap.size).toBe(0)
    expect(timestamps.size).toBe(0)
  })
})

describe('sumCountsByTimestamp', () => {
  it('sums counts across services per timestamp', () => {
    const totals = sumCountsByTimestamp([
      pt('api', '2026-07-03T00:00:00Z', 10),
      pt('web', '2026-07-03T00:00:00Z', 5),
      pt('api', '2026-07-03T01:00:00Z', 20),
    ])
    expect(totals.get('2026-07-03T00:00:00Z')).toBe(15)
    expect(totals.get('2026-07-03T01:00:00Z')).toBe(20)
  })

  it('returns an empty map for no points', () => {
    expect(sumCountsByTimestamp([]).size).toBe(0)
  })
})

describe('findClosestTimestampIndex', () => {
  const axis = ['2026-07-03T00:00:00Z', '2026-07-03T01:00:00Z', '2026-07-03T02:00:00Z']

  it('finds the nearest index to a target time', () => {
    const target = new Date('2026-07-03T01:10:00Z').getTime()
    expect(findClosestTimestampIndex(axis, target)).toBe(1)
  })

  it('picks an exact match', () => {
    const target = new Date('2026-07-03T02:00:00Z').getTime()
    expect(findClosestTimestampIndex(axis, target)).toBe(2)
  })

  it('clamps a target before the first bucket to index 0', () => {
    const target = new Date('2026-07-02T00:00:00Z').getTime()
    expect(findClosestTimestampIndex(axis, target)).toBe(0)
  })

  it('clamps a target after the last bucket to the final index', () => {
    const target = new Date('2026-07-05T00:00:00Z').getTime()
    expect(findClosestTimestampIndex(axis, target)).toBe(2)
  })

  it('returns 0 for an empty axis', () => {
    expect(findClosestTimestampIndex([], Date.now())).toBe(0)
  })

  it('resolves ties to the earliest index', () => {
    // Target exactly between index 0 and 1 -> first strict minimum wins (0).
    const target = new Date('2026-07-03T00:30:00Z').getTime()
    expect(findClosestTimestampIndex(axis, target)).toBe(0)
  })
})

describe('formatVolumeAxisLabel', () => {
  it('returns HH:MM for short ranges', () => {
    expect(formatVolumeAxisLabel('2026-07-03T09:05:00', '1h')).toMatch(/^\d{2}:\d{2}$/)
    expect(formatVolumeAxisLabel('2026-07-03T09:05:00', '6h')).toMatch(/^\d{2}:\d{2}$/)
  })

  it('prefixes DD/MM for the 24h range', () => {
    expect(formatVolumeAxisLabel('2026-07-03T09:05:00', '24h')).toMatch(
      /^\d{2}\/\d{2} \d{2}:\d{2}$/,
    )
  })

  it('prefixes the weekday for the 7d range', () => {
    expect(formatVolumeAxisLabel('2026-07-03T09:05:00', '7d')).toMatch(/^\w{3} \d{2}:\d{2}$/)
  })

  it('falls back to the raw string for an unparseable timestamp', () => {
    expect(formatVolumeAxisLabel('not-a-date', '24h')).toBe('not-a-date')
  })
})

describe('alignToCurrentAxis', () => {
  it('sorts previous points by time and maps into current-length slots', () => {
    const prev = [
      { time: '2026-07-03T02:00:00Z', count: 3 },
      { time: '2026-07-03T00:00:00Z', count: 1 },
      { time: '2026-07-03T01:00:00Z', count: 2 },
    ]
    expect(alignToCurrentAxis(prev, 3)).toEqual([1, 2, 3])
  })

  it('pads with zeros when the previous period has fewer buckets', () => {
    const prev = [{ time: '2026-07-03T00:00:00Z', count: 7 }]
    expect(alignToCurrentAxis(prev, 3)).toEqual([7, 0, 0])
  })

  it('truncates when the previous period has more buckets', () => {
    const prev = [
      { time: '2026-07-03T00:00:00Z', count: 1 },
      { time: '2026-07-03T01:00:00Z', count: 2 },
      { time: '2026-07-03T02:00:00Z', count: 3 },
    ]
    expect(alignToCurrentAxis(prev, 2)).toEqual([1, 2])
  })
})
