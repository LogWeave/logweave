import { randomUUID } from 'node:crypto'

interface TailToken {
  tenantId: string
  expiresAt: number
}

const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 1000 // 1 minute

/**
 * In-memory store for short-lived tail SSE tokens.
 * Tokens replace raw API keys in EventSource query params
 * so that long-lived credentials don't leak into URLs.
 */
export class TailTokenStore {
  private readonly tokens = new Map<string, TailToken>()
  private readonly ttlMs: number
  private cleanupTimer: ReturnType<typeof setInterval> | undefined

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  /** Start periodic cleanup of expired tokens. */
  start(): void {
    if (this.cleanupTimer) return
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
    this.cleanupTimer.unref()
  }

  /** Stop periodic cleanup. */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  /** Issue a new short-lived token for the given tenant. */
  issue(tenantId: string): string {
    const token = randomUUID()
    this.tokens.set(token, {
      tenantId,
      expiresAt: Date.now() + this.ttlMs,
    })
    return token
  }

  /** Validate and consume a token. Returns tenantId if valid, undefined if expired/unknown. */
  validate(token: string): string | undefined {
    const entry = this.tokens.get(token)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(token)
      return undefined
    }
    // Don't consume — token is valid for the full TTL (SSE reconnects need it)
    return entry.tenantId
  }

  /** Remove expired tokens. */
  private cleanup(): void {
    const now = Date.now()
    for (const [token, entry] of this.tokens) {
      if (now > entry.expiresAt) {
        this.tokens.delete(token)
      }
    }
  }

  /** Number of active tokens (for testing). */
  get size(): number {
    return this.tokens.size
  }
}
