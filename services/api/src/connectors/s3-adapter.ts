import {
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  S3Client,
} from '@aws-sdk/client-s3'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { scanStream } from './line-scanner.js'
import { templateToRegex } from './template-regex.js'
import {
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

  private createClient(config: S3ConnectorConfig): S3Client {
    return new S3Client({
      region: config.region,
      ...(config.endpoint
        ? {
            endpoint: config.endpoint,
            forcePathStyle: config.forcePathStyle ?? true,
            credentials: {
              accessKeyId: config.accessKeyId ?? '',
              secretAccessKey: config.secretAccessKey ?? '',
            },
          }
        : {}),
    })
  }

  async testConnection(config: ConnectorConfig): Promise<ConnectionTestResult> {
    const s3Config = config as S3ConnectorConfig
    const client = this.createClient(s3Config)

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
        message: count > 0
          ? `Connected. Found ${count} file(s) with prefix "${s3Config.prefix}".`
          : `Connected but no files found with prefix "${s3Config.prefix}". Check your path pattern.`,
        filesFound: count,
      }
    } catch (err) {
      client.destroy()
      const msg = err instanceof Error ? err.message : String(err)

      if (msg.includes('AccessDenied') || msg.includes('Forbidden')) {
        return {
          success: false,
          message: 'Access denied. Check IAM permissions (s3:ListBucket, s3:GetObject required).',
        }
      }
      if (msg.includes('NoSuchBucket')) {
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
    const client = this.createClient(config)
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
          continue
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
    const result = await client.send(
      new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    )

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
