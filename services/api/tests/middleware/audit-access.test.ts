import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Request, Response } from 'express'
import type pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { createAccessAuditMiddleware } from '../../src/middleware/audit-access.js'

interface RecordedCommand {
  query: string
  params: Record<string, unknown>
}

function recordingDb(): { db: DbClient; commands: RecordedCommand[] } {
  const commands: RecordedCommand[] = []
  const db = {
    query: async () => [],
    insert: async () => {},
    command: async (arg: { query: string; query_params?: Record<string, unknown> }) => {
      commands.push({ query: arg.query, params: arg.query_params ?? {} })
    },
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, commands }
}

const noopLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as pino.Logger

function makeReq(method: string, originalUrl: string): Request {
  return { method, originalUrl, ip: '203.0.113.5' } as unknown as Request
}

// A minimal Response that captures the 'finish' listener so the test can fire it.
function makeRes(
  statusCode: number,
  locals: Record<string, unknown> = { tenantId: 't-1', keyId: 'k-1' },
): Response & { fireFinish: () => void } {
  let finishCb: (() => void) | undefined
  const res = {
    statusCode,
    locals,
    on(event: string, cb: () => void) {
      if (event === 'finish') finishCb = cb
      return res
    },
    fireFinish() {
      finishCb?.()
    },
  }
  return res as unknown as Response & { fireFinish: () => void }
}

// Run the middleware end-to-end: register, assert next() was called, fire finish,
// then let the fire-and-forget insert settle.
async function runMiddleware(
  db: DbClient,
  req: Request,
  res: Response & { fireFinish: () => void },
): Promise<void> {
  const mw = createAccessAuditMiddleware({ db, logger: noopLogger })
  let nextCalled = false
  mw(req, res, () => {
    nextCalled = true
  })
  assert.equal(nextCalled, true, 'middleware must always call next()')
  res.fireFinish()
  // The middleware fires the insert without awaiting it; settle the microtask.
  await Promise.resolve()
  await Promise.resolve()
}

describe('createAccessAuditMiddleware — audited mutations', () => {
  const cases: Array<{ method: string; url: string; status: number; action: string }> = [
    { method: 'POST', url: '/v1/ingest', status: 200, action: 'ingest' },
    { method: 'PUT', url: '/v1/settings', status: 200, action: 'settings.update' },
    { method: 'POST', url: '/v1/settings', status: 200, action: 'settings.update' },
    { method: 'POST', url: '/v1/connectors', status: 201, action: 'connector.create' },
    { method: 'DELETE', url: '/v1/connectors/abc-123', status: 200, action: 'connector.delete' },
    { method: 'POST', url: '/v1/deploys', status: 200, action: 'deploy.create' },
  ]

  for (const c of cases) {
    it(`audits ${c.method} ${c.url} with action "${c.action}"`, async () => {
      const { db, commands } = recordingDb()
      await runMiddleware(db, makeReq(c.method, c.url), makeRes(c.status))

      assert.equal(commands.length, 1, 'exactly one audit insert')
      const { params } = commands[0] as RecordedCommand
      assert.equal(params.action, c.action)
      assert.equal(params.tenant_id, 't-1')
      assert.equal(params.key_id, 'k-1')
      assert.equal(params.source_ip, '203.0.113.5')
      assert.equal(params.details, `${c.method} ${c.url}`)
    })
  }

  it('strips the query string from the audited details path', async () => {
    const { db, commands } = recordingDb()
    await runMiddleware(db, makeReq('POST', '/v1/deploys?dry_run=1'), makeRes(200))

    assert.equal(commands.length, 1)
    assert.equal((commands[0] as RecordedCommand).params.details, 'POST /v1/deploys')
  })
})

describe('createAccessAuditMiddleware — exclusions', () => {
  it('does not audit read-only methods', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const { db, commands } = recordingDb()
      await runMiddleware(db, makeReq(method, '/v1/settings'), makeRes(200))
      assert.equal(commands.length, 0, `${method} must not be audited`)
    }
  })

  it('does not audit failed (>=400) responses', async () => {
    const { db, commands } = recordingDb()
    await runMiddleware(db, makeReq('POST', '/v1/settings'), makeRes(422))
    assert.equal(commands.length, 0)
  })

  it('does not audit connection-test endpoints', async () => {
    const { db, commands } = recordingDb()
    await runMiddleware(db, makeReq('POST', '/v1/connectors/test'), makeRes(200))
    assert.equal(commands.length, 0)
  })

  it('does not audit paths with no matching pattern', async () => {
    const { db, commands } = recordingDb()
    await runMiddleware(db, makeReq('POST', '/v1/watches'), makeRes(200))
    assert.equal(commands.length, 0)
  })

  it('does not match a sibling route via substring (anchored patterns)', async () => {
    const { db, commands } = recordingDb()
    await runMiddleware(db, makeReq('POST', '/v1/settings-export'), makeRes(200))
    assert.equal(commands.length, 0, '/v1/settings-export must not inherit settings.update')
  })

  it('swallows missing auth context without throwing or auditing', async () => {
    const { db, commands } = recordingDb()
    // No tenantId/keyId in locals — getTenantId throws; middleware must catch it.
    await runMiddleware(db, makeReq('POST', '/v1/settings'), makeRes(200, {}))
    assert.equal(commands.length, 0)
  })
})
