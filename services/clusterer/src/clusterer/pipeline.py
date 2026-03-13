"""Cluster pipeline: orchestrates DrainService, TemplateRegistry, and CheckpointManager.

Provides the high-level `cluster()` method that the POST /cluster endpoint calls,
plus lifecycle management (checkpoint restore, background checkpoint loop).
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from clusterer.models import ClusterResultItem

if TYPE_CHECKING:
    from clusterer.checkpoint import CheckpointManager
    from clusterer.drain_service import DrainService
    from clusterer.template_registry import TemplateRegistry

logger = logging.getLogger(__name__)


class ClusterPipeline:
    def __init__(
        self,
        *,
        drain_service: DrainService,
        registry: TemplateRegistry,
        checkpoint_manager: CheckpointManager,
    ) -> None:
        self._drain = drain_service
        self._registry = registry
        self._checkpoint = checkpoint_manager

    async def cluster(self, tenant_id: str, messages: list[str]) -> list[ClusterResultItem]:
        """Cluster messages and assign stable template IDs.

        1. Drain3 clustering (CPU-bound, run in thread)
        2. Registry lookup for each template (async, cache-first)
        3. Return combined results using registry's is_new (authoritative)
        """
        drain_results = await asyncio.to_thread(self._drain.cluster_messages, tenant_id, messages)

        results: list[ClusterResultItem] = []
        for dr in drain_results:
            template_id, is_new = await self._registry.get_or_create(tenant_id, dr.template_text)
            results.append(
                ClusterResultItem(
                    template_id=template_id,
                    template_text=dr.template_text,
                    is_new=is_new,
                )
            )
        return results

    async def restore_checkpoints(self) -> None:
        """Load all checkpoints from disk and restore DrainService state."""
        checkpoints = await asyncio.to_thread(self._checkpoint.load_all)
        for tenant_id, state in checkpoints.items():
            self._drain.load_state(tenant_id, state)
        if checkpoints:
            logger.info("Restored %d tenant checkpoint(s)", len(checkpoints))

    async def run_checkpoint_cycle(self) -> None:
        """Save all dirty tenants. Skips + logs on per-tenant errors."""
        dirty = self._drain.get_dirty_tenants()
        for tenant_id, generation in dirty.items():
            try:
                state = self._drain.get_state(tenant_id)
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
