/**
 * Diurnal (time-of-day) traffic shaping.
 *
 * LogWeave's anomaly baseline is matched by hour-of-day (ADR-014), so flat
 * round-the-clock traffic gives every hour an identical baseline and the
 * diurnal intelligence can't be exercised. This curve scales the event rate by
 * UTC hour-of-day: a smooth peak around mid-afternoon and a trough overnight,
 * so backfilled history (and optionally live traffic) has a realistic daily
 * rhythm for the baseline to learn.
 */

/** Lowest fraction of peak rate (overnight trough). */
const MIN_FACTOR = 0.2
/** UTC hour the curve peaks at. */
const PEAK_HOUR = 14

/**
 * Multiplier in [MIN_FACTOR, 1.0] for a given UTC hour-of-day (0–23, fractional
 * hours allowed). 1.0 at the daily peak, MIN_FACTOR at the opposite hour.
 */
export function diurnalFactor(hourOfDay: number): number {
  const radians = ((hourOfDay - PEAK_HOUR) / 24) * 2 * Math.PI
  const cosine = Math.cos(radians) // 1 at peak, -1 twelve hours away
  return MIN_FACTOR + (1 - MIN_FACTOR) * ((cosine + 1) / 2)
}

/** Diurnal factor for a specific instant, using its fractional UTC hour. */
export function diurnalFactorAt(date: Date): number {
  const fractionalHour = date.getUTCHours() + date.getUTCMinutes() / 60
  return diurnalFactor(fractionalHour)
}
