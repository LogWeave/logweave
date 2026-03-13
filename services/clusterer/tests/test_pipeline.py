"""Unit tests for ClusterPipeline orchestration.

Tests use mocked DrainService, TemplateRegistry, and CheckpointManager
to verify orchestration logic in isolation.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from clusterer.models import ClusterResultItem, DrainResult
from clusterer.pipeline import ClusterPipeline


def _make_pipeline(
    *,
    drain: MagicMock | None = None,
    registry: AsyncMock | None = None,
    checkpoint: MagicMock | None = None,
) -> ClusterPipeline:
    return ClusterPipeline(
        drain_service=drain or MagicMock(),
        registry=registry or AsyncMock(),
        checkpoint_manager=checkpoint or MagicMock(),
    )


class TestCluster:
    @pytest.mark.asyncio
    async def test_returns_registry_is_new_not_drain(self) -> None:
        """is_new in response comes from registry, not Drain3."""
        drain = MagicMock()
        drain.cluster_messages.return_value = [
            DrainResult(drain_cluster_id=1, template_text="error in <*>", is_new=True),
        ]
        registry = AsyncMock()
        # Registry says this template already exists (is_new=False)
        registry.get_or_create.return_value = ("uuid-123", False)

        pipeline = _make_pipeline(drain=drain, registry=registry)
        results = await pipeline.cluster("tenant_a", ["error in service-1"])

        assert len(results) == 1
        assert results[0].is_new is False  # Registry's answer, not Drain3's
        assert results[0].template_id == "uuid-123"
        assert results[0].template_text == "error in <*>"

    @pytest.mark.asyncio
    async def test_calls_drain_then_registry_for_each(self) -> None:
        """Each DrainResult gets a registry lookup."""
        drain = MagicMock()
        drain.cluster_messages.return_value = [
            DrainResult(drain_cluster_id=1, template_text="tmpl_a", is_new=True),
            DrainResult(drain_cluster_id=2, template_text="tmpl_b", is_new=True),
        ]
        registry = AsyncMock()
        registry.get_or_create.side_effect = [
            ("id-a", True),
            ("id-b", False),
        ]

        pipeline = _make_pipeline(drain=drain, registry=registry)
        results = await pipeline.cluster("t1", ["msg1", "msg2"])

        assert len(results) == 2
        assert results[0] == ClusterResultItem(
            template_id="id-a", template_text="tmpl_a", is_new=True
        )
        assert results[1] == ClusterResultItem(
            template_id="id-b", template_text="tmpl_b", is_new=False
        )
        assert registry.get_or_create.call_count == 2

    @pytest.mark.asyncio
    async def test_passes_tenant_id_to_both_services(self) -> None:
        drain = MagicMock()
        drain.cluster_messages.return_value = [
            DrainResult(drain_cluster_id=1, template_text="tmpl", is_new=True),
        ]
        registry = AsyncMock()
        registry.get_or_create.return_value = ("id-1", True)

        pipeline = _make_pipeline(drain=drain, registry=registry)
        await pipeline.cluster("my_tenant", ["msg"])

        drain.cluster_messages.assert_called_once_with("my_tenant", ["msg"])
        registry.get_or_create.assert_called_once_with("my_tenant", "tmpl")


class TestRestoreCheckpoints:
    @pytest.mark.asyncio
    async def test_loads_all_and_restores(self) -> None:
        drain = MagicMock()
        checkpoint = MagicMock()
        checkpoint.load_all.return_value = {
            "tenant_a": b"state_a",
            "tenant_b": b"state_b",
        }

        pipeline = _make_pipeline(drain=drain, checkpoint=checkpoint)
        await pipeline.restore_checkpoints()

        assert drain.load_state.call_count == 2
        drain.load_state.assert_any_call("tenant_a", b"state_a")
        drain.load_state.assert_any_call("tenant_b", b"state_b")

    @pytest.mark.asyncio
    async def test_empty_checkpoints(self) -> None:
        drain = MagicMock()
        checkpoint = MagicMock()
        checkpoint.load_all.return_value = {}

        pipeline = _make_pipeline(drain=drain, checkpoint=checkpoint)
        await pipeline.restore_checkpoints()

        drain.load_state.assert_not_called()


class TestCheckpointCycle:
    @pytest.mark.asyncio
    async def test_saves_dirty_and_marks_clean(self) -> None:
        drain = MagicMock()
        drain.get_dirty_tenants.return_value = {"t1": 3, "t2": 5}
        drain.get_state.side_effect = [b"state_t1", b"state_t2"]

        checkpoint = MagicMock()
        pipeline = _make_pipeline(drain=drain, checkpoint=checkpoint)
        await pipeline.run_checkpoint_cycle()

        assert checkpoint.save.call_count == 2
        checkpoint.save.assert_any_call("t1", b"state_t1")
        checkpoint.save.assert_any_call("t2", b"state_t2")
        drain.mark_clean.assert_any_call("t1", 3)
        drain.mark_clean.assert_any_call("t2", 5)

    @pytest.mark.asyncio
    async def test_skips_tenant_on_error(self) -> None:
        """If saving one tenant fails, continue with the rest."""
        drain = MagicMock()
        drain.get_dirty_tenants.return_value = {"t1": 1, "t2": 2}
        drain.get_state.side_effect = [Exception("boom"), b"state_t2"]

        checkpoint = MagicMock()
        pipeline = _make_pipeline(drain=drain, checkpoint=checkpoint)
        await pipeline.run_checkpoint_cycle()

        # t1 failed, t2 should still be saved
        checkpoint.save.assert_called_once_with("t2", b"state_t2")
        drain.mark_clean.assert_called_once_with("t2", 2)

    @pytest.mark.asyncio
    async def test_no_dirty_tenants(self) -> None:
        drain = MagicMock()
        drain.get_dirty_tenants.return_value = {}
        checkpoint = MagicMock()

        pipeline = _make_pipeline(drain=drain, checkpoint=checkpoint)
        await pipeline.run_checkpoint_cycle()

        checkpoint.save.assert_not_called()


class TestFlushCheckpoints:
    @pytest.mark.asyncio
    async def test_saves_all_dirty(self) -> None:
        drain = MagicMock()
        drain.get_dirty_tenants.return_value = {"t1": 1}
        drain.get_state.return_value = b"state"
        checkpoint = MagicMock()

        pipeline = _make_pipeline(drain=drain, checkpoint=checkpoint)
        await pipeline.flush_checkpoints()

        checkpoint.save.assert_called_once_with("t1", b"state")
