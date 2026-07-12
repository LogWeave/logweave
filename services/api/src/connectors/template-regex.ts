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

// Complexity guards. Templates come from Drain3 clustering, but a pathological
// log line can still yield a long template with many wildcards. The compiled
// regex is matched in-process (filesystem/Elasticsearch adapters), so many
// `.*?` segments are a backtracking/ReDoS surface. Cap both before compiling.
const MAX_TEMPLATE_LENGTH = 4096
const MAX_WILDCARDS = 64

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function templateToRegex(templateText: string): RegExp {
  if (templateText.length === 0) {
    return /^$/
  }

  // Bound the input length so a hostile template can't blow up compilation/matching.
  const text =
    templateText.length > MAX_TEMPLATE_LENGTH
      ? templateText.slice(0, MAX_TEMPLATE_LENGTH)
      : templateText

  // Split template on placeholders, keeping the delimiters
  const placeholderPattern = /<UUID>|<IP>|<ID>|<EMAIL>|<TS>|<HEX>|<\*>/g
  const parts: string[] = []
  let lastIndex = 0
  let wildcards = 0

  for (
    let match = placeholderPattern.exec(text);
    match !== null;
    match = placeholderPattern.exec(text)
  ) {
    // Add escaped literal text before this placeholder
    if (match.index > lastIndex) {
      parts.push(escapeRegExp(text.slice(lastIndex, match.index)))
    }
    const token = match[0]
    // Once the wildcard budget is spent, treat further `<*>` as literal text so
    // the compiled regex can never contain an unbounded number of `.*?` runs.
    if (token === '<*>' && wildcards >= MAX_WILDCARDS) {
      parts.push(escapeRegExp(token))
    } else {
      const replacement = PLACEHOLDER_MAP.get(token)
      if (replacement) {
        parts.push(replacement)
        if (token === '<*>') wildcards++
      }
    }
    lastIndex = match.index + token.length
  }

  // Add remaining literal text after the last placeholder
  if (lastIndex < text.length) {
    parts.push(escapeRegExp(text.slice(lastIndex)))
  }

  return new RegExp(parts.join(''), 'i')
}
