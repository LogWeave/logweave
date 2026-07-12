# Releasing LogWeave

Short, repeatable checklist for cutting a release. LogWeave versions the whole
repo together (single `v*` tag); the npm packages and Docker images share that
version.

## Toolchain

Pinned in-repo (`.nvmrc`, `.python-version`, root `packageManager`):

- Node **24**, pnpm **10**
- Python **3.11** (clusterer, via `uv`)

## Pre-release checks

```bash
pnpm install --frozen-lockfile
pnpm -r lint
pnpm -r typecheck
pnpm -r test            # API tests need ClickHouse: pnpm env:start first
pnpm audit --audit-level=high
( cd services/clusterer && uv run poe check && uv run poe test )
```

All must be green. `pnpm audit` must report no high/critical advisories (the CI
gate).

## Cut the release

1. **Bump the version** in each publishable package (`services/api`,
   `services/mcp`, `packages/transport`, `services/dashboard`) to the new
   `X.Y.Z`.
2. **Update `CHANGELOG.md`** — rename the `[Unreleased]` section to
   `X.Y.Z (YYYY-MM-DD)` and start a fresh empty `[Unreleased]`.
3. **Commit** on a release branch, open a PR, merge to `main`.
4. **Tag**: `git tag vX.Y.Z && git push origin vX.Y.Z`.

## Artifacts

- **Docker images** — build with the git sha baked in so `/healthz` reports it:

  ```bash
  docker build -f services/api/Dockerfile \
    --build-arg LOGWEAVE_GIT_SHA=$(git rev-parse --short HEAD) \
    -t ghcr.io/logweave/logweave-api:vX.Y.Z .
  ```

  Push `ghcr.io/logweave/logweave-api` and `ghcr.io/logweave/logweave-clusterer`.

- **npm packages** — publish `@logweave/mcp` and `@logweave/transport` with
  provenance (`npm publish --provenance --access public`). Smoke-test from a
  clean environment: `npx @logweave/mcp`.

## Post-release

- Verify `/healthz` reports the new version + sha on a fresh deploy.
- Confirm `npx @logweave/mcp` resolves the published version.
