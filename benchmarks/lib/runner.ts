import { type ChildProcess, spawn } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * Shared utilities for benchmark orchestration:
 * - Server lifecycle (start/stop API server as subprocess)
 * - Health check polling
 * - Statistical helpers (median)
 * - Warm-up execution
 */

/** Wait for a URL to return 200. */
export async function waitForHealthy(
  url: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms`)
}

export interface ServerProcess {
  proc: ChildProcess
  port: number
}

/** Start the API server as a subprocess with custom env vars. */
export function startApiServer(env: Record<string, string>, port = 3001): ServerProcess {
  const entrypoint = resolve('services/api/src/index.ts')
  const proc = spawn('node', ['--import', 'tsx', entrypoint], {
    env: {
      ...process.env,
      ...env,
      LOGWEAVE_PORT: port.toString(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Suppress output unless debugging
  proc.stdout?.resume()
  proc.stderr?.resume()

  return { proc, port }
}

/** Stop a server subprocess gracefully. */
export async function stopServer(server: ServerProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.proc.kill('SIGKILL')
      resolve()
    }, timeoutMs)

    server.proc.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })

    server.proc.kill('SIGTERM')
  })
}

/** Compute the median of a number array. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2
  }
  return sorted[mid]!
}

/** Compute the arithmetic mean of a number array. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/** Pick the aggregation function based on config. */
export function aggregate(
  values: readonly number[],
  method: 'median' | 'mean',
): number {
  return method === 'median' ? median(values) : mean(values)
}

/** Sleep for the specified duration. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Get the current git SHA (short). */
export function getGitSha(): string {
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

/** Get the current git branch. */
export function getGitBranch(): string {
  try {
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}
