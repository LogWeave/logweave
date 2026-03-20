#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { LogWeaveClient } from './client.js'
import { type DevToolsConfig, devDataSummary, devHealth, devQuery } from './dev-tools.js'
import {
  logweaveChanges,
  logweaveDeploys,
  logweaveErrorPatterns,
  logweaveOverview,
  logweaveSearchTemplates,
  logweaveServiceHealth,
  logweaveTemplateDetail,
} from './tools.js'

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

// ---------------------------------------------------------------------------
// Helper: wrap tool handler with try/catch → isError response
// Never throws — tool errors are returned as isError: true so the LLM can
// recover (retry, adjust params, inform user) instead of crashing the server.
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

function toolHandler(
  fn: (args: Record<string, unknown>) => Promise<string>,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      const text = await fn(args)
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared annotations
// ---------------------------------------------------------------------------

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const WRITE_OP = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

// ---------------------------------------------------------------------------
// MCP Server — uses registerTool (modern API, server.tool is deprecated)
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'logweave',
  version: '0.1.0',
})

server.registerTool(
  'overview',
  {
    title: 'System Overview',
    description:
      'Get a system health overview: total events, error rate, service count, and top error patterns. ' +
      'Use this first to understand the current state of the system. ' +
      'Do not use for specific service or template queries — use service_health or template_detail instead.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24, max: 720)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) => logweaveOverview(client, args as { hours?: number })),
)

server.registerTool(
  'error_patterns',
  {
    title: 'Error Patterns',
    description:
      'List error patterns sorted by occurrence count. Only shows templates with actual errors (level=error). ' +
      'Shows template text, service, error count, and whether the pattern is new today. ' +
      'Use this to see what errors are happening across all services. For a single service, pass the service parameter.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
      service: z.string().optional().describe('Filter to a specific service name'),
      limit: z.number().optional().describe('Max results to return (default: 100)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveErrorPatterns(client, args as { hours?: number; service?: string; limit?: number }),
  ),
)

server.registerTool(
  'changes',
  {
    title: 'Recent Changes',
    description:
      'See what changed recently: new error patterns, spiking patterns, and resolved patterns. ' +
      'Anchor to a deploy using since (ISO8601 timestamp) or deploy_id from deploys tool. ' +
      'Use this after deploys or to understand what is different from normal. ' +
      'Do not use for listing all errors — use error_patterns instead.',
    inputSchema: {
      hours: z.number().optional().describe('Time window in hours (default: 24). Ignored if since or deploy_id is set.'),
      service: z.string().optional().describe('Filter to a specific service name'),
      since: z.string().optional().describe('ISO8601 timestamp to anchor comparison (e.g. deploy time)'),
      deploy_id: z.string().optional().describe('Deploy ID from logweave_deploys to anchor comparison'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveChanges(client, args as { hours?: number; service?: string; since?: string; deploy_id?: string }),
  ),
)

server.registerTool(
  'template_detail',
  {
    title: 'Template Detail',
    description:
      'Deep dive on a specific error pattern: occurrence history, status codes, affected services, anomaly score. ' +
      'Use a template_id from error_patterns or changes results. ' +
      'Do not use without a template_id.',
    inputSchema: {
      template_id: z.string().describe('Template ID to look up (from error_patterns or changes results)'),
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveTemplateDetail(client, args as { template_id: string; hours?: number }),
  ),
)

server.registerTool(
  'service_health',
  {
    title: 'Service Health',
    description:
      'Health report for a specific service: error rate, log volume, top error patterns, and volume trend. ' +
      'Use this to check if a specific service is having problems. ' +
      'Do not use for cross-service overview — use overview instead.',
    inputSchema: {
      service: z.string().describe('Service name to check'),
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveServiceHealth(client, args as { service: string; hours?: number }),
  ),
)

server.registerTool(
  'search_templates',
  {
    title: 'Search Templates',
    description:
      'Search for error patterns by text (e.g. "timeout", "database", "connection refused"). Minimum 3 characters. ' +
      'Use this to find patterns related to a specific topic. Returns matching templates with occurrence counts and affected services.',
    inputSchema: {
      query: z.string().describe('Search text (minimum 3 characters)'),
      hours: z.number().optional().describe('Time window in hours (default: 24)'),
      limit: z.number().optional().describe('Max results to return (default: 100)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveSearchTemplates(client, args as { query: string; hours?: number; limit?: number }),
  ),
)

server.registerTool(
  'deploys',
  {
    title: 'Recent Deployments',
    description:
      'List recent deployments. Use this to find deploy IDs and timestamps for anchoring changes queries. ' +
      'Returns service name, version, commit SHA, and timestamp.',
    inputSchema: {
      service: z.string().optional().describe('Filter to a specific service name'),
      limit: z.number().optional().describe('Max results to return (default: 10)'),
    },
    annotations: READ_ONLY,
  },
  toolHandler((args) =>
    logweaveDeploys(client, args as { service?: string; limit?: number }),
  ),
)

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
