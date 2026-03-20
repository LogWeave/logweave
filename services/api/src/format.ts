const RISING_THRESHOLD = 1.5
const FALLING_THRESHOLD = 0.67
const MAX_TEMPLATE_TEXT_LENGTH = 200

/**
 * Compute human-readable trend text from current vs previous occurrence counts.
 * "rising 3.2x" | "falling 0.5x" | "stable" | "new" (no previous data)
 */
export function trendText(currentCount: number, previousCount: number): string {
  if (previousCount <= 0) {
    return currentCount > 0 ? 'new' : 'stable'
  }
  const ratio = currentCount / previousCount
  if (ratio > RISING_THRESHOLD) {
    return `rising ${ratio.toFixed(1)}x`
  }
  if (ratio < FALLING_THRESHOLD) {
    return `falling ${ratio.toFixed(1)}x`
  }
  return 'stable'
}

/**
 * Truncate template text to max length, adding truncated flag.
 */
export function truncateTemplateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEMPLATE_TEXT_LENGTH) {
    return { text, truncated: false }
  }
  return { text: text.slice(0, MAX_TEMPLATE_TEXT_LENGTH) + '...', truncated: true }
}

/**
 * Build a human-readable time range string for meta.
 */
export function formatTimeRange(hours: number): string {
  const end = new Date()
  const start = new Date(end.getTime() - hours * 3_600_000)
  return `last ${hours} hours (${start.toISOString()} to ${end.toISOString()})`
}

/**
 * Data retention description for meta.
 */
export const DATA_RETENTION = 'data covers up to 30 days'
