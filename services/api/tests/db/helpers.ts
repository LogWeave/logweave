import crypto from 'node:crypto'
import type { ClickHouseClient, ResultSet } from '@clickhouse/client'
import { createClient } from '@clickhouse/client'
import { DbClient } from '../../src/db/client.js'

const CLICKHOUSE_URL = process.env.LOGWEAVE_CLICKHOUSE_URL ?? 'http://default:logweave@localhost:8123'

let sharedClient: ClickHouseClient | undefined
let sharedDb: DbClient | undefined

export function getTestClient(): ClickHouseClient {
  if (!sharedClient) {
    sharedClient = createClient({ url: CLICKHOUSE_URL })
  }
  return sharedClient
}

export function getTestDb(): DbClient {
  if (!sharedDb) {
    sharedDb = new DbClient(getTestClient())
  }
  return sharedDb
}

export async function closeTestClient(): Promise<void> {
  sharedDb = undefined
  if (sharedClient) {
    await sharedClient.close()
    sharedClient = undefined
  }
}

/** Generate a unique tenant_id per test run to isolate test data */
export function testTenantId(suite: string): string {
  const rand = crypto.randomBytes(4).toString('hex')
  return `test-${suite}-${rand}`
}

/**
 * Type-safe row extraction from ClickHouse ResultSet.
 * Handles both JSON format ({ data: T[] }) and JSONEachRow format (T[]).
 */
export async function jsonRows<T>(result: ResultSet): Promise<T[]> {
  const json = (await result.json()) as unknown as { data: T[] } | T[]
  return Array.isArray(json) ? json : json.data
}
