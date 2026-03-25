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
export interface CircuitBreakerOptions {
  circuitThreshold?: number
  probeInterval?: number
}

export class ClusterClient {
  private url: string
  private timeoutMs: number
  private logger: pino.Logger
  private fetchFn: FetchFn
  private failures = 0
  private circuitOpen = false
  private callsSinceOpen = 0
  private readonly circuitThreshold: number
  private readonly probeInterval: number

  constructor(
    url: string,
    timeoutMs: number,
    logger: pino.Logger,
    fetchFn: FetchFn = globalThis.fetch,
    options?: CircuitBreakerOptions,
  ) {
    this.url = url
    this.timeoutMs = timeoutMs
    this.logger = logger
    this.fetchFn = fetchFn
    this.circuitThreshold = options?.circuitThreshold ?? 5
    this.probeInterval = options?.probeInterval ?? 10

    if (this.circuitThreshold < 1) {
      throw new Error('circuitThreshold must be >= 1')
    }
    if (this.probeInterval < 2) {
      throw new Error('probeInterval must be >= 2')
    }
  }

  get consecutiveFailures(): number {
    return this.failures
  }

  get isCircuitOpen(): boolean {
    return this.circuitOpen
  }

  async cluster(tenantId: string, messages: string[], simTh?: number): Promise<ClusterResult[]> {
    if (this.circuitOpen) {
      this.callsSinceOpen++
      if (this.callsSinceOpen % this.probeInterval !== 0) {
        return this.fallback(messages.length)
      }
      this.logger.info({ tenantId }, 'Clusterer circuit probe attempt')
    }

    try {
      const response = await this.fetchFn(`${this.url}/cluster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: tenantId,
          messages,
          ...(simTh !== undefined ? { sim_th: simTh } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (response.status === 422) {
        this.logger.error(
          { tenantId, statusCode: 422, messageCount: messages.length, url: this.url },
          'Clusterer rejected request — likely API server bug',
        )
        this.onFailure()
        return this.fallback(messages.length)
      }

      if (!response.ok) {
        this.logger.warn(
          { tenantId, statusCode: response.status, url: this.url },
          'Clusterer returned non-OK status',
        )
        this.onFailure()
        return this.fallback(messages.length)
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        this.logger.warn(
          { tenantId, url: this.url },
          'Clusterer returned non-JSON response body',
        )
        this.onFailure()
        return this.fallback(messages.length)
      }

      if (!this.isValidResponse(body)) {
        this.logger.warn(
          { tenantId, url: this.url },
          'Clusterer returned malformed response body',
        )
        this.onFailure()
        return this.fallback(messages.length)
      }

      if (body.results.length !== messages.length) {
        this.logger.warn(
          { tenantId, url: this.url, expected: messages.length, got: body.results.length },
          'Clusterer returned mismatched result count',
        )
        this.onFailure()
        return this.fallback(messages.length)
      }

      this.onSuccess()
      return body.results.map((r) => ({
        templateId: r.template_id,
        templateText: r.template_text,
        isNewTemplate: r.is_new,
      }))
    } catch (err) {
      const isTimeout =
        err instanceof DOMException &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      this.logger.warn(
        { tenantId, url: this.url, err, isTimeout },
        isTimeout ? 'Clusterer request timed out' : 'Clusterer request failed',
      )
      this.onFailure()
      return this.fallback(messages.length)
    }
  }

  private onFailure(): void {
    this.failures++
    if (!this.circuitOpen && this.failures >= this.circuitThreshold) {
      this.circuitOpen = true
      this.callsSinceOpen = 0
      this.logger.warn(
        { consecutiveFailures: this.failures },
        `Clusterer circuit open after ${this.failures} failures`,
      )
    }
  }

  private onSuccess(): void {
    this.failures = 0
    if (this.circuitOpen) {
      this.circuitOpen = false
      this.callsSinceOpen = 0
      this.logger.info('Clusterer recovered — circuit closed')
    }
  }

  private fallback(count: number): ClusterResult[] {
    return Array.from({ length: count }, () => ({ ...FALLBACK_RESULT }))
  }

  /**
   * Preview clustering with a throwaway miner. Returns null on failure.
   */
  async preview(
    messages: string[],
    simTh: number,
  ): Promise<{ patternCount: number; compressionRatio: number; sampleTemplates: string[] } | null> {
    try {
      const response = await this.fetchFn(`${this.url}/cluster/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, sim_th: simTh }),
        signal: AbortSignal.timeout(this.timeoutMs * 4), // preview can be slower
      })

      if (!response.ok) {
        this.logger.warn({ statusCode: response.status }, 'Clusterer /cluster/preview failed')
        return null
      }

      const body = (await response.json()) as {
        pattern_count?: number
        compression_ratio?: number
        sample_templates?: string[]
      }

      return {
        patternCount: body.pattern_count ?? 0,
        compressionRatio: body.compression_ratio ?? 0,
        sampleTemplates: body.sample_templates ?? [],
      }
    } catch {
      this.logger.warn('Clusterer /cluster/preview request failed')
      return null
    }
  }

  /**
   * Reset a tenant's Drain3 miner state. Returns true if cleared, false on failure.
   */
  async resetTenant(tenantId: string): Promise<boolean> {
    try {
      const response = await this.fetchFn(`${this.url}/cluster/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenant_id: tenantId }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (!response.ok) {
        this.logger.warn({ tenantId, statusCode: response.status }, 'Clusterer /cluster/reset failed')
        return false
      }

      const body = (await response.json()) as { cleared?: boolean }
      return body.cleared ?? false
    } catch {
      this.logger.warn({ tenantId }, 'Clusterer /cluster/reset request failed')
      return false
    }
  }

  /**
   * Embed text(s) via the clusterer's POST /embed endpoint.
   * Returns null on ANY failure — never throws.
   */
  async embed(texts: string[]): Promise<number[][] | null> {
    if (this.circuitOpen) {
      this.callsSinceOpen++
      if (this.callsSinceOpen % this.probeInterval !== 0) {
        return null
      }
    }

    try {
      const response = await this.fetchFn(`${this.url}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })

      if (!response.ok) {
        this.logger.warn({ statusCode: response.status }, 'Clusterer /embed returned non-OK')
        this.onFailure()
        return null
      }

      const body = (await response.json()) as { embeddings?: number[][] }
      if (!Array.isArray(body.embeddings)) {
        this.logger.warn('Clusterer /embed returned malformed response')
        this.onFailure()
        return null
      }

      this.onSuccess()
      return body.embeddings
    } catch {
      this.logger.warn('Clusterer /embed request failed')
      this.onFailure()
      return null
    }
  }

  private isValidResponse(body: unknown): body is ClustererResponse {
    if (typeof body !== 'object' || body === null) return false
    const obj = body as Record<string, unknown>
    if (!Array.isArray(obj.results)) return false
    return obj.results.every(
      (r: unknown) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Record<string, unknown>).template_id === 'string' &&
        typeof (r as Record<string, unknown>).template_text === 'string' &&
        typeof (r as Record<string, unknown>).is_new === 'boolean',
    )
  }
}
