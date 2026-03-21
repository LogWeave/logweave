/**
 * Convert a log template (with placeholders) into a regex for matching raw log lines.
 *
 * Placeholder mappings:
 * - <UUID> → UUID v4 pattern
 * - <IP>   → IPv4 pattern
 * - <ID>   → 6+ digit number
 * - <EMAIL> → email pattern
 * - <TS>   → ISO timestamp prefix
 * - <HEX>  → 16+ hex chars
 * - <*>    → non-greedy wildcard (Drain3)
 */

const PLACEHOLDER_MAP: ReadonlyMap<string, string> = new Map([
  ['<UUID>', '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'],
  ['<IP>', '\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}'],
  ['<ID>', '\\d{6,}'],
  ['<EMAIL>', '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+'],
  ['<TS>', '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[^ ]*'],
  ['<HEX>', '[0-9a-fA-F]{16,}'],
  ['<*>', '.*?'],
])

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function templateToRegex(templateText: string): RegExp {
  if (templateText.length === 0) {
    return /^$/
  }

  // Split template on placeholders, keeping the delimiters
  const placeholderPattern = /<UUID>|<IP>|<ID>|<EMAIL>|<TS>|<HEX>|<\*>/g
  const parts: string[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = placeholderPattern.exec(templateText)) !== null) {
    // Add escaped literal text before this placeholder
    if (match.index > lastIndex) {
      parts.push(escapeRegExp(templateText.slice(lastIndex, match.index)))
    }
    // Add the regex for this placeholder
    const replacement = PLACEHOLDER_MAP.get(match[0])
    if (replacement) {
      parts.push(replacement)
    }
    lastIndex = match.index + match[0].length
  }

  // Add remaining literal text after the last placeholder
  if (lastIndex < templateText.length) {
    parts.push(escapeRegExp(templateText.slice(lastIndex)))
  }

  return new RegExp(parts.join(''), 'i')
}
