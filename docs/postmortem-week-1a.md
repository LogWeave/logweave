# Week 1a Postmortem — Clusterer Standalone

**Date:** 2026-03-13
**Milestone:** Week 1a — Clusterer Standalone (issues #5–#11)
**Result:** All 7 issues closed, 74 tests passing, merged to main
**Review method:** 5 parallel adversarial reviewer agents (Architecture, Code Quality, Edge Cases, Test Coverage, Developer Experience)

---

## Summary

The clusterer is architecturally sound — clean module boundaries, correct tenant isolation via per-tenant miners, well-structured pipeline orchestration. The code is production-ready for single-tenant/low-tenant use. However, 5 agents independently converged on the same cluster of issues: the service will not meet the 500ms timeout contract under cold-start conditions, has no observability for debugging, and has unbounded memory growth with no tenant eviction. These must be addressed before or during Week 1b.

**Finding counts (deduplicated across agents):**

| Severity | Count |
|----------|-------|
| Blocker  | 7     |
| Tech Debt | 14   |
| Process  | 5     |
| Tooling  | 6     |

---

## 1. Blockers — Must Fix Before Week 1b

These issues will directly impact the API server integration or cause production failures.

### B1. Sequential registry lookups will blow the 500ms budget

**Reported by:** Agents 1, 2, 3 (all independently)
**Files:** `pipeline.py:51-60`, `template_registry.py:72-96`
**Severity:** HIGH — blocks the degradation contract

The `cluster()` method calls `registry.get_or_create()` one template at a time in a loop. On cold start (empty LRU cache), a batch of 100 messages producing 50 unique templates triggers 50 sequential ClickHouse roundtrips. At 5-10ms each = 250-500ms for registry alone, before Drain3 CPU time. The per-tenant `asyncio.Lock` serializes all lookups further.

**Fix:** Add `batch_get_or_create()` — single `SELECT ... FINAL WHERE template_text_hash IN (...)` for all unique texts, then INSERT only genuinely new ones. Reduces O(N) roundtrips to O(1) + M (M = new templates).

### B2. Fix `_get_tenant_lock` race condition

**Reported by:** Agents 1, 2, 3, 4 (all independently — highest consensus finding)
**File:** `template_registry.py:56-61`

Double-checked locking with the outer check outside `_global_lock`. Currently safe in asyncio's cooperative model, but fragile — any future `await` between lines 57 and 61 creates a real race that silently breaks tenant isolation for template ID assignment.

**Fix:** One-line change — always acquire `_global_lock`:
```python
async def _get_tenant_lock(self, tenant_id: str) -> asyncio.Lock:
    async with self._global_lock:
        if tenant_id not in self._tenant_locks:
            self._tenant_locks[tenant_id] = asyncio.Lock()
        return self._tenant_locks[tenant_id]
```

### B3. Zero request-level observability — 3am debugging is blind

**Reported by:** Agents 2, 5
**File:** `main.py:84-94`

The entire request path produces zero log output on success. No request ID, no tenant ID logged, no message count, no elapsed time. When the API server calls `/cluster` and gets an unexpected result, there is nothing to correlate. Error messages also swallow exception details (`main.py:33-36` — `logger.error` without `exc_info=True`).

**Fix:** Accept `X-Request-ID` header, log at entry/exit with tenant_id, message count, elapsed time. Use `logger.exception()` for final connection failures.

### B4. Health endpoint lies — always returns OK regardless of ClickHouse state

**Reported by:** Agents 2, 3, 5
**File:** `main.py:79-81`

`/health` returns `{"status": "ok"}` unconditionally. The API server will use this to decide whether to route requests. A health endpoint that reports OK when ClickHouse is down causes the API server to keep sending requests instead of falling back to `template_id=0`.

**Fix:** Add a `SELECT 1` check with short timeout. Return 503 if unreachable. Consider splitting into `/health` (liveness) and `/ready` (readiness).

### B5. No `docker-compose.dev.yml` — cannot manually test against ClickHouse

**Reported by:** Agent 5
**File:** (missing)

No way to run the clusterer locally against a real ClickHouse instance. `poe serve` tries to connect to `localhost:9000` but nothing provides ClickHouse. Manual testing of the full pipeline is impossible without improvising.

**Fix:** Add `docker-compose.dev.yml` at project root with a ClickHouse service. Document the workflow in CLAUDE.md.

### B6. No `.env.example` — environment configuration undocumented

**Reported by:** Agent 5
**File:** (missing from `services/clusterer/`)

`config.py` defines 5 settings but there's no `.env.example`. A new developer (or fresh Claude session) must read source code to discover variable names.

**Fix:** Add `services/clusterer/.env.example` with all settings and defaults.

### B7. Update PLAN.md — `template_id` type mismatch

**Reported by:** Agents 1, 3
**File:** `PLAN.md` section 7

PLAN.md specifies `template_id UInt64` but code uses `String` (UUIDv7). This was a deliberate decision (ADR pending) but PLAN.md was never updated. Will cause confusion when implementing `log_metadata` table in Week 1b.

**Fix:** Update PLAN.md section 7 to reflect `template_id String`.

---

## 2. Tech Debt — Track But Defer

These are real issues that don't block Week 1b but need tracking.

### TD1. Unbounded memory growth — no tenant eviction

**Reported by:** Agents 1, 2, 3, 4
**Files:** `drain_service.py:41-43` (`_miners`, `_locks`, `_dirty_generations`), `template_registry.py:53` (`_tenant_locks`)

Every tenant that sends a single message stays in memory forever. Each `TemplateMiner` holds the entire Drain3 tree (potentially MB). No eviction, no max-tenant limit.

**Trigger:** Implement LRU eviction when tenant count exceeds 100 or RSS exceeds a configurable threshold. Checkpoint before eviction.

### TD2. Unbounded Drain3 state growth — no `max_clusters`

**Reported by:** Agents 1, 3
**File:** `drain_service.py:53-59`

`_create_miner()` does not set `config.drain_max_clusters`. A high-cardinality tenant can grow the Drain3 tree indefinitely.

**Trigger:** Set `max_clusters=10000` per tenant. Add monitoring for cluster count.

### TD3. jsonpickle deserialization is an RCE vector

**Reported by:** Agents 1, 2, 3 (all independently)
**File:** `drain_service.py:121`

`jsonpickle.loads()` executes arbitrary code during deserialization. Current defenses (tenant_id regex, Docker volume isolation) are adequate for MVP.

**Trigger:** Add `isinstance(loaded, Drain)` assertion post-deserialization as defense-in-depth. Add HMAC verification before self-hosted GA. Long-term: safe serialization format.

### TD4. Checkpoints are serialized, blocking clustering during serialization

**Reported by:** Agent 1
**File:** `pipeline.py:86-97`

Each dirty tenant's checkpoint runs sequentially. `get_state()` holds the tenant lock during jsonpickle serialization. With 100 dirty tenants, this is 1.5+ seconds of sequential work.

**Fix when needed:** Snapshot states first (parallelizable), then write files. Or: serialize under lock (fast), write to disk outside lock (slow).

### TD5. `get_state()` on event loop thread blocks it

**Reported by:** Agent 2
**File:** `pipeline.py:89`

`self._drain.get_state(tenant_id)` runs synchronously on the event loop thread (not wrapped in `asyncio.to_thread`), while `cluster_messages` runs in a worker thread. If both contend for the same tenant lock, the event loop blocks.

**Fix:** Wrap `get_state` in `asyncio.to_thread`.

### TD6. Checkpoint disk-full leaves orphan `.tmp` files

**Reported by:** Agent 3
**File:** `checkpoint.py:33-34`

If `write_bytes` raises (disk full), the `.tmp` file is left on disk. `cleanup_stale_tmp` only runs at startup.

**Fix:** Wrap save in try/finally that cleans up `.tmp` on failure.

### TD7. No backpressure or concurrency limit on `/cluster`

**Reported by:** Agents 1, 3
**File:** `main.py:84-94`, `models.py:29`

Accepts up to 10,000 messages per request. Four concurrent 10K-message requests saturate the thread pool, starving health checks. No mechanism to abort work after the API server's 500ms timeout expires.

**Fix:** Add `asyncio.Semaphore` to limit concurrent clustering. Consider reducing max batch to 1,000.

### TD8. Global LRU cache enables cross-tenant cache pollution

**Reported by:** Agents 1, 2, 3
**File:** `template_registry.py:19`

`_CACHE_MAX_SIZE = 100_000` is global, not per-tenant. A noisy tenant can evict other tenants' entries.

**Fix when needed:** Per-tenant LRU caches with configurable max size.

### TD9. `get_dirty_tenants()` reads shared dict without synchronization

**Reported by:** Agents 1, 2, 3
**File:** `drain_service.py:92-94`

Safe under CPython GIL but relies on implementation detail. Will break under PEP 703 (free-threaded Python).

**Fix:** Add a comment documenting the GIL dependency, or protect with a lock.

### TD10. No structured logging — production logs unparseable

**Reported by:** Agent 2
**All source files**

Default Python formatter produces flat text. No JSON structure, no ISO timestamps, no indexable fields.

**Fix:** Configure `structlog` or `python-json-logger` in `main.py`.

### TD11. Dockerfile runs as root, no HEALTHCHECK

**Reported by:** Agent 5
**File:** `services/clusterer/Dockerfile`

No non-root user, no `HEALTHCHECK` instruction. Security risk and Docker Compose can't detect unhealthy containers.

**Fix:** Add `USER appuser` and `HEALTHCHECK` instruction.

### TD12. Multi-instance checkpoint corruption

**Reported by:** Agent 3
**File:** `checkpoint.py`

No file-level locking. Two clusterer instances sharing a checkpoint volume will silently corrupt state.

**Fix:** Use `fcntl.flock()` on a lockfile at startup. Document single-instance constraint.

### TD13. Drain3 config parameters not validated

**Reported by:** Agents 3, 5
**File:** `config.py:9-10`

No validation that `sim_th` is between 0 and 1, or `depth` is positive. Invalid values cause silent misbehavior.

**Fix:** Add `Field(gt=0, le=1)` and `Field(ge=2)` constraints.

### TD14. Partial batch failure — Drain3 state mutated but registry fails

**Reported by:** Agents 3, 4
**File:** `pipeline.py:49-61`

Drain3 is called first (mutating state), then registry lookups happen one-by-one. If ClickHouse dies mid-batch, Drain3 has processed all messages but only some got IDs. System is eventually consistent on retry, but no partial results are returned.

**Fix:** Catch registry exceptions per-result and return partial results with `template_id=""` fallback, or batch registry lookups so they all-or-nothing.

---

## 3. Process Improvements

### P1. No ClickHouse integration tests in CI

**Reported by:** Agents 4, 5

Every ClickHouse interaction is mocked. SQL syntax, parameter binding, schema creation, and `SELECT ... FINAL` behavior are verified only manually. The `InMemoryRegistry` test double in `test_integration.py` is valuable but does not catch SQL bugs.

**Action:** Add a ClickHouse service container to CI. Create a `pytest -m integration` marker. Test at minimum: schema creation, insert, select with FINAL, concurrent insert deduplication.

### P2. Tests access private internals — fragile to refactoring

**Reported by:** Agent 4
**Files:** `test_drain_service.py:31-33, 91-100`, `test_template_registry.py:24`

Tests assert on `svc._miners` dict contents and directly manipulate `registry._cache`. These break on internal refactoring despite correct behavior.

**Action:** Replace with behavioral assertions. Delete `TestMinerCreation` class — already covered by behavioral tests.

### P3. Missing boundary value tests

**Reported by:** Agents 3, 4
**Files:** `models.py:24, 28, 29`

No tests for: tenant_id at 128 chars, message at 32,768 chars, batch at 10,000 messages. No tests for whitespace-only messages, null bytes, Unicode edge cases.

**Action:** Add boundary and edge-case test class in `test_cluster_endpoint.py`.

### P4. `test_same_messages_same_ids` tests the mock, not the system

**Reported by:** Agent 4
**File:** `test_cluster_endpoint.py:69-78`

Sets a fixed mock return value and asserts the mock returned what it was told. Provides zero confidence in actual idempotency.

**Action:** Rename to `test_response_shape_is_consistent` or delete (integration test already covers idempotency).

### P5. Lifespan code has zero test coverage

**Reported by:** Agents 4, 5
**File:** `main.py:20-73`

ClickHouse retry loop, schema creation, checkpoint restoration, background task startup, shutdown flush — all untested. Endpoint tests bypass lifespan by injecting mock pipeline.

**Action:** Add a lifespan integration test (mocked ClickHouse client) that verifies the correct startup/shutdown sequence.

---

## 4. Agent/Tooling Improvements

### A1. No type checker despite heavy type annotation usage

**Reported by:** Agent 5

Every source file uses modern type hints (`str | None`, `dict[str, int]`, etc.) but no mypy or pyright is configured. Type annotations are documentation-only.

**Action:** Add pyright to dev dependencies and CI. Add `pyrightconfig.json` with strict mode.

### A2. Missing `poe` tasks for daily workflows

**Reported by:** Agent 5

No way to: run a single test by name, get verbose test output, run type checking, run a smoke test against a running instance. No coverage measurement (`pytest-cov` not in dev deps).

**Action:** Add tasks: `test:verbose`, `test:one`, `typecheck`, `smoke`, `coverage`.

### A3. Ruff missing security rules

**Reported by:** Agent 5
**File:** `pyproject.toml:35`

Rule set missing `S` (flake8-bandit). Would flag `jsonpickle.loads` as a security concern, forcing explicit `# noqa: S301` annotations that serve as documentation.

**Action:** Add `"S"` to ruff select list.

### A4. Missing `.gitignore` in clusterer service

**Reported by:** Agent 5

`data/drain3/` (default checkpoint directory for local dev) not in any `.gitignore`. Checkpoint files could accidentally be committed.

**Action:** Add `services/clusterer/.gitignore` with `data/` and `*.drain3`.

### A5. Shared test fixtures missing

**Reported by:** Agents 4, 5
**File:** `tests/conftest.py`

`InMemoryRegistry` is defined inside `test_integration.py` but useful elsewhere. No shared fixtures for mock ClickHouse client or temp checkpoint directory.

**Action:** Extract common test doubles into conftest or a helpers module.

### A6. Dependency version bounds too loose

**Reported by:** Agent 5
**File:** `pyproject.toml:6-13`

`drain3>=0.9` is dangerously wide given Drain3's known API instability (the `template_mined` string-vs-object issue from lessons-learned.md). Lock file handles production, but `uv sync` without `--frozen` on a dev machine is a risk.

**Action:** Tighten to `drain3>=0.9,<1.0` at minimum.

---

## Priority Order for Fixes

1. **B2** — `_get_tenant_lock` race condition (one-line fix, eliminates CRITICAL)
2. **B1** — Design `batch_get_or_create` interface (required for 500ms contract)
3. **B3** — Request-level logging (required for Week 1b debugging)
4. **B4** — Deep health check (required for API server routing decisions)
5. **B5 + B6** — Dev environment (docker-compose.dev.yml + .env.example)
6. **B7** — PLAN.md schema update (prevents Week 1b confusion)
7. **TD6** — Checkpoint .tmp cleanup (small defensive fix)
8. **P1** — ClickHouse integration tests in CI (prevents silent SQL bugs)

Items TD1-TD14 should become GitHub issues tagged `tech-debt` for tracking.
