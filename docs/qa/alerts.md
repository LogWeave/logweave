# Alerts QA Spec — Alerts Page (/alerts)

## Page Load
- Page renders without console errors
- No network requests return 4xx/5xx
- Header shows "Alert Rules" title
- Subtitle shows active rule count and alerts in last 24h (e.g. "3 active rules · 5 alerts in the last 24h")

## Rules Card
- Card titled "Rules (N)" with count of total rules
- Status summary shows enabled count (green dot) and disabled count (gray dot)
- Filter bar with Type (Threshold/Pattern), Service, and Status (Enabled/Disabled) filters
- If no rules: empty state shows "No rules configured. Create one from the service health cards or pattern detail panel."
- If rules exist but filters exclude all: shows "No rules match the current filters."
- Loading state shows 3 skeleton rows

## Rule Rows
- Each rule row shows: toggle button, rule name, type badge (threshold/pattern), service, condition
- Threshold rules show: metric, operator, value, window (e.g. "error count > 10 / 5min")
- Pattern rules show template text
- Enabled rules show green bell icon, disabled show gray bell-off icon
- Disabled rules are visually dimmed (opacity)
- Environment badge shown for rules with environment filter
- Channel count shown (e.g. "2 webhooks") or "Default" if none
- Delete button (trash icon) present on each row
- Chevron right button navigates to dashboard filtered for that rule's service

## Create Rule Form
- "Create Rule" button (with plus icon) in header toggles the form
- Form fields: Name (optional), Service (dropdown from live services), Environment (optional), Metric (Error count/Warning count/Log count), Operator (>/>=/</<=/), Value (number), Window (1/5/15/30/60 min)
- Name field has placeholder "Auto-generated if empty"
- "Create Rule" submit button and "Cancel" button
- Submit button disabled while mutation is pending
- Successful creation shows toast "Rule created" and closes form
- Failed creation shows toast "Failed to create rule"

## Alert History Card
- Card titled "Alert History" with "Last 7 days" subtitle
- If no alerts: shows "No alerts have fired yet. Create rules to start monitoring."
- Loading state shows 3 skeleton rows

## Alert History Rows
- Each row shows: severity dot, rule name, type badge, service, metric ratio (e.g. "15 / 10 (1.5x)")
- Severity dot color: red for ratio > 3x, amber for > 1.5x, blue otherwise
- Channels notified count shown if > 0
- Timestamp shown in "Mon DD, HH:MM" format

## Interactions
- Toggle rule enabled/disabled: click bell icon → toast confirms → rule appearance updates
- Delete rule: click trash → confirm dialog → toast confirms → row disappears
- Filter rules: select Type/Service/Status → list updates immediately
- Create rule: fill form → submit → rule appears in list
- Navigate to dashboard: click chevron → navigates to /?service=X&range=24h

## Error States
- API error loading rules: shows QueryError with retry button
- API error loading alerts: shows QueryError with retry button
