import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SessionData {
  userId: string
  tenantId: string
  role: string
  sessionVersion: number
  exp: number
  lastActivity?: number
}

/**
 * Stateless HMAC-signed session provider.
 * Cookie format: base64(payload).hmac-sha256(payload)
 * Swappable — implement SessionProvider interface for JWT, Redis, etc.
 */
export interface SessionProvider {
  createSession(data: Omit<SessionData, 'exp' | 'lastActivity'>): string
  refreshSession(existing: SessionData): string
  validateSession(cookieValue: string): SessionData | null
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000 // 8 hours (absolute TTL)
const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes (idle timeout)

export class HmacSessionProvider implements SessionProvider {
  private readonly key: Buffer

  constructor(signingKey: Buffer) {
    this.key = signingKey
  }

  createSession(data: Omit<SessionData, 'exp' | 'lastActivity'>): string {
    const now = Date.now()
    const payload: SessionData = {
      ...data,
      exp: now + SESSION_TTL_MS,
      lastActivity: now,
    }
    return this.encode(payload)
  }

  // Refreshes the idle timer (lastActivity) without extending the absolute exp.
  // Use on every authenticated request; createSession only at initial login.
  refreshSession(existing: SessionData): string {
    const payload: SessionData = {
      ...existing,
      lastActivity: Date.now(),
    }
    return this.encode(payload)
  }

  private encode(payload: SessionData): string {
    const payloadStr = JSON.stringify(payload)
    const payloadB64 = Buffer.from(payloadStr).toString('base64url')
    const sig = this.sign(payloadB64)
    return `${payloadB64}.${sig}`
  }

  validateSession(cookieValue: string): SessionData | null {
    const dotIndex = cookieValue.indexOf('.')
    if (dotIndex === -1) return null

    const payloadB64 = cookieValue.slice(0, dotIndex)
    const sig = cookieValue.slice(dotIndex + 1)

    // Validate HMAC
    const expected = this.sign(payloadB64)
    if (sig.length !== expected.length) return null
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

    // Decode payload
    try {
      const payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf-8')
      const data = JSON.parse(payloadStr) as SessionData

      // Check absolute expiry
      const now = Date.now()
      if (typeof data.exp !== 'number' || now > data.exp) return null
      if (!data.userId || !data.tenantId || !data.role) return null

      // Check idle timeout
      if (data.lastActivity && (now - data.lastActivity) > IDLE_TIMEOUT_MS) return null

      return data
    } catch {
      return null
    }
  }

  private sign(data: string): string {
    return createHmac('sha256', this.key).update(data).digest('base64url')
  }
}

export const SESSION_COOKIE_NAME = 'logweave_session'

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_TTL_MS,
}
