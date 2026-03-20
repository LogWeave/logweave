#!/bin/bash
#
# Stop hook: blocks Claude from finishing if tests fail for modified services.
# Reads JSON from stdin. Returns JSON with decision:"block" on exit 2 to prevent stop.
#
# Loop guard: if stop_hook_active is true, we're already in a retry loop.
# Allow stop after 3 consecutive failures to prevent infinite loops.

INPUT=$(cat)

# Loop guard: check if stop hook is already active (we're in a retry)
# Parse without jq — grep for the key in the JSON string
STOP_HOOK_ACTIVE="false"
if echo "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  STOP_HOOK_ACTIVE="true"
fi

COUNTER_FILE="/tmp/logweave-stop-gate-counter"

if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  # Increment retry counter
  COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo "0")
  COUNT=$((COUNT + 1))
  echo "$COUNT" > "$COUNTER_FILE"

  # After 3 retries, allow stop to prevent infinite loop
  if [ "$COUNT" -ge 3 ]; then
    rm -f "$COUNTER_FILE"
    exit 0
  fi
else
  # Fresh stop attempt — reset counter
  echo "0" > "$COUNTER_FILE"
fi

# Parse project_dir without jq
PROJECT_DIR=$(echo "$INPUT" | grep -o '"project_dir"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\(.*\)"/\1/')
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$CLAUDE_PROJECT_DIR"
fi
if [ -z "$PROJECT_DIR" ]; then
  exit 0
fi

# Check which services have uncommitted or recently committed changes
API_CHANGED=false
CLUSTERER_CHANGED=false

# Check staged + unstaged + untracked changes
if git -C "$PROJECT_DIR" diff --name-only HEAD 2>/dev/null | grep -q "^services/api/"; then
  API_CHANGED=true
fi
if git -C "$PROJECT_DIR" diff --cached --name-only 2>/dev/null | grep -q "^services/api/"; then
  API_CHANGED=true
fi
if git -C "$PROJECT_DIR" diff --name-only 2>/dev/null | grep -q "^services/api/"; then
  API_CHANGED=true
fi

if git -C "$PROJECT_DIR" diff --name-only HEAD 2>/dev/null | grep -q "^services/clusterer/"; then
  CLUSTERER_CHANGED=true
fi
if git -C "$PROJECT_DIR" diff --cached --name-only 2>/dev/null | grep -q "^services/clusterer/"; then
  CLUSTERER_CHANGED=true
fi
if git -C "$PROJECT_DIR" diff --name-only 2>/dev/null | grep -q "^services/clusterer/"; then
  CLUSTERER_CHANGED=true
fi

# Also check commits on current branch vs main (feature branch work)
CURRENT_BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null)
if [ -n "$CURRENT_BRANCH" ] && [ "$CURRENT_BRANCH" != "main" ]; then
  if git -C "$PROJECT_DIR" diff --name-only main...HEAD 2>/dev/null | grep -q "^services/api/"; then
    API_CHANGED=true
  fi
  if git -C "$PROJECT_DIR" diff --name-only main...HEAD 2>/dev/null | grep -q "^services/clusterer/"; then
    CLUSTERER_CHANGED=true
  fi
fi

# If no service files changed, allow stop
if [ "$API_CHANGED" = "false" ] && [ "$CLUSTERER_CHANGED" = "false" ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

FAILURES=""

# Run API tests if API files changed
if [ "$API_CHANGED" = "true" ]; then
  if [ -f "$PROJECT_DIR/services/api/package.json" ]; then
    API_OUTPUT=$(cd "$PROJECT_DIR/services/api" && pnpm test 2>&1)
    API_EXIT=$?
    if [ $API_EXIT -ne 0 ]; then
      FAILURES="${FAILURES}API tests failed (exit $API_EXIT):\n${API_OUTPUT}\n\n"
    fi
  fi
fi

# Run clusterer tests if clusterer files changed
if [ "$CLUSTERER_CHANGED" = "true" ]; then
  if [ -f "$PROJECT_DIR/services/clusterer/pyproject.toml" ]; then
    CLUSTER_OUTPUT=$(cd "$PROJECT_DIR/services/clusterer" && uv run poe test 2>&1)
    CLUSTER_EXIT=$?
    if [ $CLUSTER_EXIT -ne 0 ]; then
      FAILURES="${FAILURES}Clusterer tests failed (exit $CLUSTER_EXIT):\n${CLUSTER_OUTPUT}\n\n"
    fi
  fi
fi

# If any tests failed, block the stop
if [ -n "$FAILURES" ]; then
  # Truncate output to avoid massive JSON payloads
  TRUNCATED=$(echo -e "$FAILURES" | head -80)
  REASON="Tests must pass before finishing. Fix failing tests or remove them if no longer relevant. There is no such thing as a 'pre-existing failure' — every test either passes or gets removed.\n\n${TRUNCATED}"
  # Escape for JSON without jq — replace newlines, quotes, backslashes
  REASON_ESCAPED=$(echo -e "$REASON" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g' | tr '\n' ' ')
  echo "{\"decision\": \"block\", \"reason\": \"${REASON_ESCAPED}\"}"
  exit 2
fi

# All tests passed — allow stop
rm -f "$COUNTER_FILE"
exit 0
