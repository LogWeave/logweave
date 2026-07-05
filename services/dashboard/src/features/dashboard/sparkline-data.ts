/**
 * Pure helper for the mini sparkline. The trend classification drives the line
 * colour (warning = rising, success = falling, brand = flat), so it's extracted
 * to be tested independently of the canvas drawing.
 */

export type SparklineTrend = 'up' | 'down' | 'flat'

/**
 * Compare the last point to the first with a 20% dead band: a rise/fall under
 * 20% reads as flat, so noise doesn't flip the colour. Series shorter than two
 * points are 'flat' (nothing to compare).
 */
export function sparklineTrend(points: number[]): SparklineTrend {
  if (points.length < 2) return 'flat'
  const first = points[0] ?? 0
  const last = points[points.length - 1] ?? 0
  if (last > first * 1.2) return 'up'
  if (last < first * 0.8) return 'down'
  return 'flat'
}
