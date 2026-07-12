import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { encrypt } from '../../src/crypto.js'
import type { DbClient } from '../../src/db/client.js'
import { TenantSettingsStore } from '../../src/watches/tenant-settings.js'

const KEY = 'a'.repeat(32)
const WEBHOOK = 'https://hooks.slack.com/services/T000/B000/abcdef123456'

interface InsertedRow {
  tenant_id: string
  setting_key: string
  setting_value: string
}

/** Mock DbClient that captures inserted rows and serves canned query rows. */
function captureDb(queryRows: InsertedRow[] = []) {
  const inserted: InsertedRow[] = []
  const db = {
    query: async () => queryRows,
    insert: async (params: { values: InsertedRow[] }) => {
      inserted.push(...params.values)
    },
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, inserted }
}

describe('TenantSettingsStore Slack webhook encryption at rest', () => {
  it('encrypts the webhook URL written to the DB when a key is set', async () => {
    const { db, inserted } = captureDb()
    const store = new TenantSettingsStore({ db, encryptionKey: KEY })

    await store.set('t1', { slackWebhookUrl: WEBHOOK })

    const row = inserted.find((r) => r.setting_key === 'slackWebhookUrl')
    assert.ok(row, 'webhook row was inserted')
    assert.ok(row.setting_value.startsWith('enc2:'), 'value is encrypted')
    assert.ok(!row.setting_value.includes('hooks.slack.com'), 'plaintext URL not present')
    // In-memory cache keeps plaintext for use.
    assert.equal(store.getSlackUrl('t1'), WEBHOOK)
  })

  it('decrypts the webhook URL loaded from the DB (round-trip)', async () => {
    const ciphertext = await encrypt(WEBHOOK, KEY)
    assert.ok(ciphertext.startsWith('enc2:'))
    const { db } = captureDb([
      { tenant_id: 't1', setting_key: 'slackWebhookUrl', setting_value: ciphertext },
    ])
    const store = new TenantSettingsStore({ db, encryptionKey: KEY })

    await store.loadFromDb()

    assert.equal(store.getSlackUrl('t1'), WEBHOOK)
  })

  it('loads a legacy plaintext webhook row unchanged (backward compat)', async () => {
    const { db } = captureDb([
      { tenant_id: 't1', setting_key: 'slackWebhookUrl', setting_value: WEBHOOK },
    ])
    const store = new TenantSettingsStore({ db, encryptionKey: KEY })

    await store.loadFromDb()

    assert.equal(store.getSlackUrl('t1'), WEBHOOK)
  })

  it('stores the webhook plaintext when no encryption key is configured (dev)', async () => {
    const { db, inserted } = captureDb()
    const store = new TenantSettingsStore({ db })

    await store.set('t1', { slackWebhookUrl: WEBHOOK })

    const row = inserted.find((r) => r.setting_key === 'slackWebhookUrl')
    assert.ok(row)
    assert.equal(row.setting_value, WEBHOOK)
  })

  it('does not corrupt a bad ciphertext into a crash on load', async () => {
    // An undecryptable value (key rotated away) must not throw out of loadFromDb.
    const { db } = captureDb([
      { tenant_id: 't1', setting_key: 'slackWebhookUrl', setting_value: 'enc2:not-valid-base64!!' },
    ])
    const store = new TenantSettingsStore({ db, encryptionKey: KEY })

    await store.loadFromDb()

    assert.equal(store.getSlackUrl('t1'), undefined)
  })
})
