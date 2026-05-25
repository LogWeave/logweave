import { execSync } from 'node:child_process'
import path from 'node:path'
import type { ClickHouseClient } from '@clickhouse/client'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../../../')

const API_URL = 'http://localhost:3000'

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
  await pollUntil(() => isReachable('http://localhost:8000/health'), {
    intervalMs: 1000,
    timeoutMs: maxWaitMs,
    label: 'clusterer healthy',
  })
}

/** Direct HTTP ingest — bypasses transport SDK for precise request/response control. */
export async function ingestBatch(
  apiKey: string,
  events: unknown[],
  options?: { service?: string; environment?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${API_URL}/v1/ingest/batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      events,
      service: options?.service,
      environment: options?.environment,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body }
}

/** Query ClickHouse for current server time — avoids clock skew with test host. */
export async function getClickhouseNow(clickhouse: ClickHouseClient): Promise<string> {
  const result = await clickhouse.query({
    query: 'SELECT toString(now64(3)) AS now',
    format: 'JSONEachRow',
  })
  const rows = (await result.json()) as Array<{ now: string }>
  return rows[0]?.now ?? new Date().toISOString()
}

/**
 * Count rows inserted since a given time. Uses ClickHouse's ingest_time column
 * for delta-based assertions that are independent of prior test state.
 * Optional templateFilter restricts to clustered/unclustered rows.
 */
export async function countRowsSince(
  clickhouse: ClickHouseClient,
  tenantId: string,
  sinceTime: string,
  templateFilter?: 'clustered' | 'unclustered',
): Promise<number> {
  let templateClause = ''
  if (templateFilter === 'unclustered') templateClause = " AND template_id = '0'"
  else if (templateFilter === 'clustered') templateClause = " AND template_id != '0'"

  const result = await clickhouse.query({
    query: `SELECT count() AS cnt FROM logweave.log_metadata WHERE tenant_id = {tenant_id:String} AND ingest_time >= {since:String}${templateClause}`,
    query_params: { tenant_id: tenantId, since: sinceTime },
    format: 'JSONEachRow',
  })
  const rows = (await result.json()) as Array<{ cnt: string }>
  return Number(rows[0]?.cnt ?? 0)
}
