#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { LogWeaveClient } from './client.js'
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
// Configuration
// ---------------------------------------------------------------------------

const apiUrl = process.env.LOGWEAVE_API_URL
const apiKey = process.env.LOGWEAVE_API_KEY

if (!apiUrl) {
  console.error('LOGWEAVE_API_URL environment variable is required')
  process.exit(1)
}

if (!apiKey) {
  console.error('LOGWEAVE_API_KEY environment variable is required')
  process.exit(1)
}

const client = new LogWeaveClient({ apiUrl, apiKey })

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'logweave',
  version: '0.1.0',
})

// -- Tool: logweave_overview --
server.tool(
  'logweave_overview',
  'Get a system health overview: total events, error rate, service count, and top 5 error patterns. Use this to understand the current state of the system.',
  { hours: z.number().optional().describe('Time window in hours (default: 24, max: 720)') },
  async (args) => {
    const text = await logweaveOverview(client, args)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// -- Tool: logweave_error_patterns --
server.tool(
  'logweave_error_patterns',
  'List error patterns sorted by occurrence count. Shows template text, service, error count, and whether the pattern is new today. Use this to see what errors are happening.',
  {
    hours: z.number().optional().describe('Time window in hours (default: 24)'),
    service: z.string().optional().describe('Filter by service name'),
    limit: z.number().optional().describe('Max results (default: 100)'),
  },
  async (args) => {
    const text = await logweaveErrorPatterns(client, args)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// -- Tool: logweave_changes --
server.tool(
  'logweave_changes',
  'See what changed recently: new error patterns, spiking patterns, and resolved patterns. Can be anchored to a deploy timestamp or deploy ID. Use this after deploys or to understand what is different.',
  {
    hours: z.number().optional().describe('Time window in hours (default: 24)'),
    service: z.string().optional().describe('Filter by service name'),
    since: z.string().optional().describe('ISO8601 timestamp to anchor the comparison (e.g., deploy time)'),
    deploy_id: z.string().optional().describe('Deploy ID from logweave_deploys to anchor comparison'),
  },
  async (args) => {
    const text = await logweaveChanges(client, args)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// -- Tool: logweave_template_detail --
server.tool(
  'logweave_template_detail',
  'Deep dive on a specific error pattern: occurrence history, status codes, affected services, anomaly score. Use a template_id from logweave_error_patterns or logweave_changes.',
  {
    template_id: z.string().describe('Template ID to look up'),
    hours: z.number().optional().describe('Time window in hours (default: 24)'),
  },
  async (args) => {
    const text = await logweaveTemplateDetail(client, args)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// -- Tool: logweave_service_health --
server.tool(
  'logweave_service_health',
  'Health report for a specific service: error rate, log volume, top error patterns, and volume trend. Use this to check if a specific service is having problems.',
  {
    service: z.string().describe('Service name to check'),
    hours: z.number().optional().describe('Time window in hours (default: 24)'),
  },
  async (args) => {
    const text = await logweaveServiceHealth(client, args)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// -- Tool: logweave_search_templates --
server.tool(
  'logweave_search_templates',
  'Search for error patterns by text. Use this to find patterns related to a specific topic (e.g., "timeout", "database", "connection refused").',
  {
    query: z.string().describe('Search text (min 3 characters)'),
    hours: z.number().optional().describe('Time window in hours (default: 24)'),
    limit: z.number().optional().describe('Max results (default: 100)'),
  },
  async (args) => {
    const text = await logweaveSearchTemplates(client, args)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// -- Tool: logweave_deploys --
server.tool(
  'logweave_deploys',
  'List recent deployments. Use this to find deploy IDs and timestamps for anchoring logweave_changes queries.',
  {
    service: z.string().optional().describe('Filter by service name'),
    limit: z.number().optional().describe('Max results (default: 10)'),
  },
  async (args) => {
    const text = await logweaveDeploys(client, args)
    return { content: [{ type: 'text' as const, text }] }
  },
)

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
  // Verify API is reachable before accepting connections
  try {
    await client.healthCheck()
  } catch (err) {
    console.error(`Failed to connect to LogWeave API at ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
