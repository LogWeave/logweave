# Settings QA Spec — Settings Page (/settings)

## Page Load
- Page renders without console errors
- No network requests return 4xx/5xx
- Page title "Settings" visible
- Slack Integration card visible

## Slack Integration — Not Configured
- Card title "Slack Integration"
- Status badge shows "Not configured" (gray)
- Description text explains the setup process (create Slack App, enable webhooks, etc.)
- Webhook URL input field with placeholder "https://hooks.slack.com/services/T.../B.../..."
- "Save Webhook" button — disabled when input is empty, enabled when URL entered
- Button shows "Saving..." and is disabled while mutation is pending

## Slack Integration — Configured
- Status badge shows one of:
  - "Connected" (green) — last test succeeded
  - "Failed" (red) — last test failed
  - "Configured" (blue) — configured but never tested
- "Webhook configured." text visible
- Last tested timestamp shown if available (e.g. "Last tested: Mar 24, 2026, 2:30 PM")
- "Test Connection" button present
- "Disconnect" button present

## Interactions
- Save webhook: enter URL → click Save → toast "Slack webhook saved" → input clears → card switches to configured state
- Save invalid URL: enter URL not starting with "https://hooks.slack.com/" → toast error "Webhook URL must start with https://hooks.slack.com/"
- Test connection (success): click → button shows "Testing..." → toast "Test message sent to Slack!" → status badge updates to "Connected"
- Test connection (failure): click → toast with error message
- Disconnect: click → toast "Slack disconnected" → card switches back to not-configured state

## Error States
- Loading state: shows "Loading..." text in card
- API errors on save/test/disconnect: toast notifications for each failure case

## Edge Cases
- Webhook URL validation is client-side (prefix check) — should not accept arbitrary URLs
- Multiple rapid clicks on Save/Test/Disconnect should not cause duplicate requests (buttons disable during pending)
