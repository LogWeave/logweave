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
 * Keys on `username|sourceIp` so a single attacker IP cannot lock every legit
 * user out globally — DoS mitigation per issue #166.
 *
 * Limitation: ephemeral — resets on server restart. Acceptable for
 * single-instance deployments. Must move to ClickHouse/Redis before
 * scaling to multiple API instances.
 */
export class LockoutTracker {
  private readonly entries = new Map<string, LockoutEntry>()

  private key(username: string, sourceIp: string): string {
    return `${username}|${sourceIp}`
  }

  isLocked(username: string, sourceIp: string): boolean {
    const k = this.key(username, sourceIp)
    const entry = this.entries.get(k)
    if (!entry) return false
    if (Date.now() > entry.lockedUntil && entry.lockedUntil > 0) {
      this.entries.delete(k)
      return false
    }
    return entry.lockedUntil > 0 && Date.now() <= entry.lockedUntil
  }

  recordFailure(username: string, sourceIp: string, isTotpFailure = false): void {
    const k = this.key(username, sourceIp)
    const entry = this.entries.get(k) ?? { failCount: 0, totpFailCount: 0, lockedUntil: 0 }

    entry.failCount++
    if (isTotpFailure) entry.totpFailCount++

    if (entry.failCount >= MAX_ATTEMPTS || entry.totpFailCount >= TOTP_MAX_ATTEMPTS) {
      entry.lockedUntil = Date.now() + LOCKOUT_MS
    }

    this.entries.set(k, entry)
  }

  recordSuccess(username: string, sourceIp: string): void {
    this.entries.delete(this.key(username, sourceIp))
  }

  lockoutSecondsRemaining(username: string, sourceIp: string): number {
    const entry = this.entries.get(this.key(username, sourceIp))
    if (!entry || entry.lockedUntil <= 0) return 0
    const remaining = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
    return Math.max(0, remaining)
  }
}
