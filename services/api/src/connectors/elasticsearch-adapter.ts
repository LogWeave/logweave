/**
 * Elasticsearch / OpenSearch log source adapter.
 *
 * Uses global fetch (no new dependencies). Works with ES 7.x+ and OpenSearch 1.x+.
 *
 * testConnection: GET /_cluster/health + GET /{index}/_count
 * fetchRawLogs:   POST /{index}/_search with bool query (range + regex)
 */

import { templateToRegex } from './template-regex.js'
import {
  type ConnectionTestResult,
  type ConnectorConfig,
  type ElasticsearchConnectorConfig,
  type FetchRawLogsParams,
  type LogSourceAdapter,
  type RawLogLine,
  type RawLogResult,
  SCAN_DEFAULTS,
} from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHeaders(config: ElasticsearchConnectorConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  if (config.apiKey) {
    headers.Authorization = `ApiKey ${config.apiKey}`
  } else if (config.username && config.password) {
    const encoded = Buffer.from(`${config.username}:${config.password}`).toString('base64')
    headers.Authorization = `Basic ${encoded}`
  }

  return headers
}

/**
 * Convert a JS RegExp to an ES/OpenSearch regex string.
 * ES regex does not support lazy quantifiers (.*?) so we replace them with greedy (.*).
 * ES regex also does not support some JS features, so we strip them.
 */
function toEsRegex(regex: RegExp): string {
  return regex.source
    .replace(/\.\*\?/g, '.*')    // lazy -> greedy
    .replace(/\(\?:/g, '(')      // non-capturing groups -> capturing (ES doesn't need it)
}

// ---------------------------------------------------------------------------
// ElasticsearchAdapter
// ---------------------------------------------------------------------------

export class ElasticsearchAdapter implements LogSourceAdapter {
  readonly type = 'elasticsearch'

  async testConnection(config: ConnectorConfig): Promise<ConnectionTestResult> {
    const esConfig = config as ElasticsearchConnectorConfig
    const headers = buildHeaders(esConfig)
    const baseUrl = esConfig.url.replace(/\/$/, '')

    try {
      // Check cluster health
      const healthRes = await fetch(`${baseUrl}/_cluster/health`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })

      if (!healthRes.ok) {
        const body = await healthRes.text()
        if (healthRes.status === 401 || healthRes.status === 403) {
          return {
            success: false,
            message: 'Authentication failed. Check your credentials or API key.',
          }
        }
        return {
          success: false,
          message: `Cluster health check failed (${healthRes.status}): ${body.slice(0, 200)}`,
        }
      }

      const health = (await healthRes.json()) as Record<string, unknown>

      // Check index exists and get doc count
      const countRes = await fetch(`${baseUrl}/${encodeURIComponent(esConfig.index)}/_count`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })

      if (!countRes.ok) {
        if (countRes.status === 404) {
          return {
            success: false,
            message: `Index "${esConfig.index}" not found. Check the index name or pattern.`,
          }
        }
        return {
          success: false,
          message: `Index check failed (${countRes.status}).`,
        }
      }

      const countBody = (await countRes.json()) as { count?: number }
      const docCount = countBody.count ?? 0

      return {
        success: true,
        message: `Connected to cluster (status: ${String(health.status ?? 'unknown')}). Index "${esConfig.index}" has ${docCount} documents.`,
        filesFound: docCount,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED')) {
        return {
          success: false,
          message: `Cannot reach Elasticsearch at ${baseUrl}. Check the URL and network connectivity.`,
        }
      }
      return {
        success: false,
        message: `Connection failed: ${msg}`,
      }
    }
  }

  async fetchRawLogs(params: FetchRawLogsParams): Promise<RawLogResult> {
    const config = params.config as ElasticsearchConnectorConfig
    const headers = buildHeaders(config)
    const baseUrl = config.url.replace(/\/$/, '')
    const messageField = config.messageField ?? 'message'
    const timestampField = config.timestampField ?? '@timestamp'
    const limit = Math.min(params.limit, SCAN_DEFAULTS.maxLimit)
    const regex = templateToRegex(params.templateText)
    const esRegex = toEsRegex(regex)

    const query = {
      size: limit,
      sort: [{ [timestampField]: { order: 'desc', unmapped_type: 'date' } }],
      _source: [messageField, timestampField],
      query: {
        bool: {
          filter: [
            {
              range: {
                [timestampField]: {
                  gte: params.timeRange.start.toISOString(),
                  lte: params.timeRange.end.toISOString(),
                },
              },
            },
            {
              regexp: {
                [messageField]: {
                  value: esRegex,
                  case_insensitive: true,
                },
              },
            },
          ],
        },
      },
    }

    try {
      const res = await fetch(
        `${baseUrl}/${encodeURIComponent(config.index)}/_search`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(query),
          signal: AbortSignal.timeout(SCAN_DEFAULTS.maxTimeoutMs),
        },
      )

      if (!res.ok) {
        return {
          lines: [],
          hasMore: false,
          filesScanned: 0,
          bytesScanned: 0,
          truncated: false,
          truncatedReason: undefined,
        }
      }

      const body = (await res.json()) as {
        hits?: {
          total?: { value?: number }
          hits?: Array<{
            _source?: Record<string, unknown>
            _index?: string
          }>
        }
      }

      const hits = body.hits?.hits ?? []
      const totalHits = body.hits?.total?.value ?? 0

      const lines: RawLogLine[] = hits.map((hit) => ({
        message: String(hit._source?.[messageField] ?? ''),
        timestamp: hit._source?.[timestampField] ? String(hit._source[timestampField]) : undefined,
        source: hit._index ?? config.index,
      }))

      return {
        lines,
        hasMore: totalHits > lines.length,
        filesScanned: 1,
        bytesScanned: 0,
        truncated: totalHits > limit,
        truncatedReason: totalHits > limit ? 'file_limit' : undefined,
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
