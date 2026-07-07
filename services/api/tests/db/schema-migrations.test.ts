import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ClickHouseClient } from '@clickhouse/client'
import pino from 'pino'
import { assertLogMetadataEngine, migrationId } from '../../src/db/schema.js'

// Unit coverage for the #294 Phase-1 schema-safety changes — no ClickHouse
// needed. The ledger's end-to-end behaviour (migrations applied once, MVs not
// replayed) is asserted in the integration schema.test.ts.

const logger = pino({ level: 'silent' })

// Minimal ClickHouseClient stub: assertLogMetadataEngine only calls
// query(...).json(), which returns the system.tables engine probe rows.
function mockClient(engineRows: Array<{ engine: string }>): ClickHouseClient {
  return {
    query: async () => ({ json: async () => engineRows }),
  } as unknown as ClickHouseClient
}

describe('migrationId', () => {
  it('is deterministic for identical SQL', () => {
    assert.equal(
      migrationId('ALTER TABLE x ADD COLUMN y'),
      migrationId('ALTER TABLE x ADD COLUMN y'),
    )
  })

  it('differs for different SQL', () => {
    assert.notEqual(migrationId('CREATE TABLE a'), migrationId('CREATE TABLE b'))
  })

  it('is a stable 16-char hex id', () => {
    assert.match(migrationId('SELECT 1'), /^[0-9a-f]{16}$/)
  })
})

describe('assertLogMetadataEngine (refuse-to-start guard)', () => {
  it('throws on a legacy (non-ReplacingMergeTree) engine instead of dropping the table', async () => {
    await assert.rejects(
      () => assertLogMetadataEngine(mockClient([{ engine: 'MergeTree' }]), logger),
      /Refusing to start[\s\S]*ReplacingMergeTree/,
    )
  })

  it('does not throw when the engine is already ReplacingMergeTree', async () => {
    await assert.doesNotReject(() =>
      assertLogMetadataEngine(mockClient([{ engine: 'ReplacingMergeTree' }]), logger),
    )
  })

  it('does not throw on a fresh install (table absent)', async () => {
    await assert.doesNotReject(() => assertLogMetadataEngine(mockClient([]), logger))
  })
})
