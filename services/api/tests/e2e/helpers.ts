import { execSync } from 'node:child_process'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../../../')

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function isReachable(url: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export async function pollUntil(
  condition: () => Promise<boolean>,
  options: { intervalMs: number; timeoutMs: number; label: string },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await sleep(options.intervalMs)
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for: ${options.label}`)
}

export function stopClusterer(): void {
  execSync('docker compose stop clusterer', {
    cwd: PROJECT_ROOT,
    timeout: 30_000,
    stdio: 'pipe',
  })
}

export function startClusterer(): void {
  execSync('docker compose start clusterer', {
    cwd: PROJECT_ROOT,
    timeout: 30_000,
    stdio: 'pipe',
  })
}

export async function waitForClusterer(maxWaitMs = 30_000): Promise<void> {
  await pollUntil(
    () => isReachable('http://localhost:8000/health'),
    { intervalMs: 1000, timeoutMs: maxWaitMs, label: 'clusterer healthy' },
  )
}
