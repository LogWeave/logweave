from pathlib import Path

import pytest

from clusterer.checkpoint import CheckpointManager


@pytest.fixture
def mgr(tmp_path: Path) -> CheckpointManager:
    return CheckpointManager(str(tmp_path))


class TestSaveAndLoad:
    def test_roundtrip(self, mgr: CheckpointManager) -> None:
        data = b'{"drain_state": "test_data"}'
        mgr.save("tenant_a", data)
        assert mgr.load("tenant_a") == data

    def test_atomic_write_leaves_no_tmp(self, mgr: CheckpointManager, tmp_path: Path) -> None:
        mgr.save("tenant_a", b"data")
        assert not (tmp_path / "tenant_a.drain3.tmp").exists()
        assert (tmp_path / "tenant_a.drain3").exists()

    def test_overwrite_preserves_latest(self, mgr: CheckpointManager) -> None:
        mgr.save("tenant_a", b"old")
        mgr.save("tenant_a", b"new")
        assert mgr.load("tenant_a") == b"new"


class TestLoadEdgeCases:
    def test_missing_returns_none(self, mgr: CheckpointManager) -> None:
        assert mgr.load("nonexistent") is None

    def test_corrupt_file_returns_none(self, mgr: CheckpointManager, tmp_path: Path) -> None:
        # Write a zero-byte file to simulate corruption
        (tmp_path / "bad_tenant.drain3").write_bytes(b"")
        assert mgr.load("bad_tenant") is None


class TestLoadAll:
    def test_finds_all_tenants(self, mgr: CheckpointManager) -> None:
        mgr.save("t1", b"data1")
        mgr.save("t2", b"data2")
        mgr.save("t3", b"data3")
        result = mgr.load_all()
        assert result == {"t1": b"data1", "t2": b"data2", "t3": b"data3"}

    def test_skips_corrupt_files(self, mgr: CheckpointManager, tmp_path: Path) -> None:
        mgr.save("good", b"valid_data")
        (tmp_path / "bad.drain3").write_bytes(b"")
        result = mgr.load_all()
        assert "good" in result
        assert "bad" not in result

    def test_empty_dir(self, mgr: CheckpointManager) -> None:
        assert mgr.load_all() == {}


class TestCleanupStaleTmp:
    def test_removes_all_tmp_files(self, mgr: CheckpointManager, tmp_path: Path) -> None:
        # Stale .tmp with a .drain3 present
        mgr.save("tenant_a", b"data")
        (tmp_path / "tenant_a.drain3.tmp").write_bytes(b"stale")
        # Orphaned .tmp with no .drain3 (still stale — interrupted write)
        (tmp_path / "orphan.drain3.tmp").write_bytes(b"orphan")

        mgr.cleanup_stale_tmp()

        assert not (tmp_path / "tenant_a.drain3.tmp").exists()
        assert not (tmp_path / "orphan.drain3.tmp").exists()
        # The actual checkpoint is untouched
        assert mgr.load("tenant_a") == b"data"


class TestEnsureDir:
    def test_creates_directory(self, tmp_path: Path) -> None:
        new_dir = tmp_path / "subdir" / "checkpoints"
        mgr = CheckpointManager(str(new_dir))
        mgr.ensure_dir()
        assert new_dir.is_dir()

    def test_idempotent(self, mgr: CheckpointManager) -> None:
        mgr.ensure_dir()
        mgr.ensure_dir()  # no error
