import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { LogWeaveClient } from '../src/client.js'
import { registerPatterns } from '../src/registrations/patterns.js'
import { TEMPLATE_TEXT_MAX, truncate } from '../src/shared/handler.js'

// Capture each registered tool's name and inputSchema (a ZodRawShape) so we can
// validate the schema constraints the model is actually offered.
function captureTools(): {
  server: McpServer
  schemas: Map<string, z.ZodRawShape>
} {
  const schemas = new Map<string, z.ZodRawShape>()
  const server = {
    registerTool(name: string, def: { inputSchema: z.ZodRawShape }) {
      schemas.set(name, def.inputSchema)
    },
  } as unknown as McpServer
  return { server, schemas }
}

const fakeClient = {} as LogWeaveClient

describe('truncate helper', () => {
  it('leaves short text unchanged', () => {
    assert.equal(truncate('hello'), 'hello')
  })

  it('truncates over-long text and appends an ellipsis', () => {
    const long = 'x'.repeat(TEMPLATE_TEXT_MAX + 50)
    const out = truncate(long)
    assert.equal(out.length, TEMPLATE_TEXT_MAX + 1) // +1 for the ellipsis char
    assert.ok(out.endsWith('…'))
    assert.equal(out.slice(0, TEMPLATE_TEXT_MAX), 'x'.repeat(TEMPLATE_TEXT_MAX))
  })

  it('coerces nullish to empty string', () => {
    assert.equal(truncate(undefined), '')
    assert.equal(truncate(null), '')
  })
})

describe('error_patterns / search_templates limit clamp', () => {
  const { server, schemas } = captureTools()
  registerPatterns(server, fakeClient)

  for (const tool of ['error_patterns', 'search_templates']) {
    it(`${tool} rejects limit above 100`, () => {
      const shape = schemas.get(tool)
      assert.ok(shape, `${tool} should be registered`)
      const result = z.object(shape).safeParse(
        tool === 'search_templates' ? { query: 'error', limit: 999 } : { limit: 999 },
      )
      assert.equal(result.success, false, 'limit=999 must be rejected')
    })

    it(`${tool} accepts limit at the 100 ceiling`, () => {
      const shape = schemas.get(tool)
      assert.ok(shape)
      const result = z.object(shape).safeParse(
        tool === 'search_templates' ? { query: 'error', limit: 100 } : { limit: 100 },
      )
      assert.equal(result.success, true)
    })

    it(`${tool} allows limit to be omitted`, () => {
      const shape = schemas.get(tool)
      assert.ok(shape)
      const result = z.object(shape).safeParse(
        tool === 'search_templates' ? { query: 'error' } : {},
      )
      assert.equal(result.success, true)
    })
  }
})

describe('other patterns tools enforce their documented limit ceilings', () => {
  const { server, schemas } = captureTools()
  registerPatterns(server, fakeClient)

  it('template_events rejects limit above 100', () => {
    const shape = schemas.get('template_events')
    assert.ok(shape)
    const result = z.object(shape).safeParse({ template_id: 't1', limit: 101 })
    assert.equal(result.success, false)
  })

  it('search_by_tag rejects limit above 200', () => {
    const shape = schemas.get('search_by_tag')
    assert.ok(shape)
    const result = z.object(shape).safeParse({ key: 'k', value: 'v', limit: 201 })
    assert.equal(result.success, false)
  })

  it('search_by_tag accepts limit at its 200 ceiling', () => {
    const shape = schemas.get('search_by_tag')
    assert.ok(shape)
    const result = z.object(shape).safeParse({ key: 'k', value: 'v', limit: 200 })
    assert.equal(result.success, true)
  })
})
