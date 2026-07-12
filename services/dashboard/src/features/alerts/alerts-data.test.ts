import { describe, expect, it } from 'vitest'
import type { AlertHistoryEntry, AlertRule, ThresholdConfig } from '../../api/types'
import {
  alertSeverity,
  countEnabledRules,
  filterRules,
  isThresholdRule,
  recentAlerts,
  ruleServices,
} from './alerts-data'

function thresholdRule(overrides: Partial<AlertRule> = {}, service = 'api'): AlertRule {
  return {
    ruleId: `r-${service}`,
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
    ...overrides,
  }
}

function watchRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    ruleId: 'w1',
    name: 'watch',
    ruleType: 'template_watch',
    enabled: true,
    config: { templateId: 't1', templateText: 'boom', service: 'api' } as never,
    channels: [],
    ...overrides,
  }
}

function alert(firedAt: string, overrides: Partial<AlertHistoryEntry> = {}): AlertHistoryEntry {
  return {
    alertId: `a-${firedAt}`,
    ruleId: 'r1',
    ruleType: 'threshold',
    ruleName: 'rule',
    firedAt,
    metricValue: 20,
    thresholdValue: 10,
    details: {},
    channelsNotified: [],
    ...overrides,
  }
}

describe('isThresholdRule', () => {
  it('narrows threshold rules and rejects watches', () => {
    expect(isThresholdRule(thresholdRule())).toBe(true)
    expect(isThresholdRule(watchRule())).toBe(false)
  })
})

describe('filterRules', () => {
  const rules = [
    thresholdRule({ ruleId: 'api-on', enabled: true }, 'api'),
    thresholdRule({ ruleId: 'web-off', enabled: false }, 'web'),
    watchRule({ ruleId: 'watch-on', enabled: true }),
  ]

  it('passes all rules through empty filters', () => {
    expect(filterRules(rules, {})).toHaveLength(3)
  })

  it('filters by rule type', () => {
    expect(filterRules(rules, { type: 'template_watch' }).map((r) => r.ruleId)).toEqual([
      'watch-on',
    ])
  })

  it('filters by threshold service, dropping only mismatched threshold rules', () => {
    // web-off (threshold, service 'web') is dropped; watch-on has no service
    // dimension and passes through — see the dedicated passthrough test below.
    expect(filterRules(rules, { service: 'api' }).map((r) => r.ruleId)).toEqual([
      'api-on',
      'watch-on',
    ])
  })

  it('does not drop non-threshold rules on a service filter mismatch', () => {
    // Watch rules have no service dimension; a service filter should not remove
    // them (the guard only applies the service check to threshold rules).
    const out = filterRules([watchRule({ ruleId: 'watch-on' })], { service: 'api' })
    expect(out.map((r) => r.ruleId)).toEqual(['watch-on'])
  })

  it('filters by enabled status', () => {
    expect(filterRules(rules, { status: 'enabled' }).map((r) => r.ruleId)).toEqual([
      'api-on',
      'watch-on',
    ])
  })

  it('filters by disabled status', () => {
    expect(filterRules(rules, { status: 'disabled' }).map((r) => r.ruleId)).toEqual(['web-off'])
  })

  it('applies multiple filters together', () => {
    expect(
      filterRules(rules, { type: 'threshold', status: 'enabled' }).map((r) => r.ruleId),
    ).toEqual(['api-on'])
  })
})

describe('ruleServices', () => {
  it('returns distinct services from threshold rules only', () => {
    const rules = [
      thresholdRule({}, 'api'),
      thresholdRule({ ruleId: 'r2' }, 'web'),
      thresholdRule({ ruleId: 'r3' }, 'api'),
      watchRule(),
    ]
    expect(ruleServices(rules)).toEqual(['api', 'web'])
  })

  it('returns empty when there are no threshold rules', () => {
    expect(ruleServices([watchRule()])).toEqual([])
  })
})

describe('countEnabledRules', () => {
  it('counts only enabled rules', () => {
    const rules = [
      thresholdRule({ enabled: true }, 'a'),
      thresholdRule({ ruleId: 'r2', enabled: false }, 'b'),
      thresholdRule({ ruleId: 'r3', enabled: true }, 'c'),
    ]
    expect(countEnabledRules(rules)).toBe(2)
  })
})

describe('recentAlerts', () => {
  const now = new Date('2026-07-03T12:00:00Z').getTime()

  it('keeps alerts within the trailing 24h window', () => {
    const alerts = [
      alert('2026-07-03T11:00:00Z'), // 1h ago -> keep
      alert('2026-07-02T13:00:00Z'), // 23h ago -> keep
      alert('2026-07-02T11:00:00Z'), // 25h ago -> drop
    ]
    expect(recentAlerts(alerts, now).map((a) => a.firedAt)).toEqual([
      '2026-07-03T11:00:00Z',
      '2026-07-02T13:00:00Z',
    ])
  })

  it('honors a custom window', () => {
    const alerts = [alert('2026-07-03T11:00:00Z'), alert('2026-07-03T09:00:00Z')]
    // 2h window -> only the 1h-ago alert survives.
    expect(recentAlerts(alerts, now, 2 * 60 * 60 * 1000)).toHaveLength(1)
  })
})

describe('alertSeverity', () => {
  it.each([
    [40, 10, 4, 'danger'],
    [31, 10, 3.1, 'danger'],
    [20, 10, 2, 'warning'],
    [16, 10, 1.6, 'warning'],
    [10, 10, 1, 'normal'],
    [5, 10, 0.5, 'normal'],
  ] as const)('metric %i / threshold %i -> %fx %s', (metric, threshold, ratio, level) => {
    const result = alertSeverity(metric, threshold)
    expect(result.ratio).toBeCloseTo(ratio, 5)
    expect(result.level).toBe(level)
  })

  it('returns a neutral 1x for a non-positive threshold (no divide-by-zero)', () => {
    expect(alertSeverity(50, 0)).toEqual({ ratio: 1, level: 'normal' })
  })
})
