import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import cookieParser from 'cookie-parser'
import express, { Router } from 'express'
import pino from 'pino'
import request from 'supertest'
import { HmacSessionProvider, SESSION_COOKIE_NAME } from '../src/auth/session.js'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { deployRoutes } from '../src/routes/deploys.js'
import { ruleRoutes } from '../src/routes/rules.js'
import { settingsRoutes } from '../src/routes/settings.js'
import { tailRoutes } from '../src/routes/tail.js'
import { watchRoutes } from '../src/routes/watches.js'
import { TailBuffer } from '../src/tail/buffer.js'
import { TailTokenStore } from '../src/tail/token-store.js'
import { RuleStore } from '../src/watches/rule-store.js'
import { TenantSettingsStore } from '../src/watches/tenant-settings.js'
import { WatchStore } from '../src/watches/watch-store.js'
import { createMockDb } from './helpers/mock-db.js'

// LW-281 F1 regression. The admin write-gate used to be a router-level
// `router.use(requireAdminForWrites)` on the watches/rules/settings/deploys
// routers. Those routers are mounted PATH-LESS under /v1 (`v1.use(watchRoutes())`),
// so in Express their router-level middleware runs for EVERY /v1 request — not
// just their own routes. The result: a viewer's `POST /v1/tail/token` (the SSE
// token exchange the dashboard live-tail calls) was 403'd before it ever reached
// the tail router, because it first entered the path-less watches router and hit
// its admin gate. This test pins the mount order from app.ts and asserts the gate
// is scoped to the actual write routes, not leaked onto sibling routes.

const KEY_A = 'key-a'
const TENANT_A = 'tenant-a'
const keyMap = new Map([[KEY_A, TENANT_A]])

const SESSION_KEY = Buffer.alloc(32, 0x42)
const sessionProvider = new HmacSessionProvider(SESSION_KEY)

function viewerCookie(): string {
  return sessionProvider.createSession({
    userId: 'viewer-1',
    tenantId: TENANT_A,
    role: 'viewer',
    sessionVersion: 1,
  })
}

// Mirror app.ts: the four admin-gated routers are mounted path-less and BEFORE
// the tail router, so this reproduces the exact ordering the regression depends on.
function createTestApp() {
  const logger = pino({ level: 'silent' })
  const db = createMockDb()
  const settingsStore = new TenantSettingsStore()
  const tailTokenStore = new TailTokenStore()

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  const v1 = Router()
  v1.use(createAuthMiddleware(new Map(keyMap), sessionProvider))
  v1.use(watchRoutes({ watchStore: new WatchStore(), db, logger }))
  v1.use(ruleRoutes({ ruleStore: new RuleStore(), db, logger }))
  v1.use(settingsRoutes({ settingsStore, db, logger }))
  v1.use(deployRoutes({ db, logger }))
  v1.use(
    tailRoutes({
      tailBuffer: new TailBuffer({ bufferSize: 100 }),
      settingsStore,
      tailTokenStore,
      db,
      logger,
    }),
  )
  app.use('/v1', v1)
  app.use(createErrorHandler(logger))
  return app
}

describe('admin write-gate is scoped per route, not leaked across path-less routers (LW-281 F1)', () => {
  it('allows a viewer to POST /tail/token (was 403 before the fix)', async () => {
    const res = await request(createTestApp())
      .post('/v1/tail/token')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${viewerCookie()}`)

    assert.equal(res.status, 200)
    assert.ok(res.body.data.token, 'viewer receives an SSE token')
  })

  it('still 403s a viewer on a genuine admin write (POST /rules)', async () => {
    const res = await request(createTestApp())
      .post('/v1/rules')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${viewerCookie()}`)
      .send({
        name: 'x',
        ruleType: 'threshold',
        config: {
          metric: 'error_count',
          service: 'svc',
          operator: '>',
          value: 1,
          windowMinutes: 5,
        },
      })

    assert.equal(res.status, 403)
    assert.equal(res.body.error.code, 'FORBIDDEN')
  })

  it('still 403s a viewer on POST /watches', async () => {
    const res = await request(createTestApp())
      .post('/v1/watches')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${viewerCookie()}`)
      .send({ templateId: 'tmpl-1' })

    assert.equal(res.status, 403)
  })

  it('still lets a viewer read GET /rules', async () => {
    const res = await request(createTestApp())
      .get('/v1/rules')
      .set('Cookie', `${SESSION_COOKIE_NAME}=${viewerCookie()}`)

    assert.equal(res.status, 200)
  })

  it('lets an admin API key POST /tail/token', async () => {
    const res = await request(createTestApp())
      .post('/v1/tail/token')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.ok(res.body.data.token)
  })
})
