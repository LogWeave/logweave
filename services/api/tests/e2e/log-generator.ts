/**
 * Generate realistic log events that Drain3 can cluster into ~10 templates.
 * Each template produces count/10 events with randomized parameters.
 * Timestamps spread across a 1-hour window for multiple MV intervals.
 */

const NAMES = ['alice', 'bob', 'charlie', 'diana', 'eve', 'frank', 'grace', 'heidi']
const IPS = ['192.168.1.1', '10.0.0.2', '172.16.0.5', '10.1.2.3', '192.168.0.100']
const SERVICES = ['auth-api', 'payments', 'notifications', 'users', 'gateway']
const ROUTES = ['/api/login', '/api/users', '/api/payments', '/api/health', '/api/orders']
const HOSTS = ['db-primary', 'redis-01', 'kafka-broker', 'es-node-1', 'cache-01']
const REASONS = ['Connection refused', 'Timeout', 'DNS lookup failed', 'TLS handshake failed']
const PROVIDERS = ['sendgrid', 'ses', 'mailgun', 'postmark']
const PATHS = [
  '/uploads/report.pdf',
  '/uploads/avatar.png',
  '/uploads/data.csv',
  '/uploads/log.txt',
]

function pick<T>(arr: readonly T[]): T {
  // `arr.length > 0` is required by every caller in this file; Math.floor
  // always lands in-bounds. Cast through unknown to satisfy the typechecker
  // without an inline non-null assertion.
  return arr[Math.floor(Math.random() * arr.length)] as T
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

interface GeneratedEvent {
  level: string
  message: string
  timestamp: string
  status_code?: number
  duration_ms?: number
  route?: string
  trace_id?: string
}

type TemplateGenerator = (ts: string) => GeneratedEvent

const TEMPLATES: TemplateGenerator[] = [
  // 1. User login (info)
  (ts) => ({
    level: 'info',
    message: `User ${pick(NAMES)} logged in from ${pick(IPS)}`,
    timestamp: ts,
    route: '/api/login',
    duration_ms: randInt(10, 200),
    status_code: 200,
  }),
  // 2. Connection timeout (error)
  (ts) => ({
    level: 'error',
    message: `Connection timeout after ${randInt(5, 60)}s for ${pick(SERVICES)}`,
    timestamp: ts,
    duration_ms: randInt(5000, 60000),
  }),
  // 3. HTTP request completed (info)
  (ts) => ({
    level: 'info',
    message: `Request to ${pick(ROUTES)} completed in ${randInt(1, 500)}ms with status ${pick([200, 201, 204, 301, 404])}`,
    timestamp: ts,
    route: pick(ROUTES),
    duration_ms: randInt(1, 500),
    status_code: pick([200, 201, 204, 301, 404]),
  }),
  // 4. Database query (debug)
  (ts) => ({
    level: 'debug',
    message: `Database query executed in ${randInt(1, 200)}ms, ${randInt(0, 5000)} rows returned`,
    timestamp: ts,
    duration_ms: randInt(1, 200),
  }),
  // 5. Connection failure (error)
  (ts) => ({
    level: 'error',
    message: `Failed to connect to ${pick(HOSTS)}:${pick([5432, 6379, 9092, 9200])}: ${pick(REASONS)}`,
    timestamp: ts,
  }),
  // 6. Memory usage (warn)
  (ts) => {
    const total = pick([512, 1024, 2048, 4096])
    const pct = randInt(60, 98)
    const used = Math.round((total * pct) / 100)
    return {
      level: 'warn',
      message: `Memory usage at ${pct}% (${used}MB/${total}MB)`,
      timestamp: ts,
    }
  },
  // 7. File upload (info)
  (ts) => ({
    level: 'info',
    message: `File ${pick(PATHS)} uploaded successfully, size ${randInt(10, 50000)}KB`,
    timestamp: ts,
  }),
  // 8. Email sent (info)
  (ts) => ({
    level: 'info',
    message: `Email sent to ${pick(NAMES)}@example.com via ${pick(PROVIDERS)}`,
    timestamp: ts,
  }),
  // 9. Cache hit (debug)
  (ts) => ({
    level: 'debug',
    message: `Cache hit for key user:${randInt(1, 10000)}, TTL ${randInt(10, 3600)}s remaining`,
    timestamp: ts,
  }),
  // 10. Payment processed (info)
  (ts) => ({
    level: 'info',
    message: `Payment processed for order ORD-${randInt(10000, 99999)}, amount $${(randInt(100, 100000) / 100).toFixed(2)}`,
    timestamp: ts,
    status_code: 200,
    duration_ms: randInt(50, 2000),
  }),
]

export function generateEvents(count: number): GeneratedEvent[] {
  const events: GeneratedEvent[] = []
  const now = Date.now()
  const oneHourMs = 60 * 60 * 1000

  for (let i = 0; i < count; i++) {
    // `i % length` is always in range, so this is never undefined; the guard is
    // only here to satisfy noUncheckedIndexedAccess without a non-null assertion.
    const template = TEMPLATES[i % TEMPLATES.length]
    if (!template) continue
    // Spread timestamps across a 1-hour window
    const offsetMs = Math.floor((i / count) * oneHourMs)
    const ts = new Date(now - oneHourMs + offsetMs).toISOString()
    events.push(template(ts))
  }

  return events
}
