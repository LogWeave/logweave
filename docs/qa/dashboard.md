# Dashboard QA Spec — Main Dashboard (/)

## Page Load
- Page renders without console errors
- No network requests return 4xx/5xx
- All components resolve from loading skeletons within 5 seconds
- If no data: KPI strip shows "Waiting for data..." message with SDK install prompt — not spinners or zeros

## KPI Strip — Primary Row
- 3 hero cards visible: Spikes Active, Error Rate, Events
- Spikes Active: shows count of templates with anomaly score > 1.0
- Spikes Active: card turns red/danger variant when count > 0
- Error Rate: shows percentage with one decimal (e.g. "2.3%")
- Error Rate: card turns red/danger when rate exceeds 5%
- Error Rate: trend arrow compares to previous period (trend suffix is "pp" for percentage points)
- Events: shows total event count with locale formatting (commas)
- Each card has a tooltip on hover explaining the metric

## KPI Strip — Secondary Row
- Compact pills visible: Patterns, New Today, Services, Unclustered
- Patterns: total template count
- New Today: count of templates first seen today, amber/warning when > 0
- Services: count of distinct services
- Unclustered: count of template_id=0 events, amber/warning when > 0
- Compression ratio pill visible when data exists (format: "N:1 compression")

## Changes Panel ("What Changed?")
- Card with title "What Changed?"
- Each row shows a badge (NEW / SPIKE / RESOLVED) + template text + service name
- SPIKE rows show ratio (e.g. "12.5x") and event count
- Spike ratio text is red when >= 50x, amber when >= 10x
- Rows are clickable — clicking selects the template in the template table
- Timestamps shown for events with firstSeen data

## Volume Chart
- Stacked area chart renders with per-service coloring
- Chart has visible axes (time on X, count on Y)
- Changing time range (1h/6h/24h/7d) updates the chart data
- Hover/tooltip shows values per service at that time point

## Template Table
- Card with title showing template count
- Table columns: template text, count, errors, anomaly score, trend sparkline
- Rows are clickable — clicking opens the template detail panel on the right
- Column headers are clickable for sorting (visual sort indicator appears)
- Search input filters templates by text
- "Hide" button (eye icon) removes a row from view
- "Show Hidden" toggle reveals hidden rows
- "Watched Only" toggle filters to watched templates
- Virtualized scrolling works for large lists (no janky scroll)
- NEW badge appears on templates first seen today

## Service Health Cards
- Cards render for each service
- Each card shows service name, event count, error/warn rates
- Cards include "Alert on Service" action

## Template Detail Panel
- Opens when a template table row is clicked
- Shows full template text, occurrence chart, first/last seen timestamps
- "Watch Pattern" button present
- Close button dismisses the panel

## Interactions
- Time range selector (1H/6H/24H/7D in header) updates all dashboard components
- Service filter dropdown filters template table and recalculates KPI values
- Level filter dropdown filters by log level
- Color mode toggle (sun/moon icon) switches dark/light without page reload
- Refresh button (rotating arrow icon) triggers data refetch, icon spins during refresh
- Data freshness indicator shows "Updated just now" or "Updated Ns ago"
- Data freshness turns amber when > 120s stale, red on API error
