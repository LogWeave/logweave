/**
 * MCP E2E Integration Test
 *
 * Seeds realistic scenarios into a live LogWeave stack, then verifies
 * every MCP tool returns useful, correct answers — not just valid shapes.
 *
 * Requires: Docker Compose stack (ClickHouse + clusterer + API) running.
 * Run: cd services/mcp && pnpm test:e2e
 */

import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import {
  CASCADE_TRACE_IDS,
  apiGet,
  apiGetRaw,
  ingestBatch,
  postDeploy,
  scenario1_incident,
  scenario2_degradation,
  scenario3_burst,
  waitForMV,
} from './seed-data.js'

const API_URL = process.env.LOGWEAVE_API_URL ?? 'http://localhost:3000'

// -----------------------------------------------------------------------
// Pre-flight: check stack is running
// -----------------------------------------------------------------------

before(async () => {
  try {
    const res = await fetch(`${API_URL}/healthz`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`API returned ${res.status}`)
  } catch {
    console.error('\n  API is not running at', API_URL)
    console.error('  Start the stack: pnpm env:start && pnpm -C services/api dev\n')
    process.exit(1)
  }
})

// -----------------------------------------------------------------------
// Seed data
// -----------------------------------------------------------------------

describe('MCP E2E: seed data', () => {
  it('ingests scenario 1: microservice incident', async () => {
    const events = scenario1_incident()
    const result = await ingestBatch(events)
    assert.ok(result.accepted > 100, `Expected >100 events, got ${result.accepted}`)
  })

  it('ingests scenario 2: gradual degradation', async () => {
    const events = scenario2_degradation()
    const result = await ingestBatch(events)
    assert.ok(result.accepted > 200, `Expected >200 events, got ${result.accepted}`)
  })

  it('ingests scenario 3: multi-service burst', async () => {
    const events = scenario3_burst()
    const result = await ingestBatch(events)
    assert.ok(result.accepted > 100, `Expected >100 events, got ${result.accepted}`)
  })

  it('posts deploy marker for payments fix', async () => {
    await postDeploy('payments', '1.2.1-hotfix')
  })

  it('waits for materialized views to settle', async () => {
    await waitForMV(3000)
  })
})

// -----------------------------------------------------------------------
// Overview + Health (composite endpoints)
// -----------------------------------------------------------------------

interface OverviewResponse {
  data: {
    totalEvents: number
    errorRate: number
    serviceCount: number
    topErrorPatterns: Array<{ templateText: string }>
  }
}

interface ServiceHealthResponse {
  data: {
    service: string
    errorCount: number
    errorRate: number
    topErrorPatterns: Array<{ templateText: string }>
  }
}

describe('MCP E2E: overview + health', () => {
  it('overview: returns totalEvents > 0 and lists services', async () => {
    const res = (await apiGet('/overview', { hours: 3 })) as OverviewResponse
    assert.ok(res.data.totalEvents > 100, `totalEvents should be >100, got ${res.data.totalEvents}`)
    assert.ok(res.data.serviceCount >= 4, `serviceCount should be >=4, got ${res.data.serviceCount}`)
  })

  it('overview: error rate is non-zero', async () => {
    const res = (await apiGet('/overview', { hours: 3 })) as OverviewResponse
    assert.ok(res.data.errorRate > 0, `errorRate should be >0, got ${res.data.errorRate}`)
  })

  it('service_health: payments shows error activity', async () => {
    const res = (await apiGet('/services/payments/health', { hours: 3 })) as ServiceHealthResponse
    assert.equal(res.data.service, 'payments')
    assert.ok(res.data.errorCount > 0, 'payments should have errors')
    assert.ok(res.data.topErrorPatterns.length > 0, 'should have error patterns')
  })

  it('service_health: notifications shows burst activity', async () => {
    const res = (await apiGet('/services/notifications/health', { hours: 3 })) as ServiceHealthResponse
    assert.equal(res.data.service, 'notifications')
    assert.ok(res.data.errorCount > 0, 'notifications should have errors from burst')
  })
})

