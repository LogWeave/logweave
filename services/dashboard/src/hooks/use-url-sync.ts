import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { type TimeRange, useDashboardStore } from '../stores/dashboard-store'

const VALID_TIME_RANGES = new Set(['1h', '6h', '24h', '7d'])

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

  // On mount: read URL params and apply to store
  useEffect(() => {
    if (initialized.current) return
    initialized.current = true

    const range = searchParams.get('range')
    if (range && VALID_TIME_RANGES.has(range)) {
      setTimeRange(range as TimeRange)
    }

    const service = searchParams.get('service')
    if (service) {
      setServiceFilter(service)
    }

    const level = searchParams.get('level')
    if (level) {
      setLevelFilters(level.split(',').filter(Boolean))
    }

    const template = searchParams.get('template')
    if (template) {
      setSelectedTemplateId(template)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // On store change: update URL params
  useEffect(() => {
    if (!initialized.current) return

    const params = new URLSearchParams()
    if (timeRange !== '24h') params.set('range', timeRange)
    if (serviceFilter) params.set('service', serviceFilter)
    if (levelFilters.length > 0) params.set('level', levelFilters.join(','))
    if (selectedTemplateId) params.set('template', selectedTemplateId)

    setSearchParams(params, { replace: true })
  }, [timeRange, serviceFilter, levelFilters, selectedTemplateId, setSearchParams])
}
