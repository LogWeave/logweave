import type { DbClient } from '../db/client.js'
import { redactFields, sanitizeMessage, stripStackTraces, summarizeConfig } from './redaction.js'
import { type EventName, type InternalEvent, isKnownEvent, type Severity } from './types.js'

export interface EmitInput {
  event: EventName
  severity: Severity
  code: string
  summary: string
  fields?: Record<string, unknown>
}

export interface EmitterDeps {
  service: 'api' | 'clusterer'
  db?: DbClient // optional — when absent, only stdout receives the event
  stdout?: (line: string) => void // injectable for tests
  now?: () => Date
  isProd?: boolean
}

const SAMPLE_INTERVAL_MS = 10_000
const SAMPLED_EVENTS: ReadonlySet<EventName> = new Set(['auth.key_invalid', 'ratelimit.exceeded'])

/**
 * Internal event emitter. Single sanctioned path to the operator event feed.
 *
 * Dual-sink: always writes a JSON line to stdout, best-effort writes to ClickHouse.
 * ClickHouse failures are caught and dropped — stdout already has the event.
 *
 * High-volume per-request events (auth, ratelimit) are coalesced to at most one
 * emission per (event, tenant_id, code) every 10s to protect the internal_events
 * table from auth-attack floods.
 */
export class InternalEventEmitter {
  private readonly service: 'api' | 'clusterer'
  private readonly db: DbClient | undefined
  private readonly stdout: (line: string) => void
  private readonly now: () => Date
  private readonly isProd: boolean
  private readonly sampleCache = new Map<string, number>()

  constructor(deps: EmitterDeps) {
    this.service = deps.service
    this.db = deps.db
    this.stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`))
    this.now = deps.now ?? (() => new Date())
    this.isProd = deps.isProd ?? process.env.NODE_ENV === 'production'
  }

  emit(input: EmitInput): void {
    if (!isKnownEvent(input.event)) {
      if (!this.isProd) {
        throw new Error(`unknown internal event: ${input.event}`)
      }
      return // dev catches typos; prod silently drops to avoid crash
    }

    if (this.shouldSample(input)) return

    const rawFields = input.fields ?? {}
    const redactedFields = redactFields(rawFields)
    const safeSummary = sanitizeMessage(input.summary)

    // stdout sink retains stack traces (operator-only via docker logs)
    const stdoutEvent: InternalEvent = {
      ts: this.now().toISOString(),
      service: this.service,
      event: input.event,
      severity: input.severity,
      code: input.code,
      summary: safeSummary,
      fields: redactedFields,
    }
    try {
      this.stdout(JSON.stringify(stdoutEvent))
    } catch {
      // never throw from emitter — caller is on a hot path
    }

    // ClickHouse sink strips stack traces and ships best-effort
    const chFields = stripStackTraces(redactedFields)
    const chEvent: InternalEvent = { ...stdoutEvent, fields: chFields }
    this.shipToClickHouse(chEvent)
  }

  /**
   * Convenience: emit a config.loaded event with allowlist-only value passthrough.
   */
  emitConfigLoaded(config: Record<string, unknown>): void {
    this.emit({
      event: 'config.loaded',
      severity: 'info',
      code: 'CONFIG_LOADED',
      summary: 'config loaded',
      fields: summarizeConfig(config),
    })
  }

  private shipToClickHouse(event: InternalEvent): void {
    if (!this.db) return
    const row = {
      ts: event.ts,
      service: event.service,
      event: event.event,
      severity: event.severity,
      code: event.code,
      summary: event.summary,
      fields: JSON.stringify(event.fields),
    }
    // fire-and-forget — never await on a hot path, never re-emit on failure
    this.db
      .insert({
        table: 'logweave.internal_events',
        values: [row],
        format: 'JSONEachRow',
      })
      .catch(() => {
        // stdout already has it; do not call emit() here or we recurse
      })
  }

  private shouldSample(input: EmitInput): boolean {
    if (!SAMPLED_EVENTS.has(input.event)) return false
    const tenantId =
      typeof input.fields?.tenant_id === 'string' ? input.fields.tenant_id : '_unknown'
    const cacheKey = `${input.event}|${tenantId}|${input.code}`
    const lastEmittedAt = this.sampleCache.get(cacheKey) ?? 0
    const nowMs = this.now().getTime()
    if (nowMs - lastEmittedAt < SAMPLE_INTERVAL_MS) {
      return true // suppress
    }
    this.sampleCache.set(cacheKey, nowMs)
    // bound cache: prune entries older than 2 * interval
    if (this.sampleCache.size > 1000) {
      const cutoff = nowMs - 2 * SAMPLE_INTERVAL_MS
      for (const [k, ts] of this.sampleCache) {
        if (ts < cutoff) this.sampleCache.delete(k)
      }
    }
    return false
  }
}

let singleton: InternalEventEmitter | undefined

/**
 * Initialize the process-wide emitter. Call once at startup.
 */
export function initInternalEvents(deps: EmitterDeps): InternalEventEmitter {
  singleton = new InternalEventEmitter(deps)
  return singleton
}

/**
 * Process-wide accessor. Returns a fallback emitter if init was never called
 * (e.g. in tests that don't exercise the emitter path, or a programming bug
 * where a module emits before bootstrap finishes). The fallback writes to
 * real stdout so events are not silently dropped, and warns once to stderr
 * so the operator can spot the misuse.
 */
export function getInternalEvents(): InternalEventEmitter {
  if (singleton) return singleton
  process.stderr.write(
    'internal-events: getInternalEvents() called before initInternalEvents(); falling back to stdout-only emitter\n',
  )
  singleton = new InternalEventEmitter({ service: 'api' })
  return singleton
}

/** Test-only: reset the singleton between test cases. */
export function _resetInternalEventsForTests(): void {
  singleton = undefined
}
