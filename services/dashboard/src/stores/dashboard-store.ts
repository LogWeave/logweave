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
}

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set) => ({
      timeRange: '24h',
      setTimeRange: (timeRange) => set({ timeRange }),
      serviceFilter: null,
      setServiceFilter: (serviceFilter) => set({ serviceFilter }),
      colorMode: 'dark',
      toggleColorMode: () =>
        set((state) => ({ colorMode: state.colorMode === 'dark' ? 'light' : 'dark' })),
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      selectedTemplateId: null,
      setSelectedTemplateId: (selectedTemplateId) => set({ selectedTemplateId }),
    }),
    {
      name: 'logweave-dashboard',
      partialize: (state) => ({
        colorMode: state.colorMode,
        sidebarCollapsed: state.sidebarCollapsed,
        timeRange: state.timeRange,
      }),
    },
  ),
)

export function timeRangeToHours(range: TimeRange): number {
  const map: Record<TimeRange, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }
  return map[range]
}
