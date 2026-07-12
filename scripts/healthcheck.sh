#!/usr/bin/env bash
# LogWeave Health Check — verifies all services are running and responding.
# Usage: ./scripts/healthcheck.sh [base-url]
#
# Exit codes: 0 = all healthy, 1 = one or more services unhealthy

set -euo pipefail

BASE_URL="${1:-http://localhost:3000}"
PASS=0
FAIL=0

check() {
  local name="$1" url="$2" expected="$3"
  if response=$(curl -sf -o /dev/null -w "%{http_code}" "$url" 2>/dev/null); then
    if [ "$response" = "$expected" ]; then
      echo "  OK  $name ($url) — HTTP $response"
      PASS=$((PASS + 1))
    else
      echo "  FAIL $name ($url) — HTTP $response (expected $expected)"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "  FAIL $name ($url) — connection refused or timeout"
    FAIL=$((FAIL + 1))
  fi
}

echo "LogWeave Health Check"
echo "Base URL: $BASE_URL"
echo ""

# API health endpoints (unauthenticated)
check "API liveness"  "$BASE_URL/healthz" "200"
check "API readiness"  "$BASE_URL/readyz"  "200"

# Authenticated endpoint (requires API key)
if [ -n "${LOGWEAVE_API_KEY:-}" ]; then
  response=$(curl -sf -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $LOGWEAVE_API_KEY" \
    "$BASE_URL/v1/dashboard/overview?hours=1" 2>/dev/null) || response="000"
  if [ "$response" = "200" ]; then
    echo "  OK  API auth + query ($BASE_URL/v1/dashboard/overview) — HTTP $response"
    PASS=$((PASS + 1))
  else
    echo "  FAIL API auth + query — HTTP $response (set LOGWEAVE_API_KEY to test)"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  SKIP API auth test (set LOGWEAVE_API_KEY env var to enable)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