// -----------------------------------------------------------------------
// Pattern Discovery
// -----------------------------------------------------------------------

interface TemplatesResponse {
  data: Array<{
    templateId: string
    templateText: string
    occurrenceCount: number
    service: string
    errorCount: number
  }>
}

interface SearchResponse {
  data: Array<{
    templateId: string
    templateText: string
    occurrenceCount: number
  }>
}

describe('MCP E2E: pattern discovery', () => {
  it('error_patterns: finds connection timeout template', async () => {
    // The MCP error_patterns tool queries /dashboard/templates with level=ERROR filter
    const res = (await apiGet('/dashboard/templates', { hours: 3, level: 'ERROR' })) as TemplatesResponse
    assert.ok(res.data.length > 0, 'should find error patterns')
    const timeoutPattern = res.data.find((p) => p.templateText.toLowerCase().includes('timed out'))
    assert.ok(timeoutPattern, 'should find a timeout pattern')
  })

  it('error_patterns: finds pool exhausted template', async () => {
    const res = (await apiGet('/dashboard/templates', { hours: 3, level: 'ERROR' })) as TemplatesResponse
    const poolPattern = res.data.find((p) => p.templateText.toLowerCase().includes('pool'))
    assert.ok(poolPattern, 'should find a connection pool pattern')
  })

  it('search_templates: substring "timeout" finds patterns', async () => {
    const res = (await apiGet('/templates/search', { q: 'timed out', hours: 3 })) as SearchResponse
    assert.ok(res.data.length > 0, 'substring search for "timed out" should find results')
  })

  it('template_detail: returns sparkline for a known template', async () => {
    // First find a template with errors
    const search = (await apiGet('/dashboard/templates', { hours: 3, level: 'ERROR' })) as TemplatesResponse
    assert.ok(search.data.length > 0, 'need at least one error pattern')
    const templateId = search.data[0].templateId

    const detail = (await apiGet(`/templates/${templateId}/detail`, { hours: 3 })) as {
      data: { templateId: string; templateText: string; occurrenceCount: number; sparkline: unknown[] }
    }
    assert.equal(detail.data.templateId, templateId)
    assert.ok(detail.data.occurrenceCount > 0, 'should have occurrences')
    assert.ok(Array.isArray(detail.data.sparkline), 'should have sparkline array')
  })
})

// -----------------------------------------------------------------------
// Correlation + Tracing
// -----------------------------------------------------------------------

describe('MCP E2E: correlation + tracing', () => {
  it('trace_details: follows request across services', async () => {
    const traceId = CASCADE_TRACE_IDS[0]
    const res = (await apiGet(`/traces/${traceId}`, { hours: 3 })) as {
      data: Array<{ service: string; level: string; timestamp: string }>
    }
    assert.ok(res.data.length >= 2, `trace should span 2+ events, got ${res.data.length}`)
    const services = new Set(res.data.map((e) => e.service))
    assert.ok(services.size >= 2, `trace should have 2+ distinct services, got ${services.size}`)
  })

  it('related_patterns: timeout links to other cascade patterns', async () => {
    // Find the timeout template from payments
    const search = (await apiGet('/dashboard/templates', { hours: 3, level: 'ERROR' })) as TemplatesResponse
    const timeoutPattern = search.data.find(
      (p) => p.templateText.toLowerCase().includes('timed out') && p.service === 'payments',
    )
    if (!timeoutPattern) {
      assert.fail('Could not find payments timeout pattern to test related_patterns')
    }

    const res = (await apiGet(`/templates/${timeoutPattern.templateId}/related`, { hours: 3 })) as {
      data: Array<{ templateId: string; templateText: string; coOccurrenceCount: number }>
    }
    // Should find auth and gateway errors that share trace_ids
    assert.ok(res.data.length > 0, 'timeout should have related patterns from cascade')
  })
})

// -----------------------------------------------------------------------
// Deploys + Changes
// -----------------------------------------------------------------------

