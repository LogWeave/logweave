/**
 * Pure helpers for the Service Health cards. Extracted so the ranking and the
 * rule-coverage lookup can be unit-tested independently of the card rendering.
 */
import type { AlertRule, ServiceRow, ThresholdConfig } from '../../api/types'

/** errorRate above this fraction marks a service as unhealthy (red icon). */
export const UNHEALTHY_ERROR_RATE = 0.05

/** Estimated absolute error count for a service, used as the primary sort key. */
export function estimatedErrorCount(row: Pick<ServiceRow, 'logCount' | 'errorRate'>): number {
  return Math.round(row.logCount * row.errorRate)
}

/**
 * Rank services by error impact: highest estimated error count first, ties
 * broken by the higher error rate. Returns a new array; the input is untouched.
 */
export function sortServicesByErrorImpact(rows: ServiceRow[]): ServiceRow[] {
  return [...rows].sort((a, b) => {
    return estimatedErrorCount(b) - estimatedErrorCount(a) || b.errorRate - a.errorRate
  })
}

/** Whether a service's error rate crosses the unhealthy threshold. */
export function isUnhealthy(errorRate: number): boolean {
  return errorRate > UNHEALTHY_ERROR_RATE
}

/**
 * Set of service names already covered by a threshold alert rule. Non-threshold
 * rules (template watches) are ignored — they don't target a single service.
 */
export function servicesWithThresholdRules(rules: AlertRule[]): Set<string> {
  return new Set(
    rules
      .filter((r) => r.ruleType === 'threshold')
      .map((r) => (r.config as ThresholdConfig).service),
  )
}
