import { type ClickHouseClient, createClient } from '@clickhouse/client'
import type { DbClient } from '../db/client.js'

export function createClickHouseClient(
  url: string,
  username?: string,
  password?: string,
): ClickHouseClient {
  return createClient({
    url,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    request_timeout: 10_000,
    application: 'logweave-api',
    compression: { request: true },
  })
}

export async function pingClickHouse(db: DbClient): Promise<boolean> {
  return db.ping()
}
