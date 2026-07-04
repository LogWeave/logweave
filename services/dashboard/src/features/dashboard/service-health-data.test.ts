import { describe, expect, it } from 'vitest'
import type { AlertRule, ServiceRow, ThresholdConfig } from '../../api/types'
import {
  estimatedErrorCount,
  isUnhealthy,
  servicesWithThresholdRules,
  sortServicesByErrorImpact,
} from './service-health-data'

function svc(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    service: 'svc',
    logCount: 1000,
    errorCount: 0,
    warnCount: 0,
    errorRate: 0,
    warnRate: 0,
    newTemplateCount: 0,
    avgAnomalyScore: 0,
    ...overrides,
  }
}

function thresholdRule(service: string, ruleId = service): AlertRule {
  return {
    ruleId,
    name: `rule ${service}`,
    ruleType: 'threshold',
    enabled: true,
    config: {
      metric: 'error_count',
      service,
      operator: '>',
      value: 10,
      windowMinutes: 5,
    } satisfies ThresholdConfig,
    channels: [],
  }
}

describe('estimatedErrorCount', () => {
  it('multiplies log count by error rate and rounds', () => {
    expect(estimatedErrorCount({ logCount: 1000, errorRate: 0.023 })).toBe(23)
  })

  it('is zero when there are no errors', () => {
    expect(estimatedErrorCount({ logCount: 5000, errorRate: 0 })).toBe(0)
  })
})

describe('isUnhealthy', () => {
  it.each([
    [0.051, true],
    [0.05, false],
    [0.049, false],
    [0, false],
  ])('errorRate %f -> %s', (rate, expected) => {
    expect(isUnhealthy(rate)).toBe(expected)
  })
})

describe('sortServicesByErrorImpact', () => {
  it('ranks by estimated error count descending', () => {
    const rows = [
      svc({ service: 'low', logCount: 1000, errorRate: 0.01 }), // ~10 errors
      svc({ service: 'high', logCount: 1000, errorRate: 0.2 }), // ~200 errors
      svc({ service: 'mid', logCount: 1000, errorRate: 0.05 }), // ~50 errors
    ]
    expect(sortServicesByErrorImpact(rows).map((r) => r.service)).toEqual(['high', 'mid', 'low'])
  })

  it('breaks ties on equal error count by higher error rate', () => {
    const rows = [
      // Both ~100 errors, but "b" has the higher rate over fewer logs.
      svc({ service: 'a', logCount: 10_000, errorRate: 0.01 }),
      svc({ service: 'b', logCount: 1000, errorRate: 0.1 }),
    ]
    expect(sortServicesByErrorImpact(rows).map((r) => r.service)).toEqual(['b', 'a'])
  })

  it('does not mutate the input array', () => {
    const rows = [svc({ service: 'a', errorRate: 0.01 }), svc({ service: 'b', errorRate: 0.5 })]
    const snapshot = rows.map((r) => r.service)
    sortServicesByErrorImpact(rows)
    expect(rows.map((r) => r.service)).toEqual(snapshot)
  })

  it('returns an empty array for no services', () => {
    expect(sortServicesByErrorImpact([])).toEqual([])
  })
})

describe('servicesWithThresholdRules', () => {
  it('collects the service of each threshold rule', () => {
    const set = servicesWithThresholdRules([thresholdRule('api'), thresholdRule('web')])
    expect(set).toEqual(new Set(['api', 'web']))
  })

  it('ignores non-threshold rules', () => {
    const watch: AlertRule = {
      ruleId: 'w1',
      name: 'watch',
      ruleType: 'template_watch',
      enabled: true,
      config: { templateId: 't1', service: 'api' } as never,
      channels: [],
    }
    const set = servicesWithThresholdRules([thresholdRule('api'), watch])
    expect(set).toEqual(new Set(['api']))
  })

  it('deduplicates multiple rules on the same service', () => {
    const set = servicesWithThresholdRules([thresholdRule('api', 'r1'), thresholdRule('api', 'r2')])
    expect(set).toEqual(new Set(['api']))
  })

  it('returns an empty set for no rules', () => {
    expect(servicesWithThresholdRules([]).size).toBe(0)
  })
})
