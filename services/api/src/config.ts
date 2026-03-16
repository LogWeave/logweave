import { z } from 'zod'

/**
 * Parse and validate LOGWEAVE_API_KEYS JSON string into a Map.
 * Format: '{"api-key-1":"tenant-a","api-key-2":"tenant-b"}'
 * Validates: non-empty keys, non-empty tenant_id values.
 */
const apiKeysSchema = z
  .string()
  .min(2)
  .transform((val, ctx) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(val)
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'LOGWEAVE_API_KEYS must be valid JSON' })
      return z.NEVER
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LOGWEAVE_API_KEYS must be a JSON object',
      })
      return z.NEVER
    }
    const entries = Object.entries(parsed as Record<string, unknown>)
    if (entries.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'LOGWEAVE_API_KEYS must have at least one key' })
      return z.NEVER
    }
    for (const [key, value] of entries) {
      if (key.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'API key must not be empty' })
        return z.NEVER
      }
      if (typeof value !== 'string' || value.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'All API key values must be non-empty tenant_id strings',
        })
        return z.NEVER
      }
    }
    return new Map(entries as [string, string][])
  })

const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  clickhouseUrl: z.string().min(1),
  clustererUrl: z.string().min(1),
  clustererTimeoutMs: z.coerce.number().int().min(50).max(30_000).default(500),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  shutdownTimeoutMs: z.coerce.number().int().min(1000).max(30_000).default(10_000),
  recoveryIntervalMs: z.coerce.number().int().min(1000).max(300_000).default(60_000),
  recoveryLookbackHours: z.coerce.number().int().min(1).max(168).default(24),
  apiKeys: apiKeysSchema,
})

export type Config = z.infer<typeof configSchema>

/**
 * Load and validate config from LOGWEAVE_* environment variables.
 * Throws ZodError on missing or invalid values.
 */
export function loadConfig(): Config {
  return configSchema.parse({
    port: process.env.LOGWEAVE_PORT,
    clickhouseUrl: process.env.LOGWEAVE_CLICKHOUSE_URL,
    clustererUrl: process.env.LOGWEAVE_CLUSTERER_URL,
    clustererTimeoutMs: process.env.LOGWEAVE_CLUSTERER_TIMEOUT_MS,
    logLevel: process.env.LOGWEAVE_LOG_LEVEL,
    shutdownTimeoutMs: process.env.LOGWEAVE_SHUTDOWN_TIMEOUT_MS,
    recoveryIntervalMs: process.env.LOGWEAVE_RECOVERY_INTERVAL_MS,
    recoveryLookbackHours: process.env.LOGWEAVE_RECOVERY_LOOKBACK_HOURS,
    apiKeys: process.env.LOGWEAVE_API_KEYS,
  })
}
