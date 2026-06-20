"""Per-tenant Drain3 wrapper for log template clustering.

Manages independent TemplateMiner instances per tenant. Each tenant's
Drain3 tree is completely isolated — no cross-tenant template contamination.

Note: cluster_messages() is synchronous and CPU-bound. At the endpoint
level (issue #9), wrap calls in asyncio.to_thread() to avoid blocking
the event loop.
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING

import jsonpickle
from drain3.template_miner import TemplateMiner
from drain3.template_miner_config import TemplateMinerConfig

from clusterer.models import TENANT_ID_PATTERN, DrainResult

if TYPE_CHECKING:
    from drain3.drain import Drain

logger = logging.getLogger(__name__)


def _validate_tenant_id(tenant_id: str) -> None:
    if not TENANT_ID_PATTERN.match(tenant_id):
        raise ValueError(f"Invalid tenant_id: {tenant_id!r}")


class TenantLimitError(Exception):
    """Raised when the maximum number of tenants has been reached."""


class DrainService:
    def __init__(
        self,
        *,
        sim_th: float = 0.4,
        depth: int = 4,
        max_clusters: int = 10_000,
        max_tenants: int = 200,
    ) -> None:
        self._sim_th = sim_th
        self._depth = depth
        self._max_clusters = max_clusters
        self._max_tenants = max_tenants
        self._miners: dict[str, TemplateMiner] = {}
        self._dirty_generations: dict[str, int] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._locks_lock = threading.Lock()

    @property
    def max_tenants(self) -> int:
        return self._max_tenants

    def _get_lock(self, tenant_id: str) -> threading.Lock:
        """Get or create a per-tenant lock. Thread-safe."""
        with self._locks_lock:
            if tenant_id not in self._locks:
                self._locks[tenant_id] = threading.Lock()
        return self._locks[tenant_id]

    def _create_miner(self, sim_th: float | None = None) -> TemplateMiner:
        config = TemplateMinerConfig()
        config.drain_sim_th = sim_th if sim_th is not None else self._sim_th
        config.drain_depth = self._depth
        config.drain_max_clusters = self._max_clusters
        config.snapshot_compress_state = False
        config.masking_instructions = []
        return TemplateMiner(persistence_handler=None, config=config)

    def _get_or_create_miner(self, tenant_id: str) -> TemplateMiner:
        """Return existing miner or create a new one. Must be called under tenant lock."""
        if tenant_id not in self._miners:
            if len(self._miners) >= self._max_tenants:
                raise TenantLimitError(f"Maximum tenant count ({self._max_tenants}) reached")
            self._miners[tenant_id] = self._create_miner()
        return self._miners[tenant_id]

    def cluster_messages(
        self, tenant_id: str, messages: list[str], *, sim_th: float | None = None
    ) -> list[DrainResult]:
        """Cluster pre-processed messages for a tenant. Synchronous, thread-safe.

        If sim_th is provided, the miner's config is temporarily overridden
        for this batch, then restored to the original value.
        """
        _validate_tenant_id(tenant_id)
        lock = self._get_lock(tenant_id)
        with lock:
            miner = self._get_or_create_miner(tenant_id)
            original_sim_th = miner.config.drain_sim_th
            if sim_th is not None:
                miner.config.drain_sim_th = sim_th
            try:
                results: list[DrainResult] = []
                state_changed = False
                for msg in messages:
                    result = miner.add_log_message(msg)
                    is_new = result["change_type"] == "cluster_created"
                    results.append(
                        DrainResult(
                            drain_cluster_id=result["cluster_id"],
                            template_text=result["template_mined"],
                            is_new=is_new,
                        )
                    )
                    if result["change_type"] != "none":
                        state_changed = True
                if state_changed:
                    gen = self._dirty_generations.get(tenant_id, 0) + 1
                    self._dirty_generations[tenant_id] = gen
                return results
            finally:
                miner.config.drain_sim_th = original_sim_th

    def get_dirty_tenants(self) -> dict[str, int]:
        """Return {tenant_id: generation} snapshot of dirty tenants.

        Read without a lock: dict() over a dict is a single atomic operation
        under the CPython GIL (no Python-level bytecode interleaves), so the
        snapshot can't observe a half-mutated dict even though writers hold only
        their per-tenant lock. A tenant reset between this snapshot and the
        subsequent get_state() is handled there (returns None).
        """
        return dict(self._dirty_generations)

    def mark_clean(self, tenant_id: str, generation: int) -> None:
        """Mark tenant as checkpointed. Only clears if generation hasn't advanced."""
        lock = self._get_lock(tenant_id)
        with lock:
            current = self._dirty_generations.get(tenant_id)
            if current is not None and current <= generation:
                del self._dirty_generations[tenant_id]

    def get_state(self, tenant_id: str) -> bytes | None:
        """Serialize miner's Drain3 state to bytes. Thread-safe.

        Returns None if the tenant has no miner — e.g. it was reset between a
        get_dirty_tenants() snapshot and this call. The checkpoint cycle treats
        None as a clean skip rather than letting a KeyError surface as a noisy
        logged exception for an expected, benign race.

        Security: uses jsonpickle (Drain3's native format). Only load state
        from trusted checkpoint volume — never from external sources.
        """
        lock = self._get_lock(tenant_id)
        with lock:
            miner = self._miners.get(tenant_id)
            if miner is None:
                return None
            return jsonpickle.dumps(miner.drain, keys=True).encode("utf-8")

    def load_state(self, tenant_id: str, state: bytes) -> None:
        """Restore a miner from checkpoint bytes. Thread-safe."""
        _validate_tenant_id(tenant_id)
        lock = self._get_lock(tenant_id)
        with lock:
            miner = self._create_miner()
            loaded_drain: Drain = jsonpickle.loads(state, keys=True)  # noqa: S301
            miner.drain.id_to_cluster = loaded_drain.id_to_cluster
            miner.drain.clusters_counter = loaded_drain.clusters_counter
            miner.drain.root_node = loaded_drain.root_node
            self._miners[tenant_id] = miner
            logger.info(
                "Restored tenant %s: %d clusters",
                tenant_id,
                len(loaded_drain.clusters),
            )

    def preview(self, messages: list[str], *, sim_th: float = 0.4) -> tuple[int, float, list[str]]:
        """Cluster messages with a throwaway miner.

        Returns (pattern_count, compression_ratio, top_templates). No side
        effects — the miner is discarded after this call.
        """
        miner = self._create_miner(sim_th=sim_th)
        for msg in messages:
            miner.add_log_message(msg)

        clusters = list(miner.drain.clusters)
        pattern_count = len(clusters)
        compression_ratio = len(messages) / pattern_count if pattern_count > 0 else 0.0

        # Top 10 templates by frequency (descending)
        sorted_clusters = sorted(clusters, key=lambda c: c.size, reverse=True)
        sample_templates = [c.get_template() for c in sorted_clusters[:10]]

        return pattern_count, compression_ratio, sample_templates

    def reset_tenant(self, tenant_id: str) -> bool:
        """Delete a tenant's miner state. Thread-safe. Returns True if miner existed.

        The per-tenant lock in self._locks is intentionally left in place (not
        pruned): another thread may already hold a reference to it, so popping it
        here could hand a concurrent caller a different lock object for the same
        tenant and break mutual exclusion. self._locks therefore tracks the
        historical distinct-tenant count, which is bounded in practice by the
        deployment's tenant cardinality.
        """
        _validate_tenant_id(tenant_id)
        lock = self._get_lock(tenant_id)
        with lock:
            existed = tenant_id in self._miners
            self._miners.pop(tenant_id, None)
            self._dirty_generations.pop(tenant_id, None)
            if existed:
                logger.info("Reset miner for tenant %s", tenant_id)
            return existed
