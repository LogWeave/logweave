import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import type { DbClient } from '../../src/db/client.js'
import { createAuthMiddleware } from '../../src/middleware/auth.js'
import { createErrorHandler } from '../../src/middleware/error-handler.js'
import { ruleRoutes } from '../../src/routes/rules.js'
import { RuleStore } from '../../src/watches/rule-store.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY_A = 'key-a'
const KEY_B = 'key-b'
const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const keyMap = new Map([
  [KEY_A, TENANT_A],
  [KEY_B, TENANT_B],
])

const VALID_THRESHOLD_BODY = {
  name: 'High error rate',
  ruleType: 'threshold' as const,
  config: {
    metric: 'error_count',
    service: 'payment-service',
    operator: '>',
    value: 10,
    windowMinutes: 5,
  },
}

const VALID_TEMPLATE_WATCH_BODY = {
  name: 'Watch OOM pattern',
  ruleType: 'template_watch' as const,
  config: {
    templateId: 'tmpl-oom-1',
    templateText: 'Out of memory in <*>',
  },
}

// ---------------------------------------------------------------------------
// Mock DbClient
// ---------------------------------------------------------------------------

const mockAlertRows = [
  {
    alert_id: '019abc-alert-1',
    rule_id: 'rule-1',
    rule_type: 'threshold',
    rule_name: 'High errors',
    fired_at: '2026-03-20T14:32:00.000Z',
    metric_value: 15,
    threshold_value: 10,
    details: JSON.stringify({
      service: 'payment-service',
      metric: 'error_count',
      operator: '>',
      windowMinutes: 5,
    }),
    channels_notified: JSON.stringify(['https://hooks.slack.com/services/T00/B00/xxx']),
  },
  {
    alert_id: '019abc-alert-2',
    rule_id: 'rule-2',
    rule_type: 'spike',
    rule_name: 'Connection timeout in <*>',
    fired_at: '2026-03-20T10:00:00.000Z',
    metric_value: 3.5,
    threshold_value: 1.0,
    details: JSON.stringify({ service: 'api-gateway', currentCount: 42, baselineCount: 12 }),
    channels_notified: '[]',
  },
]

