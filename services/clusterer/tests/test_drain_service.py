import pytest

from clusterer.drain_service import DrainService
from clusterer.models import DrainResult


@pytest.fixture
def svc() -> DrainService:
    return DrainService(sim_th=0.4, depth=4)


class TestClusterMessages:
    def test_same_message_returns_same_cluster(self, svc: DrainService) -> None:
        r1 = svc.cluster_messages("t1", ["Connection timeout to host1 after 500ms"])
        r2 = svc.cluster_messages("t1", ["Connection timeout to host1 after 500ms"])
        assert r1[0].drain_cluster_id == r2[0].drain_cluster_id
        assert r1[0].template_text == r2[0].template_text

    def test_different_messages_may_differ(self, svc: DrainService) -> None:
        r1 = svc.cluster_messages("t1", ["Connection timeout to host1"])
        r2 = svc.cluster_messages("t1", ["Rate limit exceeded for user"])
        assert r1[0].drain_cluster_id != r2[0].drain_cluster_id

    def test_tenant_isolation(self, svc: DrainService) -> None:
        msg = "Connection timeout to host1"
        r1 = svc.cluster_messages("tenant_a", [msg])
        r2 = svc.cluster_messages("tenant_b", [msg])
        # Both should get cluster_id 1 (first cluster in their respective miners)
        assert r1[0].drain_cluster_id == r2[0].drain_cluster_id
        # But they use separate miners — verify by checking the miners dict
        assert "tenant_a" in svc._miners
        assert "tenant_b" in svc._miners
        assert svc._miners["tenant_a"] is not svc._miners["tenant_b"]

    def test_batch_clustering(self, svc: DrainService) -> None:
        messages = [f"Request {i} completed" for i in range(10)]
        results = svc.cluster_messages("t1", messages)
        assert len(results) == 10
        assert all(isinstance(r, DrainResult) for r in results)

    def test_returns_drain_result(self, svc: DrainService) -> None:
        results = svc.cluster_messages("t1", ["test message"])
        r = results[0]
        assert isinstance(r, DrainResult)
        assert isinstance(r.drain_cluster_id, int)
        assert isinstance(r.template_text, str)
        assert isinstance(r.is_new, bool)


class TestIsNewFlag:
    def test_first_message_is_new(self, svc: DrainService) -> None:
        results = svc.cluster_messages("t1", ["A brand new error occurred"])
        assert results[0].is_new is True

    def test_same_template_not_new(self, svc: DrainService) -> None:
        svc.cluster_messages("t1", ["A brand new error occurred"])
        results = svc.cluster_messages("t1", ["A brand new error occurred"])
        assert results[0].is_new is False


class TestDirtyTracking:
    def test_new_tenant_not_dirty(self, svc: DrainService) -> None:
        assert svc.get_dirty_tenants() == {}

    def test_clustering_marks_dirty(self, svc: DrainService) -> None:
        svc.cluster_messages("t1", ["error message"])
        dirty = svc.get_dirty_tenants()
        assert "t1" in dirty
        assert dirty["t1"] >= 1

    def test_mark_clean_with_matching_gen(self, svc: DrainService) -> None:
        svc.cluster_messages("t1", ["error message"])
        dirty = svc.get_dirty_tenants()
        gen = dirty["t1"]
        svc.mark_clean("t1", gen)
        assert "t1" not in svc.get_dirty_tenants()

    def test_mark_clean_with_stale_gen_keeps_dirty(self, svc: DrainService) -> None:
        svc.cluster_messages("t1", ["msg1"])
        dirty = svc.get_dirty_tenants()
        old_gen = dirty["t1"]
        # More messages arrive, advancing the generation
        svc.cluster_messages("t1", ["msg2"])
        svc.mark_clean("t1", old_gen)
        # Still dirty because gen advanced
        assert "t1" in svc.get_dirty_tenants()


class TestMinerCreation:
    def test_creates_on_first_cluster(self, svc: DrainService) -> None:
        assert "new_tenant" not in svc._miners
        svc.cluster_messages("new_tenant", ["test msg"])
        assert "new_tenant" in svc._miners

    def test_reuses_existing_miner(self, svc: DrainService) -> None:
        svc.cluster_messages("t1", ["msg1"])
        miner1 = svc._miners["t1"]
        svc.cluster_messages("t1", ["msg2"])
        miner2 = svc._miners["t1"]
        assert miner1 is miner2


class TestTenantIdValidation:
    def test_rejects_path_traversal(self, svc: DrainService) -> None:
        with pytest.raises(ValueError, match="Invalid tenant_id"):
            svc.cluster_messages("../../etc/evil", ["msg"])

    def test_rejects_dots(self, svc: DrainService) -> None:
        with pytest.raises(ValueError, match="Invalid tenant_id"):
            svc.cluster_messages("tenant.with.dots", ["msg"])

    def test_rejects_empty(self, svc: DrainService) -> None:
        with pytest.raises(ValueError, match="Invalid tenant_id"):
            svc.cluster_messages("", ["msg"])

    def test_accepts_valid_ids(self, svc: DrainService) -> None:
        for tid in ["tenant_a", "customer-123", "ABC_def_456"]:
            results = svc.cluster_messages(tid, ["test msg"])
            assert len(results) == 1


class TestStateSerialization:
    def test_get_state_returns_bytes(self, svc: DrainService) -> None:
        svc.cluster_messages("t1", ["test message for serialization"])
        state = svc.get_state("t1")
        assert isinstance(state, bytes)
        assert len(state) > 0

    def test_load_state_restores_clustering(self, svc: DrainService) -> None:
        # Train and capture results
        svc.cluster_messages("t1", ["Connection timeout to host after 100ms"])
        original = svc.cluster_messages("t1", ["Connection timeout to host after 200ms"])
        state = svc.get_state("t1")

        # Create fresh service and restore
        svc2 = DrainService(sim_th=0.4, depth=4)
        svc2.load_state("t1", state)

        # Same message should produce same template
        restored = svc2.cluster_messages("t1", ["Connection timeout to host after 300ms"])
        assert restored[0].template_text == original[0].template_text

    def test_load_state_unknown_tenant_creates_miner(self, svc: DrainService) -> None:
        svc.cluster_messages("t1", ["test msg"])
        state = svc.get_state("t1")

        svc2 = DrainService(sim_th=0.4, depth=4)
        svc2.load_state("t1", state)
        assert "t1" in svc2._miners
