#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { LogWeaveClient } from './client.js'
import { registerChanges } from './registrations/changes.js'
import { registerCorrelations } from './registrations/correlations.js'
import { registerInsights } from './registrations/insights.js'
import { registerOverview } from './registrations/overview.js'
import { registerPatterns } from './registrations/patterns.js'
import { registerRaw } from './registrations/raw.js'
import { registerRules } from './registrations/rules.js'
import { VERSION } from './version.js'

// Fail fast on missing env vars. stderr only — stdout is the JSON-RPC stream.

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
  version: VERSION,
})

registerOverview(server, client)
registerPatterns(server, client)
registerCorrelations(server, client)
registerChanges(server, client)
registerRaw(server, client)
registerRules(server, client)
registerInsights(server, client)

if (process.env.LOGWEAVE_DEV === 'true') {
  // Dev tools bypass tenant scoping and are excluded from the published build.
  // Load them dynamically via a non-literal specifier so the prod bundle never
  // references the module, and only after the multi-tenant guard inside passes.
  const devModule = './registrations/dev.js'
  try {
    const dev = (await import(devModule)) as {
      registerDev: (
        server: McpServer,
        config: { clickhouseUrl: string; clustererUrl: string; apiUrl: string },
      ) => Promise<boolean>
    }
    const registered = await dev.registerDev(server, {
      clickhouseUrl: process.env.LOGWEAVE_CLICKHOUSE_URL ?? 'http://localhost:8123',
      clustererUrl: process.env.LOGWEAVE_CLUSTERER_URL ?? 'http://localhost:8000',
      apiUrl,
    })
    if (registered) {
      process.stderr.write('Dev mode enabled — 3 diagnostic tools registered\n')
    }
  } catch (err) {
    process.stderr.write(
      `Dev tools unavailable in this build: ${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
}

async function main() {
  // Health check before accepting connections — tools still return errors
  // gracefully if the API is down, but the readiness signal on stderr now
  // reflects real backend state instead of always firing on connect.
  try {
    await client.healthCheck()
    process.stderr.write('LogWeave API reachable\n')
  } catch (err) {
    process.stderr.write(
      `Warning: LogWeave API health check failed at ${apiUrl}: ${err instanceof Error ? err.message : String(err)}\n` +
        'Tools will return errors until the API is reachable.\n',
    )
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('LogWeave MCP server connected successfully\n')
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
