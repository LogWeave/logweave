#!/usr/bin/env bash
# Dev task runner for logweave-clusterer
set -euo pipefail
cd "$(dirname "$0")"

# Ensure uv/uvx are on PATH
export PATH="$HOME/.local/bin:$PATH"

case "${1:-help}" in
  install)  uv sync --dev ;;
  test)     uv run pytest --tb=short "${@:2}" ;;
  lint)     uvx ruff check src/ tests/ ;;
  format)   uvx ruff format src/ tests/ ;;
  check)    uvx ruff check src/ tests/ && uvx ruff format --check src/ tests/ ;;
  serve)    uv run uvicorn clusterer.main:app --reload --host 0.0.0.0 --port 8000 ;;
  clean)    rm -rf .venv __pycache__ .pytest_cache src/clusterer/__pycache__ ;;
  help|*)
    echo "Usage: ./dev.sh <command>"
    echo ""
    echo "  install   Install all deps (including dev)"
    echo "  test      Run pytest (extra args forwarded)"
    echo "  lint      Run ruff linter"
    echo "  format    Run ruff formatter"
    echo "  check     Lint + format check (CI mode)"
    echo "  serve     Run dev server with hot reload"
    echo "  clean     Remove venv and caches"
    ;;
esac
