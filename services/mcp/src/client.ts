/**
 * HTTP client for the LogWeave API.
 * Handles auth, timeouts, User-Agent, and error formatting.
 */

const DEFAULT_TIMEOUT_MS = 5_000
const COMPOSITE_TIMEOUT_MS = 10_000
const USER_AGENT = '@logweave/mcp/0.1.0'

export interface LogWeaveClientConfig {
  apiUrl: string
  apiKey: string
}

export class LogWeaveClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>

  constructor(config: LogWeaveClientConfig) {
    this.baseUrl = config.apiUrl.replace(/\/+$/, '')
    this.headers = {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    }
  }

  async healthCheck(): Promise<void> {
    const res = await this.fetch('/healthz', { timeout: 3_000 })
    if (!res.ok) {
      throw new Error(`LogWeave API health check failed (status ${res.status})`)
    }
  }

  async get(path: string, params?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = this.buildUrl(path, params)
    return this.request(url, { method: 'GET' })
  }

  async getComposite(
    path: string,
    params?: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const url = this.buildUrl(path, params)
    return this.request(url, { method: 'GET', timeout: COMPOSITE_TIMEOUT_MS })
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const url = this.buildUrl(path)
    return this.request(url, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  private buildUrl(path: string, params?: Record<string, string | number | undefined>): string {
    const url = new URL(`${this.baseUrl}/v1${path}`)
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value))
        }
      }
    }
    return url.toString()
  }

  private async fetch(path: string, opts?: { timeout?: number }): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    return globalThis.fetch(url, {
      headers: this.headers,
      signal: AbortSignal.timeout(opts?.timeout ?? DEFAULT_TIMEOUT_MS),
    })
  }

  private async request(
    url: string,
    opts: { method: string; body?: string; timeout?: number },
  ): Promise<unknown> {
    let res: Response
    try {
      res = await globalThis.fetch(url, {
        method: opts.method,
        headers: this.headers,
        body: opts.body,
        signal: AbortSignal.timeout(opts.timeout ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(
          `LogWeave API request timed out after ${opts.timeout ?? DEFAULT_TIMEOUT_MS}ms`,
        )
      }
      throw new Error(
        `LogWeave API is unreachable at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after') ?? '60'
      throw new Error(
        `Rate limited by LogWeave API. Retry after ${retryAfter} seconds. Reduce query frequency.`,
      )
    }

    if (!res.ok) {
      let detail = ''
      try {
        const body = (await res.json()) as { error?: { message?: string } }
        detail = body?.error?.message ?? ''
      } catch {
        // ignore parse errors
      }
      throw new Error(`LogWeave API error (${res.status}): ${detail || res.statusText}`)
    }

    return res.json()
  }
}
