import type { MemorySnapshot } from './types.js'

const MB = 1024 * 1024

/** Take a memory snapshot from the current process. */
export function takeMemorySnapshot(): MemorySnapshot {
  const mem = process.memoryUsage()
  return {
    rss_mb: Math.round((mem.rss / MB) * 10) / 10,
    heap_used_mb: Math.round((mem.heapUsed / MB) * 10) / 10,
  }
}

/**
 * Take a memory snapshot from a remote HTTP endpoint.
 * Falls back to local snapshot if the endpoint is unreachable.
 */
export async function takeRemoteMemorySnapshot(url: string): Promise<MemorySnapshot> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return takeMemorySnapshot()
    const data = (await res.json()) as {
      rss?: number
      heapUsed?: number
      memory?: { rss?: number; heapUsed?: number }
    }
    const rss = data.rss ?? data.memory?.rss ?? 0
    const heapUsed = data.heapUsed ?? data.memory?.heapUsed ?? 0
    return {
      rss_mb: Math.round((rss / MB) * 10) / 10,
      heap_used_mb: Math.round((heapUsed / MB) * 10) / 10,
    }
  } catch {
    return takeMemorySnapshot()
  }
}
