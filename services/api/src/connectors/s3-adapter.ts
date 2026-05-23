import type { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import {
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  S3Client,
} from '@aws-sdk/client-s3'
import { AssumeRoleCommand, type AssumeRoleCommandOutput, STSClient } from '@aws-sdk/client-sts'
import { getInternalEvents } from '../internal-events/emitter.js'
import { scanStream } from './line-scanner.js'
import { buildRoleSessionName } from './session-name.js'
import { templateToRegex } from './template-regex.js'
import {
  type AdapterAuditContext,
  type ConnectionTestResult,
  type ConnectorConfig,
  type FetchRawLogsParams,
  type LogSourceAdapter,
  type RawLogLine,
  type RawLogResult,
  type S3ConnectorConfig,
  SCAN_DEFAULTS,
} from './types.js'

// ---------------------------------------------------------------------------
// STS error handling
// ---------------------------------------------------------------------------

/**
 * Tagged error so testConnection can distinguish a failure during the STS
 * AssumeRole step from a failure later (ListObjectsV2 etc.). Carries the raw
 * AWS error name so the mapper can give specific guidance.
 */
export class StsAssumeRoleError extends Error {
  readonly errorName: string

  constructor(awsErrorName: string, awsMessage: string) {
    super(awsMessage)
    this.name = 'StsAssumeRoleError'
    this.errorName = awsErrorName
  }
}

/**
 * Synthetic name used when AssumeRole returns 200 OK but with no credentials
 * in the response. Distinct from a real AWS error: indicates a LogWeave
 * server-side bug, not a customer-fixable trust-policy issue.
 */
const NO_CREDENTIALS_RETURNED = 'NoCredentialsReturned'

/**
 * AWS SDK v3 sets the AWS error code as `error.name` (e.g. "AccessDenied",
 * "InvalidClientTokenId"). Substring-matching the message string would be
 * brittle — different SDK versions and translation layers reword the
 * sentence — so we route on `name`.
 */
function awsErrorName(err: unknown): string {
  return (err as { name?: string } | undefined)?.name ?? 'Unknown'
}

interface StsErrorMapping {
  /** Internal-event code (operator-facing). */
  code: string
  /** User-facing message — never echoes the raw AWS message. */
  message: string
}

export function mapStsError(errorName: string): StsErrorMapping {
  switch (errorName) {
    case 'AccessDenied':
      return {
        code: 'S3_ASSUME_ROLE_DENIED',
        message:
          "AWS denied the AssumeRole request. The IAM role exists but its trust policy doesn't accept this connection — most often the External ID in the role doesn't match the one LogWeave is sending. Re-run the quick-create flow (or update the role's trust policy by hand) to align the External ID.",
      }
    case 'InvalidClientTokenId':
    case 'SignatureDoesNotMatch':
      return {
        code: 'S3_STS_INVALID_CREDENTIALS',
        message:
          "LogWeave's own AWS credentials are invalid or unsigned. This is a server-side configuration problem — contact whoever runs your LogWeave instance.",
      }
    // AWS SDK v3 sets `error.name = 'ExpiredTokenException'` for both wire
    // codes "ExpiredToken" and "ExpiredTokenException" — the SDK collapses
    // them to the modeled class name.
    case 'ExpiredTokenException':
      return {
        code: 'S3_STS_EXPIRED_TOKEN',
        message:
          "LogWeave's AWS session token has expired. This is a server-side configuration problem — contact whoever runs your LogWeave instance.",
      }
    // Same collapse: wire "MalformedPolicy" surfaces as the class name
    // "MalformedPolicyDocumentException" in the SDK.
    case 'MalformedPolicyDocumentException':
      return {
        code: 'S3_STS_MALFORMED_POLICY',
        message:
          "The IAM role's trust policy is malformed. If you used quick-create, update or re-create the CloudFormation stack; otherwise check the role's trust policy JSON.",
      }
    case 'RegionDisabledException':
      return {
        code: 'S3_STS_REGION_DISABLED',
        message:
          'STS is disabled in the configured region. Pick a different region, or enable STS in your AWS account settings.',
      }
    case 'Throttling':
    case 'ThrottlingException':
      return {
        code: 'S3_STS_THROTTLED',
        message: 'AWS rate-limited the AssumeRole request. Wait a few seconds and try again.',
      }
    case NO_CREDENTIALS_RETURNED:
      return {
        code: 'S3_STS_NO_CREDENTIALS',
        message:
          'AWS accepted the AssumeRole request but returned no credentials. This is a LogWeave server-side bug — contact whoever runs your LogWeave instance.',
      }
    default:
      return {
        code: 'S3_STS_UNKNOWN',
        message:
          "AssumeRole failed for a reason we don't have a specific message for. Common causes: the role hasn't finished provisioning yet (CloudFormation can take 30–60s), the role ARN was mistyped, or the role was deleted. Wait a minute and try again.",
      }
  }
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function resolvePathPrefixes(
  config: S3ConnectorConfig,
  service: string,
  timeRange: { start: Date; end: Date },
): string[] {
  const prefixes: string[] = []
  const current = new Date(timeRange.start)

  while (current <= timeRange.end) {
    const year = current.getUTCFullYear().toString()
    const month = String(current.getUTCMonth() + 1).padStart(2, '0')
    const day = String(current.getUTCDate()).padStart(2, '0')
    const hour = String(current.getUTCHours()).padStart(2, '0')

    let prefix = config.pathPattern
      .replace('{prefix}', config.prefix)
      .replace('{service}', service)
      .replace('{year}', year)
      .replace('{month}', month)
      .replace('{day}', day)
      .replace('{hour}', hour)

    // If pattern doesn't have {hour}, avoid duplicates
    if (!config.pathPattern.includes('{hour}')) {
      prefix = config.pathPattern
        .replace('{prefix}', config.prefix)
        .replace('{service}', service)
        .replace('{year}', year)
        .replace('{month}', month)
        .replace('{day}', day)
    }

    if (!prefixes.includes(prefix)) {
      prefixes.push(prefix)
    }

    // Advance by 1 hour
    current.setUTCHours(current.getUTCHours() + 1)
  }

  return prefixes
}

// ---------------------------------------------------------------------------
// S3 console link generation
// ---------------------------------------------------------------------------

function s3ConsoleUrl(config: S3ConnectorConfig, key: string): string {
  if (config.endpoint) {
    // MinIO console — assumes console runs on port 9001
    const base = config.endpoint.replace(/:\d+$/, ':9001')
    return `${base}/browser/${config.bucket}/${key}`
  }
  return `https://s3.console.aws.amazon.com/s3/object/${config.bucket}?prefix=${encodeURIComponent(key)}`
}

// ---------------------------------------------------------------------------
// S3Adapter
// ---------------------------------------------------------------------------

export class S3Adapter implements LogSourceAdapter {
  readonly type = 's3'

  private async createClient(
    config: S3ConnectorConfig,
    auditContext: AdapterAuditContext | undefined,
  ): Promise<S3Client> {
    // MinIO / dev-mode: static credentials against a custom endpoint.
    if (config.endpoint) {
      return new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle ?? true,
        credentials: {
          accessKeyId: config.accessKeyId ?? '',
          secretAccessKey: config.secretAccessKey ?? '',
        },
      })
    }

    // Production: assume the customer's cross-account role via STS.
    if (config.roleArn) {
      if (!auditContext) {
        // The session name plumbing is a hard requirement on the AWS path:
        // it surfaces in the customer's CloudTrail. Forgetting to thread it
        // through would silently regress per-tenant audit visibility.
        throw new Error(
          'S3Adapter: auditContext required when roleArn is configured (needed for RoleSessionName)',
        )
      }
      const roleSessionName = buildRoleSessionName({
        tenantId: auditContext.tenantId,
        connectorId: auditContext.connectorId,
        secret: auditContext.sessionNameSecret,
      })
      const sts = new STSClient({ region: config.region })
      try {
        let result: AssumeRoleCommandOutput
        try {
          result = await sts.send(
            new AssumeRoleCommand({
              RoleArn: config.roleArn,
              RoleSessionName: roleSessionName,
              ExternalId: config.externalId,
              DurationSeconds: 3600,
            }),
          )
        } catch (err) {
          // Re-throw as a tagged error so testConnection can map STS-specific
          // failure modes without string-matching the SDK error name from a
          // catch-all block.
          throw new StsAssumeRoleError(
            awsErrorName(err),
            err instanceof Error ? err.message : String(err),
          )
        }
        const creds = result.Credentials
        if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
          throw new StsAssumeRoleError(
            NO_CREDENTIALS_RETURNED,
            'AssumeRole did not return credentials',
          )
        }
        return new S3Client({
          region: config.region,
          credentials: {
            accessKeyId: creds.AccessKeyId,
            secretAccessKey: creds.SecretAccessKey,
            sessionToken: creds.SessionToken,
            expiration: creds.Expiration,
          },
        })
      } finally {
        sts.destroy()
      }
    }

    // Fallback: default credential chain (env / instance profile).
    return new S3Client({ region: config.region })
  }

  async testConnection(
    config: ConnectorConfig,
    auditContext?: AdapterAuditContext,
  ): Promise<ConnectionTestResult> {
    const s3Config = config as S3ConnectorConfig

    // STS AssumeRole runs inside createClient. Its errors get a distinct
    // event + actionable message — separate from S3-level failures because
    // the user-facing remediation is different (trust policy vs IAM
    // permission vs bucket).
    let client: S3Client
    try {
      client = await this.createClient(s3Config, auditContext)
    } catch (err) {
      if (err instanceof StsAssumeRoleError) {
        const { code, message } = mapStsError(err.errorName)
        getInternalEvents().emit({
          event: 's3.assume_role_failed',
          severity: 'error',
          code,
          summary: 's3 connector AssumeRole failed',
          fields: { region: s3Config.region, error_name: err.errorName },
        })
        return { success: false, message }
      }
      throw err
    }

    try {
      const result = await client.send(
        new ListObjectsV2Command({
          Bucket: s3Config.bucket,
          Prefix: s3Config.prefix,
          MaxKeys: 10,
        }),
      )

      const count = result.KeyCount ?? 0
      client.destroy()

      return {
        success: true,
        message:
          count > 0
            ? `Connected. Found ${count} file(s) with prefix "${s3Config.prefix}".`
            : `Connected but no files found with prefix "${s3Config.prefix}". Check your path pattern.`,
        filesFound: count,
      }
    } catch (err) {
      client.destroy()
      const errorName = awsErrorName(err)
      const isAccessDenied = errorName === 'AccessDenied' || errorName === 'Forbidden'
      const isNoSuchBucket = errorName === 'NoSuchBucket'
      const code = isAccessDenied
        ? 'S3_ACCESS_DENIED'
        : isNoSuchBucket
          ? 'S3_NO_SUCH_BUCKET'
          : 'S3_UNKNOWN'
      getInternalEvents().emit({
        event: 's3.connector_failed',
        severity: 'error',
        code,
        summary: 's3 connector test failed',
        fields: { region: s3Config.region, error_name: errorName },
      })

      if (isAccessDenied) {
        return {
          success: false,
          message: 'Access denied. Check IAM permissions (s3:ListBucket, s3:GetObject required).',
        }
      }
      if (isNoSuchBucket) {
        return {
          success: false,
          message: `Bucket "${s3Config.bucket}" does not exist or is not accessible.`,
        }
      }
      // Catch-all: do not echo the raw SDK error back to the user. AWS error
      // messages can include account IDs, ARNs, and request fingerprints that
      // shouldn't surface in a UI. Specific cases (AccessDenied, NoSuchBucket)
      // are handled above; this fallback covers the long tail.
      return {
        success: false,
        message: 'Connection failed. Check the bucket, region, and credentials, then try again.',
      }
    }
  }

  async fetchRawLogs(params: FetchRawLogsParams): Promise<RawLogResult> {
    const config = params.config as S3ConnectorConfig
    const client = await this.createClient(config, params.auditContext)
    const regex = templateToRegex(params.templateText)
    const limit = Math.min(params.limit, SCAN_DEFAULTS.maxLimit)

    const lines: RawLogLine[] = []
    let filesScanned = 0
    let bytesScanned = 0
    let truncated = false
    let truncatedReason: 'file_limit' | 'timeout' | undefined

    const startTime = Date.now()

    try {
      // Fast path: use sourceRef if provided
      const keys: string[] = []

      if (params.sourceRef) {
        keys.push(params.sourceRef)
      } else {
        // Resolve prefixes and list objects
        const prefixes = resolvePathPrefixes(config, params.service, params.timeRange)

        for (const prefix of prefixes) {
          if (keys.length >= SCAN_DEFAULTS.maxFiles) break

          let continuationToken: string | undefined
          do {
            const result: ListObjectsV2CommandOutput = await client.send(
              new ListObjectsV2Command({
                Bucket: config.bucket,
                Prefix: prefix,
                MaxKeys: 1000,
                ContinuationToken: continuationToken,
              }),
            )

            for (const obj of result.Contents ?? []) {
              if (obj.Key && keys.length < SCAN_DEFAULTS.maxFiles) {
                keys.push(obj.Key)
              }
            }

            continuationToken = result.NextContinuationToken
          } while (continuationToken && keys.length < SCAN_DEFAULTS.maxFiles)
        }
      }

      // Scan files for matching lines
      for (const key of keys) {
        if (lines.length >= limit) break
        if (Date.now() - startTime > SCAN_DEFAULTS.maxTimeoutMs) {
          truncated = true
          truncatedReason = 'timeout'
          break
        }
        if (filesScanned >= SCAN_DEFAULTS.maxFiles) {
          truncated = true
          truncatedReason = 'file_limit'
          break
        }

        filesScanned++

        try {
          const fileLines = await this.scanFile(client, config, key, regex, limit - lines.length)
          bytesScanned += fileLines.bytesRead

          for (const line of fileLines.matches) {
            lines.push({
              message: line.message,
              timestamp: line.timestamp,
              source: key,
              sourceUrl: s3ConsoleUrl(config, key),
            })
            if (lines.length >= limit) break
          }
        } catch {
          // Skip unreadable files (permissions, deleted between list and get, etc.)
        }
      }

      if (!truncated && keys.length >= SCAN_DEFAULTS.maxFiles && lines.length < limit) {
        truncated = true
        truncatedReason = 'file_limit'
      }
    } finally {
      client.destroy()
    }

    return {
      lines,
      hasMore: truncated && lines.length > 0,
      filesScanned,
      bytesScanned,
      truncated,
      truncatedReason,
    }
  }

  private async scanFile(
    client: S3Client,
    config: S3ConnectorConfig,
    key: string,
    regex: RegExp,
    remaining: number,
  ): Promise<{ matches: Array<{ message: string; timestamp?: string }>; bytesRead: number }> {
    const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))

    if (!result.Body) {
      return { matches: [], bytesRead: 0 }
    }

    let stream: Readable = result.Body as Readable

    // Decompress if gzipped
    if (config.compression === 'gzip' || key.endsWith('.gz')) {
      const gunzip = createGunzip()
      stream = stream.pipe(gunzip)
    }

    return scanStream({ stream, regex, logFormat: config.logFormat, remaining })
  }
}
