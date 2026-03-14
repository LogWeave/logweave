import { z } from 'zod'

const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  clickhouseUrl: z.string().min(1),
  clustererUrl: z.string().min(1),
  clustererTimeoutMs: z.coerce.number().int().min(50).max(30_000).default(500),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  shutdownTimeoutMs: z.coerce.number().int().min(1000).max(30_000).default(10_000),
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
  })
}
