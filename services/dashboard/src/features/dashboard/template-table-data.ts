/**
 * Pure helpers for the Patterns (template) table. Sorting is delegated to
 * TanStack Table; what lives here is the visibility filtering, sparkline
 * selection, search predicate, and stale-hidden-id reconciliation — extracted
 * so they can be unit-tested without the virtualized table.
 */
import type { TemplateRow } from '../../api/types'

export interface VisibilityFilter {
  /** Template ids the user has hidden. */
  hiddenIds: string[]
  /** When true, hidden rows are shown (dimmed) rather than removed. */
  showHidden: boolean
  /** When true, restrict to watched templates only. */
  watchedOnly: boolean
  /** Set of watched template ids. */
  watchedIds: Set<string>
}

/**
 * The rows the table should display given the current visibility toggles.
 * Hidden rows drop out unless showHidden is on; watchedOnly further narrows to
 * the watched set. Returns a new array; the input is untouched.
 */
export function filterVisibleTemplates(
  templates: TemplateRow[],
  { hiddenIds, showHidden, watchedOnly, watchedIds }: VisibilityFilter,
): TemplateRow[] {
  const hidden = new Set(hiddenIds)
  let filtered = showHidden ? templates : templates.filter((t) => !hidden.has(t.templateId))
  if (watchedOnly) {
    filtered = filtered.filter((t) => watchedIds.has(t.templateId))
  }
  return filtered
}

/**
 * Ids of the top-N templates by anomaly score — the set we fetch sparklines
 * for. Ranked highest score first; ties keep input order. Does not mutate.
 */
export function topSparklineIds(templates: TemplateRow[], limit = 20): string[] {
  return [...templates]
    .sort((a, b) => b.maxAnomalyScore - a.maxAnomalyScore)
    .slice(0, limit)
    .map((t) => t.templateId)
}

/** Case-insensitive search across a row's template text and service name. */
export function matchesTemplateSearch(row: TemplateRow, search: string): boolean {
  const q = search.toLowerCase()
  return row.templateText.toLowerCase().includes(q) || row.service.toLowerCase().includes(q)
}

/**
 * Hidden ids that no longer correspond to any current template, so the caller
 * can prune them from persisted state (they'd otherwise accumulate forever).
 */
export function staleHiddenIds(templates: TemplateRow[], hiddenIds: string[]): string[] {
  if (templates.length === 0 || hiddenIds.length === 0) return []
  const currentIds = new Set(templates.map((t) => t.templateId))
  return hiddenIds.filter((id) => !currentIds.has(id))
}

/** Count of current templates that are hidden. */
export function countHidden(templates: TemplateRow[], hiddenIds: string[]): number {
  const hidden = new Set(hiddenIds)
  return templates.reduce((n, t) => (hidden.has(t.templateId) ? n + 1 : n), 0)
}
