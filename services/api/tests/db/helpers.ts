import crypto from 'node:crypto'
import type { ClickHouseClient, ResultSet } from '@clickhouse/client'
import { createClient } from '@clickhouse/client'

const CLICKHOUSE_URL = process.env.LOGWEAVE_CLICKHOUSE_URL ?? 'http://localhost:8123'

let sharedClient: ClickHouseClient | undefined

export function getTestClient(): ClickHouseClient {
  if (!sharedClient) {
    sharedClient = createClient({ url: CLICKHOUSE_URL, database: 'logweave' })
  }
  return sharedClient
}

export async function closeTestClient(): Promise<void> {
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

/** Type-safe row extraction from ClickHouse ResultSet */
export async function jsonRows<T>(result: ResultSet): Promise<T[]> {
  // ResponseJSON is a union type; for JSONEachRow/JSON queries it's always T[]
  return (await result.json()) as unknown as T[]
}
