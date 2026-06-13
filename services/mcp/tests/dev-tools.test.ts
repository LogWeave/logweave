import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerDev } from '../src/registrations/dev.js'

const CONFIG = {
  clickhouseUrl: 'http://clickhouse.test',
  clustererUrl: 'http://clusterer.test',
  apiUrl: 'http://api.test',
}

// Minimal McpServer stub that records registered tool names.
function fakeServer(): { server: McpServer; tools: string[] } {
  const tools: string[] = []
  const server = {
    registerTool(name: string) {
      tools.push(name)
    },
  } as unknown as McpServer
  return { server, tools }
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function stubTenantCount(value: string | { status: number }): void {
  globalThis.fetch = (async () => {
    if (typeof value === 'object') {
      return { ok: false, status: value.status, statusText: 'err', text: async () => '' } as Response
    }
    return { ok: true, status: 200, statusText: 'OK', text: async () => value } as Response
  }) as typeof fetch
}

describe('registerDev multi-tenant guard', () => {
  it('refuses to register when the backend has more than one tenant', async () => {
    stubTenantCount('4')
    const { server, tools } = fakeServer()
    const registered = await registerDev(server, CONFIG)
    assert.equal(registered, false)
    assert.deepEqual(tools, [], 'no dev tools should be registered against multi-tenant backends')
  })

  it('registers the 3 diagnostic tools for a single-tenant backend', async () => {
    stubTenantCount('1')
    const { server, tools } = fakeServer()
    const registered = await registerDev(server, CONFIG)
    assert.equal(registered, true)
    assert.deepEqual(tools.sort(), ['dev_data_summary', 'dev_health', 'dev_query'])
  })

  it('registers for an empty backend (zero tenants)', async () => {
    stubTenantCount('0')
    const { server, tools } = fakeServer()
    const registered = await registerDev(server, CONFIG)
    assert.equal(registered, true)
    assert.equal(tools.length, 3)
  })

  it('fails closed (refuses) when the tenant count cannot be verified', async () => {
    stubTenantCount({ status: 500 })
    const { server, tools } = fakeServer()
    const registered = await registerDev(server, CONFIG)
    assert.equal(registered, false)
    assert.deepEqual(tools, [])
  })
})
