# ADR-001: Two-Language Stack (Python + Node.js)

**Status:** Accepted
**Date:** 2026-03-13

## Context

LogWeave needs a log clustering algorithm to extract templates from raw log messages.
Drain3 is the only production-grade, actively maintained implementation of the Drain
algorithm. It is written in Python. There is no equivalent library in Node.js or any
other language with comparable maturity.

The API server, dashboard, and SDK transport target a Node.js ecosystem (Express,
Winston logger transport, npm distribution).

## Decision

Use Python 3.11+ / FastAPI for the clusterer service and Node.js / Express for the
API server. The two services communicate over HTTP within Docker Compose networking.

## Consequences

- **Positive:** We get Drain3 without porting effort. Each service uses the best tool
  for its job. The clusterer is small and changes infrequently.
- **Negative:** Two language runtimes in the stack. Developers need familiarity with
  both Python and Node.js. Docker images are slightly larger.
- **Mitigated by:** Treating the clusterer as a stable, single-purpose service with a
  narrow HTTP API contract. Changes to the clusterer are rare after initial setup.
