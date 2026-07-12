import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  countDistinctTenants,
  type DevToolsConfig,
  devDataSummary,
  devHealth,
  devQuery,
} from '../dev-tools.js'
import { READ_ONLY, toolHandler } from '../shared/handler.js'

/**
 * Register the dev-only diagnostic tools. Returns true if registered.
 *
 * These tools talk to ClickHouse directly and bypass tenant scoping, so this
 * refuses to register against any multi-tenant backend (and fails closed if the
 * tenant count can't be verified). The module itself is also excluded from the
 * published build (see tsconfig.build.json) — this guard protects dev/source
 * runs where the file is present.
 */
export async function registerDev(server: McpServer, config: DevToolsConfig): Promise<boolean> {
  let tenantCount: number
  try {
    tenantCount = await countDistinctTenants(config)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(
      `Dev tools: could not verify tenant count, refusing to register (${msg})\n`,
    )
    return false
  }
  if (tenantCount > 1) {
    process.stderr.write(
      `Dev tools refused: backend has ${tenantCount} tenants and these tools bypass tenant isolation\n`,
    )
    return false
  }

  server.registerTool(
    'dev_health',
    {
      title: '[Dev] Service Health Check',
      description:
        'Check if all LogWeave services are running (API, ClickHouse, Clusterer). ' +
        'Dev-only tool — not available in production.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    toolHandler(() => devHealth(config)),
  )

  server.registerTool(
    'dev_query',
    {
      title: '[Dev] ClickHouse Query',
      description:
        'Run a read-only SQL query against ClickHouse. Only SELECT, SHOW, DESCRIBE, EXPLAIN, and WITH are allowed. ' +
        'Results formatted as a markdown table (max 50 rows). Dev-only tool.',
      inputSchema: {
        sql: z.string().describe('SQL query to execute (SELECT only)'),
      },
      annotations: READ_ONLY,
    },
    toolHandler((args) => devQuery(config, args as { sql: string })),
  )

  server.registerTool(
    'dev_data_summary',
    {
      title: '[Dev] Data Summary',
      description:
        'Show row counts, time ranges, tenant counts, and log level distribution across all LogWeave tables. ' +
        'Use this to understand what data exists. Dev-only tool.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    toolHandler(() => devDataSummary(config)),
  )

  return true
}
