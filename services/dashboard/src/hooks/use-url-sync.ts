import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useDashboardStore } from '../stores/dashboard-store'
import { buildUrlParams, parseUrlParams } from './url-sync'

/**
 * Two-way sync between dashboard store and URL search params.
 * URL params take precedence on initial load. Store changes update the URL.
 *
 * Synced params: range, service, level, template
 */
export function useUrlSync() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialized = useRef(false)

  const timeRange = useDashboardStore((s) => s.timeRange)
  const serviceFilter = useDashboardStore((s) => s.serviceFilter)
  const levelFilters = useDashboardStore((s) => s.levelFilters)
  const selectedTemplateId = useDashboardStore((s) => s.selectedTemplateId)
  const setTimeRange = useDashboardStore((s) => s.setTimeRange)
  const setServiceFilter = useDashboardStore((s) => s.setServiceFilter)
  const setLevelFilters = useDashboardStore((s) => s.setLevelFilters)
  const setSelectedTemplateId = useDashboardStore((s) => s.setSelectedTemplateId)

  // On mount: read URL params and apply to store. Mount-once read of the
  // initial query string — we don't want the effect to re-fire when the
  // store setters or searchParams change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once URL read
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const parsed = parseUrlParams(searchParams)
    if (parsed.range !== undefined) setTimeRange(parsed.range)
    if (parsed.service !== undefined) setServiceFilter(parsed.service)
    if (parsed.levels !== undefined) setLevelFilters(parsed.levels)
    if (parsed.template !== undefined) setSelectedTemplateId(parsed.template)
  }, [])

  // On store change: update URL params
  useEffect(() => {
    if (!initialized.current) return

    const params = buildUrlParams({
      timeRange,
      serviceFilter,
      levelFilters,
      selectedTemplateId,
    })

    setSearchParams(params, { replace: true })
  }, [timeRange, serviceFilter, levelFilters, selectedTemplateId, setSearchParams])
}
