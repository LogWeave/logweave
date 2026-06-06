/**
 * Format a timestamp as a short relative string ("2h ago", "just now") for
 * display, paired with an unambiguous ISO string for the tooltip. Locale-
 * dependent `toLocaleString()` produced ambiguous `05/06/2026` output that read
 * as either Jun 5 or May 6 depending on the user's locale.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface FormattedTime {
  /** Short display string — "just now", "5m ago", "3h ago", "2d ago". */
  relative: string
  /** Unambiguous ISO-8601 in UTC for tooltips. */
  iso: string
}

export function formatRelativeTime(input: string | number | Date): FormattedTime {
  const date = new Date(input)
  const diff = Date.now() - date.getTime()
  const iso = date
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC')

  let relative: string
  if (diff < MINUTE) relative = 'just now'
  else if (diff < HOUR) relative = `${Math.floor(diff / MINUTE)}m ago`
  else if (diff < DAY) relative = `${Math.floor(diff / HOUR)}h ago`
  else relative = `${Math.floor(diff / DAY)}d ago`

  return { relative, iso }
}
