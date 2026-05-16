// Redaction rules for internal events. Non-negotiable: this module is the only
// sanctioned path into the sinks, and direct emission of unsafe data is impossible
// to express through the emitter API.

// Values for these config keys may appear verbatim in events. Anything that
// might carry credentials (DSNs, full URLs with userinfo, API keys, tokens)
// must NOT be on this list — see summarizeConfig for the host-only treatment
// of URL-shaped fields.
const CONFIG_VALUE_ALLOWLIST: ReadonlySet<string> = new Set([
  'port',
  'log_level',
  'logLevel',
  'node_env',
  'nodeEnv',
  'service_version',
  'serviceVersion',
])

// Config keys whose values are URLs that may embed credentials. We emit only
// the hostname for these.
const URL_HOST_ONLY_KEYS: ReadonlySet<string> = new Set([
  'clickhouse_url',
  'clickhouseUrl',
  'clusterer_url',
  'clustererUrl',
])

// Field names that, regardless of event, must never appear with their value.
// Match is case-insensitive substring.
const UNIVERSAL_FORBIDDEN_SUBSTRINGS: readonly string[] = [
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'passwd',
  'webhook_url',
  'webhookurl',
  'authorization',
  'cookie',
  'sessionid',
  'session_id',
  'bearer',
  'private',
  'credential',
]

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase()
  return UNIVERSAL_FORBIDDEN_SUBSTRINGS.some((needle) => lower.includes(needle))
}

function redactedPlaceholder(value: unknown): string {
  if (typeof value === 'string') return `<redacted:len=${value.length}>`
  if (value === null || value === undefined) return '<redacted>'
  return `<redacted:type=${typeof value}>`
}

/**
 * Apply universal forbidden-key scrubbing to any fields payload. Values for
 * forbidden keys become a redacted placeholder.
 */
export function redactFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (isForbiddenKey(key)) {
      out[key] = redactedPlaceholder(value)
      continue
    }
    // Recurse one level into nested objects so things like { config: { password: "..." } }
    // are still scrubbed. We do not deep-recurse beyond that — `fields` is meant to be flat
    // metadata, not arbitrary trees.
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested: Record<string, unknown> = {}
      for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) {
        nested[k2] = isForbiddenKey(k2) ? redactedPlaceholder(v2) : v2
      }
      out[key] = nested
      continue
    }
    out[key] = value
  }
  return out
}

/**
 * Summarize a config object for config.loaded events. Only allowlisted keys
 * pass through with their values. Everything else becomes `<redacted:len=N>`.
 *
 * Input may be any record; nested objects are summarized one level deep.
 */
export function summarizeConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (CONFIG_VALUE_ALLOWLIST.has(key)) {
      out[key] = value
    } else if (URL_HOST_ONLY_KEYS.has(key) && typeof value === 'string') {
      out[`${key}_host`] = safeUrlHost(value)
    } else {
      out[key] = redactedPlaceholder(value)
    }
  }
  return out
}

function safeUrlHost(value: string): string {
  try {
    return new URL(value).host || '<unparseable>'
  } catch {
    return '<unparseable>'
  }
}

/**
 * Strip stack traces and any property whose value contains a multi-line
 * indented stack-frame pattern. Use on error fields before they go to ClickHouse.
 * Stack traces are still allowed on stdout for operator debugging via docker logs.
 */
const STACK_KEY_NAMES = new Set(['stack', 'stackTrace', 'stack_trace'])
const STACK_LIKE = /\n\s+at\s/

function stripOneLevel(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }
  const inner: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (STACK_KEY_NAMES.has(k)) continue
    if (typeof v === 'string' && STACK_LIKE.test(v)) {
      inner[k] = v.split('\n')[0] ?? ''
      continue
    }
    inner[k] = v
  }
  return inner
}

export function stripStackTraces(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (STACK_KEY_NAMES.has(key)) continue
    if (typeof value === 'string' && STACK_LIKE.test(value)) {
      out[key] = value.split('\n')[0] ?? ''
      continue
    }
    out[key] = stripOneLevel(value)
  }
  return out
}

/**
 * Sanitize an arbitrary error message so it cannot carry secrets pulled in
 * from format strings like `failed to query: ${apiKey}`. Heuristic: cap length
 * and strip anything that looks like a long opaque token.
 */
export function sanitizeMessage(message: string): string {
  const TOKEN_PATTERN = /\b[a-zA-Z0-9_\-]{24,}\b/g
  return message.replace(TOKEN_PATTERN, '<redacted:token>').slice(0, 240)
}
