# Contributing to LogWeave

Thanks for your interest in contributing to LogWeave.

## Getting Started

```bash
git clone https://github.com/logweave/logweave.git
cd logweave
bash scripts/setup.sh
docker compose up --build
```

## Project Structure

- `services/api/` — Node.js / Express / TypeScript API server
- `services/clusterer/` — Python / FastAPI / Drain3 clustering service
- `services/dashboard/` — React / Vite / Tailwind dashboard
- `services/mcp/` — MCP server (26 tools for AI assistants)

## Development

### API Server

```bash
cd services/api
pnpm install
pnpm test          # run tests
pnpm typecheck     # type check
pnpm lint          # lint + format check
```

### Clusterer

```bash
cd services/clusterer
uv sync --dev
uv run poe test    # run tests
uv run poe check   # lint + format check
```

### Dashboard

```bash
cd services/dashboard
pnpm install
pnpm dev           # dev server with hot reload
pnpm build         # production build
```

### CloudFormation templates

CFN templates live under `services/*/cloudformation/`. CI runs `cfn-lint`
with `--non-zero-exit-code error`; warnings are logged but don't fail
the build. Run locally before pushing:

```bash
uvx cfn-lint --non-zero-exit-code error services/*/cloudformation/*.yaml
```

## Code Standards

- **TypeScript** for all API and dashboard code
- **Biome** for JS/TS linting and formatting
- **ruff** for Python linting and formatting
- All ClickHouse queries must use parameterized values (`{param:Type}` syntax)
- All API endpoints must call `getTenantId(res)` for tenant isolation
- Tests are required for new features

## Pull Requests

1. Create a feature branch from `main`
2. Write tests for new functionality
3. Ensure `pnpm test` and `pnpm typecheck` pass
4. Keep PRs focused — one feature or fix per PR
5. Write a clear description of what changed and why

## Reporting Issues

Open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- LogWeave version and environment details

## License

By contributing, you agree that your contributions will be licensed under the BSL 1.1 license (see LICENSE).
