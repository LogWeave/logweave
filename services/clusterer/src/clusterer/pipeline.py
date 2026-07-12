"""Cluster pipeline: orchestrates DrainService, TemplateRegistry, and CheckpointManager.

Provides the high-level `cluster()` method that the POST /cluster endpoint calls,
plus lifecycle management (checkpoint restore, background checkpoint loop).
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING, Protocol, runtime_checkable

from clusterer.models import ClusterResultItem

if TYPE_CHECKING:
    from clusterer.checkpoint import CheckpointManager
    from clusterer.drain_service import DrainService


@runtime_checkable
class RegistryProtocol(Protocol):
    """Interface for template ID registries (ClickHouse or in-memory test double)."""

    async def get_or_create(self, tenant_id: str, template_text: str) -> tuple[str, bool]: ...

    async def batch_get_or_create(
        self, tenant_id: str, template_texts: list[str]
    ) -> dict[str, tuple[str, bool]]: ...


logger = logging.getLogger(__name__)


class ClusterPipeline:
    def __init__(
        self,
        *,
        drain_service: DrainService,
        registry: RegistryProtocol,
        checkpoint_manager: CheckpointManager,
    ) -> None:
        self._drain = drain_service
        self._registry = registry
        self._checkpoint = checkpoint_manager

    async def cluster(
        self, tenant_id: str, messages: list[str], *, sim_th: float | None = None
    ) -> list[ClusterResultItem]:
        """Cluster messages and assign stable template IDs.

        1. Drain3 clustering (CPU-bound, run in thread)
        2. Registry lookup for each template (async, cache-first)
        3. Return combined results using registry's is_new (authoritative)

        Scaling note: step 1 runs in a worker thread, but Drain3 is pure-Python
        and CPU-bound, so the GIL means it does not truly run in parallel with
        other request handling — it bounds single-process throughput. The design
        is one clusterer process per deployment (see PLAN.md); horizontal scale
        is by sharding tenants across processes, not threads. A ProcessPoolExecutor
        would side-step the GIL but adds per-call serialization cost and rules out
        the shared in-process miner/registry caches, so it is deferred.
        """
        drain_results = await asyncio.to_thread(
            self._drain.cluster_messages, tenant_id, messages, sim_th=sim_th
        )

        # Batch registry lookup: deduplicate template texts, single round-trip
        unique_texts = list({dr.template_text for dr in drain_results})
        text_to_id = await self._registry.batch_get_or_create(tenant_id, unique_texts)

        results: list[ClusterResultItem] = []
        for dr in drain_results:
            template_id, is_new = text_to_id[dr.template_text]
            results.append(
                ClusterResultItem(
                    template_id=template_id,
                    template_text=dr.template_text,
                    is_new=is_new,
                )
            )
        return results

    async def preview(
        self, messages: list[str], *, sim_th: float = 0.4
    ) -> tuple[int, float, list[str]]:
        """Preview clustering with a throwaway miner. No side effects."""
        return await asyncio.to_thread(self._drain.preview, messages, sim_th=sim_th)

    async def reset_tenant(self, tenant_id: str) -> bool:
        """Clear a tenant's miner state and checkpoint. Returns True if miner existed."""
        existed = await asyncio.to_thread(self._drain.reset_tenant, tenant_id)
        await asyncio.to_thread(self._checkpoint.delete, tenant_id)
        return existed

    async def restore_checkpoints(self) -> None:
        """Load checkpoints from disk and restore DrainService state, up to max_tenants.

        The cap is enforced during restore (oldest-first by checkpoint mtime) so
        the memory ceiling holds across restarts — checkpoints beyond the cap are
        not even read into memory. Skips and logs on per-tenant restore errors
        (e.g., corrupt checkpoint data); that tenant starts with a fresh tree.
        """
        tenant_ids = await asyncio.to_thread(self._checkpoint.list_tenants)
        cap = self._drain.max_tenants
        to_restore = tenant_ids[:cap]
        skipped = len(tenant_ids) - len(to_restore)

        restored = 0
        for tenant_id in to_restore:
            try:
                state = await asyncio.to_thread(self._checkpoint.load, tenant_id)
                if state is None:
                    continue
                self._drain.load_state(tenant_id, state)
                restored += 1
            except Exception:
                logger.warning(
                    "Failed to restore checkpoint for tenant %s, starting fresh",
                    tenant_id,
                    exc_info=True,
                )
        if restored:
            logger.info("Restored %d tenant checkpoint(s)", restored)
        if skipped:
            logger.warning(
                "Skipped %d checkpoint(s) beyond max_tenants cap of %d — "
                "oldest checkpoints were restored first; the rest start fresh",
                skipped,
                cap,
            )

    async def run_checkpoint_cycle(self) -> None:
        """Save all dirty tenants. Skips + logs on per-tenant errors."""
        dirty = self._drain.get_dirty_tenants()
        for tenant_id, generation in dirty.items():
            try:
                state = await asyncio.to_thread(self._drain.get_state, tenant_id)
                # None => the tenant was reset after the dirty snapshot; reset
                # already cleared its dirty mark, so there is nothing to save.
                if state is None:
                    continue
                await asyncio.to_thread(self._checkpoint.save, tenant_id, state)
                self._drain.mark_clean(tenant_id, generation)
            except Exception:
                logger.warning(
                    "Failed to checkpoint tenant %s, skipping",
                    tenant_id,
                    exc_info=True,
                )

    async def checkpoint_loop(self, interval: int) -> None:
        """Run checkpoint cycles at a fixed interval. Skips if previous cycle overran."""
        while True:
            await asyncio.sleep(interval)
            try:
                await self.run_checkpoint_cycle()
            except Exception:
                logger.warning("Checkpoint cycle failed", exc_info=True)

    async def flush_checkpoints(self) -> None:
        """Final checkpoint flush — save all dirty tenants (shutdown path)."""
        await self.run_checkpoint_cycle()
