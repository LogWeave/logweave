/**
 * Dev-only diagnostic tools — registered only when LOGWEAVE_DEV=true.
 * Uses plain HTTP fetch against ClickHouse and service health endpoints.
 * No new dependencies.
 */

const CH_TIMEOUT_MS = 10_000

export interface DevToolsConfig {
  clickhouseUrl: string
  clustererUrl: string
  apiUrl: string
}

// Count distinct tenants across every tenant-bearing table, not just those that
// have shipped logs — a tenant provisioned via settings/watches but with no log
// data yet must still count toward the multi-tenant guard.
const TENANT_COUNT_QUERY = `SELECT uniqExact(tenant_id) FROM (
  SELECT tenant_id FROM logweave.log_metadata
  UNION ALL
  SELECT tenant_id FROM logweave.tenant_settings
  UNION ALL
  SELECT tenant_id FROM logweave.watches
)
FORMAT TabSeparated
SETTINGS readonly=1`

/**
 * Count distinct tenants in the backend. Used as a safety gate: dev tools query
 * ClickHouse directly and bypass tenant scoping, so they must never register
 * against a multi-tenant deployment. Throws on connection/HTTP error so the
 * caller fails closed (refuses to register).
 */
export async function countDistinctTenants(config: DevToolsConfig): Promise<number> {
  const res = await globalThis.fetch(config.clickhouseUrl, {
    method: 'POST',
    body: TENANT_COUNT_QUERY,
    signal: AbortSignal.timeout(CH_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`ClickHouse returned ${res.status} ${res.statusText}`)
  }
  const count = Number.parseInt((await res.text()).trim(), 10)
  if (!Number.isFinite(count)) {
    throw new Error('Could not parse tenant count from ClickHouse')
  }
  return count
}

// ---------------------------------------------------------------------------
// dev_health — check all 3 services
// ---------------------------------------------------------------------------

export async function devHealth(config: DevToolsConfig): Promise<string> {
  const checks = await Promise.allSettled([
    checkService('API', `${config.apiUrl}/healthz`),
    checkService('ClickHouse', `${config.clickhouseUrl}/ping`),
    checkService('Clusterer', `${config.clustererUrl}/health`),
  ])

  let text = '## Service Health\n\n'
  for (const result of checks) {
    if (result.status === 'fulfilled') {
      text += result.value
    } else {
      text += `- UNKNOWN: ${result.reason}\n`
    }
  }
  return text
}

async function checkService(name: string, url: string): Promise<string> {
  try {
    const res = await globalThis.fetch(url, {
      signal: AbortSignal.timeout(3_000),
    })
    if (res.ok) {
      return `- **${name}**: UP (${res.status})\n`
    }
    return `- **${name}**: ERROR (${res.status} ${res.statusText})\n`
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `- **${name}**: DOWN (${msg})\n`
  }
}

// ---------------------------------------------------------------------------
// dev_query — run a read-only SELECT against ClickHouse
// ---------------------------------------------------------------------------

export async function devQuery(
  config: DevToolsConfig,
  args: { sql: string },
): Promise<string> {
  const sql = args.sql.trim()

  // Safety: only allow SELECT and SHOW/DESCRIBE/EXPLAIN
  const firstWord = sql.split(/\s/)[0].toUpperCase()
  if (!['SELECT', 'SHOW', 'DESCRIBE', 'EXPLAIN', 'WITH'].includes(firstWord)) {
    return 'Error: Only SELECT, SHOW, DESCRIBE, EXPLAIN, and WITH queries are allowed.'
  }
  if (sql.includes(';')) {
    return 'Error: Multi-statement queries are not allowed.'
  }

  try {
    const res = await globalThis.fetch(config.clickhouseUrl, {
      method: 'POST',
      body: `${sql}\nFORMAT TabSeparatedWithNames\nSETTINGS readonly=1`,
      signal: AbortSignal.timeout(CH_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text()
      return `ClickHouse error (${res.status}):\n${body.slice(0, 1000)}`
    }

    const body = await res.text()
    if (!body.trim()) {
      return 'Query returned no results.'
    }

    // Format as markdown table
    const lines = body.trim().split('\n')
    if (lines.length < 1) return 'Empty result.'

    const headers = lines[0].split('\t')
    let text = `| ${headers.join(' | ')} |\n`
    text += `| ${headers.map(() => '---').join(' | ')} |\n`

    for (let i = 1; i < lines.length && i <= 50; i++) {
      const cols = lines[i].split('\t')
      text += `| ${cols.join(' | ')} |\n`
    }

    if (lines.length > 51) {
      text += `\n(showing 50 of ${lines.length - 1} rows)\n`
    }

    return text
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `ClickHouse connection error: ${msg}`
  }
}

// ---------------------------------------------------------------------------
// dev_data_summary — row counts, time ranges, tenant list
// ---------------------------------------------------------------------------

export async function devDataSummary(config: DevToolsConfig): Promise<string> {
  const sql = `
SELECT
    'log_metadata' AS table_name,
    count() AS row_count,
    min(timestamp) AS min_time,
    max(timestamp) AS max_time,
    uniqExact(tenant_id) AS tenants,
    uniqExact(service) AS services
FROM logweave.log_metadata

UNION ALL

SELECT
    'template_stats' AS table_name,
    count() AS row_count,
    min(interval_start) AS min_time,
    max(interval_start) AS max_time,
    uniqExact(tenant_id) AS tenants,
    0 AS services
FROM logweave.template_stats

UNION ALL

SELECT
    'service_stats' AS table_name,
    count() AS row_count,
    min(interval_start) AS min_time,
    max(interval_start) AS max_time,
    uniqExact(tenant_id) AS tenants,
    uniqExact(service) AS services
FROM logweave.service_stats

UNION ALL

SELECT
    'template_registry' AS table_name,
    count() AS row_count,
    min(first_seen) AS min_time,
    max(first_seen) AS max_time,
    uniqExact(tenant_id) AS tenants,
    0 AS services
FROM logweave.template_registry FINAL

UNION ALL

SELECT
    'deploys' AS table_name,
    count() AS row_count,
    min(timestamp) AS min_time,
    max(timestamp) AS max_time,
    uniqExact(tenant_id) AS tenants,
    uniqExact(service) AS services
FROM logweave.deploys
`

  try {
    const res = await globalThis.fetch(config.clickhouseUrl, {
      method: 'POST',
      body: `${sql.trim()}\nFORMAT TabSeparatedWithNames`,
      signal: AbortSignal.timeout(CH_TIMEOUT_MS),
    })

    if (!res.ok) {
      const body = await res.text()
      return `ClickHouse error: ${body.slice(0, 500)}`
    }

    const body = await res.text()
    const lines = body.trim().split('\n')

    let text = '## Data Summary\n\n'
    text += '| Table | Rows | First Data | Last Data | Tenants | Services |\n'
    text += '| --- | --- | --- | --- | --- | --- |\n'

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t')
      text += `| ${cols.join(' | ')} |\n`
    }

    // Also get level distribution
    const levelRes = await globalThis.fetch(config.clickhouseUrl, {
      method: 'POST',
      body: "SELECT level, count() AS cnt FROM logweave.log_metadata GROUP BY level ORDER BY cnt DESC\nFORMAT TabSeparatedWithNames",
      signal: AbortSignal.timeout(CH_TIMEOUT_MS),
    })

    if (levelRes.ok) {
      const levelBody = await levelRes.text()
      const levelLines = levelBody.trim().split('\n')
      text += '\n### Log Levels\n\n'
      for (let i = 1; i < levelLines.length; i++) {
        const [level, count] = levelLines[i].split('\t')
        text += `- ${level || '(empty)'}: ${count}\n`
      }
    }

    return text
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return `ClickHouse connection error: ${msg}`
  }
}
