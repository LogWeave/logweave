import { beforeEach, describe, expect, it } from 'vitest'
import { type TimeRange, timeRangeToHours, useDashboardStore } from './dashboard-store'

// The store is a persisted singleton. Capture its pristine state once, then
// restore it before every test so cases can't leak into one another and the
// localStorage-backed persistence never carries over.
const initialState = useDashboardStore.getState()

function resetStore() {
  useDashboardStore.setState(initialState, true)
  localStorage.clear()
}

describe('timeRangeToHours', () => {
  it.each<[TimeRange, number]>([
    ['1h', 1],
    ['6h', 6],
    ['24h', 24],
    ['7d', 168],
  ])('maps %s to %i hours', (range, hours) => {
    expect(timeRangeToHours(range)).toBe(hours)
  })
})

describe('dashboard store', () => {
  beforeEach(resetStore)

  it('starts with sensible defaults', () => {
    const s = useDashboardStore.getState()
    expect(s.timeRange).toBe('24h')
    expect(s.serviceFilter).toBeNull()
    expect(s.selectedTemplateId).toBeNull()
    expect(s.levelFilters).toEqual([])
    expect(s.hiddenTemplateIds).toEqual([])
  })

  it('setTimeRange updates the range', () => {
    useDashboardStore.getState().setTimeRange('7d')
    expect(useDashboardStore.getState().timeRange).toBe('7d')
  })

  it('changing the service filter clears the selected template', () => {
    const store = useDashboardStore.getState()
    store.setSelectedTemplateId('tpl-123')
    expect(useDashboardStore.getState().selectedTemplateId).toBe('tpl-123')

    store.setServiceFilter('api')
    const next = useDashboardStore.getState()
    expect(next.serviceFilter).toBe('api')
    // Selecting a new service must drop the stale template selection.
    expect(next.selectedTemplateId).toBeNull()
  })

  it('selecting a time-window range clears the investigating status code', () => {
    const store = useDashboardStore.getState()
    store.setInvestigatingStatusCode(500)
    expect(useDashboardStore.getState().investigatingStatusCode).toBe(500)

    store.setSelectedTimeRange({ start: '2026-07-03T00:00:00Z', end: '2026-07-03T01:00:00Z' })
    expect(useDashboardStore.getState().investigatingStatusCode).toBeNull()
  })

  describe('hidden templates', () => {
    it('toggleHideTemplate adds then removes an id', () => {
      const store = useDashboardStore.getState()
      store.toggleHideTemplate('a')
      expect(useDashboardStore.getState().hiddenTemplateIds).toEqual(['a'])

      store.toggleHideTemplate('a')
      expect(useDashboardStore.getState().hiddenTemplateIds).toEqual([])
    })

    it('hideAllTemplates unions without duplicating existing ids', () => {
      const store = useDashboardStore.getState()
      store.toggleHideTemplate('a')
      store.hideAllTemplates(['a', 'b', 'c'])
      const ids = useDashboardStore.getState().hiddenTemplateIds
      expect([...ids].sort()).toEqual(['a', 'b', 'c'])
    })

    it('unhideAllTemplates clears the list', () => {
      const store = useDashboardStore.getState()
      store.hideAllTemplates(['a', 'b'])
      store.unhideAllTemplates()
      expect(useDashboardStore.getState().hiddenTemplateIds).toEqual([])
    })
  })

  it('setLevelFilters replaces the level list', () => {
    const store = useDashboardStore.getState()
    store.setLevelFilters(['ERROR', 'WARN'])
    expect(useDashboardStore.getState().levelFilters).toEqual(['ERROR', 'WARN'])
    store.setLevelFilters([])
    expect(useDashboardStore.getState().levelFilters).toEqual([])
  })

  it('toggleColorMode flips between dark and light', () => {
    expect(useDashboardStore.getState().colorMode).toBe('dark')
    useDashboardStore.getState().toggleColorMode()
    expect(useDashboardStore.getState().colorMode).toBe('light')
    useDashboardStore.getState().toggleColorMode()
    expect(useDashboardStore.getState().colorMode).toBe('dark')
  })

  it('toggleTailTimezone flips between local and utc', () => {
    expect(useDashboardStore.getState().tailTimezone).toBe('local')
    useDashboardStore.getState().toggleTailTimezone()
    expect(useDashboardStore.getState().tailTimezone).toBe('utc')
  })
})
