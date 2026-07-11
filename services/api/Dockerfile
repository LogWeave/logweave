# Build context is the repository root (see docker-compose.prod.yml) so this
# image can build the API and the dashboard SPA together. Both are pnpm-workspace
# packages whose `catalog:` dependencies resolve against the root lockfile, so we
# build from the workspace and use `pnpm deploy` to produce a self-contained
# runtime node_modules.

# ---- Workspace install (dev deps needed to build both packages) ----
FROM node:24-alpine AS workspace

WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate

# Copy every workspace manifest first so pnpm can build the dependency graph and
# validate the frozen lockfile; cached until a manifest changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY services/api/package.json services/api/
COPY services/dashboard/package.json services/dashboard/
COPY services/mcp/package.json services/mcp/
COPY packages/transport/package.json packages/transport/
COPY simulator/package.json simulator/
RUN pnpm --filter logweave-api --filter logweave-dashboard install --frozen-lockfile

# ---- Dashboard build (Vite -> services/dashboard/dist) ----
FROM workspace AS dashboard-build

COPY services/dashboard/ services/dashboard/
RUN pnpm --filter logweave-dashboard build

# ---- API build + self-contained prod deploy ----
FROM workspace AS api-build

COPY services/api/ services/api/
RUN pnpm --filter logweave-api build
# Deploy produces /app-deploy with a self-contained (hoisted) node_modules of
# prod-only deps. --legacy is required since pnpm v10 for non-injected workspaces.
RUN pnpm --filter logweave-api --prod --legacy deploy /app-deploy

# ---- Runtime ----
FROM node:24-alpine

WORKDIR /app

COPY --from=api-build /app-deploy/node_modules node_modules/
COPY --from=api-build /repo/services/api/dist dist/
COPY --from=dashboard-build /repo/services/dashboard/dist ./dashboard/dist
COPY services/api/package.json ./

# app.ts resolves the SPA from LOGWEAVE_DASHBOARD_DIR; point it at the copied
# dist so `GET /` serves the dashboard rather than the 404 catch-all.
ENV LOGWEAVE_DASHBOARD_DIR=/app/dashboard/dist

RUN addgroup -S app && adduser -S app -G app
USER app

# Git sha for /healthz + the startup log line. Pass at build time:
#   docker build --build-arg LOGWEAVE_GIT_SHA=$(git rev-parse --short HEAD) ...
ARG LOGWEAVE_GIT_SHA=dev
ENV LOGWEAVE_GIT_SHA=$LOGWEAVE_GIT_SHA

EXPOSE 3000

CMD ["node", "dist/index.js"]
