import pytest

from clusterer.config import get_settings


def test_settings_defaults():
    s = get_settings()
    assert s.drain3_checkpoint_dir == "/data/drain3"
    assert s.drain3_checkpoint_interval == 60
    assert s.clickhouse_url == "clickhouse://localhost:9000/logweave"
    assert s.drain3_max_clusters == 10_000
    assert s.max_concurrent_requests == 4
    assert s.request_timeout_seconds == 0.45
    assert s.max_tenants == 200
    assert s.checkpoint_hmac_key.get_secret_value() == ""


def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("LOGWEAVE_DRAIN3_CHECKPOINT_DIR", "/tmp/test")
    monkeypatch.setenv("LOGWEAVE_DRAIN3_CHECKPOINT_INTERVAL", "120")
    monkeypatch.setenv("LOGWEAVE_CLICKHOUSE_URL", "clickhouse://test:9000/db")
    monkeypatch.setenv("LOGWEAVE_MAX_TENANTS", "500")
    s = get_settings()
    assert s.drain3_checkpoint_dir == "/tmp/test"
    assert s.drain3_checkpoint_interval == 120
    assert s.clickhouse_url == "clickhouse://test:9000/db"
    assert s.max_tenants == 500


def test_sim_th_validation():
    """sim_th must be > 0.0 and <= 1.0."""
    from pydantic import ValidationError

    from clusterer.config import Settings

    with pytest.raises(ValidationError):
        Settings(drain3_sim_th=0.0)

    with pytest.raises(ValidationError):
        Settings(drain3_sim_th=1.5)


def test_depth_validation():
    """depth must be >= 2."""
    from pydantic import ValidationError

    from clusterer.config import Settings

    with pytest.raises(ValidationError):
        Settings(drain3_depth=1)
