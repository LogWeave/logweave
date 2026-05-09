/**
 * Grafana Loki log source adapter.
 *
 * Uses global fetch (no new dependencies).
 *
 * testConnection: GET /ready + GET /loki/api/v1/labels
 * fetchRawLogs:   GET /loki/api/v1/query_range with LogQL `|~ "regex"`
 */

import { templateToRegex } from './template-regex.js'
import {
  type ConnectionTestResult,
  type ConnectorConfig,
  type FetchRawLogsParams,
  type LokiConnectorConfig,
  type LogSourceAdapter,
  type RawLogLine,
  type RawLogResult,
  SCAN_DEFAULTS,
} from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHeaders(config: LokiConnectorConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }

  if (config.orgId) {
    headers['X-Scope-OrgID'] = config.orgId
  }

  if (config.username && config.password) {
    const encoded = Buffer.from(`${config.username}:${config.password}`).toString('base64')
    headers.Authorization = `Basic ${encoded}`
  }

  return headers
}

/**
 * Convert a JS RegExp source to a Loki-compatible regex string.
 * Loki regex (RE2) does not support lazy quantifiers (.*?) — replace with greedy (.*).
 */
function toLokiRegex(regex: RegExp): string {
  return regex.source
    .replace(/\.\*\?/g, '.*')
}

/**
 * Convert a Date to Loki nanosecond timestamp string.
 */
function toNanos(date: Date): string {
  return `${date.getTime()}000000`
}

/**
 * Parse a Loki nanosecond timestamp to an ISO string.
 */
function nanosToIso(nanos: string): string {
  const ms = Number(nanos.slice(0, -6))
  return new Date(ms).toISOString()
}

// ---------------------------------------------------------------------------
// LokiAdapter
// ---------------------------------------------------------------------------

export class LokiAdapter implements LogSourceAdapter {
  readonly type = 'loki'

  async testConnection(config: ConnectorConfig): Promise<ConnectionTestResult> {
    const lokiConfig = config as LokiConnectorConfig
    const headers = buildHeaders(lokiConfig)
    const baseUrl = lokiConfig.url.replace(/\/$/, '')

    try {
      // Check readiness
      const readyRes = await fetch(`${baseUrl}/ready`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })

      if (!readyRes.ok) {
        return {
          success: false,
          message: `Loki not ready (${readyRes.status}). Check the server status.`,
        }
      }

      // Check labels to verify data access
      const labelsRes = await fetch(`${baseUrl}/loki/api/v1/labels`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })

      if (!labelsRes.ok) {
        if (labelsRes.status === 401 || labelsRes.status === 403) {
          return {
            success: false,
            message: 'Authentication failed. Check your credentials.',
          }
        }
        return {
          success: false,
          message: `Labels query failed (${labelsRes.status}).`,
        }
      }

      const labelsBody = (await labelsRes.json()) as { data?: string[] }
      const labelCount = labelsBody.data?.length ?? 0

      return {
        success: true,
        message: `Connected to Loki. Found ${labelCount} label(s).`,
        filesFound: labelCount,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
        return {
          success: false,
          message: `Cannot reach Loki at ${baseUrl}. Check the URL and network connectivity.`,
        }
      }
      // Catch-all: do not echo the raw error back to the user.
      return {
        success: false,
        message: 'Connection failed. Check the URL, stream selector, and credentials, then try again.',
      }
    }
  }

  async fetchRawLogs(params: FetchRawLogsParams): Promise<RawLogResult> {
    const config = params.config as LokiConnectorConfig
    const headers = buildHeaders(config)
    const baseUrl = config.url.replace(/\/$/, '')
    const limit = Math.min(params.limit, SCAN_DEFAULTS.maxLimit)
    const regex = templateToRegex(params.templateText)
    const lokiRegex = toLokiRegex(regex)

    // Build LogQL: stream selector + regex line filter
    const logql = `${config.streamSelector} |~ \`${lokiRegex}\``

    const url = new URL(`${baseUrl}/loki/api/v1/query_range`)
    url.searchParams.set('query', logql)
    url.searchParams.set('start', toNanos(params.timeRange.start))
    url.searchParams.set('end', toNanos(params.timeRange.end))
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('direction', 'backward')

    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(SCAN_DEFAULTS.maxTimeoutMs),
      })

      if (!res.ok) {
        return {
          lines: [],
          hasMore: false,
          filesScanned: 0,
          bytesScanned: 0,
          truncated: false,
        }
      }

      const body = (await res.json()) as {
        data?: {
          result?: Array<{
            stream?: Record<string, string>
            values?: Array<[string, string]>
          }>
        }
      }

      const results = body.data?.result ?? []
      const lines: RawLogLine[] = []

      for (const stream of results) {
        const streamLabels = stream.stream ?? {}
        const source = Object.entries(streamLabels)
          .map(([k, v]) => `${k}=${v}`)
          .join(',')

        for (const [ts, msg] of stream.values ?? []) {
          if (lines.length >= limit) break
          lines.push({
            message: msg,
            timestamp: nanosToIso(ts),
            source: source || config.streamSelector,
          })
        }
        if (lines.length >= limit) break
      }

      return {
        lines,
        hasMore: lines.length >= limit,
        filesScanned: results.length,
        bytesScanned: 0,
        truncated: lines.length >= limit,
        truncatedReason: lines.length >= limit ? 'file_limit' : undefined,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('TimeoutError') || msg.includes('AbortError')) {
        return {
          lines: [],
          hasMore: false,
          filesScanned: 0,
          bytesScanned: 0,
          truncated: true,
          truncatedReason: 'timeout',
        }
      }
      throw err
    }
  }
}
