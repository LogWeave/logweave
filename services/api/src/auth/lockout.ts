const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes
const TOTP_MAX_ATTEMPTS = 3

interface LockoutEntry {
  failCount: number
  totpFailCount: number
  lockedUntil: number
}

/**
 * In-memory account lockout tracker.
 * Tracks failed login attempts per username, locks after threshold.
 *
 * Limitation: ephemeral — resets on server restart. Acceptable for
 * single-instance deployments. Must move to ClickHouse/Redis before
 * scaling to multiple API instances.
 */
export class LockoutTracker {
  private readonly entries = new Map<string, LockoutEntry>()

  isLocked(username: string): boolean {
    const entry = this.entries.get(username)
    if (!entry) return false
    if (Date.now() > entry.lockedUntil && entry.lockedUntil > 0) {
      this.entries.delete(username)
      return false
    }
    return entry.lockedUntil > 0 && Date.now() <= entry.lockedUntil
  }

  recordFailure(username: string, isTotpFailure = false): void {
    const entry = this.entries.get(username) ?? { failCount: 0, totpFailCount: 0, lockedUntil: 0 }

    entry.failCount++
    if (isTotpFailure) entry.totpFailCount++

    if (entry.failCount >= MAX_ATTEMPTS || entry.totpFailCount >= TOTP_MAX_ATTEMPTS) {
      entry.lockedUntil = Date.now() + LOCKOUT_MS
    }

    this.entries.set(username, entry)
  }

  recordSuccess(username: string): void {
    this.entries.delete(username)
  }

  lockoutSecondsRemaining(username: string): number {
    const entry = this.entries.get(username)
    if (!entry || entry.lockedUntil <= 0) return 0
    const remaining = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
    return Math.max(0, remaining)
  }
}
