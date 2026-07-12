import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/auth-provider'
import { ChangePasswordPage } from './auth/change-password-page'
import { LoginPage } from './auth/login-page'
import { Layout } from './components/layout'
import { Skeleton } from './components/ui/skeleton'
import { DashboardPage } from './features/dashboard/dashboard-page'

const SettingsPage = lazy(() =>
  import('./features/settings/settings-page').then((m) => ({ default: m.SettingsPage })),
)

const TailPage = lazy(() =>
  import('./features/tail/tail-page').then((m) => ({ default: m.TailPage })),
)

const AlertsPage = lazy(() =>
  import('./features/alerts/alerts-page').then((m) => ({ default: m.AlertsPage })),
)

const MockupsPage = lazy(() =>
  import('./features/mockups/ux-mockups').then((m) => ({ default: m.MockupsPage })),
)

const TotpSetupPage = lazy(() =>
  import('./auth/totp-setup-page').then((m) => ({ default: m.TotpSetupPage })),
)

function AuthGate() {
  const { user, isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-base">
        <Skeleton className="h-8 w-32" />
      </div>
    )
  }

  if (!isAuthenticated) return <LoginPage />
  if (user?.mustChangePassword) return <ChangePasswordPage />

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route
          path="/alerts"
          element={
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <AlertsPage />
            </Suspense>
          }
        />
        <Route
          path="/tail"
          element={
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <TailPage />
            </Suspense>
          }
        />
        <Route
          path="/settings"
          element={
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <SettingsPage />
            </Suspense>
          }
        />
        <Route
          path="/settings/two-factor"
          element={
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <TotpSetupPage />
            </Suspense>
          }
        />
        <Route
          path="/mockups"
          element={
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <MockupsPage />
            </Suspense>
          }
        />
      </Route>
    </Routes>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </BrowserRouter>
  )
}
