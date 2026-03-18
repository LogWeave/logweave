import { Outlet } from 'react-router-dom'
import { Toaster } from 'sonner'
import { TemplateDetailPanel } from '../features/dashboard/template-detail-panel'
import { Header } from './header'
import { Sidebar } from './sidebar'

export function Layout() {
  return (
    <div className="flex h-screen overflow-hidden bg-surface-base">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Header />
        <div className="flex-1 flex overflow-hidden">
          <main className="flex-1 overflow-y-auto p-4 md:p-6 pb-20 md:pb-6">
            <Outlet />
          </main>
          <TemplateDetailPanel />
        </div>
      </div>
      <Toaster position="top-right" richColors />
    </div>
  )
}
