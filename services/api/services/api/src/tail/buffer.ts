import type { TailEvent, TailFilterOptions } from './types.js'

type Subscriber = (event: TailEvent) => void

interface TenantRing {
  events: Array<TailEvent | undefined>
  head: number
  size: number
  seq: number
  lastActivity: number
}

export interface TailBufferOptions {
  maxEventsPerTenant?: number
  maxMemoryMb?: number
}

const DEFAULT_MAX_EVENTS = 10_000
const DEFAULT_MAX_MEMORY_MB = 256
const BYTES_PER_EVENT_ESTIMATE = 700

export class TailBuffer {
  private readonly rings = new Map<string, TenantRing>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  private readonly maxEvents: number
  private readonly maxMemoryBytes: number

  constructor(options?: TailBufferOptions) {
    this.maxEvents = options?.maxEventsPerTenant ?? DEFAULT_MAX_EVENTS
    this.maxMemoryBytes = (options?.maxMemoryMb ?? DEFAULT_MAX_MEMORY_MB) * 1024 * 1024
  }

  push(tenantId: string, event: Omit<TailEvent, 'seq'>): void {
    this.enforceMemoryCeiling()

    let ring = this.rings.get(tenantId)
    if (!ring) {
      ring = {
        events: new Array(this.maxEvents),
        head: 0,
        size: 0,
        seq: 0,
        lastActivity: Date.now(),
      }
      this.rings.set(tenantId, ring)
    }

    ring.seq++
    const fullEvent: TailEvent = { ...event, seq: ring.seq }

    const idx = ring.head % ring.events.length
    ring.events[idx] = fullEvent
    ring.head = (ring.head + 1) % ring.events.length
    if (ring.size < ring.events.length) ring.size++
    ring.lastActivity = Date.now()

    // Notify subscribers (non-blocking)
    const subs = this.subscribers.get(tenantId)
    if (subs) {
      for (const cb of subs) {
        try { cb(fullEvent) } catch { /* subscriber error must not crash ingest */ }
      }
    }
  }

  since(
    tenantId: string,
    afterSeq: number,
    options?: TailFilterOptions,
  ): { events: TailEvent[]; cursor: number; gap?: boolean; missedEstimate?: number } {
    const ring = this.rings.get(tenantId)
    if (!ring || ring.size === 0) {
      return { events: [], cursor: afterSeq }
    }

    const limit = options?.limit ?? 100
    const events: TailEvent[] = []
    let gap = false
    let missedEstimate = 0

    // Find the oldest available seq
    const oldestIdx = ring.size >= ring.events.length
      ? ring.head
      : 0
    const oldestEvent = ring.events[oldestIdx]
    if (oldestEvent && afterSeq > 0 && afterSeq < oldestEvent.seq) {
      gap = true
      missedEstimate = oldestEvent.seq - afterSeq - 1
    }

    // Scan from oldest to newest
    for (let i = 0; i < ring.size && events.length < limit; i++) {
      const idx = (oldestIdx + i) % ring.events.length
      const evt = ring.events[idx]
      if (!evt || evt.seq <= afterSeq) continue
      if (matchesFilter(evt, options)) {
        events.push(evt)
      }
    }

    const cursor = events.length > 0 ? events[events.length - 1]!.seq : afterSeq
    const result: { events: TailEvent[]; cursor: number; gap?: boolean; missedEstimate?: number } = { events, cursor }
    if (gap) {
      result.gap = true
      result.missedEstimate = missedEstimate
    }
    return result
  }

  recent(
    tenantId: string,
    options?: TailFilterOptions & { seconds?: number },
  ): { events: TailEvent[]; cursor: number } {
    const ring = this.rings.get(tenantId)
    if (!ring || ring.size === 0) {
      return { events: [], cursor: 0 }
    }

    const limit = options?.limit ?? 50
    const seconds = options?.seconds ?? 60
    const cutoff = new Date(Date.now() - seconds * 1000).toISOString()
    const events: TailEvent[] = []

    // Scan from newest to oldest, collect up to limit
    for (let i = ring.size - 1; i >= 0 && events.length < limit * 2; i--) {
      const idx = (ring.head - 1 - (ring.size - 1 - i) + ring.events.length) % ring.events.length
      const evt = ring.events[idx]
      if (!evt) continue
      if (evt.timestamp < cutoff) break
      if (matchesFilter(evt, options)) {
        events.push(evt)
      }
    }

    events.reverse()
    const trimmed = events.slice(-limit)
    const cursor = trimmed.length > 0 ? trimmed[trimmed.length - 1]!.seq : ring.seq
    return { events: trimmed, cursor }
  }

  subscribe(tenantId: string, callback: Subscriber): () => void {
    let subs = this.subscribers.get(tenantId)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(tenantId, subs)
    }
    subs.add(callback)

    return () => {
      subs!.delete(callback)
      if (subs!.size === 0) {
        this.subscribers.delete(tenantId)
      }
    }
  }

  stats(): { tenants: number; totalEvents: number; memoryBytes: number } {
    let totalEvents = 0
    for (const ring of this.rings.values()) {
      totalEvents += ring.size
    }
    return {
      tenants: this.rings.size,
      totalEvents,
      memoryBytes: totalEvents * BYTES_PER_EVENT_ESTIMATE,
    }
  }

  private enforceMemoryCeiling(): void {
    const estimatedBytes = this.stats().memoryBytes
    if (estimatedBytes < this.maxMemoryBytes) return

    // Evict least-recently-active tenant
    let oldestTenant: string | undefined
    let oldestTime = Infinity
    for (const [id, ring] of this.rings) {
      if (ring.lastActivity < oldestTime) {
        oldestTime = ring.lastActivity
        oldestTenant = id
      }
    }
    if (oldestTenant) {
      this.rings.delete(oldestTenant)
      this.subscribers.delete(oldestTenant)
    }
  }
}

function matchesFilter(evt: TailEvent, options?: TailFilterOptions): boolean {
  if (!options) return true
  if (options.service && evt.service !== options.service) return false
  if (options.level && evt.level !== options.level) return false
  if (options.templateId && evt.templateId !== options.templateId) return false
  if (options.minAnomalyScore != null && evt.anomalyScore < options.minAnomalyScore) return false
  return true
}
