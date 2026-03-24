# Tail QA Spec — Live Tail Page (/tail)

## Page Load
- Page renders without console errors
- No network requests return 4xx/5xx (except SSE which is expected to be long-lived)
- Toolbar visible at top with controls
- Main area shows "Click 'Start Tail' to begin streaming live events" when disconnected

## Toolbar — Disconnected State
- "Start Tail" button visible and enabled
- "Pause" button visible but disabled
- "Clear" button visible but disabled (no events)
- Service filter dropdown ("All services") populated from API
- Level filter dropdown ("All levels") with options: ERROR, WARN, INFO, DEBUG
- Status indicator: gray dot + "Disconnected"

## Toolbar — Connected State
- "Stop" button replaces "Start Tail"
- "Pause" button enabled
- "Clear" button enabled when events exist
- Event count shown (e.g. "42 events")
- Event rate shown (e.g. "3/sec")
- Status indicator: green dot + "Connected"

## Event Stream
- When connected with no events yet: shows "Waiting for events..."
- Events render as monospace rows with: timestamp (HH:MM:SS), level, service, template text
- ERROR rows have red background tint
- WARN rows have amber background tint
- Level text is colored: ERROR=red, WARN=yellow, INFO=green, DEBUG=gray, FATAL=purple
- Status code shown in brackets when > 0 (e.g. "[404]")
- Duration shown when > 0 (e.g. "123ms")
- Anomaly score badge shown when > 0.5 (red badge with score)
- Auto-scrolls to bottom as new events arrive
- Scrolling up manually pauses auto-scroll

## Paused State
- When paused: shows "Paused — N events buffered" instead of event list
- "Resume" button replaces "Pause"
- Events continue buffering in background

## Interactions
- Start Tail: click → SSE connection opens → events start streaming → status goes green
- Stop: click → SSE disconnects → status goes gray → events remain visible
- Pause/Resume: toggles between showing live stream and paused message
- Clear: removes all buffered events → counter resets to 0
- Service filter: changing while connected should filter incoming events
- Level filter: changing while connected should filter incoming events
- Scroll up: disables auto-scroll → new events still arrive but view stays put

## Error States
- SSE connection error: red banner appears below toolbar with error message
- Status indicator shows: red dot + "Error"

## Edge Cases
- High volume: events should not cause UI to freeze (ring buffer limits count)
- Service dropdown should update if new services appear while tailing
