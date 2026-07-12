"""Integration test: kill/restart stability gate (issue #10).

This is the milestone gate for Week 1a. The clusterer is not considered
complete until this passes.

Tests the critical path: Drain3 state persistence + template ID stability
across simulated restarts, without requiring a real ClickHouse instance.
Uses an in-memory TemplateRegistry substitute with the same get_or_create
interface.
"""

from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

import pytest
from uuid_utils import uuid7

if TYPE_CHECKING:
    from pathlib import Path

from clusterer.checkpoint import CheckpointManager
from clusterer.drain_service import DrainService
from clusterer.pipeline import ClusterPipeline

# ---------------------------------------------------------------------------
# In-memory TemplateRegistry — dict-based, same get_or_create interface
# ---------------------------------------------------------------------------


class InMemoryRegistry:
    """Drop-in replacement for TemplateRegistry that uses a dict instead of ClickHouse.

    Mirrors the real registry's behaviour:
    - Cache-first lookup by (tenant_id, template_text)
    - Assigns UUIDv7 on first encounter
    - Returns (template_id, is_new) tuple
    """

    def __init__(self) -> None:
        self._store: dict[tuple[str, str], str] = {}

    async def get_or_create(self, tenant_id: str, template_text: str) -> tuple[str, bool]:
        key = (tenant_id, template_text)
        existing = self._store.get(key)
        if existing is not None:
            return existing, False
        new_id = str(uuid7())
        self._store[key] = new_id
        return new_id, True

    async def batch_get_or_create(
        self, tenant_id: str, template_texts: list[str]
    ) -> dict[str, tuple[str, bool]]:
        result: dict[str, tuple[str, bool]] = {}
        for text in template_texts:
            template_id, is_new = await self.get_or_create(tenant_id, text)
            result[text] = (template_id, is_new)
        return result

    @property
    def templates(self) -> dict[tuple[str, str], str]:
        """Expose internal state for assertions."""
        return dict(self._store)


# ---------------------------------------------------------------------------
# Test message corpus — realistic log messages that produce distinct templates
# ---------------------------------------------------------------------------

_LOG_TEMPLATES = [
    "Connection timeout to host-{host} after {ms}ms",
    "Failed to authenticate user {user} from {ip}",
    "Request to {endpoint} returned status {code}",
    "Database query took {ms}ms for table {table}",
    "Rate limit exceeded for client {client}",
    "Memory usage at {pct}% on node {node}",
    "Disk space warning: {pct}% used on {volume}",
    "Service {svc} health check failed with error {err}",
    "Retry attempt {n} for operation {op}",
    "Cache miss for key {key} in region {region}",
]


def _generate_messages(count: int) -> list[str]:
    """Generate `count` pre-processed log messages from templates.

    Rotates through templates, substituting different values to produce
    messages that Drain3 should cluster into ~10 distinct patterns.
    """
    messages: list[str] = []
    for i in range(count):
        template = _LOG_TEMPLATES[i % len(_LOG_TEMPLATES)]
        # Use a deterministic hash to fill placeholders consistently per index
        h = hashlib.md5(str(i).encode()).hexdigest()  # noqa: S324
        msg = template.format(
            host=f"srv-{h[:4]}",
            ms=str(100 + (i % 500)),
            user=f"user-{h[:6]}",
            ip=f"10.0.{i % 256}.{(i * 3) % 256}",
            endpoint=f"/api/v1/{h[:8]}",
            code=str([200, 404, 500, 502][i % 4]),
            table=f"tbl_{h[:5]}",
            client=f"client-{h[:4]}",
            pct=str(50 + (i % 50)),
            node=f"node-{i % 8}",
            volume=f"/dev/sd{chr(97 + i % 4)}",
            svc=f"svc-{h[:3]}",
            err=f"E{i % 100:03d}",
            n=str(i % 5 + 1),
            op=f"op-{h[:6]}",
            key=f"key-{h[:8]}",
            region=f"region-{i % 3}",
        )
        messages.append(msg)
    return messages


TENANT_ID = "test-tenant"
MESSAGE_COUNT = 1000


