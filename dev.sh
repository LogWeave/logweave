#!/usr/bin/env bash
set -euo pipefail

# LogWeave task runner — unified commands across all services
# Usage: ./dev.sh <command>

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

heading() { echo -e "\n${BLUE}${BOLD}=== $1 ===${NC}\n"; }
success() { echo -e "${GREEN}✓ $1${NC}"; }
fail()    { echo -e "${RED}✗ $1${NC}"; }

cmd_test() {
  heading "Clusterer tests (pytest)"
  (cd services/clusterer && uv run poe test) || { fail "Clusterer tests failed"; return 1; }
  success "Clusterer tests passed"

  heading "API server tests (node:test)"
  (cd services/api && pnpm test) || { fail "API tests failed"; return 1; }
  success "API tests passed"

  heading "Transport tests (node:test)"
  (cd packages/transport && pnpm test) || { fail "Transport tests failed"; return 1; }
  success "Transport tests passed"
}

cmd_lint() {
  heading "Clusterer lint (ruff)"
  (cd services/clusterer && uv run poe check) || { fail "Clusterer lint failed"; return 1; }
  success "Clusterer lint passed"

  heading "API server lint (biome)"
  (cd services/api && pnpm lint) || { fail "API lint failed"; return 1; }
  success "API lint passed"

  heading "Dashboard lint (biome)"
  (cd services/dashboard && pnpm lint) || { fail "Dashboard lint failed"; return 1; }
  success "Dashboard lint passed"

  heading "Transport lint (biome)"
  (cd packages/transport && pnpm lint) || { fail "Transport lint failed"; return 1; }
  success "Transport lint passed"
}

cmd_typecheck() {
  heading "API server typecheck"
  (cd services/api && pnpm typecheck) || { fail "API typecheck failed"; return 1; }
  success "API typecheck passed"

  heading "Dashboard typecheck"
  (cd services/dashboard && pnpm typecheck) || { fail "Dashboard typecheck failed"; return 1; }
  success "Dashboard typecheck passed"

  heading "Transport typecheck"
  (cd packages/transport && pnpm typecheck) || { fail "Transport typecheck failed"; return 1; }
  success "Transport typecheck passed"
}

cmd_build() {
  heading "Transport build"
  (cd packages/transport && pnpm build) || { fail "Transport build failed"; return 1; }
  success "Transport built"

  heading "API server build"
  (cd services/api && pnpm build) || { fail "API build failed"; return 1; }
  success "API built"
}

cmd_dev() {
  heading "Starting dev servers"
  echo "Starting ClickHouse..."
  docker compose up clickhouse -d

  echo "Starting clusterer..."
  (cd services/clusterer && uv run poe serve) &

  echo "Starting API server..."
  (cd services/api && pnpm dev) &

  echo "Starting dashboard..."
  (cd services/dashboard && pnpm dev) &

  wait
}

cmd_dashboard() {
  heading "Starting dashboard dev server"
  (cd services/dashboard && pnpm dev)
}

cmd_up() {
  heading "Docker Compose up"
  docker compose up --build "$@"
}

cmd_down() {
  heading "Docker Compose down"
  docker compose down "$@"
}

cmd_benchmark() {
  heading "Benchmark suite"
  (cd benchmarks && pnpm start "$@") || { fail "Benchmarks failed"; return 1; }
  success "Benchmarks complete"
}

cmd_help() {
  echo -e "${BOLD}LogWeave Dev Runner${NC}"
  echo ""
  echo "Usage: ./dev.sh <command>"
  echo ""
  echo "Commands:"
  echo "  test        Run all tests (clusterer + API + transport)"
  echo "  lint        Lint all services (ruff + biome)"
  echo "  typecheck   TypeScript type checking (API + transport)"
  echo "  build       Build all TypeScript packages"
  echo "  dev         Start dev servers (ClickHouse + clusterer + API + dashboard)"
  echo "  dashboard   Start dashboard dev server only"
  echo "  up          docker compose up --build"
  echo "  down        docker compose down"
  echo "  benchmark   Run benchmark suite (pass args after, e.g. --filter 'ingest-*')"
  echo "  help        Show this message"
}

case "${1:-help}" in
  test)      cmd_test ;;
  lint)      cmd_lint ;;
  typecheck) cmd_typecheck ;;
  build)     cmd_build ;;
  dev)       cmd_dev ;;
  dashboard) cmd_dashboard ;;
  up)        cmd_up "${@:2}" ;;
  down)      cmd_down "${@:2}" ;;
  benchmark) cmd_benchmark "${@:2}" ;;
  help|*)    cmd_help ;;
esac
