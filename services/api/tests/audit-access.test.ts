import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../src/db/client.js'
import { createAccessAuditMiddleware } from '../src/middleware/audit-access.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'

const KEY_A = 'key-a'
const TENANT_A = 'tenant-a'
const keyMap = new Map([[KEY_A, TENANT_A]])

interface CapturedCommand {
  query: string
  query_params: Record<string, unknown>
}

function auditRows(commands: CapturedCommand[]): Record<string, unknown>[] {
  return commands.filter((c) => c.query.includes('audit_log')).map((c) => c.query_params)
}

// The middleware lives inside the router mounted at /v1, so req.path is
// mount-relative — the test reproduces that by mounting the router at /v1.
function createTestApp() {
  const logger = pino({ level: 'silent' })
  const commands: CapturedCommand[] = []
  const db = {
    query: async () => [],
    insert: async () => {},
    command: async (params: CapturedCommand) => {
      commands.push(params)
    },
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient

  const app = express()
  app.use(express.json())
  const v1 = express.Router()
  v1.use(createAuthMiddleware(keyMap))
  v1.use(createAccessAuditMiddleware({ db, logger }))
  v1.put('/settings', (_req, res) => res.json({ ok: true }))
  v1.post('/connectors', (_req, res) => res.status(201).json({ ok: true }))
  v1.post('/connectors/abc/test', (_req, res) => res.json({ ok: true }))
  v1.post('/deploys', (_req, res) => res.status(201).json({ ok: true }))
  v1.post('/settings/bad', (_req, res) => res.status(400).json({ error: 'bad' }))
  v1.post('/settings-export', (_req, res) => res.status(201).json({ ok: true }))
  // A rules route that does NOT self-audit — proves the middleware no longer
  // carries rule.* patterns (rule auditing moved to the route handler).
  v1.post('/rules', (_req, res) => res.status(201).json({ ok: true }))
  v1.get('/settings', (_req, res) => res.json({ ok: true }))
  app.use('/v1', v1)
  return { app, commands }
}

describe('createAccessAuditMiddleware', () => {
  it('audits a settings mutation despite req.path being mount-relative', async () => {
    const { app, commands } = createTestApp()
    await request(app).put('/v1/settings').set('Authorization', `Bearer ${KEY_A}`).send({ a: 1 })
    await delay(0)

    const rows = auditRows(commands)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.action, 'settings.update')
    assert.equal(rows[0]?.tenant_id, TENANT_A)
  })

  it('audits connector and deploy mutations', async () => {
    const { app, commands } = createTestApp()
    await request(app).post('/v1/connectors').set('Authorization', `Bearer ${KEY_A}`).send({})
    await request(app).post('/v1/deploys').set('Authorization', `Bearer ${KEY_A}`).send({})
    await delay(0)

    const actions = auditRows(commands).map((r) => r.action)
    assert.ok(actions.includes('connector.create'))
    assert.ok(actions.includes('deploy.create'))
  })

  it('does not audit GET requests', async () => {
    const { app, commands } = createTestApp()
    await request(app).get('/v1/settings').set('Authorization', `Bearer ${KEY_A}`)
    await delay(0)

    assert.equal(auditRows(commands).length, 0)
  })

  it('does not audit failed (4xx) mutations', async () => {
    const { app, commands } = createTestApp()
    await request(app).post('/v1/settings/bad').set('Authorization', `Bearer ${KEY_A}`).send({})
    await delay(0)

    assert.equal(auditRows(commands).length, 0)
  })

  it('does not audit rule mutations (handled explicitly in routes)', async () => {
    // The middleware no longer carries rule.* patterns, so a POST /v1/rules must
    // produce no middleware audit row (the route handler audits explicitly).
    const { app, commands } = createTestApp()
    await request(app).post('/v1/rules').set('Authorization', `Bearer ${KEY_A}`).send({})
    await delay(0)

    assert.equal(auditRows(commands).length, 0)
  })

  it('does not audit connection-test endpoints (…/test)', async () => {
    const { app, commands } = createTestApp()
    await request(app)
      .post('/v1/connectors/abc/test')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({})
    await delay(0)

    assert.equal(auditRows(commands).length, 0)
  })

  it('does not match a sibling route via substring (settings-export)', async () => {
    const { app, commands } = createTestApp()
    await request(app).post('/v1/settings-export').set('Authorization', `Bearer ${KEY_A}`).send({})
    await delay(0)

    assert.equal(auditRows(commands).length, 0)
  })
})
