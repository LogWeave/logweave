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
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LOGWEAVE_API_KEYS must have at least one key',
      })
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
      if (value === '_internal') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'tenant_id "_internal" is reserved for internal operator events and cannot be assigned to an API key',
        })
        return z.NEVER
      }
    }
    return new Map(entries as [string, string][])
  })

/**
 * Parse LOGWEAVE_TRUST_PROXY into an Express `trust proxy` value.
 * - unset/false/off/0 → false (don't trust X-Forwarded-For; req.ip = socket)
 * - true/on → 1 (trust exactly one proxy hop — the documented Caddy/nginx in
 *   front; the address that proxy added is the real client and is not spoofable)
 * - a number → that many trusted hops
 * - anything else → passed through (subnet list or preset like 'loopback')
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const lower = (value ?? '').trim().toLowerCase()
  if (lower === '' || lower === 'false' || lower === 'off' || lower === '0') return false
  if (lower === 'true' || lower === 'on') return 1
  if (/^\d+$/.test(lower)) return Number(lower)
  return value as string
}

const configSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  trustProxy: z.string().optional().transform(parseTrustProxy),
  clickhouseUrl: z.string().min(1),
  clickhouseUser: z.string().optional(),
  clickhousePassword: z.string().optional(),
  clustererUrl: z.string().min(1),
  clustererTimeoutMs: z.coerce.number().int().min(50).max(30_000).default(500),
  // Shared secret forwarded to the clusterer on destructive endpoints
  // (X-Internal-Secret). Must match LOGWEAVE_INTERNAL_SECRET on the clusterer.
  clustererInternalSecret: z.string().optional(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  shutdownTimeoutMs: z.coerce.number().int().min(1000).max(30_000).default(10_000),
  recoveryEnabled: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  recoveryIntervalMs: z.coerce.number().int().min(1000).max(300_000).default(60_000),
  recoveryLookbackHours: z.coerce.number().int().min(1).max(168).default(24),
  // Archive reconciliation sweep (epic #265, #279) — backfills objects the
  // best-effort notify hop missed. Defaults off; only runs when an archive
  // bucket is also configured.
  archiveReconcileEnabled: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  archiveReconcileIntervalMs: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
  // Nightly archive compaction (epic #265, #284) — merges small objects in
  // closed partitions. Defaults off; only runs when an archive bucket is set.
  archiveCompactionEnabled: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  archiveCompactionIntervalMs: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(86_400_000),
  apiKeys: apiKeysSchema,
  dashboardBaseUrl: z.string().url().optional(),
  rateLimitRpm: z.coerce.number().int().min(1).max(10_000).default(300),
  rateLimitTenantRpm: z.coerce.number().int().min(1).max(10_000).default(600),
  rateLimitIngestRpm: z.coerce.number().int().min(1).max(10_000).default(600),
  maxConcurrentQueries: z.coerce.number().int().min(1).max(100).default(8),
  encryptionKey: z
    .string()
    .min(32, 'LOGWEAVE_ENCRYPTION_KEY must be at least 32 chars (use: openssl rand -hex 32)')
    .optional(),
  retentionEnabled: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  retentionIntervalMs: z.coerce.number().int().min(60_000).max(86_400_000).default(86_400_000),
  awsAccountId: z
    .string()
    .regex(/^\d{12}$/, 'LOGWEAVE_AWS_ACCOUNT_ID must be a 12-digit AWS account ID')
    .optional(),
  s3CfnTemplateUrl: z.string().url().optional(),
  // Durable archive (epic #265): the customer's own S3 bucket Vector writes to.
  // When set, raw-log drill-down reads archived objects by source_ref.
  archiveBucket: z.string().optional(),
  archiveRegion: z.string().default('us-east-1'),
  // Dev only: S3-compatible endpoint (Floci) for archive drill-down.
  archiveS3Endpoint: z.string().url().optional(),
  // When set, ingest routes forward batches to the Vector archive engine
  // (durable S3, gated 200) and the async consumer clusters off the hot path,
  // instead of clustering synchronously (epic #265).
  vectorArchiveUrl: z.string().url().optional(),
})

// Fail-safe coupling (#287): the durable-archive forward path has NO real-time
// notify producer — Vector's aws_s3 sink is terminal (it can't fan out the
// landed object key to an http sink), and an S3-ObjectCreated→SQS producer is
// deferred by the no-SQS MVP constraint. That leaves the reconciliation sweep as
// the ONLY writer that backfills forwarded objects into log_metadata. So when
// forwarding is on (vectorArchiveUrl set), the sweep MUST run or forwarded logs
// land in S3 but are permanently unqueryable. We force it on here — overriding
// even an explicit LOGWEAVE_ARCHIVE_RECONCILE_ENABLED=false — because honouring a
// false there would silently re-open the black hole. Backfill latency is the
// sweep interval (~5 min default). When forwarding is off the flag is honoured
// as-is (the synchronous ingest path writes log_metadata itself).
const withReconcileCoupling = configSchema.transform((c) => ({
  ...c,
  archiveReconcileEnabled: c.archiveReconcileEnabled || c.vectorArchiveUrl !== undefined,
}))

export type Config = z.infer<typeof withReconcileCoupling>

/**
 * Load and validate config from LOGWEAVE_* environment variables.
 * Throws ZodError on missing or invalid values.
 */
