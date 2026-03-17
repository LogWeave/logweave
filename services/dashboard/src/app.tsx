import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/layout'
import { DashboardPage } from './features/dashboard/dashboard-page'
import { DashboardV2Page } from './features/dashboard-v2/dashboard-v2-page'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/v2" element={<DashboardV2Page />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