function createMockDb(queryResults?: unknown[]): DbClient {
  return {
    query: async () => queryResults ?? [],
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function createTestApp(opts?: { maxRules?: number; queryResults?: unknown[] }) {
  const logger = pino({ level: 'silent' })
  const ruleStore = new RuleStore({ maxPerTenant: opts?.maxRules })
  const db = createMockDb(opts?.queryResults)
  const app = express()
  app.use(express.json())
  const auth = createAuthMiddleware(new Map(keyMap))
  app.use('/v1', auth, ruleRoutes({ ruleStore, db, logger }))
  app.use(createErrorHandler(logger))
  return { app, ruleStore }
}

// ---------------------------------------------------------------------------
// POST /v1/rules
// ---------------------------------------------------------------------------

describe('POST /v1/rules', () => {
  it('creates a threshold rule, returns 201 with ruleId', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)

    assert.equal(res.status, 201)
    assert.ok(res.body.data.ruleId, 'should have ruleId')
    assert.equal(res.body.data.name, 'High error rate')
    assert.equal(res.body.data.ruleType, 'threshold')
    assert.equal(res.body.data.enabled, true)
    assert.deepEqual(res.body.data.channels, [])
    assert.ok(res.body.meta.fetchedAt)
    // Should not expose tenantId in response
    assert.equal(res.body.data.tenantId, undefined)
  })

  it('creates a template_watch rule, returns 201', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_TEMPLATE_WATCH_BODY)

    assert.equal(res.status, 201)
    assert.equal(res.body.data.ruleType, 'template_watch')
    assert.equal(res.body.data.config.templateId, 'tmpl-oom-1')
  })

  it('accepts channels array', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ ...VALID_THRESHOLD_BODY, channels: ['https://hooks.slack.com/services/T00/B00/xxx'] })

    assert.equal(res.status, 201)
    assert.deepEqual(res.body.data.channels, ['https://hooks.slack.com/services/T00/B00/xxx'])
  })

  it('defaults enabled to true', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)

    assert.equal(res.body.data.enabled, true)
  })

  it('accepts enabled=false', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ ...VALID_THRESHOLD_BODY, enabled: false })

    assert.equal(res.status, 201)
    assert.equal(res.body.data.enabled, false)
  })

  it('returns 400 for missing name', async () => {
    const { app } = createTestApp()
    const { name: _, ...noName } = VALID_THRESHOLD_BODY
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(noName)

    assert.equal(res.status, 400)
  })

  it('returns 400 for invalid ruleType', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ ...VALID_THRESHOLD_BODY, ruleType: 'invalid' })

    assert.equal(res.status, 400)
  })

  it('returns 400 for threshold rule with template_watch config', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        name: 'Bad config',
        ruleType: 'threshold',
        config: { templateId: 'tmpl-1', templateText: 'some text' },
      })

    assert.equal(res.status, 400)
  })

  it('returns 400 for invalid operator', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        ...VALID_THRESHOLD_BODY,
        config: { ...VALID_THRESHOLD_BODY.config, operator: '!=' },
      })

    assert.equal(res.status, 400)
  })

  it('returns 400 for non-positive threshold value', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        ...VALID_THRESHOLD_BODY,
        config: { ...VALID_THRESHOLD_BODY.config, value: 0 },
      })

    assert.equal(res.status, 400)
  })

  it('returns 400 for invalid channel URL', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ ...VALID_THRESHOLD_BODY, channels: ['not-a-url'] })

    assert.equal(res.status, 400)
  })

  it('returns 400 when rule limit exceeded', async () => {
    const { app } = createTestApp({ maxRules: 1 })
    await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)

    const res = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ ...VALID_THRESHOLD_BODY, name: 'Second rule' })

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'RULE_LIMIT_EXCEEDED')
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp()
    const res = await request(app).post('/v1/rules').send(VALID_THRESHOLD_BODY)

    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/rules
// ---------------------------------------------------------------------------

