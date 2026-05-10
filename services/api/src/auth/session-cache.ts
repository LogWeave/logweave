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
const DEFAULT_EVICT_INTERVAL_MS = 5 * 60_000 // 5 minutes

export class SessionValidationCache {
  private readonly cache = new Map<string, CachedUser>()
  private readonly ttlMs: number
  private evictTimer: ReturnType<typeof setInterval> | null = null

  constructor(ttlMs = DEFAULT_TTL_MS, evictIntervalMs = DEFAULT_EVICT_INTERVAL_MS) {
    this.ttlMs = ttlMs
    // Periodic sweep evicts expired entries even if they're never read again.
    // Without this, entries for users who never re-authenticate accumulate
    // forever — a slow leak proportional to total ever-active users.
    this.evictTimer = setInterval(() => this.evictExpired(), evictIntervalMs)
    this.evictTimer.unref()
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

  /** Stop the background eviction timer (for clean shutdown / tests). */
  stop(): void {
    if (this.evictTimer) {
      clearInterval(this.evictTimer)
      this.evictTimer = null
    }
  }

  private evictExpired(): void {
    const now = Date.now()
    for (const [userId, entry] of this.cache) {
      if (now - entry.fetchedAt > this.ttlMs) {
        this.cache.delete(userId)
      }
    }
  }
}
