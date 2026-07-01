import type { S3ConnectorConfig } from './types.js'

/**
 * Inputs for {@link buildArchiveConfig}, sourced from the environment at
 * startup (see `app.ts`). The archive bucket is the customer's OWN bucket —
 * the durable-archive system of record that Vector writes to (epic #265) — not
 * a user-configured external connector.
 */
export interface ArchiveConfigEnv {
  /** LOGWEAVE_ARCHIVE_BUCKET. Absent → archive drill-down is disabled. */
  bucket?: string
  /** AWS_REGION (defaults to us-east-1). */
  region?: string
  /** Dev only: LOGWEAVE_S3_ENDPOINT (Floci). Triggers static-cred + path-style. */
  endpoint?: string
  /** Dev only: AWS_ACCESS_KEY_ID (used with `endpoint`). */
  accessKeyId?: string
  /** Dev only: AWS_SECRET_ACCESS_KEY (used with `endpoint`). */
  secretAccessKey?: string
}

/**
 * Build the S3 connector config for the customer's archive bucket, or
 * `undefined` when no archive bucket is configured (archive drill-down off).
 *
 * Auth: in production there is NO `roleArn` / static creds, so `S3Adapter`
 * falls through to the default credential chain — i.e. the EC2 instance role
 * that has `s3:Put/Get/DeleteObject` + `ListBucket` on this bucket (network.yml;
 * Get/Delete are for the compaction sweep, #284). In dev, `endpoint` + static
 * creds point it at Floci, path-style.
 *
 * `logFormat: 'jsonl'` + `compression: 'gzip'` match what Vector writes
 * (newline-delimited JSON, gzip, `.log.gz`); the line-scanner extracts the
 * `message` field per line and matches the drill-down regex against it.
 */
export function buildArchiveConfig(env: ArchiveConfigEnv): S3ConnectorConfig | undefined {
  if (!env.bucket) return undefined

  const base: S3ConnectorConfig = {
    type: 's3',
    bucket: env.bucket,
    prefix: '',
    // Mirrors Vector's key_prefix. Only the listing fallback reads this; archive
    // drill-down uses the exact source_ref keys recorded in log_metadata.
    pathPattern: 'tenant={tenant}/service={service}/date={year}-{month}-{day}/hour={hour}/',
    region: env.region ?? 'us-east-1',
    logFormat: 'jsonl',
    compression: 'gzip',
  }

  if (env.endpoint) {
    return {
      ...base,
      endpoint: env.endpoint,
      forcePathStyle: true,
      accessKeyId: env.accessKeyId ?? '',
      secretAccessKey: env.secretAccessKey ?? '',
    }
  }

  return base
}
