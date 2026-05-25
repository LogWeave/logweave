import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import pino from 'pino'
import { ClusterClient } from '../../src/pipeline/cluster-client.js'

const CLUSTERER_URL = process.env.LOGWEAVE_CLUSTERER_URL ?? 'http://localhost:8000'
const TIMEOUT_MS = 2000 // generous timeout for Docker

describe('ClusterClient integration (requires Docker Compose)', () => {
  let reachable = false

  before(async () => {
    // Skip all tests if clusterer is unreachable
    try {
      const res = await fetch(`${CLUSTERER_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      reachable = res.ok
    } catch {
      reachable = false
    }
  })

  it('clusters real messages and returns UUIDv7 template_ids', async (t) => {
    if (!reachable) {
      t.skip('Clusterer not reachable — run docker compose up first')
      return
    }

    const logger = pino({ level: 'silent' })
    const client = new ClusterClient(CLUSTERER_URL, TIMEOUT_MS, logger)

    const results = await client.cluster('integration-test', [
      'User alice logged in from 192.168.1.1',
      'User bob logged in from 10.0.0.2',
      'Connection timeout after 30s',
    ])

    assert.equal(results.length, 3)
    assert.equal(client.consecutiveFailures, 0)

    // All results should have non-zero template IDs (UUIDv7 format)
    for (const result of results) {
      assert.notEqual(result.templateId, '0', 'Expected real template_id, got fallback')
      assert.ok(result.templateText.length > 0, 'Expected non-empty template_text')
      assert.equal(typeof result.isNewTemplate, 'boolean')
    }

    // Similar messages should get the same template
    assert.equal(
      results[0]?.templateId,
      results[1]?.templateId,
      'Similar log-in messages should share a template',
    )
  })
})