describe('GET /v1/rules', () => {
  it('returns empty array for new tenant', async () => {
    const { app } = createTestApp()
    const res = await request(app).get('/v1/rules').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
    assert.equal(res.body.meta.count, 0)
  })

  it('returns all rules for tenant', async () => {
    const { app } = createTestApp()
    await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)
    await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_TEMPLATE_WATCH_BODY)

    const res = await request(app).get('/v1/rules').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 2)
    assert.equal(res.body.meta.count, 2)
    assert.ok(res.body.meta.fetchedAt)
  })

  it('tenant isolation — tenant B cannot see tenant A rules', async () => {
    const { app } = createTestApp()
    await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)

    const res = await request(app).get('/v1/rules').set('Authorization', `Bearer ${KEY_B}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
  })
})

// ---------------------------------------------------------------------------
// PUT /v1/rules/:id
// ---------------------------------------------------------------------------

describe('PUT /v1/rules/:id', () => {
  it('updates enabled flag', async () => {
    const { app } = createTestApp()
    const createRes = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)
    const ruleId = createRes.body.data.ruleId

    const res = await request(app)
      .put(`/v1/rules/${ruleId}`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ enabled: false })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.enabled, false)
    assert.equal(res.body.data.ruleId, ruleId)
  })

  it('updates name', async () => {
    const { app } = createTestApp()
    const createRes = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)
    const ruleId = createRes.body.data.ruleId

    const res = await request(app)
      .put(`/v1/rules/${ruleId}`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ name: 'Renamed rule' })

    assert.equal(res.status, 200)
    assert.equal(res.body.data.name, 'Renamed rule')
  })

  it('updates channels', async () => {
    const { app } = createTestApp()
    const createRes = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)
    const ruleId = createRes.body.data.ruleId

    const res = await request(app)
      .put(`/v1/rules/${ruleId}`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ channels: ['https://hooks.slack.com/services/T00/B00/new'] })

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.channels, ['https://hooks.slack.com/services/T00/B00/new'])
  })

  it('returns 404 for nonexistent rule', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .put('/v1/rules/nonexistent-id')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ enabled: false })

    assert.equal(res.status, 404)
  })

  it('tenant isolation — tenant B cannot update tenant A rule', async () => {
    const { app } = createTestApp()
    const createRes = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)
    const ruleId = createRes.body.data.ruleId

    const res = await request(app)
      .put(`/v1/rules/${ruleId}`)
      .set('Authorization', `Bearer ${KEY_B}`)
      .send({ enabled: false })

    assert.equal(res.status, 404)
  })

  it('rejects config type mismatch on update — threshold rule with template_watch config', async () => {
    const { app } = createTestApp()
    const createRes = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)
    const ruleId = createRes.body.data.ruleId

    const res = await request(app)
      .put(`/v1/rules/${ruleId}`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({ config: { templateId: 'tmpl-1', templateText: 'wrong type' } })

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'CONFIG_TYPE_MISMATCH')
  })

  it('rejects config type mismatch on update — template_watch rule with threshold config', async () => {
    const { app } = createTestApp()
    const createRes = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_TEMPLATE_WATCH_BODY)
    const ruleId = createRes.body.data.ruleId

    const res = await request(app)
      .put(`/v1/rules/${ruleId}`)
      .set('Authorization', `Bearer ${KEY_A}`)
      .send({
        config: {
          metric: 'error_count',
          service: 'svc',
          operator: '>',
          value: 5,
          windowMinutes: 10,
        },
      })

    assert.equal(res.status, 400)
    assert.equal(res.body.error.code, 'CONFIG_TYPE_MISMATCH')
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp()
    const res = await request(app).put('/v1/rules/some-id').send({ enabled: false })

    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// DELETE /v1/rules/:id
// ---------------------------------------------------------------------------

describe('DELETE /v1/rules/:id', () => {
  it('returns 204 for existing rule', async () => {
    const { app } = createTestApp()
    const createRes = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)
    const ruleId = createRes.body.data.ruleId

    const res = await request(app)
      .delete(`/v1/rules/${ruleId}`)
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 204)

    // Verify it's gone
    const listRes = await request(app).get('/v1/rules').set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(listRes.body.data.length, 0)
  })

  it('returns 204 for nonexistent rule (idempotent)', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .delete('/v1/rules/nonexistent-id')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 204)
  })

  it('tenant isolation — tenant B cannot delete tenant A rule', async () => {
    const { app } = createTestApp()
    const createRes = await request(app)
      .post('/v1/rules')
      .set('Authorization', `Bearer ${KEY_A}`)
      .send(VALID_THRESHOLD_BODY)
    const ruleId = createRes.body.data.ruleId

    await request(app).delete(`/v1/rules/${ruleId}`).set('Authorization', `Bearer ${KEY_B}`)

    // Tenant A's rule should still exist
    const listRes = await request(app).get('/v1/rules').set('Authorization', `Bearer ${KEY_A}`)
    assert.equal(listRes.body.data.length, 1)
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp()
    const res = await request(app).delete('/v1/rules/some-id')

    assert.equal(res.status, 401)
  })
})

// ---------------------------------------------------------------------------
// GET /v1/alerts
// ---------------------------------------------------------------------------

describe('GET /v1/alerts', () => {
  it('returns alert history from DB', async () => {
    const { app } = createTestApp({ queryResults: mockAlertRows })
    const res = await request(app).get('/v1/alerts').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 2)
    assert.ok(res.body.meta.fetchedAt)
    assert.equal(res.body.meta.count, 2)
  })

  it('maps snake_case DB rows to camelCase response', async () => {
    const { app } = createTestApp({ queryResults: mockAlertRows })
    const res = await request(app).get('/v1/alerts').set('Authorization', `Bearer ${KEY_A}`)

    const first = res.body.data[0]
    assert.equal(first.alertId, '019abc-alert-1')
    assert.equal(first.ruleId, 'rule-1')
    assert.equal(first.ruleType, 'threshold')
    assert.equal(first.ruleName, 'High errors')
    assert.equal(first.metricValue, 15)
    assert.equal(first.thresholdValue, 10)
    assert.equal(first.firedAt, '2026-03-20T14:32:00.000Z')
  })

  it('parses details JSON', async () => {
    const { app } = createTestApp({ queryResults: mockAlertRows })
    const res = await request(app).get('/v1/alerts').set('Authorization', `Bearer ${KEY_A}`)

    const first = res.body.data[0]
    assert.deepEqual(first.details, {
      service: 'payment-service',
      metric: 'error_count',
      operator: '>',
      windowMinutes: 5,
    })
  })

  it('parses channelsNotified JSON', async () => {
    const { app } = createTestApp({ queryResults: mockAlertRows })
    const res = await request(app).get('/v1/alerts').set('Authorization', `Bearer ${KEY_A}`)

    const first = res.body.data[0]
    assert.deepEqual(first.channelsNotified, ['https://hooks.slack.com/services/T00/B00/xxx'])
  })

  it('returns empty array when no alerts', async () => {
    const { app } = createTestApp({ queryResults: [] })
    const res = await request(app).get('/v1/alerts').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data, [])
    assert.equal(res.body.meta.count, 0)
  })

  it('accepts hours query param', async () => {
    const { app } = createTestApp({ queryResults: [] })
    const res = await request(app)
      .get('/v1/alerts?hours=48')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
  })

  it('accepts rule_id filter param', async () => {
    const { app } = createTestApp({ queryResults: mockAlertRows })
    const res = await request(app)
      .get('/v1/alerts?ruleId=rule-1')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
  })

  it('accepts service filter param', async () => {
    const { app } = createTestApp({ queryResults: mockAlertRows })
    const res = await request(app)
      .get('/v1/alerts?service=payment-service')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
  })

  it('accepts combined filter params', async () => {
    const { app } = createTestApp({ queryResults: [] })
    const res = await request(app)
      .get('/v1/alerts?hours=48&ruleId=rule-1&service=payment-service&limit=50')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.meta.hours, 48)
  })

  it('returns 400 for hours=0', async () => {
    const { app } = createTestApp({ queryResults: [] })
    const res = await request(app).get('/v1/alerts?hours=0').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 400)
  })

  it('returns 400 for hours exceeding 720', async () => {
    const { app } = createTestApp({ queryResults: [] })
    const res = await request(app)
      .get('/v1/alerts?hours=999')
      .set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 400)
  })

  it('returns 401 without auth', async () => {
    const { app } = createTestApp()
    const res = await request(app).get('/v1/alerts')

    assert.equal(res.status, 401)
  })

  // Bug #169 regression: corrupted JSON in alert rows used to leak through as
  // a raw string, breaking clients that expected `details: object | null` and
  // `channelsNotified: string[]`. Now we fall back to typed defaults.
  it('handles corrupted details JSON with typed fallbacks', async () => {
    const corruptedRow = [
      { ...mockAlertRows[0], details: 'not-json', channels_notified: 'also-not-json' },
    ]
    const { app } = createTestApp({ queryResults: corruptedRow })
    const res = await request(app).get('/v1/alerts').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data.length, 1)
    assert.equal(res.body.data[0].details, null, 'details falls back to null on parse failure')
    assert.deepEqual(
      res.body.data[0].channelsNotified,
      [],
      'channelsNotified falls back to [] on parse failure',
    )
  })

  it('falls back when JSON parses to wrong shape (array as details, object as channels)', async () => {
    const wrongShapeRow = [
      { ...mockAlertRows[0], details: '[1,2,3]', channels_notified: '{"foo":"bar"}' },
    ]
    const { app } = createTestApp({ queryResults: wrongShapeRow })
    const res = await request(app).get('/v1/alerts').set('Authorization', `Bearer ${KEY_A}`)

    assert.equal(res.status, 200)
    assert.equal(res.body.data[0].details, null, 'array is not a valid details object')
    assert.deepEqual(
      res.body.data[0].channelsNotified,
      [],
      'object is not a valid channels_notified array',
    )
  })
})
