import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { DbClient } from '../../src/db/client.js'
import { ingestBatch } from '../../src/pipeline/ingest.js'
import { AnomalyScorer } from '../../src/pipeline/anomaly-scorer.js'
import type { ClusterClient, ClusterResult } from '../../src/pipeline/cluster-client.js'
import { TenantSettingsStore } from '../../src/watches/tenant-settings.js'

const logger = pino({ level: 'silent' })
const TENANT = 'tenant-test'

interface InsertCall {
  table?: string
  values: unknown[]
}

function createDb(): { db: DbClient; metadataInserts: unknown[][]; tagInserts: InsertCall[] } {
  const metadataInserts: unknown[][] = []
  const tagInserts: InsertCall[] = []
  const db = {
    insert: async (params: { table?: string; values: unknown[] }) => {
      // batchInsert calls without `table`; tag insert passes table='logweave.event_tags'
      if (params.table === 'logweave.event_tags') {
        tagInserts.push({ table: params.table, values: params.values })
      } else {
        metadataInserts.push(params.values)
      }
    },
    query: async () => [],
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, metadataInserts, tagInserts }
}

function makeClusterClient(results: ClusterResult[]): ClusterClient {
  return {
    cluster: async () => results,
  } as unknown as ClusterClient
}

describe('ingestBatch — Phase 4.5 tag extraction', () => {
  // Bug #172 regression: when parse errors drop events from `items`, Phase 4.5
  // must still pair tags with the correct raw event. Previously it indexed
  // into `events[i]` which had a different length.
  it('extracts tags from the correct raw event after parse errors', async () => {
    const { db, tagInserts } = createDb()
    const settingsStore = new TenantSettingsStore({ logger })
    await settingsStore.set(TENANT, { extractTags: ['customer_id'] })
    const anomalyScorer = new AnomalyScorer({ db, logger, coldStartMs: Infinity })

    // Two valid events with distinct customer_id, separated by an unparseable one.
    const events = [
      { message: 'order placed', level: 'info', service: 'api', customer_id: 'cust-A' },
      'not-an-object', // will be skipped by parseEvent
      { message: 'order placed', level: 'info', service: 'api', customer_id: 'cust-B' },
    ]

    const clusterClient = makeClusterClient([
      { templateId: 'tpl-1', templateText: 'order placed', isNewTemplate: false },
      { templateId: 'tpl-1', templateText: 'order placed', isNewTemplate: false },
    ])

    await ingestBatch(
      { clusterClient, db, logger, anomalyScorer, settingsStore },
      TENANT,
      events,
      {},
    )

    assert.equal(tagInserts.length, 1)
    const tagValues = tagInserts[0]!.values as Array<Record<string, unknown>>
    assert.equal(tagValues.length, 2)
    // The two extracted tags must be the two valid events' values, not duplicates
    // of the same event or the wrong pairing.
    const values = tagValues.map((t) => t.tag_value).sort()
    assert.deepEqual(values, ['cust-A', 'cust-B'])
  })

  it('extracts tags from the correct raw event after level filtering', async () => {
    const { db, tagInserts } = createDb()
    const settingsStore = new TenantSettingsStore({ logger })
    await settingsStore.set(TENANT, {
      extractTags: ['customer_id'],
      minIngestLevel: 'WARN',
    })
    const anomalyScorer = new AnomalyScorer({ db, logger, coldStartMs: Infinity })

    const events = [
      { message: 'noisy', level: 'debug', service: 'api', customer_id: 'cust-DEBUG' },
      { message: 'warning!', level: 'warn', service: 'api', customer_id: 'cust-WARN' },
      { message: 'info', level: 'info', service: 'api', customer_id: 'cust-INFO' },
      { message: 'error!', level: 'error', service: 'api', customer_id: 'cust-ERR' },
    ]

    const clusterClient = makeClusterClient([
      { templateId: 'tpl-w', templateText: 'warning!', isNewTemplate: false },
      { templateId: 'tpl-e', templateText: 'error!', isNewTemplate: false },
    ])

    await ingestBatch(
      { clusterClient, db, logger, anomalyScorer, settingsStore },
      TENANT,
      events,
      {},
    )

    assert.equal(tagInserts.length, 1)
    const tagValues = tagInserts[0]!.values as Array<Record<string, unknown>>
    const values = tagValues.map((t) => t.tag_value).sort()
    // Only WARN and ERROR survive the level filter; DEBUG and INFO are dropped.
    assert.deepEqual(values, ['cust-ERR', 'cust-WARN'])
  })
})
