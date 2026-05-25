import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import pino from 'pino'
import type { ClustererHealthChecker } from '../../src/clients/clusterer.js'
import type { DbClient } from '../../src/db/client.js'
import { ClusterClient } from '../../src/pipeline/cluster-client.js'
import { RecoverySweep } from '../../src/recovery/reconcile.js'
import type { LogMetadataRow } from '../../src/types.js'

const logger = pino({ level: 'silent' })

/** Build a fake unclustered row for testing. */
function unclusteredRow(overrides?: Record<string, unknown>) {
  return {
    id: `00000000-0000-7000-0000-00000000000${Math.floor(Math.random() * 10)}`,
    tenant_id: 'tenant-a',
    timestamp: '2026-03-14T12:00:00.000Z',
    service: 'auth-api',
    level: 'INFO',
    environment: 'production',
    anomaly_score: 0,
    status_code: 200,
    duration_ms: 45.2,
    trace_id: 'trace-1',
    route: '/api/login',
    source_type: 'transport',
    source_ref: '',
    pre_processed_message: 'User <*> logged in',
    preprocessing_version: 1,
    ...overrides,
  }
}

/** Create a mock ClustererHealthChecker. */
function mockHealthChecker(healthy: boolean): ClustererHealthChecker {
  return {
    consecutiveFailures: healthy ? 0 : 5,
    lastChecked: Date.now(),
    check: async () => healthy,
  } as unknown as ClustererHealthChecker
}

/** Create a mock fetch returning cluster results. */
function mockFetch(
  results: Array<{ template_id: string; template_text: string; is_new: boolean }>,
  options?: { delayMs?: number },
): typeof globalThis.fetch {
  return async () => {
    if (options?.delayMs) {
      await new Promise((r) => setTimeout(r, options.delayMs))
    }
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/** Build standard cluster results for N messages. */
function clusterResults(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    template_id: `tpl-${i + 1}`,
    template_text: `Template <*> ${i + 1}`,
    is_new: i === 0,
  }))
}

interface MockDbOptions {
  pages: Record<string, unknown>[][]
  commandCalls?: Array<{ query: string; query_params?: Record<string, unknown> }>
  commandError?: Error
  insertError?: Error
  insertErrorForTenant?: string
}

