from pathlib import Path

import pytest

from clusterer.checkpoint import CheckpointManager


@pytest.fixture
def mgr(tmp_path: Path) -> CheckpointManager:
    # Keyed by default: loading checkpoints requires an HMAC key (fail-closed),
    # so the supported configuration is keyed. Tests that exercise the keyless
    # path construct a keyless manager inline.
    return CheckpointManager(str(tmp_path), hmac_key="default-fixture-key")


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


class TestListTenants:
    def test_oldest_first_by_mtime(self, mgr: CheckpointManager, tmp_path: Path) -> None:
        import os

        for name, mtime in (("newest", 3000), ("oldest", 1000), ("middle", 2000)):
            mgr.save(name, b"data")
            path = tmp_path / f"{name}.drain3"
            os.utime(path, (mtime, mtime))
        assert mgr.list_tenants() == ["oldest", "middle", "newest"]

    def test_skips_invalid_tenant_names(self, mgr: CheckpointManager, tmp_path: Path) -> None:
        mgr.save("valid", b"data")
        (tmp_path / "not a tenant.drain3").write_bytes(b"data")
        assert mgr.list_tenants() == ["valid"]

    def test_empty_dir(self, mgr: CheckpointManager) -> None:
        assert mgr.list_tenants() == []


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


class TestHmac:
    @pytest.fixture
    def hmac_mgr(self, tmp_path: Path) -> CheckpointManager:
        return CheckpointManager(str(tmp_path), hmac_key="test-secret-key")

    def test_hmac_roundtrip(self, hmac_mgr: CheckpointManager) -> None:
        data = b'{"drain_state": "test_data"}'
        hmac_mgr.save("tenant_a", data)
        assert hmac_mgr.load("tenant_a") == data

    def test_tampered_data_rejected(self, hmac_mgr: CheckpointManager, tmp_path: Path) -> None:
        data = b"original_state"
        hmac_mgr.save("tenant_a", data)
        # Tamper with the file
        path = tmp_path / "tenant_a.drain3"
        raw = path.read_bytes()
        path.write_bytes(b"tampered" + raw[8:])
        assert hmac_mgr.load("tenant_a") is None

    def test_truncated_file_rejected(self, hmac_mgr: CheckpointManager, tmp_path: Path) -> None:
        data = b"some state"
        hmac_mgr.save("tenant_a", data)
        path = tmp_path / "tenant_a.drain3"
        # Write file smaller than HMAC size
        path.write_bytes(b"short")
        assert hmac_mgr.load("tenant_a") is None

    def test_no_hmac_key_refuses_load(self, tmp_path: Path) -> None:
        """Fail-closed: without hmac_key, save still writes but load refuses.

        The bytes feed jsonpickle deserialization (RCE-capable), so an
        unverifiable checkpoint must never be returned — the tenant starts fresh.
        """
        keyless = CheckpointManager(str(tmp_path))
        data = b"plain_state"
        keyless.save("tenant_a", data)
        assert (tmp_path / "tenant_a.drain3").exists()
        assert keyless.load("tenant_a") is None

    def test_hmac_file_larger_than_plain(self, hmac_mgr: CheckpointManager, tmp_path: Path) -> None:
        """HMAC-protected file should be 32 bytes larger."""
        keyless = CheckpointManager(str(tmp_path))
        data = b"test_state"
        keyless.save("plain", data)
        hmac_mgr.save("hmac", data)
        plain_size = (tmp_path / "plain.drain3").stat().st_size
        hmac_size = (tmp_path / "hmac.drain3").stat().st_size
        assert hmac_size == plain_size + 32

    def test_wrong_key_rejected(self, tmp_path: Path) -> None:
        """Loading with a different key than save should reject."""
        mgr1 = CheckpointManager(str(tmp_path), hmac_key="key1")
        mgr2 = CheckpointManager(str(tmp_path), hmac_key="key2")
        mgr1.save("tenant_a", b"secret_state")
        assert mgr2.load("tenant_a") is None


class TestEnsureDir:
    def test_creates_directory(self, tmp_path: Path) -> None:
        new_dir = tmp_path / "subdir" / "checkpoints"
        mgr = CheckpointManager(str(new_dir))
        mgr.ensure_dir()
        assert new_dir.is_dir()

    def test_idempotent(self, mgr: CheckpointManager) -> None:
        mgr.ensure_dir()
        mgr.ensure_dir()  # no error
