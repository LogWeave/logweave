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
      const message =
        res.status === 401
          ? 'Authentication failed — check your API key in the dashboard configuration.'
          : (body?.error?.message ?? res.statusText)
      throw new ApiError(res.status, message)
    }
    return res.json() as Promise<T>
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const base = config.apiUrl || window.location.origin
    const url = new URL(path, base)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(res.status, body?.error?.message ?? res.statusText)
    }
    return res.json() as Promise<T>
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const base = config.apiUrl || window.location.origin
    const url = new URL(path, base)
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      throw new ApiError(res.status, errBody?.error?.message ?? res.statusText)
    }
    return res.json() as Promise<T>
  }

  async del<T>(path: string): Promise<T> {
    const base = config.apiUrl || window.location.origin
    const url = new URL(path, base)
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      throw new ApiError(res.status, errBody?.error?.message ?? res.statusText)
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as T
    }
    return res.json() as Promise<T>
  }
}

export const api = new ApiClient()
