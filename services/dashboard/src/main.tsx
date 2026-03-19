import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { memo, StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app'
import './globals.css'
import './theme/echarts-dark'
import './theme/echarts-light'
import { useDashboardStore } from './stores/dashboard-store'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000),
      refetchOnWindowFocus: false,
      refetchIntervalInBackground: false,
      gcTime: 3 * 60 * 1000, // 3 minutes — cap stale cache growth
      staleTime: 30_000,
    },
  },
})

const ThemeSync = memo(function ThemeSync() {
  const colorMode = useDashboardStore((s) => s.colorMode)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', colorMode === 'dark')
    document.documentElement.classList.toggle('light', colorMode === 'light')
  }, [colorMode])
  return null
})

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeSync />
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
