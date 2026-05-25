import { Bell, LayoutDashboard, Radio, Rocket, Settings } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { useOnboardingRemaining, useOnboardingStatus } from '../features/onboarding/use-onboarding'
import { cn } from '../lib/cn'
import { useDashboardStore } from '../stores/dashboard-store'

const navItems = [
  { icon: LayoutDashboard, label: 'Dashboard', path: '/' },
  { icon: Bell, label: 'Alerts', path: '/alerts' },
  { icon: Radio, label: 'Live Tail', path: '/tail' },
  { icon: Settings, label: 'Settings', path: '/settings' },
]

export function Sidebar() {
  const collapsed = useDashboardStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useDashboardStore((s) => s.toggleSidebar)
  const location = useLocation()

  const { data: onboardingResponse } = useOnboardingStatus()
  const status = onboardingResponse?.data
  const remaining = useOnboardingRemaining(status)
  const showSetup = remaining > 0 && !status?.dismissed

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
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
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
                to={item.path}
                className={cn(
                  'flex items-center gap-3 px-2.5 py-2 rounded-[var(--radius-md)] text-sm transition-colors',
                  isActive
                    ? 'bg-brand-500/10 text-brand-400'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-elevated',
                )}
                title={collapsed ? item.label : undefined}
              >
                <Icon size={18} className="shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            )
          })}

          {/* Setup nav item — shown only when onboarding is incomplete */}
          {showSetup && (
            <Link
              to="/"
              className={cn(
                'flex items-center gap-3 px-2.5 py-2 rounded-[var(--radius-md)] text-sm transition-colors',
                'text-brand-400 hover:bg-brand-500/10',
              )}
              title={collapsed ? `Setup (${remaining} left)` : undefined}
            >
              <Rocket size={18} className="shrink-0" />
              {!collapsed && (
                <>
                  <span>Setup</span>
                  <span className="ml-auto text-[10px] font-medium bg-brand-500/20 text-brand-400 rounded-full px-1.5 py-0.5">
                    {remaining}
                  </span>
                </>
              )}
              {collapsed && (
                <span className="absolute left-9 text-[9px] font-bold bg-brand-500 text-white rounded-full h-4 w-4 flex items-center justify-center">
                  {remaining}
                </span>
              )}
            </Link>
          )}
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
              to={item.path}
              className={cn(
                'flex-1 flex flex-col items-center gap-1 py-2 text-[10px]',
                isActive ? 'text-brand-400' : 'text-text-muted',
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