/** Create a mock DbClient that returns paginated results, captures commands and inserts. */
function mockDb(options: MockDbOptions) {
  let queryCallCount = 0
  const commandCalls: Array<{ query: string; query_params?: Record<string, unknown> }> =
    options.commandCalls ?? []
  const queryCalls: Array<Record<string, unknown>> = []
  const insertedRows: LogMetadataRow[][] = []

  const db = {
    query: async (params: Record<string, unknown>) => {
      queryCalls.push(params)
      const page = options.pages[queryCallCount] ?? []
      queryCallCount++
      return page
    },
    command: async (params: { query: string; query_params?: Record<string, unknown> }) => {
      if (options.commandError) throw options.commandError
      commandCalls.push(params)
    },
    insert: async (params: { values: LogMetadataRow[] }) => {
      if (options.insertError) throw options.insertError
      if (
        options.insertErrorForTenant &&
        params.values[0]?.tenant_id === options.insertErrorForTenant
      ) {
        throw new Error(`INSERT failed for tenant ${options.insertErrorForTenant}`)
      }
      insertedRows.push(params.values)
    },
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient

  return { db, commandCalls, queryCalls, insertedRows }
}

function createSweep(options: {
  pages: Record<string, unknown>[][]
  healthy?: boolean
  fetchFn?: typeof globalThis.fetch
  sweepMaxRows?: number
  insertError?: Error
  insertErrorForTenant?: string
  commandError?: Error
}) {
  const { db, commandCalls, queryCalls, insertedRows } = mockDb({
    pages: options.pages,
    commandError: options.commandError,
    insertError: options.insertError,
    insertErrorForTenant: options.insertErrorForTenant,
  })
  const healthChecker = mockHealthChecker(options.healthy ?? true)

  const fetchFn = options.fetchFn ?? mockFetch(clusterResults(1))
  const clusterClient = new ClusterClient('http://localhost:8000', 500, logger, fetchFn)

  const sweep = new RecoverySweep(
    { db, clusterClient, clustererHealth: healthChecker, logger },
    {
      sweepIntervalMs: 60_000,
      sweepMaxRows: options.sweepMaxRows ?? 1000,
      batchSize: 500,
      backpressureThresholdMs: 300,
      lookbackHours: 24,
    },
  )

  return { sweep, commandCalls, queryCalls, insertedRows, clusterClient }
}

describe('RecoverySweep', () => {
  it('startup recovery re-clusters 10 template_id=0 rows', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      unclusteredRow({
        id: `00000000-0000-7000-0000-0000000000${String(i).padStart(2, '0')}`,
        pre_processed_message: `User user${i} logged in`,
      }),
    )
    const fetchFn = mockFetch(clusterResults(10))
    const { sweep, commandCalls, insertedRows } = createSweep({
      pages: [rows, []],
      fetchFn,
    })

    const recovered = await sweep.runStartupReconciliation()

    assert.equal(recovered, 10)
    // INSERT was called with 10 new rows
    assert.equal(insertedRows.length, 1)
    assert.equal(insertedRows[0]?.length, 10)
    // All new rows have real template_ids
    for (const row of insertedRows[0]!) {
      assert.notEqual(row.template_id, '0')
      assert.equal(row.pre_processed_message, null)
    }
    // DELETE was called with the 10 old IDs, scoped by tenant_id
    assert.equal(commandCalls.length, 1)
    assert.ok(commandCalls[0]?.query.includes('DELETE FROM'))
    assert.ok(commandCalls[0]?.query.includes('tenant_id'), 'DELETE must include tenant_id scope')
    const deletedIds = commandCalls[0]?.query_params?.ids as string[]
    assert.equal(deletedIds.length, 10)
    assert.equal(commandCalls[0]?.query_params?.tenant_id, 'tenant-a')
  })

  it('startup skips when clusterer is unhealthy', async () => {
    const { sweep, queryCalls } = createSweep({
      pages: [[]],
      healthy: false,
    })

    const recovered = await sweep.runStartupReconciliation()

    assert.equal(recovered, 0)
    // No DB queries should have been made
    assert.equal(queryCalls.length, 0)
  })

  it('INSERT-then-DELETE produces correct rows with preserved fields', async () => {
    const original = unclusteredRow({
      id: 'aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa',
      tenant_id: 'tenant-x',
      timestamp: '2026-03-14T10:00:00.000Z',
      service: 'payments',
      level: 'ERROR',
      environment: 'staging',
      anomaly_score: 0.5,
      status_code: 500,
      duration_ms: 120.3,
      trace_id: 'trace-abc',
      route: '/pay',
      source_type: 'transport',
      source_ref: 'ref-1',
      pre_processed_message: 'Payment failed for user <*>',
      preprocessing_version: 1,
    })

    const clusterResponse = [
      { template_id: 'tpl-pay', template_text: 'Payment failed for user <*>', is_new: true },
    ]
    const fetchFn = mockFetch(clusterResponse)
    const { sweep, commandCalls, insertedRows } = createSweep({
      pages: [[original], []],
      fetchFn,
    })

    await sweep.runStartupReconciliation()

    const newRow = insertedRows[0]?.[0]!
    // Template fields updated
    assert.equal(newRow.template_id, 'tpl-pay')
    assert.equal(newRow.template_text, 'Payment failed for user <*>')
    assert.equal(
      newRow.is_new_template,
      0,
      'Recovery re-clustering should not count as new template',
    )
    assert.equal(newRow.pre_processed_message, null)
    // All other fields preserved
    assert.equal(newRow.tenant_id, 'tenant-x')
    assert.equal(newRow.timestamp, '2026-03-14T10:00:00.000Z')
    assert.equal(newRow.service, 'payments')
    assert.equal(newRow.level, 'ERROR')
    assert.equal(newRow.environment, 'staging')
    assert.equal(newRow.anomaly_score, 0.5)
    assert.equal(newRow.status_code, 500)
    assert.equal(newRow.duration_ms, 120.3)
    assert.equal(newRow.trace_id, 'trace-abc')
    assert.equal(newRow.route, '/pay')
    assert.equal(newRow.source_type, 'transport')
    assert.equal(newRow.source_ref, 'ref-1')
    assert.equal(newRow.preprocessing_version, 1)
    // No id field — let ClickHouse auto-generate new UUIDv7
    assert.equal('id' in newRow, false, 'New row should not have an id field')
    // DELETE used the old id
    const deletedIds = commandCalls[0]?.query_params?.ids as string[]
    assert.deepEqual(deletedIds, ['aaaaaaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa'])
  })

  it('per-tenant batching — cluster called separately per tenant', async () => {
    const rows = [
      unclusteredRow({ id: 'id-a1', tenant_id: 'tenant-a', pre_processed_message: 'msg-a1' }),
      unclusteredRow({ id: 'id-b1', tenant_id: 'tenant-b', pre_processed_message: 'msg-b1' }),
      unclusteredRow({ id: 'id-a2', tenant_id: 'tenant-a', pre_processed_message: 'msg-a2' }),
      unclusteredRow({ id: 'id-b2', tenant_id: 'tenant-b', pre_processed_message: 'msg-b2' }),
    ]

    const clusterCalls: Array<{ tenantId: string; messages: string[] }> = []
    const fetchFn: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { tenant_id: string; messages: string[] }
      clusterCalls.push({ tenantId: body.tenant_id, messages: body.messages })
      const results = body.messages.map((_, i) => ({
        template_id: `tpl-${i}`,
        template_text: `tpl ${i}`,
        is_new: false,
      }))
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { sweep } = createSweep({ pages: [rows, []], fetchFn })

    await sweep.runStartupReconciliation()

    assert.equal(clusterCalls.length, 2)
    // One call per tenant
    const tenantIds = clusterCalls.map((c) => c.tenantId).sort()
    assert.deepEqual(tenantIds, ['tenant-a', 'tenant-b'])
    // Correct messages per tenant
    const callA = clusterCalls.find((c) => c.tenantId === 'tenant-a')!
    assert.deepEqual(callA.messages, ['msg-a1', 'msg-a2'])
    const callB = clusterCalls.find((c) => c.tenantId === 'tenant-b')!
    assert.deepEqual(callB.messages, ['msg-b1', 'msg-b2'])
  })

  it('backpressure — sweep aborts when clusterer response > 300ms', async () => {
    const rows = [
      unclusteredRow({ id: 'id-1', tenant_id: 'tenant-a', pre_processed_message: 'msg1' }),
      unclusteredRow({ id: 'id-2', tenant_id: 'tenant-b', pre_processed_message: 'msg2' }),
    ]
    // Clusterer responds slowly (350ms)
    const slowResults = [{ template_id: 'tpl-1', template_text: 'tpl', is_new: false }]
    const fetchFn = mockFetch(slowResults, { delayMs: 350 })

    const { sweep, insertedRows } = createSweep({ pages: [rows, []], fetchFn })

    const recovered = await sweep.runStartupReconciliation()

    // First tenant processed, second skipped due to backpressure
    assert.ok(recovered <= 1, `Expected at most 1 recovered, got ${recovered}`)
  })

  it('mutex — concurrent sweep attempts are blocked', async () => {
    // First sweep takes a while (slow query)
    let queryResolve: (() => void) | null = null
    const slowDb = {
      query: async () => {
        await new Promise<void>((resolve) => {
          queryResolve = resolve
        })
        return []
      },
      command: async () => {},
      insert: async () => {},
      ping: async () => true,
      close: async () => {},
    } as unknown as DbClient

    const healthChecker = mockHealthChecker(true)
    const clusterClient = new ClusterClient('http://localhost:8000', 500, logger, mockFetch([]))

    const sweep = new RecoverySweep(
      { db: slowDb, clusterClient, clustererHealth: healthChecker, logger },
      {
        sweepIntervalMs: 60_000,
        sweepMaxRows: 1000,
        batchSize: 500,
        backpressureThresholdMs: 300,
        lookbackHours: 24,
      },
    )

    // Start first sweep (will block on query)
    const firstSweep = sweep.runStartupReconciliation()

    // Wait a tick for the first sweep to acquire the mutex
    await new Promise((r) => setTimeout(r, 10))

    // Second sweep should be blocked
    const secondResult = await sweep.runStartupReconciliation()
    assert.equal(secondResult, 0, 'Second sweep should return 0 when mutex is held')

    // Unblock first sweep
    queryResolve?.()
    await firstSweep
  })

  it('still-unclustered results are skipped — no INSERT/DELETE', async () => {
    const rows = [unclusteredRow({ id: 'id-1', pre_processed_message: 'msg1' })]
    // Clusterer returns template_id='0' (still failing)
    const failResults = [{ template_id: '0', template_text: '[unclustered]', is_new: false }]
    const fetchFn = mockFetch(failResults)

    const { sweep, commandCalls, insertedRows } = createSweep({ pages: [rows, []], fetchFn })

    const recovered = await sweep.runStartupReconciliation()

    assert.equal(recovered, 0)
    assert.equal(insertedRows.length, 0, 'No INSERT should happen for still-unclustered rows')
    assert.equal(commandCalls.length, 0, 'No DELETE should happen for still-unclustered rows')
  })

  it('INSERT failure prevents DELETE and sweep continues to next tenant', async () => {
    // Two tenants on the same page: tenant-a INSERT fails, tenant-b should still recover
    const rows = [
      unclusteredRow({ id: 'id-a1', tenant_id: 'tenant-a', pre_processed_message: 'msg-a1' }),
      unclusteredRow({ id: 'id-b1', tenant_id: 'tenant-b', pre_processed_message: 'msg-b1' }),
    ]

    const fetchFn: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { messages: string[] }
      const results = body.messages.map((_, i) => ({
        template_id: `tpl-${i + 1}`,
        template_text: `Template ${i + 1}`,
        is_new: false,
      }))
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { sweep, commandCalls, insertedRows } = createSweep({
      pages: [rows, []],
      fetchFn,
      insertErrorForTenant: 'tenant-a',
    })

    const recovered = await sweep.runStartupReconciliation()

    // tenant-a: INSERT failed → no DELETE, 0 recovered
    // tenant-b: INSERT succeeded → DELETE ran, 1 recovered
    assert.equal(recovered, 1, 'Only tenant-b should be recovered')
    assert.equal(insertedRows.length, 1, 'Only tenant-b INSERT should succeed')
    assert.equal(insertedRows[0]?.[0]?.tenant_id, 'tenant-b')
    assert.equal(commandCalls.length, 1, 'Only tenant-b DELETE should run')
    assert.equal(commandCalls[0]?.query_params?.tenant_id, 'tenant-b')
  })

  it('DELETE failure still returns correct recovered count and logs warning', async () => {
    const rows = [unclusteredRow({ id: 'id-1', pre_processed_message: 'msg1' })]
    const fetchFn = mockFetch(clusterResults(1))

    // Build sweep with a logger that captures warn calls
    const warnCalls: Array<{ obj: Record<string, unknown>; msg: string }> = []
    const testLogger = pino({ level: 'silent' })
    const origWarn = testLogger.warn.bind(testLogger)
    testLogger.warn = ((obj: Record<string, unknown>, msg: string) => {
      warnCalls.push({ obj, msg })
      origWarn(obj, msg)
    }) as typeof testLogger.warn

    const { db, insertedRows } = mockDb({
      pages: [rows, []],
      commandError: new Error('ClickHouse delete failed'),
    })
    const healthChecker = mockHealthChecker(true)
    const clusterClient = new ClusterClient('http://localhost:8000', 500, testLogger, fetchFn)

    const sweep = new RecoverySweep(
      { db, clusterClient, clustererHealth: healthChecker, logger: testLogger },
      {
        sweepIntervalMs: 60_000,
        sweepMaxRows: 1000,
        batchSize: 500,
        backpressureThresholdMs: 300,
        lookbackHours: 24,
      },
    )

    const recovered = await sweep.runStartupReconciliation()

    assert.equal(recovered, 1, 'Should return 1 even though DELETE failed')
    assert.equal(insertedRows.length, 1, 'INSERT should have succeeded')
    // Verify warning was logged for the DELETE failure
    const deleteWarning = warnCalls.find((c) => c.msg.includes('DELETE failed'))
    assert.ok(deleteWarning, 'Should log a warning when DELETE fails')
    assert.equal(deleteWarning?.obj.tenantId, 'tenant-a', 'Warning should include tenant_id')
  })

  it('cursor pagination — multiple pages fetched with advancing cursor', async () => {
    // Page 1: 3 rows, Page 2: 2 rows, Page 3: empty
    const page1 = Array.from({ length: 3 }, (_, i) =>
      unclusteredRow({
        id: `00000000-0000-7000-0000-00000000000${i}`,
        pre_processed_message: `p1-msg${i}`,
      }),
    )
    const page2 = Array.from({ length: 2 }, (_, i) =>
      unclusteredRow({
        id: `00000000-0000-7000-0000-00000000001${i}`,
        pre_processed_message: `p2-msg${i}`,
      }),
    )

    const fetchFn: typeof globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string) as { messages: string[] }
      const results = body.messages.map((_, i) => ({
        template_id: `tpl-${i}`,
        template_text: `tpl ${i}`,
        is_new: false,
      }))
      return new Response(JSON.stringify({ results }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const { sweep, queryCalls } = createSweep({ pages: [page1, page2, []], fetchFn })

    const recovered = await sweep.runStartupReconciliation()

    assert.equal(recovered, 5)
    // 3 query calls (page1 + page2 + empty)
    assert.equal(queryCalls.length, 3)
    // Second query should use cursor from last row of page 1
    const secondParams = queryCalls[1]?.query_params as Record<string, unknown>
    assert.equal(
      secondParams.cursor,
      page1[2]?.id,
      'Cursor should advance to last ID of previous page',
    )
    // Third query should use cursor from last row of page 2
    const thirdParams = queryCalls[2]?.query_params as Record<string, unknown>
    assert.equal(
      thirdParams.cursor,
      page2[1]?.id,
      'Cursor should advance to last ID of previous page',
    )
  })
})
