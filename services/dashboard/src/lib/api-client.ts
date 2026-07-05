import { config } from '../config'

class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Extract the CSRF token from a raw `document.cookie` string. The cookie is a
 * signed `token.signature` pair (double-submit); we send back only the token
 * half. Returns undefined when the cookie is absent, empty, or has no token
 * before the signature separator. Pure so it can be tested without a document.
 */
export function parseCsrfToken(cookieString: string): string | undefined {
  const match = cookieString.match(/logweave_csrf=([^;]+)/)
  if (!match?.[1]) return undefined
  const value = decodeURIComponent(match[1])
  const dotIndex = value.indexOf('.')
  return dotIndex > 0 ? value.slice(0, dotIndex) : undefined
}

function getCsrfToken(): string | undefined {
  return parseCsrfToken(document.cookie)
}

/**
 * CSRF header for cookie-based state-changing requests made outside the
 * ApiClient (the auth pages use raw fetch). Empty under Bearer auth or when no
 * token cookie is present yet (e.g. login, which the server exempts).
 */
export function csrfHeader(): Record<string, string> {
  if (config.apiKey) return {}
  const csrf = getCsrfToken()
  return csrf ? { 'X-CSRF-Token': csrf } : {}
}

/**
 * User-facing message for a failed response. A 401 always means the session is
 * gone (expired cookie or revoked key), so we surface the same "sign in again"
 * prompt regardless of verb — a raw "Unauthorized" on a POST/PUT/DELETE is
 * useless to the user. Otherwise prefer the server's structured error message,
 * falling back to the HTTP status text.
 */
export function apiErrorMessage(status: number, statusText: string, body: unknown): string {
  if (status === 401) return 'Authentication failed — please sign in again.'
  const message = (body as { error?: { message?: string } })?.error?.message
  return message ?? statusText
}

class ApiClient {
  private headers(): HeadersInit {
    const h: HeadersInit = { Accept: 'application/json' }
    // If VITE_LOGWEAVE_API_KEY is set (dev/legacy), use Bearer auth
    // Otherwise rely on session cookie (credentials: 'include')
    if (config.apiKey) {
      h.Authorization = `Bearer ${config.apiKey}`
    }
    return h
  }

  private mutationHeaders(): HeadersInit {
    const h: HeadersInit = {
      ...this.headers(),
      'Content-Type': 'application/json',
    }
    // Add CSRF token for cookie-based auth (not needed for Bearer)
    if (!config.apiKey) {
      const csrf = getCsrfToken()
      if (csrf) (h as Record<string, string>)['X-CSRF-Token'] = csrf
    }
    return h
  }

  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const base = config.apiUrl || window.location.origin
    const url = new URL(path, base)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, String(v))
      }
    }
    const res = await fetch(url, {
      headers: this.headers(),
      credentials: 'include',
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new ApiError(res.status, apiErrorMessage(res.status, res.statusText, body))
    }
    return res.json() as Promise<T>
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const base = config.apiUrl || window.location.origin
    const url = new URL(path, base)
    const res = await fetch(url, {
      method: 'POST',
      headers: this.mutationHeaders(),
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      throw new ApiError(res.status, apiErrorMessage(res.status, res.statusText, errBody))
    }
    return res.json() as Promise<T>
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    const base = config.apiUrl || window.location.origin
    const url = new URL(path, base)
    const res = await fetch(url, {
      method: 'PUT',
      headers: this.mutationHeaders(),
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      throw new ApiError(res.status, apiErrorMessage(res.status, res.statusText, errBody))
    }
    return res.json() as Promise<T>
  }

  async del<T>(path: string): Promise<T> {
    const base = config.apiUrl || window.location.origin
    const url = new URL(path, base)
    const res = await fetch(url, {
      method: 'DELETE',
      headers: this.mutationHeaders(),
      credentials: 'include',
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      throw new ApiError(res.status, apiErrorMessage(res.status, res.statusText, errBody))
    }
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as T
    }
    return res.json() as Promise<T>
  }
}

export const api = new ApiClient()
