import { describe, expect, it } from 'vitest'
import { sparklineTrend } from './sparkline-data'

describe('sparklineTrend', () => {
  it('is flat with fewer than two points', () => {
    expect(sparklineTrend([])).toBe('flat')
    expect(sparklineTrend([5])).toBe('flat')
  })

  it('rises when the last point is more than 20% above the first', () => {
    expect(sparklineTrend([100, 130])).toBe('up')
  })

  it('falls when the last point is more than 20% below the first', () => {
    expect(sparklineTrend([100, 70])).toBe('down')
  })

  it.each([
    [100, 120], // exactly +20% is inside the dead band
    [100, 80], // exactly -20% is inside the dead band
    [100, 110],
    [100, 100],
  ])('treats a change within the dead band (%d -> %d) as flat', (first, last) => {
    expect(sparklineTrend([first, last])).toBe('flat')
  })

  it('compares only the first and last points, ignoring the middle', () => {
    expect(sparklineTrend([100, 5, 500, 130])).toBe('up')
  })

  it('rises from a zero baseline once any positive value appears', () => {
    // first * 1.2 === 0, so any last > 0 counts as up
    expect(sparklineTrend([0, 1])).toBe('up')
  })
})