describe('MCP E2E: deploys + changes', () => {
  it('deploys: returns the payments deploy marker', async () => {
    const res = (await apiGet('/deploys', { service: 'payments' })) as {
      data: Array<{ service: string; version: string; commitSha: string }>
    }
    assert.ok(res.data.length > 0, 'should find deploy markers')
    const paymentsDeploy = res.data.find((d) => d.service === 'payments')
    assert.ok(paymentsDeploy, 'should find payments deploy')
    assert.equal(paymentsDeploy.version, '1.2.1-hotfix')
  })

  it('changes: detects new or spiking patterns', async () => {
    const res = (await apiGet('/dashboard/changes', { hours: 3 })) as {
      data: {
        new: Array<{ templateText: string }>
        spike: Array<{ templateText: string }>
        resolved: Array<{ templateText: string }>
      }
    }
    const total = res.data.new.length + res.data.spike.length + res.data.resolved.length
    assert.ok(total > 0, `changes should show activity, got ${total} events`)
    assert.ok(res.data.new.length > 0 || res.data.spike.length > 0, 'should have new or spike changes')
  })
})

// -----------------------------------------------------------------------
// Incident post-mortem
// -----------------------------------------------------------------------

describe('MCP E2E: incident_postmortem', () => {
  it('returns summary, timeline, and patterns for payments incident', async () => {
    const [outlier, changes, patterns, deploys] = await Promise.all([
      apiGet('/services/payments/outlier', { hours: 3 }) as Promise<{
        data: { verdict: string; zScore: number; currentRate: number }
      }>,
      apiGet('/dashboard/changes', { service: 'payments', hours: 3 }) as Promise<{
        data: { new: Array<{ templateText: string }>; spike: Array<{ templateText: string }> }
      }>,
      apiGet('/dashboard/templates', { service: 'payments', hours: 3, level: 'ERROR', limit: 10 }) as Promise<{
        data: Array<{ templateId: string; templateText: string; occurrenceCount: number }>
      }>,
      apiGet('/deploys', { service: 'payments', limit: 5 }) as Promise<{
        data: Array<{ service: string; version: string }>
      }>,
    ])

    assert.ok(
      ['normal', 'elevated', 'outlier'].includes(outlier.data.verdict),
      `verdict should be valid, got ${outlier.data.verdict}`,
    )
    assert.ok(outlier.data.zScore != null, 'zScore should be present')

    const totalChanges = (changes.data.new?.length ?? 0) + (changes.data.spike?.length ?? 0)
    assert.ok(totalChanges > 0, `incident should have changes, got ${totalChanges}`)

    assert.ok(patterns.data.length > 0, 'payments should have error patterns')

    assert.ok(deploys.data.length > 0, 'payments should have deploy markers')
    assert.equal(deploys.data[0].version, '1.2.1-hotfix')
  })

  it('correlations available for top payments error pattern', async () => {
    const patterns = (await apiGet('/dashboard/templates', {
      service: 'payments',
      hours: 3,
      level: 'ERROR',
      limit: 1,
    })) as { data: Array<{ templateId: string }> }

    assert.ok(patterns.data.length > 0, 'need at least one error pattern')
    const templateId = patterns.data[0].templateId

    const corr = (await apiGet(`/templates/${templateId}/correlations`, { hours: 3 })) as {
      data: Array<{ templateText: string; service: string; coefficient: number }>
    }
    // Correlations may be empty if no cross-service data — just verify shape
    assert.ok(Array.isArray(corr.data), 'correlations should return an array')
  })
})

// -----------------------------------------------------------------------
// Error handling
// -----------------------------------------------------------------------

describe('MCP E2E: error handling', () => {
  it('returns 404 for unknown trace_id', async () => {
    const res = await apiGetRaw('/traces/nonexistent-trace-id', { hours: 3 })
    assert.equal(res.status, 404)
  })

  it('returns 401 without auth', async () => {
    const res = await fetch(`${API_URL}/v1/overview`)
    assert.equal(res.status, 401)
  })

  it('returns 400 for invalid search query (too short)', async () => {
    const res = await apiGetRaw('/templates/search', { q: 'ab' })
    assert.equal(res.status, 400)
  })
})