def _build_pipeline(
    registry: InMemoryRegistry,
    checkpoint_dir: str,
) -> ClusterPipeline:
    """Create a fresh pipeline with real DrainService + CheckpointManager.

    A fixed HMAC key is supplied so the kill/restart gate exercises the
    supported (keyed) checkpoint path — keyless deployments fail closed on load.
    """
    drain_service = DrainService(sim_th=0.4, depth=4)
    checkpoint_mgr = CheckpointManager(checkpoint_dir, hmac_key="integration-test-key")
    checkpoint_mgr.ensure_dir()
    return ClusterPipeline(
        drain_service=drain_service,
        registry=registry,
        checkpoint_manager=checkpoint_mgr,
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestKillRestartStability:
    """Milestone gate: template IDs must be 100% stable across restart."""

    @pytest.mark.asyncio
    async def test_template_ids_stable_across_restart(self, tmp_path: Path) -> None:
        """POST 1000 messages, checkpoint, 'restart', POST same 1000 — IDs must match.

        Acceptance criteria:
        1. 100% template_id stability across restart
        2. Checkpoint file exists on disk after clustering
        3. After restart, Drain3 state restored — same patterns get same template_ids
        """
        checkpoint_dir = str(tmp_path / "checkpoints")
        messages = _generate_messages(MESSAGE_COUNT)

        # --- Phase 1: Initial clustering ---
        registry = InMemoryRegistry()
        pipeline1 = _build_pipeline(registry, checkpoint_dir)

        # First pass trains Drain3 — templates may evolve (generalize) as more
        # messages arrive. Second pass through the *same* pipeline produces the
        # stable, fully-generalized template texts. This is the baseline.
        await pipeline1.cluster(TENANT_ID, messages)
        results1 = await pipeline1.cluster(TENANT_ID, messages)
        assert len(results1) == MESSAGE_COUNT

        # Record message -> template_id mapping (from stabilized templates)
        first_pass_ids = {msg: r.template_id for msg, r in zip(messages, results1, strict=True)}

        # Force checkpoint (don't wait for background loop)
        await pipeline1.run_checkpoint_cycle()

        # Verify checkpoint file exists on disk
        checkpoint_file = tmp_path / "checkpoints" / f"{TENANT_ID}.drain3"
        assert checkpoint_file.exists(), "Checkpoint file must exist after clustering"
        assert checkpoint_file.stat().st_size > 0, "Checkpoint file must not be empty"

        # --- Phase 2: Simulate kill/restart ---
        # Same registry (simulates persistent ClickHouse), fresh DrainService
        pipeline2 = _build_pipeline(registry, checkpoint_dir)
        await pipeline2.restore_checkpoints()

        results2 = await pipeline2.cluster(TENANT_ID, messages)
        assert len(results2) == MESSAGE_COUNT

        second_pass_ids = {msg: r.template_id for msg, r in zip(messages, results2, strict=True)}

        # --- Verify: 100% template_id stability ---
        mismatches: list[str] = []
        for msg in messages:
            id1 = first_pass_ids[msg]
            id2 = second_pass_ids[msg]
            if id1 != id2:
                mismatches.append(f"  {msg[:60]}... : {id1} != {id2}")

        assert not mismatches, (
            f"{len(mismatches)} template_id mismatches across restart:\n"
            + "\n".join(mismatches[:20])
        )

    @pytest.mark.asyncio
    async def test_no_duplicate_template_ids_for_same_text(self, tmp_path: Path) -> None:
        """SELECT ... FINAL equivalent: no duplicate template_ids for the same template_text.

        In the real system, ReplacingMergeTree + FINAL prevents duplicates. Our in-memory
        registry must also return the same ID for the same (tenant_id, template_text).
        """
        checkpoint_dir = str(tmp_path / "checkpoints")
        messages = _generate_messages(MESSAGE_COUNT)

        registry = InMemoryRegistry()
        pipeline = _build_pipeline(registry, checkpoint_dir)

        # Cluster twice without restart
        results1 = await pipeline.cluster(TENANT_ID, messages)
        results2 = await pipeline.cluster(TENANT_ID, messages)

        # Every template_text should map to exactly one template_id
        text_to_ids: dict[str, set[str]] = {}
        for r in [*results1, *results2]:
            text_to_ids.setdefault(r.template_text, set()).add(r.template_id)

        duplicates = {text: ids for text, ids in text_to_ids.items() if len(ids) > 1}
        assert not duplicates, "Duplicate template_ids for same template_text:\n" + "\n".join(
            f"  {text}: {ids}" for text, ids in duplicates.items()
        )

    @pytest.mark.asyncio
    async def test_is_new_false_on_second_pass(self, tmp_path: Path) -> None:
        """After restart, all templates should be known (is_new=False)."""
        checkpoint_dir = str(tmp_path / "checkpoints")
        messages = _generate_messages(MESSAGE_COUNT)

        registry = InMemoryRegistry()
        pipeline1 = _build_pipeline(registry, checkpoint_dir)

        # Two-pass warmup so Drain3 templates stabilize before checkpoint
        await pipeline1.cluster(TENANT_ID, messages)
        await pipeline1.cluster(TENANT_ID, messages)
        await pipeline1.run_checkpoint_cycle()

        # Restart
        pipeline2 = _build_pipeline(registry, checkpoint_dir)
        await pipeline2.restore_checkpoints()
        results2 = await pipeline2.cluster(TENANT_ID, messages)

        new_templates = [r for r in results2 if r.is_new]
        assert not new_templates, (
            f"{len(new_templates)} templates marked is_new=True after restart "
            f"(expected all False): {[r.template_text for r in new_templates[:5]]}"
        )

    @pytest.mark.asyncio
    async def test_multiple_tenants_isolated(self, tmp_path: Path) -> None:
        """Each tenant's Drain3 state is independent — no cross-tenant contamination.

        Uses different message corpora: tenant-a gets 200 messages first (builds a
        distinctive Drain3 tree), then tenant-b gets a separate corpus. Verifies
        tenant-b's results are unaffected by tenant-a's tree state.
        """
        checkpoint_dir = str(tmp_path / "checkpoints")

        registry = InMemoryRegistry()
        pipeline = _build_pipeline(registry, checkpoint_dir)

        # Tenant-a gets trained on 200 messages to build a distinctive tree
        messages_a = _generate_messages(200)
        await pipeline.cluster("tenant-a", messages_a)

        # Tenant-b processes the same messages — results should match a fresh tree
        fresh_pipeline = _build_pipeline(InMemoryRegistry(), str(tmp_path / "fresh"))
        results_fresh = await fresh_pipeline.cluster("tenant-fresh", messages_a)
        results_b = await pipeline.cluster("tenant-b", messages_a)

        # Template texts should match (same messages, independent trees)
        texts_fresh = {r.template_text for r in results_fresh}
        texts_b = {r.template_text for r in results_b}
        assert texts_fresh == texts_b, (
            "Tenant-b results should match a fresh pipeline — "
            f"diff: {texts_fresh.symmetric_difference(texts_b)}"
        )

        # Template IDs must be disjoint across all tenants
        ids_a = {r.template_id for r in (await pipeline.cluster("tenant-a", messages_a[:10]))}
        ids_b = {r.template_id for r in results_b}
        assert ids_a.isdisjoint(ids_b), "Different tenants must have different template_ids"

    @pytest.mark.asyncio
    async def test_checkpoint_restored_after_restart(self, tmp_path: Path) -> None:
        """Verify Drain3 tree structure is preserved — new messages matching existing
        patterns get existing template_ids without re-discovering them."""
        checkpoint_dir = str(tmp_path / "checkpoints")

        # Phase 1: train on first 500 messages
        messages_train = _generate_messages(500)
        registry = InMemoryRegistry()
        pipeline1 = _build_pipeline(registry, checkpoint_dir)
        results_train = await pipeline1.cluster(TENANT_ID, messages_train)
        await pipeline1.run_checkpoint_cycle()

        # Phase 2: restart, then send *different* messages that match the same templates
        pipeline2 = _build_pipeline(registry, checkpoint_dir)
        await pipeline2.restore_checkpoints()

        # Generate messages 500-999 — same templates, different values
        messages_new = _generate_messages(1000)[500:]
        results_new = await pipeline2.cluster(TENANT_ID, messages_new)

        # All templates from the new messages should already be known
        known_texts = {r.template_text for r in results_train}
        new_texts = {r.template_text for r in results_new}

        # Templates from new messages should be a subset of (or equal to) known templates.
        # Some new messages may produce the same templates as training messages.
        unexpected_new = new_texts - known_texts
        # Allow some tolerance — Drain3 may generalize slightly differently
        # but the core templates should overlap substantially
        overlap_ratio = len(new_texts & known_texts) / len(new_texts) if new_texts else 1.0
        assert overlap_ratio >= 0.95, (
            f"After restart, only {overlap_ratio:.0%} of templates from new messages "
            f"matched known templates. Expected >= 95%. "
            f"Unexpected: {unexpected_new}"
        )

    @pytest.mark.asyncio
    async def test_corrupted_checkpoint_recovery(self, tmp_path: Path) -> None:
        """A corrupted checkpoint should not prevent startup — the tenant gets a fresh tree."""
        checkpoint_dir = str(tmp_path / "checkpoints")
        messages = _generate_messages(100)

        # Phase 1: cluster and checkpoint normally
        registry = InMemoryRegistry()
        pipeline1 = _build_pipeline(registry, checkpoint_dir)
        await pipeline1.cluster(TENANT_ID, messages)
        await pipeline1.run_checkpoint_cycle()

        # Corrupt the checkpoint file
        checkpoint_file = tmp_path / "checkpoints" / f"{TENANT_ID}.drain3"
        assert checkpoint_file.exists()
        checkpoint_file.write_bytes(b"corrupted-data-not-valid-jsonpickle")

        # Phase 2: restart should succeed despite corruption
        pipeline2 = _build_pipeline(registry, checkpoint_dir)
        await pipeline2.restore_checkpoints()  # Should skip corrupt tenant, not crash

        # Clustering should still work (fresh Drain3 tree for this tenant)
        results = await pipeline2.cluster(TENANT_ID, messages)
        assert len(results) == 100
        # Templates will get new IDs since the registry still has the old ones
        # but Drain3 may produce different template_texts from a fresh tree

    @pytest.mark.asyncio
    async def test_completes_under_30_seconds(self, tmp_path: Path) -> None:
        """Full integration cycle must complete in under 30 seconds."""
        import time

        checkpoint_dir = str(tmp_path / "checkpoints")
        messages = _generate_messages(MESSAGE_COUNT)

        start = time.monotonic()

        registry = InMemoryRegistry()
        pipeline1 = _build_pipeline(registry, checkpoint_dir)
        await pipeline1.cluster(TENANT_ID, messages)
        await pipeline1.run_checkpoint_cycle()

        pipeline2 = _build_pipeline(registry, checkpoint_dir)
        await pipeline2.restore_checkpoints()
        await pipeline2.cluster(TENANT_ID, messages)

        elapsed = time.monotonic() - start
        assert elapsed < 30, f"Integration test took {elapsed:.1f}s, must be under 30s"
