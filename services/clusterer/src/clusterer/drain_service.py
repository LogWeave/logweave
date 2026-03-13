"""Per-tenant Drain3 wrapper for log template clustering.

Manages independent TemplateMiner instances per tenant. Each tenant's
Drain3 tree is completely isolated — no cross-tenant template contamination.

Note: cluster_messages() is synchronous and CPU-bound. At the endpoint
level (issue #9), wrap calls in asyncio.to_thread() to avoid blocking
the event loop.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import jsonpickle
from drain3.template_miner import TemplateMiner
from drain3.template_miner_config import TemplateMinerConfig

from clusterer.models import DrainResult

if TYPE_CHECKING:
    from drain3.drain import Drain

logger = logging.getLogger(__name__)


class DrainService:
    def __init__(self, *, sim_th: float = 0.4, depth: int = 4) -> None:
        self._sim_th = sim_th
        self._depth = depth
        self._miners: dict[str, TemplateMiner] = {}
        self._dirty_generations: dict[str, int] = {}

    def _create_miner(self) -> TemplateMiner:
        config = TemplateMinerConfig()
        config.drain_sim_th = self._sim_th
        config.drain_depth = self._depth
        config.snapshot_compress_state = False
        config.masking_instructions = []
        return TemplateMiner(persistence_handler=None, config=config)

    def get_miner(self, tenant_id: str) -> TemplateMiner:
        """Return existing miner or create a new one for the tenant."""
        if tenant_id not in self._miners:
            self._miners[tenant_id] = self._create_miner()
        return self._miners[tenant_id]

    def cluster_messages(self, tenant_id: str, messages: list[str]) -> list[DrainResult]:
        """Cluster pre-processed messages for a tenant. Synchronous."""
        miner = self.get_miner(tenant_id)
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

    def get_dirty_tenants(self) -> dict[str, int]:
        """Return {tenant_id: generation} snapshot of dirty tenants."""
        return dict(self._dirty_generations)

    def mark_clean(self, tenant_id: str, generation: int) -> None:
        """Mark tenant as checkpointed. Only clears if generation hasn't advanced."""
        current = self._dirty_generations.get(tenant_id)
        if current is not None and current <= generation:
            del self._dirty_generations[tenant_id]

    def get_state(self, tenant_id: str) -> bytes:
        """Serialize miner's Drain3 state to bytes.

        Security: uses jsonpickle (Drain3's native format). Only load state
        from trusted checkpoint volume — never from external sources.
        """
        miner = self._miners[tenant_id]
        return jsonpickle.dumps(miner.drain, keys=True).encode("utf-8")

    def load_state(self, tenant_id: str, state: bytes) -> None:
        """Restore a miner from checkpoint bytes."""
        miner = self._create_miner()
        loaded_drain: Drain = jsonpickle.loads(state, keys=True)
        miner.drain.id_to_cluster = loaded_drain.id_to_cluster
        miner.drain.clusters_counter = loaded_drain.clusters_counter
        miner.drain.root_node = loaded_drain.root_node
        self._miners[tenant_id] = miner
        logger.info(
            "Restored tenant %s: %d clusters",
            tenant_id,
            len(loaded_drain.clusters),
        )
