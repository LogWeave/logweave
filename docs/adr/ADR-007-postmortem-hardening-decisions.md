# ADR-007: Week 1a Postmortem Hardening Decisions

**Status:** Accepted
**Date:** 2026-03-14
**Deciders:** Solo maintainer
**Context:** Issue #12 — fix Week 1a postmortem findings. Two rounds of adversarial review.

## Context

After completing Week 1a, four adversarial review agents analyzed the clusterer for
security, correctness, performance, and operational issues. This ADR documents the
decisions made during the hardening pass, including what was fixed, what was deliberately
deferred, and why.

## Decisions

### 1. Batch INSERT uses DEFAULT columns, not Python-side hash computation

The template registry schema uses `cityHash64(template_text)` as part of the sort key.
The original batch INSERT via `client.insert()` omitted `template_text_hash` and
`first_seen`, which would default to 0/epoch — breaking ReplacingMergeTree dedup.

**Decision:** Add `DEFAULT cityHash64(template_text)` and `DEFAULT now64(3)` to the
schema DDL. This lets `client.insert()` omit those columns and have ClickHouse compute
them server-side. Single round-trip batch INSERT with correct hash values.

**Rejected:** Computing cityHash64 in Python — no pure-Python implementation available,
and adding a C extension dependency for a hash that ClickHouse already computes is
unnecessary complexity.

### 2. Batch SELECT does NOT use hash pre-filter

The single-row SELECT uses `template_text_hash = cityHash64({text})` as a fast index
filter. The batch SELECT uses `template_text IN {texts:Array(String)}` without the hash.

**Decision:** Acceptable for now. The batch SELECT path only runs for cache misses
(genuinely new templates). In steady state, 99%+ of lookups hit the in-memory cache.
The number of unique templates per request is small (typically <20 per batch of 1000
messages). A scan of a few hundred templates per tenant is negligible.

**Revisit when:** Template registries exceed 10K entries per tenant, or profiling shows
batch SELECT as a bottleneck.

### 3. `load_state` deliberately bypasses `max_tenants` limit

`DrainService.load_state()` directly inserts into the miners dict without checking
`max_tenants`. This means checkpoint restore can exceed the limit.

**Decision:** This is intentional. Losing checkpoint state (discarding trained Drain3
trees) is worse than temporarily running above the tenant limit. A warning is logged
when restored count exceeds `max_tenants`. The limit prevents unbounded growth from
new tenants — it is not a hard cap on total system state.

**Rejected:** Enforcing the limit during restore — this would silently discard tenant
state, causing template ID instability (the exact problem checkpoints are meant to
prevent).

### 4. `get_dirty_tenants()` relies on CPython GIL for thread safety

`dict()` copy of `_dirty_generations` is not protected by a lock. In CPython, `dict()`
on a dict is atomic at the bytecode level due to the GIL.

**Decision:** Acceptable. We target CPython 3.11+ (specified in pyproject.toml). The
free-threaded Python 3.13+ (PEP 703) is experimental and opt-in. If we ever adopt it,
this needs a lock.

**Revisit when:** Adopting free-threaded Python or `nogil` builds.

### 5. HMAC key defaults to empty (disabled), with startup warning

Checkpoint HMAC verification is optional. When `LOGWEAVE_CHECKPOINT_HMAC_KEY` is empty,
checkpoints are saved/loaded without integrity verification.

**Decision:** Default to disabled with a loud startup WARNING log. The HMAC protects
against checkpoint tampering (jsonpickle deserialization can execute arbitrary code).
In development, the checkpoint volume is local. In production, operators must set the
key — the warning makes this visible. The key uses `SecretStr` to prevent accidental
logging of the value.

**Rejected:** Making the key required — this would break local development and testing
without providing security benefit (dev checkpoints are local).

### 6. Request body size limit deferred to Week 1b

`ClusterRequest` allows 1000 messages * 32KB = ~32MB per request. With 4 concurrent
requests, that's ~128MB in-flight.

**Decision:** Defer body size limits to the API server (Week 1b). The clusterer is an
internal service — the API server is the trust boundary. The API server will enforce
per-tenant rate limits and body size constraints.

**Revisit when:** Implementing the API server's `/ingest` endpoint.

### 7. ExceptionHandlerMiddleware re-raises (no double logging)

The middleware catches unhandled exceptions, logs them with request context, and
re-raises. Reviewers flagged this as causing double logging.

**Decision:** No double logging occurs in practice. The `/cluster` endpoint has its own
try/except that catches all exceptions and converts them to HTTP responses (422/500/503/504).
Exceptions never reach the middleware from `/cluster`. The middleware exists as a safety
net for future endpoints that may not have their own error handling.

## Consequences

- Schema DDL now includes DEFAULT expressions — existing tables need `ALTER TABLE` or
  recreation during migration (acceptable: no production data yet)
- `cachetools` is now an explicit dependency (was transitive via drain3)
- `checkpoint_hmac_key` uses `SecretStr` — callers must use `.get_secret_value()`
- `DrainService.max_tenants` exposed as a public property (was private `_max_tenants`)
- Several "deferred" items tracked here for Week 1b pickup
