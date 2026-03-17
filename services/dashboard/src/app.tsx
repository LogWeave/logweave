import { BrowserRouter, Route, Routes } from 'react-router-dom'

function DashboardPlaceholder() {
  return (
    <div className="flex h-screen items-center justify-center bg-surface-base">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-text-primary mb-2">LogWeave Dashboard</h1>
        <p className="text-text-secondary">Scaffold loaded. Widgets coming next.</p>
        <div className="mt-4 inline-flex gap-2">
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-brand-500/10 text-brand-400 border border-brand-500/20">
            React 19
          </span>
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-brand-500/10 text-brand-400 border border-brand-500/20">
            Tailwind 4
          </span>
          <span className="px-3 py-1 rounded-full text-xs font-medium bg-brand-500/10 text-brand-400 border border-brand-500/20">
            ECharts
          </span>
        </div>
      </div>
    </div>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<DashboardPlaceholder />} />
        <Route path="/v2" element={<DashboardPlaceholder />} />
      </Routes>
    </BrowserRouter>
  )
}
