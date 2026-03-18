import { BarChart3, Bell, LayoutDashboard, Settings } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from '../lib/cn'
import { useDashboardStore } from '../stores/dashboard-store'

const navItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/' },
  { icon: BarChart3, label: 'Patterns', path: '/patterns', disabled: true },
  { icon: Bell, label: 'Alerts', path: '/alerts', disabled: true },
  { icon: Settings, label: 'Settings', path: '/settings', disabled: true },
]

export function Sidebar() {
  const collapsed = useDashboardStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useDashboardStore((s) => s.toggleSidebar)
  const location = useLocation()

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'hidden md:flex flex-col bg-surface-raised border-r border-border-subtle transition-all duration-200',
          collapsed ? 'w-14' : 'w-52',
        )}
      >
        {/* Logo */}
        <div className="flex items-center h-14 px-3 border-b border-border-subtle">
          <button
            type="button"
            onClick={toggleSidebar}
            className="flex items-center gap-2 text-text-primary hover:text-brand-400 transition-colors"
          >
            <div className="h-8 w-8 rounded-[var(--radius-md)] bg-brand-500 flex items-center justify-center text-white font-bold text-sm shrink-0">
              LW
            </div>
            {!collapsed && <span className="font-semibold text-sm">LogWeave</span>}
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-2 px-2 space-y-1">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path
            const Icon = item.icon
            return (
              <Link
                key={item.path}
                to={item.disabled ? '#' : item.path}
                className={cn(
                  'flex items-center gap-3 px-2.5 py-2 rounded-[var(--radius-md)] text-sm transition-colors',
                  isActive
                    ? 'bg-brand-500/10 text-brand-400'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-elevated',
                  item.disabled && 'opacity-40 pointer-events-none',
                )}
                title={collapsed ? item.label : undefined}
              >
                <Icon size={18} className="shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            )
          })}
        </nav>
      </aside>

      {/* Mobile bottom tab bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-surface-raised border-t border-border-subtle flex">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path
          const Icon = item.icon
          return (
            <Link
              key={item.path}
              to={item.disabled ? '#' : item.path}
              className={cn(
                'flex-1 flex flex-col items-center gap-1 py-2 text-[10px]',
                isActive ? 'text-brand-400' : 'text-text-muted',
                item.disabled && 'opacity-40 pointer-events-none',
              )}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>
    </>
  )
}
