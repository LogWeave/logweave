import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { csrfHeader } from '../lib/api-client'

interface AuthUser {
  userId: string
  username: string
  tenantId: string
  role: 'admin' | 'viewer'
  mustChangePassword: boolean
  totpEnabled: boolean
}

interface AuthContextValue {
  user: AuthUser | null
  isAuthenticated: boolean
  isLoading: boolean
  login: (username: string, password: string, totpCode?: string) => Promise<{ error?: string }>
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ data?: T; error?: string; status: number }> {
  try {
    const base = window.location.origin
    const res = await fetch(`${base}${path}`, {
      ...init,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...csrfHeader(), ...init?.headers },
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok) return { data: body.data, status: res.status }
    return { error: body.error?.message ?? 'Request failed', status: res.status }
  } catch {
    return { error: 'Network error', status: 0 }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const refreshUser = useCallback(async () => {
    const result = await fetchJson<AuthUser>('/v1/auth/me')
    if (result.data) {
      setUser(result.data)
    } else {
      setUser(null)
    }
    setIsLoading(false)
  }, [])

  useEffect(() => {
    refreshUser()
  }, [refreshUser])

  const login = useCallback(async (username: string, password: string, totpCode?: string) => {
    const result = await fetchJson<AuthUser>('/v1/auth/session', {
      method: 'POST',
      body: JSON.stringify({ username, password, totpCode }),
    })
    if (result.data) {
      setUser(result.data)
      return {}
    }
    return { error: result.error ?? 'Login failed' }
  }, [])

  const logout = useCallback(async () => {
    await fetchJson('/v1/auth/session', { method: 'DELETE' })
    setUser(null)
  }, [])

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated: user !== null, isLoading, login, logout, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  )
}
