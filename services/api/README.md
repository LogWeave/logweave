# LogWeave API Server

Node.js/Express/TypeScript server handling log ingestion, dashboard queries, alerting, and authentication.

## Quick Start

```bash
pnpm install
pnpm dev          # dev server with hot reload
pnpm test         # run tests (verbose)
pnpm test:dot     # run tests (compact output)
pnpm typecheck    # type check
pnpm lint         # Biome lint
```

Integration tests require ClickHouse:

```bash
docker compose up clickhouse -d
pnpm test:integration
```

## Configuration

See [install guide](../../docs/install.md#environment-variable-reference) for all `LOGWEAVE_*` env vars.
