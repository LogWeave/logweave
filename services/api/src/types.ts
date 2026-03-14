import type { ClickHouseClient } from '@clickhouse/client'

export type { ClickHouseClient }

export interface ClustererHealth {
  consecutiveFailures: number
  lastChecked: number
}
