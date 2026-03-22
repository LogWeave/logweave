import { type Request, type Response, Router } from 'express'
import type pino from 'pino'
import { z } from 'zod'
import { insertAuditEvent } from '../db/audit-queries.js'
import type { DbClient } from '../db/client.js'
import { HttpStatus } from '../http-status.js'
import { getTenantId, getKeyId } from '../middleware/auth.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'
import type { TailBuffer } from '../tail/buffer.js'
import { levelMeetsSeverity, type TailEvent } from '../tail/types.js'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface TailDeps {
  tailBuffer: TailBuffer
  settingsStore: TenantSettingsStore
  db: DbClient
  logger: pino.Logger
  maxConnections?: number
}

// ---------------------------------------------------------------------------
// Connection tracking
// ---------------------------------------------------------------------------

const tenantConnections = new Map<string, number>()

function getConnectionCount(tenantId: string): number {
  return tenantConnections.get(tenantId) ?? 0
}

function incrementConnections(tenantId: string): void {
  tenantConnections.set(tenantId, getConnectionCount(tenantId) + 1)
}

function decrementConnections(tenantId: string): void {
  const count = getConnectionCount(tenantId) - 1
  if (count <= 0) {
    tenantConnections.delete(tenantId)
  } else {
    tenantConnections.set(tenantId, count)
  }
}

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const tailFilterSchema = z.object({
  service: z.string().optional(),
  level: z.string().optional(),
  min_level: z.string().optional(),
  template_id: z.string().optional(),
  min_anomaly: z.coerce.number().min(0).max(1).optional(),
})

const pollSchema = tailFilterSchema.extend({
  seconds: z.coerce.number().int().min(1).max(60).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.number().int().optional(),
})

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

