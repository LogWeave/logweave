#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { LogWeaveClient } from './client.js'
import { type DevToolsConfig, devDataSummary, devHealth, devQuery } from './dev-tools.js'
import { registerChanges } from './registrations/changes.js'
import { registerCorrelations } from './registrations/correlations.js'
import { registerInsights } from './registrations/insights.js'
import { registerOverview } from './registrations/overview.js'
import { registerPatterns } from './registrations/patterns.js'
import { registerRaw } from './registrations/raw.js'
import { registerRules } from './registrations/rules.js'
import { READ_ONLY, WRITE_OP, toolHandler } from './shared/handler.js'

// ---------------------------------------------------------------------------
// Configuration — fail fast on missing env vars (stderr only, never stdout)
// ---------------------------------------------------------------------------

const apiUrl = process.env.LOGWEAVE_API_URL
const apiKey = process.env.LOGWEAVE_API_KEY

if (!apiUrl) {
  process.stderr.write('Error: LOGWEAVE_API_URL environment variable is required\n')
  process.exit(1)
}

if (!apiKey) {
  process.stderr.write('Error: LOGWEAVE_API_KEY environment variable is required\n')
  process.exit(1)
}

const client = new LogWeaveClient({ apiUrl, apiKey })

const server = new McpServer({
  name: 'logweave',
  version: '0.1.0',
})

registerOverview(server, client)
registerPatterns(server, client)
registerCorrelations(server, client)
registerChanges(server, client)
registerRaw(server, client)
registerRules(server, client)
registerInsights(server, client)

// ---------------------------------------------------------------------------
// Correlation & analysis tools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Raw log drill-down
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// New tools from gap analysis (#113)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dev-only tools — registered when LOGWEAVE_DEV=true
// ---------------------------------------------------------------------------

const devMode = process.env.LOGWEAVE_DEV === 'true'

if (devMode) {
  const devConfig: DevToolsConfig = {
    clickhouseUrl: process.env.LOGWEAVE_CLICKHOUSE_URL ?? 'http://localhost:8123',
    clustererUrl: process.env.LOGWEAVE_CLUSTERER_URL ?? 'http://localhost:8000',
    apiUrl: apiUrl,
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
    toolHandler(() => devHealth(devConfig)),
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
    toolHandler((args) => devQuery(devConfig, args as { sql: string })),
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
    toolHandler(() => devDataSummary(devConfig)),
  )

  process.stderr.write('Dev mode enabled — 3 diagnostic tools registered\n')
}

// ---------------------------------------------------------------------------
// Startup — connect transport first, health check lazily
// stdout is the JSON-RPC stream — never write to it directly.
// All logging goes to stderr.
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)

  // Health check after connection (non-blocking — tools will return errors if API is down)
  try {
    await client.healthCheck()
    process.stderr.write('LogWeave MCP server connected successfully\n')
  } catch (err) {
    process.stderr.write(
      `Warning: LogWeave API health check failed at ${apiUrl}: ${err instanceof Error ? err.message : String(err)}\n` +
        'Tools will return errors until the API is reachable.\n',
    )
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
