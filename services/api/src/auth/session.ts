import { createHmac, timingSafeEqual } from 'node:crypto'

export interface SessionData {
  userId: string
  tenantId: string
  role: string
  sessionVersion: number
  exp: number
}

/**
 * Stateless HMAC-signed session provider.
 * Cookie format: base64(payload).hmac-sha256(payload)
 * Swappable — implement SessionProvider interface for JWT, Redis, etc.
 */
export interface SessionProvider {
  createSession(data: Omit<SessionData, 'exp'>): string
  validateSession(cookieValue: string): SessionData | null
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000 // 8 hours (absolute TTL)

export class HmacSessionProvider implements SessionProvider {
  private readonly key: Buffer

  constructor(signingKey: Buffer) {
    this.key = signingKey
  }

  createSession(data: Omit<SessionData, 'exp'>): string {
    const payload: SessionData = {
      ...data,
      exp: Date.now() + SESSION_TTL_MS,
    }
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

      // Check expiry
      if (typeof data.exp !== 'number' || Date.now() > data.exp) return null
      if (!data.userId || !data.tenantId || !data.role) return null

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
