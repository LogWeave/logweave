/**
 * Test data seeder for MCP e2e tests.
 *
 * Generates 3 realistic scenarios and ingests them via the API.
 * All timestamps are relative to now() so time-window queries work.
 */

const API_URL = process.env.LOGWEAVE_API_URL ?? 'http://localhost:3000'
const API_KEY = process.env.LOGWEAVE_API_KEY ?? 'dev-key'

interface RawEvent {
  message: string
  level: string
  service: string
  timestamp: string
  trace_id?: string
  status_code?: number
  duration_ms?: number
  route?: string
}

function minutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString()
}

function randomTraceId(): string {
  return crypto.randomUUID()
}

function randomIp(): string {
  return `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
}

// -----------------------------------------------------------------------
// Scenario 1: Microservice Incident — cascade + deploy fix
// -----------------------------------------------------------------------

/** Shared trace IDs for cross-service correlation in scenario 1 */
export const CASCADE_TRACE_IDS: string[] = Array.from({ length: 20 }, () => randomTraceId())

export function scenario1_incident(): RawEvent[] {
  const events: RawEvent[] = []

  // T-60 to T-30: Normal traffic across payments, auth, gateway
  for (let m = 60; m > 30; m--) {
    for (let i = 0; i < 3; i++) {
      const traceId = randomTraceId()
      events.push(
        {
          message: `Processing payment for order ${1000 + i}`,
          level: 'INFO',
          service: 'payments',
          timestamp: minutesAgo(m),
          trace_id: traceId,
          status_code: 200,
          duration_ms: 50 + Math.random() * 100,
          route: '/api/v1/charge',
        },
        {
          message: `Token validated for user ${100 + i}`,
          level: 'INFO',
          service: 'auth',
          timestamp: minutesAgo(m),
          trace_id: traceId,
          status_code: 200,
          duration_ms: 10 + Math.random() * 20,
        },
        {
          message: `Forwarded request to payments`,
          level: 'INFO',
          service: 'gateway',
          timestamp: minutesAgo(m),
          trace_id: traceId,
          status_code: 200,
          duration_ms: 60 + Math.random() * 120,
          route: '/checkout',
        },
      )
    }
  }

  // T-30 to T-10: Payment timeout cascade
  for (let m = 30; m > 10; m--) {
    for (let i = 0; i < 5; i++) {
      // Use shared trace IDs so related_patterns can find the cascade
      const traceId = CASCADE_TRACE_IDS[i % CASCADE_TRACE_IDS.length]
      events.push(
        {
          message: `Connection to ${randomIp()} timed out after ${3000 + Math.random() * 2000}ms`,
          level: 'ERROR',
          service: 'payments',
          timestamp: minutesAgo(m),
          trace_id: traceId,
          status_code: 504,
          duration_ms: 5000,
          route: '/api/v1/charge',
        },
        {
          message: `Token validation failed for downstream service`,
          level: 'ERROR',
          service: 'auth',
          timestamp: minutesAgo(m),
          trace_id: traceId,
          status_code: 503,
        },
        {
          message: `Upstream payments returned 503`,
          level: 'ERROR',
          service: 'gateway',
          timestamp: minutesAgo(m),
          trace_id: traceId,
          status_code: 503,
          route: '/checkout',
        },
      )
    }
    // Some normal traffic mixed in
    events.push(
      {
        message: `Health check passed`,
        level: 'INFO',
        service: 'payments',
        timestamp: minutesAgo(m),
        status_code: 200,
      },
      {
        message: `Health check passed`,
        level: 'INFO',
        service: 'auth',
        timestamp: minutesAgo(m),
        status_code: 200,
      },
    )
  }

  // T-5 to T-0: Recovery after deploy
  for (let m = 5; m > 0; m--) {
    for (let i = 0; i < 3; i++) {
      events.push(
        {
          message: `Processing payment for order ${2000 + i}`,
          level: 'INFO',
          service: 'payments',
          timestamp: minutesAgo(m),
          status_code: 200,
          duration_ms: 50 + Math.random() * 100,
          route: '/api/v1/charge',
        },
        {
          message: `Token validated for user ${200 + i}`,
          level: 'INFO',
          service: 'auth',
          timestamp: minutesAgo(m),
          status_code: 200,
        },
      )
    }
  }

  return events
}

// -----------------------------------------------------------------------
// Scenario 2: Gradual Degradation — database connection pool drain
// -----------------------------------------------------------------------

export function scenario2_degradation(): RawEvent[] {
  const events: RawEvent[] = []

  // T-120 to T-0: Increasing error rate
  for (let m = 120; m > 0; m--) {
    const errorProbability = Math.min(0.15, 0.01 + (120 - m) * 0.0012)

    for (let i = 0; i < 4; i++) {
      if (Math.random() < errorProbability) {
        events.push({
          message: `Connection pool exhausted after ${1000 + Math.random() * 4000}ms waiting`,
          level: 'ERROR',
          service: 'api-service',
          timestamp: minutesAgo(m),
          status_code: 503,
          duration_ms: 5000 + Math.random() * 5000,
          route: '/api/v1/query',
        })
      } else {
        events.push({
          message: `Query completed in ${10 + Math.random() * 200}ms`,
          level: 'INFO',
          service: 'api-service',
          timestamp: minutesAgo(m),
          status_code: 200,
          duration_ms: 10 + Math.random() * 200,
          route: '/api/v1/query',
        })
      }
    }

    // Occasional warnings as pool fills up
    if (Math.random() < errorProbability * 2) {
      events.push({
        message: `Connection pool at ${70 + Math.floor(Math.random() * 30)}% capacity`,
        level: 'WARN',
        service: 'api-service',
        timestamp: minutesAgo(m),
      })
    }
  }

  return events
}

// -----------------------------------------------------------------------
// Scenario 3: Multi-Service Burst — sudden 503 spike
// -----------------------------------------------------------------------

export function scenario3_burst(): RawEvent[] {
  const events: RawEvent[] = []

  // T-30 to T-0: 4 services normal
  for (let m = 30; m > 0; m--) {
    for (const svc of ['notifications', 'billing', 'inventory', 'search']) {
      events.push({
        message: `Request processed successfully`,
        level: 'INFO',
        service: svc,
        timestamp: minutesAgo(m),
        status_code: 200,
        duration_ms: 20 + Math.random() * 80,
      })
    }
  }

  // T-15 to T-10: notifications burst with 503s
  for (let m = 15; m > 10; m--) {
    for (let i = 0; i < 8; i++) {
      events.push({
        message: `SMS gateway returned 503 Service Unavailable`,
        level: 'ERROR',
        service: 'notifications',
        timestamp: minutesAgo(m),
        status_code: 503,
        duration_ms: 3000 + Math.random() * 2000,
        route: '/api/v1/notify',
      })
      // Some retry attempts
      events.push({
        message: `Retrying SMS delivery attempt ${i + 1} of 3`,
        level: 'WARN',
        service: 'notifications',
        timestamp: minutesAgo(m),
        route: '/api/v1/notify',
      })
    }
  }

  return events
}

// -----------------------------------------------------------------------
// Ingest helper — seeds data in batches
// -----------------------------------------------------------------------

export async function ingestBatch(events: RawEvent[]): Promise<{ accepted: number }> {
  const batchSize = 200
  let totalAccepted = 0

  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize)
    const res = await fetch(`${API_URL}/v1/ingest/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({ events: batch }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Ingest failed (${res.status}): ${body}`)
    }

    const result = (await res.json()) as { accepted: number }
    totalAccepted += result.accepted
  }

  return { accepted: totalAccepted }
}

export async function postDeploy(service: string, version: string): Promise<void> {
  const res = await fetch(`${API_URL}/v1/deploys`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      service,
      version,
      commit_sha: 'abc123fix',
      timestamp: minutesAgo(10),
    }),
  })
  if (!res.ok) {
    throw new Error(`Deploy post failed: ${res.status}`)
  }
}

export async function waitForMV(ms = 3000): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Call an API endpoint and return parsed JSON. */
export async function apiGet(
  path: string,
  params?: Record<string, string | number>,
): Promise<unknown> {
  const url = new URL(`${API_URL}/v1${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`API ${path} failed (${res.status}): ${body}`)
  }
  return res.json()
}

export async function apiGetRaw(
  path: string,
  params?: Record<string, string | number>,
): Promise<Response> {
  const url = new URL(`${API_URL}/v1${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v))
    }
  }
  return fetch(url.toString(), {
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
}
