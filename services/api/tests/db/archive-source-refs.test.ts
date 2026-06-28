import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import pino from 'pino'
import { getArchiveSourceRefs } from '../../src/db/archive-queries.js'
import { initSchema } from '../../src/db/schema.js'
import { uuidv7 } from '../../src/uuid.js'
import { closeTestClient, getTestClient, getTestDb, testTenantId } from './helpers.js'

const logger = pino({ level: 'silent' })

/** ClickHouse DateTime64 literal for `offsetMs` from now (recent → dodges TTL). */
function chTime(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').replace('Z', '')
}

function row(
  tenantId: string,
  o: {
    templateId: string
    service: string
    sourceType: string
    sourceRef: string
    offsetMs?: number
  },
) {
  return {
    id: uuidv7(),
    event_id: uuidv7(),
    tenant_id: tenantId,
    timestamp: chTime(o.offsetMs ?? 0),
    ingest_time: chTime(o.offsetMs ?? 0),
    service: o.service,
    level: 'ERROR',
    environment: 'test',
    template_id: o.templateId,
    template_text: 'connection <*> timed out',
    is_new_template: 0,
    anomaly_score: 0,
    status_code: 500,
    duration_ms: 1,
    trace_id: '',
    route: '',
    source_type: o.sourceType,
    source_ref: o.sourceRef,
    preprocessing_version: 1,
  }
}

describe('getArchiveSourceRefs', () => {
  const db = getTestDb()
  const client = getTestClient()

  before(async () => {
    await initSchema(client, logger)
  })

  after(async () => {
    await closeTestClient()
  })

  it('returns distinct own-tenant s3 source_refs, newest first, excluding cross-tenant refs', async () => {
    const tenantId = testTenantId('archive-refs')
    const tpl = 'tpl-arch'
    const svc = 'svc-a'
    // Archive keys live under the tenant's own prefix (Vector's key_prefix).
    const own = (name: string) =>
      `tenant=${tenantId}/service=${svc}/date=2026-06-29/hour=00/${name}`
    const keyOld = own('old.log.gz')
    const keyNew = own('new.log.gz')

    await client.insert({
      table: 'logweave.log_metadata',
      values: [
        // Two distinct keys for the target template+service (newest first = keyNew).
        row(tenantId, {
          templateId: tpl,
          service: svc,
          sourceType: 's3',
          sourceRef: keyOld,
          offsetMs: -60_000,
        }),
        row(tenantId, {
          templateId: tpl,
          service: svc,
          sourceType: 's3',
          sourceRef: keyNew,
          offsetMs: -10_000,
        }),
        // A replayed event in the older object — must collapse (distinct keys).
        row(tenantId, {
          templateId: tpl,
          service: svc,
          sourceType: 's3',
          sourceRef: keyOld,
          offsetMs: -55_000,
        }),
        // SECURITY: this row belongs to our tenant but its ref points at ANOTHER
        // tenant's archive partition (a client could forge this at ingest). It
        // MUST NOT be returned — the prefix guard is the cross-tenant defense.
        row(tenantId, {
          templateId: tpl,
          service: svc,
          sourceType: 's3',
          sourceRef: 'tenant=victim/service=svc-a/date=2026-06-29/hour=00/secret.log.gz',
          offsetMs: -5_000,
        }),
        // Excluded: non-s3 source.
        row(tenantId, {
          templateId: tpl,
          service: svc,
          sourceType: 'transport',
          sourceRef: own('t'),
        }),
        // Excluded: different template / service / empty ref.
        row(tenantId, {
          templateId: 'other',
          service: svc,
          sourceType: 's3',
          sourceRef: own('o1'),
        }),
        row(tenantId, {
          templateId: tpl,
          service: 'svc-b',
          sourceType: 's3',
          sourceRef: own('o2'),
        }),
        row(tenantId, { templateId: tpl, service: svc, sourceType: 's3', sourceRef: '' }),
      ],
      format: 'JSONEachRow',
    })

    // Absorb read-after-write delay.
    let refs: string[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 200))
      refs = await getArchiveSourceRefs(db, tenantId, {
        templateId: tpl,
        service: svc,
        hours: 24,
        maxFiles: 20,
      })
      if (refs.length >= 2) break
    }

    assert.deepEqual(
      refs,
      [keyNew, keyOld],
      'own-tenant refs newest-first; cross-tenant ref excluded',
    )
  })

  it('returns empty when the template has no archived (s3) events', async () => {
    const tenantId = testTenantId('archive-refs-empty')
    await client.insert({
      table: 'logweave.log_metadata',
      values: [
        row(tenantId, {
          templateId: 'tpl-x',
          service: 'svc-x',
          sourceType: 'transport',
          sourceRef: '',
        }),
      ],
      format: 'JSONEachRow',
    })

    const refs = await getArchiveSourceRefs(db, tenantId, {
      templateId: 'tpl-x',
      service: 'svc-x',
      hours: 24,
      maxFiles: 20,
    })
    assert.deepEqual(refs, [])
  })
})
