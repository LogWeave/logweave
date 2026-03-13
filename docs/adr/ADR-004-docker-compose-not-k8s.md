# ADR-004: Docker Compose, Not Kubernetes

**Status:** Accepted
**Date:** 2026-03-13

## Context

LogWeave is maintained by a solo developer. The stack has three containers: API server,
clusterer, and ClickHouse. Deployment targets are SaaS (single VPS) and self-hosted
(customer's Docker environment). Customer count target for MVP is 2-5.

## Decision

Use Docker Compose for all deployment. No Kubernetes, no ECS, no managed container
orchestration. Single `docker-compose.yml` with environment variable differentiation
for SaaS vs self-hosted modes.

## Consequences

- **Positive:** Zero orchestration overhead. Self-hosted customers can deploy with
  `docker compose up`. Debugging is straightforward (docker logs, docker exec).
  No YAML sprawl, no helm charts, no cluster management.
- **Negative:** No auto-scaling, no rolling deploys, no built-in health-check
  restart policies beyond Docker's own restart flags. Manual scaling if needed.
- **Revisit when:** Customer count exceeds 50, or API response times consistently
  exceed 500ms under load. Then evaluate SQS + Fargate per PLAN.md Phase 3.
