import {
  ESTIMATED_EVENT_BYTES,
  levelMeetsSeverity,
  TAIL_DEFAULTS,
  type TailBufferConfig,
  type TailBufferStats,
  type TailEvent,
  type TailQueryOptions,
  type TailQueryResult,
} from './types.js'

// ---------------------------------------------------------------------------
// Per-tenant ring
// ---------------------------------------------------------------------------

interface TenantRing {
  events: Array<TailEvent | undefined>
  head: number // next write position
  size: number // current count of valid events
  seq: number // monotonic sequence counter
  lastPushTime: number // for idle eviction
}

function createRing(capacity: number): TenantRing {
  return {
    events: new Array(capacity),
    head: 0,
    size: 0,
    seq: 0,
    lastPushTime: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// TailBuffer
// ---------------------------------------------------------------------------

type Subscriber = (event: TailEvent) => void

export class TailBuffer {
  private readonly rings = new Map<string, TenantRing>()
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  private readonly config: TailBufferConfig
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private totalEventCount = 0

  constructor(config?: Partial<TailBufferConfig>) {
    this.config = { ...TAIL_DEFAULTS, ...config }
  }

  /** Start periodic cleanup of idle tenants and aged events. */
  start(): void {
    // Run cleanup every 30 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000)
    this.cleanupTimer.unref()
  }

  /** Stop cleanup timer. */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /** Push a new event into the tenant's ring buffer. */
  push(tenantId: string, event: Omit<TailEvent, 'seq'>): void {
    // Enforce global memory ceiling
    this.enforceMemoryCeiling(tenantId)

    let ring = this.rings.get(tenantId)
    if (!ring) {
      ring = createRing(this.config.bufferSize)
      this.rings.set(tenantId, ring)
    }

    ring.seq++
    const tailEvent: TailEvent = { ...event, seq: ring.seq }

    ring.events[ring.head] = tailEvent
    ring.head = (ring.head + 1) % ring.events.length
    if (ring.size < ring.events.length) {
      ring.size++
      this.totalEventCount++
    }
    ring.lastPushTime = Date.now()

    // Notify subscribers (non-blocking — callbacks must queue, not write)
    const subs = this.subscribers.get(tenantId)
    if (subs) {
      for (const cb of subs) {
        try {
          cb(tailEvent)
        } catch {
          // Subscriber errors must not crash the ingest pipeline
        }
      }
    }
  }

  /** Get events since a sequence number. */
  since(tenantId: string, afterSeq: number, options?: TailQueryOptions): TailQueryResult {
    const ring = this.rings.get(tenantId)
    if (!ring || ring.size === 0) {
      return { events: [], cursor: afterSeq }
    }

    const limit = options?.limit ?? 200
    const events: TailEvent[] = []
    const oldestSeq = this.oldestSeq(ring)

    let gap = false
    let missedEstimate = 0

    if (afterSeq < oldestSeq) {
      gap = true
      missedEstimate = oldestSeq - afterSeq - 1
    }

    // Scan the ring for events after afterSeq
    const startIdx = this.ringStartIndex(ring)
    for (let i = 0; i < ring.size && events.length < limit; i++) {
      const idx = (startIdx + i) % ring.events.length
      const evt = ring.events[idx]
      if (!evt || evt.seq <= afterSeq) continue
      if (this.matchesFilter(evt, options)) {
        events.push(evt)
      }
    }

    const lastEvent = events[events.length - 1]
    const cursor = lastEvent ? lastEvent.seq : ring.seq

    const result: TailQueryResult = { events, cursor }
    if (gap) {
      result.gap = true
      result.missedEstimate = missedEstimate
    }
    return result
  }

  /** Get the N most recent events within a time window. */
  recent(tenantId: string, options?: TailQueryOptions & { seconds?: number }): TailQueryResult {
    const ring = this.rings.get(tenantId)
    if (!ring || ring.size === 0) {
      return { events: [], cursor: 0 }
    }

    const limit = options?.limit ?? 200
    const seconds = options?.seconds ?? 30
    const cutoff = new Date(Date.now() - seconds * 1000).toISOString()

    const events: TailEvent[] = []

    // Scan from newest to oldest, collect matches
    const startIdx = this.ringStartIndex(ring)
    const candidates: TailEvent[] = []

    for (let i = ring.size - 1; i >= 0 && candidates.length < limit * 2; i--) {
      const idx = (startIdx + i) % ring.events.length
      const evt = ring.events[idx]
      if (!evt) continue
      if (evt.timestamp < cutoff) break
      if (this.matchesFilter(evt, options)) {
        candidates.push(evt)
      }
    }

    // Reverse to chronological order, take limit
    candidates.reverse()
    events.push(...candidates.slice(0, limit))

    const lastEvt = events[events.length - 1]
    const cursor = lastEvt ? lastEvt.seq : ring.seq

    return { events, cursor }
  }

  /** Subscribe to new events for a tenant. Returns unsubscribe function. */
  subscribe(tenantId: string, callback: Subscriber): () => void {
    let subs = this.subscribers.get(tenantId)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(tenantId, subs)
    }
    subs.add(callback)

    return () => {
      subs.delete(callback)
      if (subs.size === 0) {
        this.subscribers.delete(tenantId)
      }
    }
  }

  /** Get buffer statistics. */
  stats(): TailBufferStats {
    return {
      tenants: this.rings.size,
      totalEvents: this.totalEventCount,
      memoryBytes: this.totalEventCount * ESTIMATED_EVENT_BYTES,
    }
  }

  /** Check if a tenant has a buffer. */
  hasTenant(tenantId: string): boolean {
    return this.rings.has(tenantId)
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private oldestSeq(ring: TenantRing): number {
    if (ring.size === 0) return 0
    const startIdx = this.ringStartIndex(ring)
    return ring.events[startIdx]?.seq ?? 0
  }

  private ringStartIndex(ring: TenantRing): number {
    if (ring.size < ring.events.length) return 0
    return ring.head // when full, head points to the oldest (about to be overwritten)
  }

  private matchesFilter(event: TailEvent, options?: TailQueryOptions): boolean {
    if (!options) return true
    if (options.service && event.service !== options.service) return false
    // Case-insensitive exact match: levels are uppercased at ingest, but the
    // client-supplied filter value may arrive in any case (poll/SSE paths).
    if (options.level && event.level.toUpperCase() !== options.level.toUpperCase()) return false
    if (options.minLevel && !levelMeetsSeverity(event.level, options.minLevel)) return false
    if (options.templateId && event.templateId !== options.templateId) return false
    if (options.minAnomalyScore !== undefined && event.anomalyScore < options.minAnomalyScore)
      return false
    return true
  }

  private enforceMemoryCeiling(excludeTenantId: string): void {
    const currentMemory = this.stats().memoryBytes
    if (currentMemory < this.config.maxMemoryBytes) return

    // Find LRU tenant (oldest lastPushTime), excluding the one being pushed to
    let lruTenant: string | undefined
    let lruTime = Infinity

    for (const [tid, ring] of this.rings) {
      if (tid === excludeTenantId) continue
      if (ring.lastPushTime < lruTime) {
        lruTime = ring.lastPushTime
        lruTenant = tid
      }
    }

    if (lruTenant) {
      const evicted = this.rings.get(lruTenant)
      if (evicted) this.totalEventCount -= evicted.size
      this.rings.delete(lruTenant)
      this.subscribers.delete(lruTenant)
    }
  }

  private cleanup(): void {
    const now = Date.now()
    const maxAgeMs = this.config.bufferSeconds * 1000

    for (const [tenantId, ring] of this.rings) {
      // Evict idle tenants
      if (now - ring.lastPushTime > this.config.idleTimeoutMs) {
        this.totalEventCount -= ring.size
        this.rings.delete(tenantId)
        this.subscribers.delete(tenantId)
        continue
      }

      // Check if all events are expired — if so, reset the ring entirely.
      // Partial eviction is handled by the circular wrap (oldest events are
      // naturally overwritten by new pushes). The `recent()` method already
      // filters by timestamp, so stale events are invisible to consumers.
      const cutoff = now - maxAgeMs
      const newestIdx = (ring.head - 1 + ring.events.length) % ring.events.length
      const newest = ring.events[newestIdx]

      if (newest && new Date(newest.timestamp).getTime() < cutoff) {
        // All events are expired — reset the ring
        ring.events = new Array(ring.events.length)
        ring.head = 0
        ring.size = 0
      }
    }
  }
}