function writeSseEvent(res: Response, event: TailEvent): boolean {
  try {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`)
    return true
  } catch {
    return false
  }
}

function writeSseComment(res: Response, comment: string): void {
  try {
    res.write(`:${comment}\n\n`)
  } catch {
    // Client disconnected
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function tailRoutes(deps: TailDeps): Router {
  const router = Router()
  const maxConn = deps.maxConnections ?? 5

  // GET /tail — SSE stream of live events
  router.get('/tail', validateQuery(tailFilterSchema), (req: Request, res: Response) => {
    const tenantId = getTenantId(res)
    const keyId = getKeyId(res)
    const tailMode = deps.settingsStore.get(tenantId).tailMode

    // Check if tail is enabled
    if (!tailMode || tailMode === 'disabled') {
      res.status(HttpStatus.FORBIDDEN).json({
        error: { code: 'TAIL_DISABLED', message: 'Live tail is not enabled for this tenant. Set tail_mode via PUT /v1/settings.' },
      })
      return
    }

    // Check connection limit
    if (getConnectionCount(tenantId) >= maxConn) {
      res.status(HttpStatus.TOO_MANY_REQUESTS).json({
        error: { code: 'CONNECTION_LIMIT', message: `Maximum tail connections reached (${maxConn}). Close an existing connection first.` },
      })
      return
    }

    const filters = getQuery<z.infer<typeof tailFilterSchema>>(req)

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    incrementConnections(tenantId)
    let eventsStreamed = 0
    const startTime = Date.now()

    // Replay from Last-Event-ID if provided
    const lastEventId = req.headers['last-event-id']
    if (lastEventId) {
      const afterSeq = Number(lastEventId)
      if (!Number.isNaN(afterSeq)) {
        const replay = deps.tailBuffer.since(tenantId, afterSeq, {
          service: filters.service,
          level: filters.level,
          minLevel: filters.min_level,
          templateId: filters.template_id,
          minAnomalyScore: filters.min_anomaly,
          limit: 200,
        })
        if (replay.gap) {
          res.write(`event: gap\ndata: ${JSON.stringify({ missedEstimate: replay.missedEstimate })}\n\n`)
        }
        for (const evt of replay.events) {
          writeSseEvent(res, evt)
          eventsStreamed++
        }
      }
    }

    // Subscribe to new events
    let pendingEvents: TailEvent[] = []

    const unsubscribe = deps.tailBuffer.subscribe(tenantId, (event) => {
      // Non-blocking: queue the event, don't write synchronously
      if (matchesFilter(event, filters)) {
        pendingEvents.push(event)
      }
    })

    // Drain loop: write queued events to SSE
    const drainInterval = setInterval(() => {
      if (pendingEvents.length === 0) return

      const batch = pendingEvents
      pendingEvents = []

      // Backpressure check
      if (batch.length > 1000) {
        res.write(`event: error\ndata: ${JSON.stringify({ reason: 'backpressure' })}\n\n`)
        cleanup('backpressure')
        return
      }

      for (const evt of batch) {
        if (!writeSseEvent(res, evt)) {
          cleanup('write_error')
          return
        }
        eventsStreamed++
      }
    }, 100) // Drain every 100ms

    // Heartbeat every 10 seconds
    const heartbeat = setInterval(() => {
      writeSseComment(res, 'keepalive')
    }, 10_000)

    // Cleanup on disconnect — guarded against double invocation (C1 fix)
    let cleaned = false
    const onShutdown = (): void => {
      try { res.write('event: shutdown\ndata: {}\n\n') } catch { /* already closed */ }
      cleanup('shutdown')
    }

    function cleanup(reason: string): void {
      if (cleaned) return
      cleaned = true

      clearInterval(drainInterval)
      clearInterval(heartbeat)
      unsubscribe()
      decrementConnections(tenantId)
      process.removeListener('SIGTERM', onShutdown)

      const durationMs = Date.now() - startTime
      deps.logger.info(
        { tenantId, keyId, reason, durationMs, eventsStreamed },
        'Tail SSE connection closed',
      )

      // Audit: tail.disconnect
      insertAuditEvent(deps.db, tenantId, {
        keyId,
        action: 'tail.disconnect',
        details: JSON.stringify({ reason }),
        durationMs,
        eventsStreamed,
      }).catch(() => { /* audit write failure must not crash cleanup */ })

      try { res.end() } catch { /* already ended */ }
    }

    req.on('close', () => cleanup('client'))
    res.on('error', () => cleanup('error'))
    process.on('SIGTERM', onShutdown)

    deps.logger.info(
      { tenantId, keyId, filters },
      'Tail SSE connection opened',
    )

    // Audit: tail.connect
    insertAuditEvent(deps.db, tenantId, {
      keyId,
      action: 'tail.connect',
      sourceIp: req.ip ?? '',
      details: JSON.stringify(filters),
    }).catch(() => { /* audit write failure must not crash the connection */ })
  })

  // GET /tail/poll — cursor-based polling for MCP tool
  router.get('/tail/poll', validateQuery(pollSchema), (req: Request, res: Response) => {
    const tenantId = getTenantId(res)
    const tailMode = deps.settingsStore.get(tenantId).tailMode

    if (!tailMode || tailMode === 'disabled') {
      res.status(HttpStatus.OK).json({
        data: { events: [], cursor: 0 },
        meta: {
          count: 0,
          fetchedAt: new Date().toISOString(),
          message: 'Live tail is not enabled for this tenant. Set tail_mode via PUT /v1/settings.',
        },
      })
      return
    }

    const params = getQuery<z.infer<typeof pollSchema>>(req)
    const filterOpts = {
      service: params.service,
      level: params.level,
      minLevel: params.min_level,
      templateId: params.template_id,
      minAnomalyScore: params.min_anomaly,
      limit: params.limit,
    }

    const result = params.cursor !== undefined
      ? deps.tailBuffer.since(tenantId, params.cursor, filterOpts)
      : deps.tailBuffer.recent(tenantId, { ...filterOpts, seconds: params.seconds })

    res.status(HttpStatus.OK).json({
      data: {
        events: result.events,
        cursor: result.cursor,
        gap: result.gap,
        missedEstimate: result.missedEstimate,
      },
      meta: {
        count: result.events.length,
        fetchedAt: new Date().toISOString(),
      },
    })
  })

  // GET /tail/stats — buffer utilization metrics
  router.get('/tail/stats', (_req: Request, res: Response) => {
    const stats = deps.tailBuffer.stats()
    let connectionsActive = 0
    for (const count of tenantConnections.values()) {
      connectionsActive += count
    }

    res.status(HttpStatus.OK).json({
      data: {
        ...stats,
        connectionsActive,
      },
      meta: { fetchedAt: new Date().toISOString() },
    })
  })

  return router
}

// ---------------------------------------------------------------------------
// Filter helper
// ---------------------------------------------------------------------------

function matchesFilter(
  event: TailEvent,
  filters: { service?: string; level?: string; min_level?: string; template_id?: string; min_anomaly?: number },
): boolean {
  if (filters.service && event.service !== filters.service) return false
  if (filters.level && event.level !== filters.level) return false
  if (filters.min_level && !levelMeetsSeverity(event.level, filters.min_level)) return false
  if (filters.template_id && event.templateId !== filters.template_id) return false
  if (filters.min_anomaly !== undefined && event.anomalyScore < filters.min_anomaly) return false
  return true
}
