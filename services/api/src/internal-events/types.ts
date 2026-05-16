export type Severity = 'info' | 'warn' | 'error'

export interface InternalEvent {
  ts: string
  service: 'api' | 'clusterer'
  event: EventName
  severity: Severity
  code: string
  summary: string
  fields: Record<string, unknown>
}

// MVP event catalog. Unknown names are rejected by the emitter.
export const EVENT_CATALOG = [
  'service.started',
  'service.stopping',
  'config.loaded',
  'config.invalid',
  'migration.applied',
  'clickhouse.query_failed',
  'clickhouse.unreachable',
  'clusterer.timeout',
  'clusterer.unreachable',
  'slack.webhook_failed',
  's3.connector_failed',
  'auth.key_invalid',
  'auth.tenant_unknown',
  'ratelimit.exceeded',
] as const

export type EventName = (typeof EVENT_CATALOG)[number]

export function isKnownEvent(name: string): name is EventName {
  return (EVENT_CATALOG as readonly string[]).includes(name)
}
