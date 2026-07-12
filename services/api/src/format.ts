const MAX_TEMPLATE_TEXT_LENGTH = 200

/**
 * Truncate template text to max length, adding truncated flag.
 */
export function truncateTemplateText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEMPLATE_TEXT_LENGTH) {
    return { text, truncated: false }
  }
  return { text: `${text.slice(0, MAX_TEMPLATE_TEXT_LENGTH)}...`, truncated: true }
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
