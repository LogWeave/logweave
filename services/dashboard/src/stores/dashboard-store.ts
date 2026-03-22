import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type TimeRange = '1h' | '6h' | '24h' | '7d'
export type ColorMode = 'dark' | 'light'

interface DashboardState {
  timeRange: TimeRange
  setTimeRange: (range: TimeRange) => void
  serviceFilter: string | null
  setServiceFilter: (service: string | null) => void
  colorMode: ColorMode
  toggleColorMode: () => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  selectedTemplateId: string | null
  setSelectedTemplateId: (id: string | null) => void
  hiddenTemplateIds: string[]
  toggleHideTemplate: (id: string) => void
  hideAllTemplates: (ids: string[]) => void
  unhideAllTemplates: () => void
  showHidden: boolean
  toggleShowHidden: () => void
  levelFilters: string[]
  toggleLevelFilter: (level: string) => void
  clearLevelFilters: () => void
  setLevelFilters: (levels: string[]) => void
  watchedOnly: boolean
  toggleWatchedOnly: () => void
  selectedTimeRange: { start: string; end: string } | null
  setSelectedTimeRange: (range: { start: string; end: string } | null) => void
  investigatingStatusCode: number | null
  setInvestigatingStatusCode: (code: number | null) => void
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      timeRange: '24h',
      setTimeRange: (timeRange) => set({ timeRange }),
      serviceFilter: null,
      setServiceFilter: (serviceFilter) => set({ serviceFilter, selectedTemplateId: null }),
      colorMode: 'dark',
      toggleColorMode: () =>
        set((state) => ({ colorMode: state.colorMode === 'dark' ? 'light' : 'dark' })),
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      selectedTemplateId: null,
      setSelectedTemplateId: (selectedTemplateId) => set({ selectedTemplateId }),
      hiddenTemplateIds: [],
      toggleHideTemplate: (id) =>
        set((state) => ({
          hiddenTemplateIds: state.hiddenTemplateIds.includes(id)
            ? state.hiddenTemplateIds.filter((h) => h !== id)
            : [...state.hiddenTemplateIds, id],
        })),
      hideAllTemplates: (ids) =>
        set((state) => ({
          hiddenTemplateIds: [...new Set([...state.hiddenTemplateIds, ...ids])],
        })),
      unhideAllTemplates: () => set({ hiddenTemplateIds: [] }),
      showHidden: false,
      toggleShowHidden: () => set((state) => ({ showHidden: !state.showHidden })),
      levelFilters: [],
      toggleLevelFilter: (level) =>
        set((state) => ({
          levelFilters: state.levelFilters.includes(level)
            ? state.levelFilters.filter((l) => l !== level)
            : [...state.levelFilters, level],
        })),
      clearLevelFilters: () => set({ levelFilters: [] }),
      setLevelFilters: (levelFilters) => set({ levelFilters }),
      watchedOnly: false,
      toggleWatchedOnly: () => set((state) => ({ watchedOnly: !state.watchedOnly })),
      selectedTimeRange: null,
      setSelectedTimeRange: (selectedTimeRange) => set({ selectedTimeRange, investigatingStatusCode: null }),
      investigatingStatusCode: null,
      setInvestigatingStatusCode: (investigatingStatusCode) => set({ investigatingStatusCode }),
    }),
    {
      name: 'logweave-dashboard',
      partialize: (state) => ({
        colorMode: state.colorMode,
        sidebarCollapsed: state.sidebarCollapsed,
        timeRange: state.timeRange,
        hiddenTemplateIds: state.hiddenTemplateIds,
      }),
    },
  ),
)

export function timeRangeToHours(range: TimeRange): number {
  const map: Record<TimeRange, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }
  return map[range]
}
