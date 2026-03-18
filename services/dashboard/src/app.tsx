import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/layout'
import { DashboardPage } from './features/dashboard/dashboard-page'
import { SettingsPage } from './features/settings/settings-page'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
