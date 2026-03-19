import { Suspense, lazy } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/layout'
import { Skeleton } from './components/ui/skeleton'
import { DashboardPage } from './features/dashboard/dashboard-page'

const SettingsPage = lazy(() =>
  import('./features/settings/settings-page').then((m) => ({ default: m.SettingsPage })),
)

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route
            path="/settings"
            element={
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <SettingsPage />
              </Suspense>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
