import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { LogWeaveClient } from '../src/client.js'
import { registerInsights } from '../src/registrations/insights.js'
import { escapeCell } from '../src/shared/handler.js'

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}>

interface GetCall {
  path: string
  params?: Record<string, unknown>
}

type Responder = unknown | ((params?: Record<string, unknown>) => unknown)

// Capture each registered tool's handler so we can invoke it directly.
function captureHandlers(): { server: McpServer; handlers: Map<string, ToolHandler> } {
  const handlers = new Map<string, ToolHandler>()
  const server = {
    registerTool(name: string, _def: unknown, handler: ToolHandler) {
      handlers.set(name, handler)
    },
  } as unknown as McpServer
  return { server, handlers }
}

// Mock client that records every get() and returns canned data keyed by path
// (exact match first, then prefix match for templated paths like /services/x/outlier).
function mockClient(responses: Record<string, Responder>): {
  client: LogWeaveClient
  calls: GetCall[]
} {
  const calls: GetCall[] = []
  const resolve = (path: string): Responder | undefined => {
    if (path in responses) return responses[path]
    for (const key of Object.keys(responses)) {
      if (path.startsWith(key)) return responses[key]
    }
    return undefined
  }
  const client = {
    async get(path: string, params?: Record<string, unknown>) {
      calls.push({ path, params })
      const r = resolve(path)
      if (r === undefined) return { data: [], meta: {} }
      return typeof r === 'function' ? (r as (p?: Record<string, unknown>) => unknown)(params) : r
    },
  } as unknown as LogWeaveClient
  return { client, calls }
}

describe('escapeCell', () => {
  it('escapes pipes so a cell cannot start a new column', () => {
    assert.equal(escapeCell('a | b'), 'a \\| b')
  })

  it('replaces newlines with spaces so a cell cannot end the row', () => {
    assert.equal(escapeCell('line1\nline2'), 'line1 line2')
    assert.equal(escapeCell('line1\r\nline2'), 'line1 line2')
  })

  it('coerces nullish to empty string', () => {
    assert.equal(escapeCell(undefined), '')
    assert.equal(escapeCell(null), '')
  })
})

describe('incident_postmortem window consistency', () => {
  it('uses a single since-derived window for every sub-query when since is provided', async () => {
    const { server, handlers } = captureHandlers()
    const { client, calls } = mockClient({
      '/deploys': { data: [], meta: {} },
      '/dashboard/changes': { data: {}, meta: {} },
      '/services/': { data: {}, meta: {} },
      '/dashboard/templates': { data: [], meta: {} },
      '/dashboard/anomaly-state': { data: null },
    })
    registerInsights(server, client)

    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    await (handlers.get('incident_postmortem') as ToolHandler)({ service: 'api', since })

    const changesCall = calls.find((c) => c.path === '/dashboard/changes')
    const outlierCall = calls.find((c) => c.path.startsWith('/services/'))
    const templatesCall = calls.find((c) => c.path === '/dashboard/templates')

    assert.ok(changesCall && outlierCall && templatesCall, 'all three sub-queries should fire')
    assert.equal(changesCall.params?.since, since, 'changes is anchored to since')

    const outlierHours = outlierCall.params?.hours as number
    const templatesHours = templatesCall.params?.hours as number
    const changesHours = changesCall.params?.hours as number
    assert.equal(outlierHours, templatesHours, 'outlier and templates share one window')
    assert.equal(outlierHours, changesHours, 'changes shares the same window length')
    assert.ok(
      outlierHours > 2,
      `window should be derived from since (~6h), not the 2h default; got ${outlierHours}`,
    )
  })

  it('falls back to the default 2h window for every sub-query when since is absent', async () => {
    const { server, handlers } = captureHandlers()
    const { client, calls } = mockClient({
      '/deploys': { data: [], meta: {} },
      '/dashboard/changes': { data: {}, meta: {} },
      '/services/': { data: {}, meta: {} },
      '/dashboard/templates': { data: [], meta: {} },
      '/dashboard/anomaly-state': { data: null },
    })
    registerInsights(server, client)

    await (handlers.get('incident_postmortem') as ToolHandler)({ service: 'api' })

    const outlierCall = calls.find((c) => c.path.startsWith('/services/'))
    const templatesCall = calls.find((c) => c.path === '/dashboard/templates')
    assert.equal(outlierCall?.params?.hours, 2)
    assert.equal(templatesCall?.params?.hours, 2)
  })
})

describe('compare_periods', () => {
  it('requests both windows with a matched explicit limit so classification is symmetric', async () => {
    const { server, handlers } = captureHandlers()
    const { client, calls } = mockClient({ '/dashboard/templates': { data: [] } })
    registerInsights(server, client)

    await (handlers.get('compare_periods') as ToolHandler)({
      service: 'api',
      recent_hours: 2,
      baseline_hours: 2,
    })

    const templateCalls = calls.filter((c) => c.path === '/dashboard/templates')
    assert.equal(templateCalls.length, 2, 'fetches the combined and recent windows')
    for (const c of templateCalls) {
      assert.equal(c.params?.limit, 500, 'both windows use the same high limit')
    }
  })

  it('escapes pipe characters in changed-pattern table cells', async () => {
    const { server, handlers } = captureHandlers()
    const { client } = mockClient({
      '/dashboard/templates': (params) =>
        (params?.hours as number) === 4
          ? { data: [{ templateId: 't1', template: 'has | pipe', count: 110, service: 'api' }] }
          : { data: [{ templateId: 't1', template: 'has | pipe', count: 100, service: 'api' }] },
    })
    registerInsights(server, client)

    const res = await (handlers.get('compare_periods') as ToolHandler)({
      service: 'api',
      recent_hours: 2,
      baseline_hours: 2,
    })
    const text = res.content[0]?.text ?? ''

    assert.ok(text.includes('## Significant Changes'), 'should render the changes table')
    assert.ok(text.includes('has \\| pipe'), 'pipe in the template should be escaped')
  })
})
