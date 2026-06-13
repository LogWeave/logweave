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

/**
 * Format an event timestamp as HH:MM:SS in either the user's local timezone
 * or UTC, with an unambiguous ISO-8601 string for the tooltip showing the
 * other zone. Used by Live Tail event rows so users can flip between zones
 * without losing context.
 */
export interface FormattedTimeOfDay {
  /** HH:MM:SS in the requested zone. */
  primary: string
  /** ISO-8601 string in the other zone (for hover/title). */
  alternate: string
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function formatTimeOfDay(
  input: string | number | Date,
  mode: 'local' | 'utc',
): FormattedTimeOfDay {
  const date = new Date(input)
  let primary: string
  let alternate: string
  if (mode === 'local') {
    primary = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    alternate = date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
  } else {
    primary = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`
    // Build a "local" representation manually so we don't depend on locale formatting.
    const offsetMin = -date.getTimezoneOffset()
    const sign = offsetMin >= 0 ? '+' : '-'
    const offsetH = pad2(Math.floor(Math.abs(offsetMin) / 60))
    const offsetM = pad2(Math.abs(offsetMin) % 60)
    const yyyy = date.getFullYear()
    const mm = pad2(date.getMonth() + 1)
    const dd = pad2(date.getDate())
    const hh = pad2(date.getHours())
    const mi = pad2(date.getMinutes())
    const ss = pad2(date.getSeconds())
    alternate = `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} UTC${sign}${offsetH}:${offsetM}`
  }
  return { primary, alternate }
}
