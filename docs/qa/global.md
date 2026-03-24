# Global QA Spec — Cross-Page Checks

## Navigation
- Sidebar shows 4 items: Dashboard, Alerts, Live Tail, Settings
- Each sidebar item is a link that navigates to the correct page
- Active page is highlighted in the sidebar (brand color)
- Clicking LW logo toggles sidebar collapsed/expanded (does NOT navigate)
- Collapsed sidebar shows only icons with title tooltips
- Mobile: bottom tab bar shows all 4 navigation items

## Header
- Page title updates to match current page (Dashboard, Alerts, Live Tail, Settings)
- Time range selector (1H/6H/24H/7D) visible on all pages
- Filter bar (Level, Service) visible in header
- Refresh button visible and functional
- Color mode toggle (sun/moon) visible

## State Persistence
- Time range selection persists across page navigation (change to 7D on dashboard → navigate to alerts → come back → still 7D)
- Color mode (dark/light) persists across navigation and page refresh
- Sidebar collapsed state persists across navigation
- Service filter persists across navigation

## Color Mode
- Dark mode: dark backgrounds, light text, no white flashes on navigation
- Light mode: light backgrounds, dark text
- Toggle is instant — no page reload
- All components respect the mode (charts, cards, badges, inputs)
- No text becomes invisible in either mode

## Data Freshness
- Header shows "Updated just now" or "Updated Ns ago" with live counter
- Turns amber when data is > 120 seconds stale
- Shows "API error" in red when overview request fails

## Error Boundary
- Each dashboard section is wrapped in an error boundary
- If one component crashes, others continue to render
- Error boundary shows component name and error message

## Responsive
- Dashboard should be usable at common breakpoints (1920px, 1440px, 1024px, 768px)
- Sidebar collapses automatically on smaller viewports
- KPI cards stack vertically on mobile
- Template table scrolls horizontally if needed on small screens
