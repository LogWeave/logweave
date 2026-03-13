"""Thread-safety tests for DrainService.

Verifies that concurrent access to the same tenant's miner via
asyncio.to_thread() does not corrupt state.
"""

import threading
from concurrent.futures import ThreadPoolExecutor

from clusterer.drain_service import DrainService


class TestConcurrentClusterMessages:
    def test_concurrent_same_tenant_no_corruption(self) -> None:
        """Two threads clustering for the same tenant should not corrupt state."""
        svc = DrainService(sim_th=0.4, depth=4)
        errors: list[Exception] = []

        def cluster_batch(batch_id: int) -> None:
            try:
                messages = [f"Error {batch_id} in service-{i} after timeout" for i in range(100)]
                results = svc.cluster_messages("shared_tenant", messages)
                assert len(results) == 100
            except Exception as e:
                errors.append(e)

        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(cluster_batch, i) for i in range(8)]
            for f in futures:
                f.result()

        assert errors == [], f"Thread errors: {errors}"

    def test_concurrent_different_tenants_parallel(self) -> None:
        """Different tenants should run in parallel without blocking each other."""
        svc = DrainService(sim_th=0.4, depth=4)
        tenant_results: dict[str, int] = {}
        lock = threading.Lock()

        def cluster_for_tenant(tenant_id: str) -> None:
            messages = [f"Error in {tenant_id} service-{i}" for i in range(50)]
            results = svc.cluster_messages(tenant_id, messages)
            with lock:
                tenant_results[tenant_id] = len(results)

        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = [executor.submit(cluster_for_tenant, f"tenant_{i}") for i in range(4)]
            for f in futures:
                f.result()

        assert len(tenant_results) == 4
        assert all(count == 50 for count in tenant_results.values())


class TestConcurrentGetState:
    def test_get_state_during_clustering(self) -> None:
        """get_state() called while cluster_messages() is running should not crash."""
        svc = DrainService(sim_th=0.4, depth=4)
        # Seed with initial data so get_state has something to serialize
        svc.cluster_messages("t1", ["initial seed message for state"])
        errors: list[Exception] = []

        def do_clustering() -> None:
            try:
                for _ in range(10):
                    svc.cluster_messages("t1", [f"concurrent msg {i}" for i in range(20)])
            except Exception as e:
                errors.append(e)

        def do_get_state() -> None:
            try:
                for _ in range(10):
                    state = svc.get_state("t1")
                    assert isinstance(state, bytes)
                    assert len(state) > 0
            except Exception as e:
                errors.append(e)

        with ThreadPoolExecutor(max_workers=2) as executor:
            f1 = executor.submit(do_clustering)
            f2 = executor.submit(do_get_state)
            f1.result()
            f2.result()

        assert errors == [], f"Thread errors: {errors}"
