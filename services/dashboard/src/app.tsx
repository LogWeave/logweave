import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { Layout } from './components/layout'

function DashboardPage() {
  return (
    <div className="space-y-6">
      <div className="text-center py-20">
        <h2 className="text-xl font-semibold text-text-primary mb-2">Dashboard</h2>
        <p className="text-text-secondary text-sm">
          KPI strip, volume chart, service cards, and template table coming next.
        </p>
      </div>
    </div>
  )
}

function DashboardV2Page() {
  return (
    <div className="space-y-6">
      <div className="text-center py-20">
        <h2 className="text-xl font-semibold text-text-primary mb-2">Dashboard V2</h2>
        <p className="text-text-secondary text-sm">Alternative charts-first layout.</p>
      </div>
    </div>
  )
}

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
