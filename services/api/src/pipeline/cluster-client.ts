import type pino from 'pino'

export interface ClusterResult {
  templateId: string
  templateText: string
  isNewTemplate: boolean
}

/** Shape of the clusterer's POST /cluster response. */
interface ClustererResponse {
  results: Array<{
    template_id: string
    template_text: string
    is_new: boolean
  }>
}

type FetchFn = typeof globalThis.fetch

const FALLBACK_RESULT: Readonly<ClusterResult> = {
  templateId: '0',
  templateText: '[unclustered]',
  isNewTemplate: false,
}

/**
 * HTTP client for the clusterer's POST /cluster endpoint.
 * Returns fallback results on ANY failure — never throws.
 * Best-effort enrichment per PLAN.md degradation contract.
 */
export class ClusterClient {
  private url: string
  private timeoutMs: number
  private logger: pino.Logger
  private fetchFn: FetchFn
  private failures = 0

  constructor(
    url: string,
    timeoutMs: number,
    logger: pino.Logger,
    fetchFn: FetchFn = globalThis.fetch,
  ) {
    this.url = url
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.fetchFn = fetchFn
  }

  get consecutiveFailures(): number {
    return this.failures
  }

  async cluster(tenantId: string, messages: string[]): Promise<ClusterResult[]> {
    try {
      const response = await this.fetchFn(`${this.url}/cluster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId, messages }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (response.status === 422) {
        this.logger.error(
          { tenantId, statusCode: 422, messageCount: messages.length, url: this.url },
          'Clusterer rejected request — likely API server bug',
        )
        this.failures++
        return this.fallback(messages.length)
      }

      if (!response.ok) {
        this.logger.warn(
          { tenantId, statusCode: response.status, url: this.url },
          'Clusterer returned non-OK status',
        )
        this.failures++
        return this.fallback(messages.length)
      }

      const body = (await response.json()) as unknown
      if (!this.isValidResponse(body)) {
        this.logger.warn(
          { tenantId, url: this.url },
          'Clusterer returned malformed response body',
        )
        this.failures++
        return this.fallback(messages.length)
      }

      this.failures = 0
      return body.results.map((r) => ({
        templateId: r.template_id,
        templateText: r.template_text,
        isNewTemplate: r.is_new,
      }))
    } catch (err) {
      const isTimeout =
        err instanceof DOMException && err.name === 'AbortError'
      this.logger.warn(
        { tenantId, url: this.url, err, isTimeout },
        isTimeout ? 'Clusterer request timed out' : 'Clusterer request failed',
      )
      this.failures++
      return this.fallback(messages.length)
    }
  }

  private fallback(count: number): ClusterResult[] {
    return Array.from({ length: count }, () => ({ ...FALLBACK_RESULT }))
  }

  private isValidResponse(body: unknown): body is ClustererResponse {
    if (typeof body !== 'object' || body === null) return false
    const obj = body as Record<string, unknown>
    return Array.isArray(obj.results)
  }
}
