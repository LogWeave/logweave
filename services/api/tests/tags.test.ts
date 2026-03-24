import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import express from 'express'
import pino from 'pino'
import request from 'supertest'
import { createAuthMiddleware } from '../src/middleware/auth.js'
import { createErrorHandler } from '../src/middleware/error-handler.js'
import { settingsRoutes } from '../src/routes/settings.js'
import { tagRoutes } from '../src/routes/tags.js'
import { TenantSettingsStore } from '../src/watches/tenant-settings.js'

const TEST_KEY = 'test-key'
const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const keyMap = new Map([
  [TEST_KEY, TENANT_A],
  ['key-b', TENANT_B],
])

function createTestApp() {
  const logger = pino({ level: 'silent' })
  const settingsStore = new TenantSettingsStore({ logger })
  const app = express()
  app.use(express.json())
  const auth = createAuthMiddleware(keyMap)
  app.use('/v1', auth, settingsRoutes({ settingsStore, logger }))
  app.use('/v1', auth, tagRoutes({ db: null as never, logger }))
  app.use(createErrorHandler(logger))
  return { app, settingsStore }
}

// ---------------------------------------------------------------------------
// Tag extraction settings API
// ---------------------------------------------------------------------------

describe('GET /v1/settings/tags', () => {
  it('returns empty array when no tags configured', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .get('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.extractTags, [])
  })

  it('returns configured tags', async () => {
    const { app, settingsStore } = createTestApp()
    await settingsStore.set(TENANT_A, { extractTags: ['customer_id', 'order_id'] })

    const res = await request(app)
      .get('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.extractTags, ['customer_id', 'order_id'])
  })
})

describe('PUT /v1/settings/tags', () => {
  it('saves tag keys', async () => {
    const { app, settingsStore } = createTestApp()
    const res = await request(app)
      .put('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ extractTags: ['user_id', 'request_id'] })

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.extractTags, ['user_id', 'request_id'])

    const stored = settingsStore.get(TENANT_A)
    assert.deepEqual(stored.extractTags, ['user_id', 'request_id'])
  })

  it('allows empty array to clear tags', async () => {
    const { app, settingsStore } = createTestApp()
    await settingsStore.set(TENANT_A, { extractTags: ['customer_id'] })

    const res = await request(app)
      .put('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ extractTags: [] })

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.extractTags, [])
    assert.deepEqual(settingsStore.get(TENANT_A).extractTags, [])
  })

  it('rejects keys with invalid characters', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .put('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ extractTags: ['valid_key', 'invalid key!'] })

    assert.equal(res.status, 400)
  })

  it('rejects more than 20 keys', async () => {
    const { app } = createTestApp()
    const tooMany = Array.from({ length: 21 }, (_, i) => `key_${i}`)
    const res = await request(app)
      .put('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ extractTags: tooMany })

    assert.equal(res.status, 400)
  })

  it('rejects keys longer than 64 characters', async () => {
    const { app } = createTestApp()
    const longKey = 'a'.repeat(65)
    const res = await request(app)
      .put('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ extractTags: [longKey] })

    assert.equal(res.status, 400)
  })

  it('rejects empty key strings', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .put('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ extractTags: [''] })

    assert.equal(res.status, 400)
  })

  it('tenant isolation — tenant A cannot see tenant B tags', async () => {
    const { app, settingsStore } = createTestApp()
    await settingsStore.set(TENANT_A, { extractTags: ['a_key'] })
    await settingsStore.set(TENANT_B, { extractTags: ['b_key'] })

    const res = await request(app)
      .get('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.deepEqual(res.body.data.extractTags, ['a_key'])
  })

  it('accepts valid alphanumeric keys with dots and dashes', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .put('/v1/settings/tags')
      .set('Authorization', `Bearer ${TEST_KEY}`)
      .send({ extractTags: ['my.field', 'my-field', 'my_field', 'field123'] })

    assert.equal(res.status, 200)
    assert.deepEqual(res.body.data.extractTags, ['my.field', 'my-field', 'my_field', 'field123'])
  })
})

// ---------------------------------------------------------------------------
// Tag query route validation
// ---------------------------------------------------------------------------

describe('GET /v1/events/by-tag', () => {
  it('returns 400 when key is missing', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .get('/v1/events/by-tag?value=test')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
  })

  it('returns 400 when value is missing', async () => {
    const { app } = createTestApp()
    const res = await request(app)
      .get('/v1/events/by-tag?key=customer_id')
      .set('Authorization', `Bearer ${TEST_KEY}`)

    assert.equal(res.status, 400)
  })
})

// ---------------------------------------------------------------------------
// TenantSettingsStore extractTags persistence
// ---------------------------------------------------------------------------

describe('TenantSettingsStore.extractTags', () => {
  it('round-trips extractTags through set/get', async () => {
    const store = new TenantSettingsStore()
    await store.set('t1', { extractTags: ['customer_id', 'order_id'] })

    const settings = store.get('t1')
    assert.deepEqual(settings.extractTags, ['customer_id', 'order_id'])
  })

  it('merges extractTags with other settings', async () => {
    const store = new TenantSettingsStore()
    await store.set('t1', { retentionDays: 14 })
    await store.set('t1', { extractTags: ['user_id'] })

    const settings = store.get('t1')
    assert.equal(settings.retentionDays, 14)
    assert.deepEqual(settings.extractTags, ['user_id'])
  })

  it('returns empty object for unknown tenant', () => {
    const store = new TenantSettingsStore()
    const settings = store.get('unknown')
    assert.deepEqual(settings, {})
    assert.equal(settings.extractTags, undefined)
  })
})
