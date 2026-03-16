import { generateEvents } from '../../services/api/tests/e2e/log-generator.js'

/**
 * Pre-generates HTTP request payloads as JSON strings for autocannon.
 * Payloads are generated once at startup — autocannon round-robins through them.
 * Uses the E2E log generator for realistic, diverse event data.
 */

export interface FixtureSet {
  /** JSON string payloads ready for HTTP body */
  readonly payloads: readonly string[]
  /** Number of events per payload */
  readonly batchSize: number
}

const PAYLOADS_PER_SIZE = 20

export function generateFixtures(batchSize: number, service = 'bench-service'): FixtureSet {
  const payloads: string[] = []

  for (let i = 0; i < PAYLOADS_PER_SIZE; i++) {
    const events = generateEvents(batchSize)
    const payload = JSON.stringify({
      service,
      environment: 'bench',
      events,
    })
    payloads.push(payload)
  }

  return { payloads, batchSize }
}

/**
 * Pre-generate fixtures for all batch sizes found in scenarios.
 * Returns a map of batchSize → FixtureSet for fast lookup during benchmarking.
 */
export function generateAllFixtures(batchSizes: readonly number[]): Map<number, FixtureSet> {
  const map = new Map<number, FixtureSet>()
  const unique = [...new Set(batchSizes)]
  for (const size of unique) {
    map.set(size, generateFixtures(size))
  }
  return map
}

/**
 * Generate multi-tenant fixtures — each tenant gets its own payloads.
 * Returns a map of tenantId → FixtureSet.
 */
export function generateMultiTenantFixtures(
  tenantCount: number,
  batchSize: number,
): Map<string, FixtureSet> {
  const map = new Map<string, FixtureSet>()
  for (let i = 0; i < tenantCount; i++) {
    const tenantId = `bench-tenant-${i.toString()}`
    map.set(tenantId, generateFixtures(batchSize, `bench-service-${i.toString()}`))
  }
  return map
}
