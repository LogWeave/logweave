/**
 * Pure helpers for the Alerts page. Rule evaluation / firing / dedup all happen
 * server-side; what lives client-side is filtering the rule list, deriving
 * filter options, and classifying alert-history severity. Extracted here so
 * those transforms can be unit-tested without the page.
 */
import type { AlertHistoryEntry, AlertRule, ThresholdConfig } from '../../api/types'

const DAY_MS = 24 * 60 * 60 * 1000

export function isThresholdRule(rule: AlertRule): rule is AlertRule & { config: ThresholdConfig } {
  return rule.ruleType === 'threshold'
}

export interface RuleFilters {
  /** Match a specific ruleType. */
  type?: string
  /** Match a threshold rule's service (ignored for non-threshold rules). */
  service?: string
  /** 'enabled' | 'disabled' — match the rule's enabled flag. */
  status?: string
}

/** Filter rules by type, service, and enabled status. Empty filters pass all. */
export function filterRules(rules: AlertRule[], filters: RuleFilters): AlertRule[] {
  return rules.filter((r) => {
    if (filters.type && r.ruleType !== filters.type) return false
    if (filters.service && isThresholdRule(r) && r.config.service !== filters.service) return false
    if (filters.status === 'enabled' && !r.enabled) return false
    if (filters.status === 'disabled' && r.enabled) return false
    return true
  })
}

/** Distinct services referenced by threshold rules — the service filter options. */
export function ruleServices(rules: AlertRule[]): string[] {
  return [...new Set(rules.flatMap((r) => (isThresholdRule(r) ? [r.config.service] : [])))]
}

/** Count of enabled rules. */
export function countEnabledRules(rules: AlertRule[]): number {
  return rules.reduce((n, r) => (r.enabled ? n + 1 : n), 0)
}

/** Alerts fired within the trailing window (default 24h) of `nowMs`. */
export function recentAlerts(
  alerts: AlertHistoryEntry[],
  nowMs: number = Date.now(),
  windowMs: number = DAY_MS,
): AlertHistoryEntry[] {
  return alerts.filter((a) => nowMs - new Date(a.firedAt).getTime() < windowMs)
}

export type AlertSeverity = 'danger' | 'warning' | 'normal'

export interface AlertSeverityResult {
  /** metricValue / thresholdValue; 1 when the threshold is non-positive. */
  ratio: number
  level: AlertSeverity
}

/**
 * Severity of a fired alert from how far it overshot its threshold: >3x is
 * critical, >1.5x is a warning. A non-positive threshold yields a neutral 1x.
 */
export function alertSeverity(metricValue: number, thresholdValue: number): AlertSeverityResult {
  const ratio = thresholdValue > 0 ? metricValue / thresholdValue : 1
  const level: AlertSeverity = ratio > 3 ? 'danger' : ratio > 1.5 ? 'warning' : 'normal'
  return { ratio, level }
}

/**
 * Format a metric or threshold value for display. Threshold baselines are
 * computed floats that can carry a long fractional tail (e.g.
 * 16.97222222222222); round to at most 2 decimals and add grouping so the
 * alert history reads cleanly.
 */
export function formatMetric(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