export function loadConfig(): Config {
  return withReconcileCoupling.parse({
    port: process.env.LOGWEAVE_PORT,
    trustProxy: process.env.LOGWEAVE_TRUST_PROXY,
    clickhouseUrl: process.env.LOGWEAVE_CLICKHOUSE_URL,
    clickhouseUser: process.env.LOGWEAVE_CLICKHOUSE_USER || undefined,
    clickhousePassword: process.env.LOGWEAVE_CLICKHOUSE_PASSWORD || undefined,
    clustererUrl: process.env.LOGWEAVE_CLUSTERER_URL,
    clustererTimeoutMs: process.env.LOGWEAVE_CLUSTERER_TIMEOUT_MS,
    clustererInternalSecret: process.env.LOGWEAVE_INTERNAL_SECRET || undefined,
    logLevel: process.env.LOGWEAVE_LOG_LEVEL,
    shutdownTimeoutMs: process.env.LOGWEAVE_SHUTDOWN_TIMEOUT_MS,
    recoveryEnabled: process.env.LOGWEAVE_RECOVERY_ENABLED,
    recoveryIntervalMs: process.env.LOGWEAVE_RECOVERY_INTERVAL_MS,
    archiveReconcileEnabled: process.env.LOGWEAVE_ARCHIVE_RECONCILE_ENABLED,
    archiveReconcileIntervalMs: process.env.LOGWEAVE_ARCHIVE_RECONCILE_INTERVAL_MS,
    archiveCompactionEnabled: process.env.LOGWEAVE_ARCHIVE_COMPACTION_ENABLED,
    archiveCompactionIntervalMs: process.env.LOGWEAVE_ARCHIVE_COMPACTION_INTERVAL_MS,
    recoveryLookbackHours: process.env.LOGWEAVE_RECOVERY_LOOKBACK_HOURS,
    apiKeys: process.env.LOGWEAVE_API_KEYS,
    dashboardBaseUrl: process.env.LOGWEAVE_DASHBOARD_BASE_URL,
    rateLimitRpm: process.env.LOGWEAVE_RATE_LIMIT_RPM,
    rateLimitTenantRpm: process.env.LOGWEAVE_RATE_LIMIT_TENANT_RPM,
    rateLimitIngestRpm: process.env.LOGWEAVE_RATE_LIMIT_INGEST_RPM,
    maxConcurrentQueries: process.env.LOGWEAVE_MAX_CONCURRENT_QUERIES,
    encryptionKey: process.env.LOGWEAVE_ENCRYPTION_KEY,
    retentionEnabled: process.env.LOGWEAVE_RETENTION_ENABLED,
    retentionIntervalMs: process.env.LOGWEAVE_RETENTION_INTERVAL_MS,
    awsAccountId: process.env.LOGWEAVE_AWS_ACCOUNT_ID || undefined,
    s3CfnTemplateUrl: process.env.LOGWEAVE_S3_CFN_TEMPLATE_URL || undefined,
    archiveBucket: process.env.LOGWEAVE_ARCHIVE_BUCKET || undefined,
    archiveRegion: process.env.AWS_REGION || undefined,
    archiveS3Endpoint: process.env.LOGWEAVE_S3_ENDPOINT || undefined,
    vectorArchiveUrl: process.env.LOGWEAVE_VECTOR_ARCHIVE_URL || undefined,
  })
}
