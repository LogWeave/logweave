import type { ClustererHealth } from '../types.js'

export class ClustererHealthChecker implements ClustererHealth {
  consecutiveFailures = 0
  lastChecked = 0

  private url: string
  private timeoutMs: number

  constructor(url: string, timeoutMs: number) {
    this.url = url
    this.timeoutMs = timeoutMs
  }

  async check(): Promise<boolean> {
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

      const response = await fetch(`${this.url}/health`, {
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (response.ok) {
        this.consecutiveFailures = 0
        this.lastChecked = Date.now()
        return true
      }

      this.consecutiveFailures++
      this.lastChecked = Date.now()
      return false
    } catch {
      this.consecutiveFailures++
      this.lastChecked = Date.now()
      return false
    }
  }
}
