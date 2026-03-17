import { config } from '../config'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

class ApiClient {
  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const base = config.apiUrl || window.location.origin
    const url = new URL(path, base)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(res.status, body?.error?.message ?? res.statusText)
    }
    return res.json() as Promise<T>
  }
}

export const api = new ApiClient()
