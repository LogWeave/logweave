import type { DbClient } from '../../src/db/client.js'

/**
 * Create a minimal mock DbClient that returns empty results.
 * Use for tests that don't need ClickHouse.
 */
export function createMockDb(): DbClient {
  return {
    query: async () => [],
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

export interface BaselineSpec {
  tenantId: string
  service: string
  templateId: string
  avgCount: number
  /**
   * UTC hour-of-day (0–23) this baseline applies to. Omit to fan out to all
   * 24 hours with the same avgCount — convenient for tests that don't care
   * about hour-of-day behaviour.
   */
  hourOfDay?: number
}

/**
 * Mock DbClient that returns anomaly baseline rows scoped to the queried
 * tenant_id. Matches the shape of `queryAnomalyBaselines` (template_id,
 * service, hour_of_day, avg_count_per_interval). Use when a test needs to
 * feed baselines into AnomalyScorer.refreshBaselines() without reaching
 * into the scorer's private state.
 */
export function createBaselineMockDb(baselines: BaselineSpec[]): DbClient {
  return {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      const tenantId = params.query_params?.tenant_id as string | undefined
      const rows: Array<{
        template_id: string
        service: string
        hour_of_day: number
        avg_count_per_interval: string
      }> = []
      for (const b of baselines) {
        if (b.tenantId !== tenantId) continue
        const hours =
          b.hourOfDay === undefined ? Array.from({ length: 24 }, (_, h) => h) : [b.hourOfDay]
        for (const hour of hours) {
          rows.push({
            template_id: b.templateId,
            service: b.service,
            hour_of_day: hour,
            avg_count_per_interval: String(b.avgCount),
          })
        }
      }
      return rows
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

// Dashboard query templates start with a `/* @query: <name> */` marker
// (see services/api/src/db/dashboard/*). Mocks route by that name rather
// than SQL fragments so refactors to the SQL don't break tests.
const QUERY_NAME_RE = /@query:\s*(\w+)/

export function extractQueryName(sql: string): string | undefined {
  return QUERY_NAME_RE.exec(sql)?.[1]
}

/**
 * Create a mock DbClient that routes by the `/* @query: <name> *\/` marker
 * embedded in each dashboard SQL template. Unknown query names throw so
 * that typos surface immediately instead of silently returning [].
 */
export function createQueryNameMockDb(queryResults?: Map<string, unknown>): DbClient {
  return {
    query: async (params: { query: string; query_params: Record<string, unknown> }) => {
      if (!queryResults) return []
      const name = extractQueryName(params.query)
      if (!name) {
        throw new Error(
          `mock DbClient: query missing @query marker — add a /* @query: <name> */ comment to the SQL template`,
        )
      }
      if (queryResults.has(name)) return queryResults.get(name)
      // Configured but no entry for this name: tests sometimes intentionally
      // leave queries unmocked (e.g. empty-result tests). Default to [].
      return []
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
}

/**
 * Create a mock DbClient that captures queries for assertion.
 * Returns `{ db, queries }` where `queries` is an array of captured query strings.
 */
export function createCapturingDb(mockResponses?: Map<string, unknown[]>): {
  db: DbClient
  queries: string[]
} {
  const queries: string[] = []
  const db = {
    query: async (params: { query: string }) => {
      queries.push(params.query)
      if (mockResponses) {
        for (const [key, value] of mockResponses) {
          if (params.query.includes(key)) return value
        }
      }
      return []
    },
    insert: async () => {},
    command: async () => {},
    ping: async () => true,
    close: async () => {},
  } as unknown as DbClient
  return { db, queries }
}
