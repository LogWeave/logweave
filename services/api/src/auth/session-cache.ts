/**
 * In-memory cache for session validation.
 * Prevents DB query on every authenticated request while ensuring
 * deleted/password-changed users lose access within TTL seconds.
 */

interface CachedUser {
  sessionVersion: number
  isDeleted: boolean
  fetchedAt: number
}

const DEFAULT_TTL_MS = 60_000 // 60 seconds

export class SessionValidationCache {
  private readonly cache = new Map<string, CachedUser>()
  private readonly ttlMs: number

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs
  }

  get(userId: string): CachedUser | undefined {
    const entry = this.cache.get(userId)
    if (!entry) return undefined
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(userId)
      return undefined
    }
    return entry
  }

  set(userId: string, sessionVersion: number, isDeleted: boolean): void {
    this.cache.set(userId, { sessionVersion, isDeleted, fetchedAt: Date.now() })
  }

  invalidate(userId: string): void {
    this.cache.delete(userId)
  }
}
