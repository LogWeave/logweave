import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { LogWeaveClient } from '../src/client.js'
import { registerRules } from '../src/registrations/rules.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
type Handler = (args: Record<string, unknown>) => Promise<ToolResult>

// Capture the registered tool handlers so we can invoke create_rule directly.
function captureHandlers(client: LogWeaveClient): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server = {
    registerTool(name: string, _def: unknown, handler: Handler) {
      handlers.set(name, handler)
    },
  } as unknown as McpServer
  registerRules(server, client)
  return handlers
}

// Mock client that records POST bodies and returns a created-rule envelope.
function mockClient(): { client: LogWeaveClient; posts: Array<{ path: string; body: unknown }> } {
  const posts: Array<{ path: string; body: unknown }> = []
  const client = {
    async post(path: string, body: unknown) {
      posts.push({ path, body })
      return { data: { ruleId: 'r1', name: 'n', enabled: true, channels: [] }, meta: {} }
    },
  } as unknown as LogWeaveClient
  return { client, posts }
}

const TEMPLATE_ID = '0192f8a1-6c3e-7b21-9a4d-1f2e3d4c5b6a'

describe('create_rule template_watch validation', () => {
  it('rejects template_watch without template_text and does not POST', async () => {
    const { client, posts } = mockClient()
    const handler = captureHandlers(client).get('create_rule')
    assert.ok(handler)

    const res = await handler({
      name: 'watch OOM',
      rule_type: 'template_watch',
      template_id: TEMPLATE_ID,
    })

    assert.match(res.content[0]!.text, /template_text is required/i)
    assert.equal(posts.length, 0, 'must not call the API when a required field is missing')
  })

  it('rejects template_watch without template_id and does not POST', async () => {
    const { client, posts } = mockClient()
    const handler = captureHandlers(client).get('create_rule')
    assert.ok(handler)

    const res = await handler({
      name: 'watch OOM',
      rule_type: 'template_watch',
      template_text: 'Container <*> killed: out of memory',
    })

    assert.match(res.content[0]!.text, /template_id is required/i)
    assert.equal(posts.length, 0)
  })

  it('POSTs a valid template_watch rule with templateText in config', async () => {
    const { client, posts } = mockClient()
    const handler = captureHandlers(client).get('create_rule')
    assert.ok(handler)

    const res = await handler({
      name: 'watch OOM',
      rule_type: 'template_watch',
      template_id: TEMPLATE_ID,
      template_text: 'Container <*> killed: out of memory',
    })

    assert.equal(posts.length, 1)
    assert.equal(posts[0]!.path, '/rules')
    const body = posts[0]!.body as { ruleType: string; config: Record<string, unknown> }
    assert.equal(body.ruleType, 'template_watch')
    assert.equal(body.config.templateId, TEMPLATE_ID)
    assert.equal(body.config.templateText, 'Container <*> killed: out of memory')
    assert.match(res.content[0]!.text, /Rule Created/i)
  })
})

describe('create_rule threshold validation', () => {
  it('POSTs a valid threshold rule mapping window_minutes → windowMinutes', async () => {
    const { client, posts } = mockClient()
    const handler = captureHandlers(client).get('create_rule')
    assert.ok(handler)

    await handler({
      name: 'payments error spike',
      rule_type: 'threshold',
      metric: 'error_count',
      service: 'payments-api',
      operator: '>',
      value: 10,
      window_minutes: 5,
    })

    assert.equal(posts.length, 1)
    const body = posts[0]!.body as { ruleType: string; config: Record<string, unknown> }
    assert.equal(body.ruleType, 'threshold')
    assert.equal(body.config.windowMinutes, 5)
    assert.equal(body.config.metric, 'error_count')
  })

  it('rejects a threshold rule missing window_minutes', async () => {
    const { client, posts } = mockClient()
    const handler = captureHandlers(client).get('create_rule')
    assert.ok(handler)

    const res = await handler({
      name: 'payments error spike',
      rule_type: 'threshold',
      metric: 'error_count',
      service: 'payments-api',
      operator: '>',
      value: 10,
    })

    assert.match(res.content[0]!.text, /window_minutes is required/i)
    assert.equal(posts.length, 0)
  })
})
