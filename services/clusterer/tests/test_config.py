import pytest

from clusterer.config import get_settings


def test_settings_defaults():
    s = get_settings()
    assert s.drain3_checkpoint_dir == "/data/drain3"
    assert s.drain3_checkpoint_interval == 60
    assert s.clickhouse_url == "clickhouse://localhost:9000/logweave"
    assert s.clickhouse_user is None
    assert s.clickhouse_password.get_secret_value() == ""
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


def test_clickhouse_credentials_from_env(monkeypatch):
    monkeypatch.setenv("LOGWEAVE_CLICKHOUSE_USER", "logweave")
    monkeypatch.setenv("LOGWEAVE_CLICKHOUSE_PASSWORD", "s3cret")
    s = get_settings()
    assert s.clickhouse_user == "logweave"
    assert s.clickhouse_password.get_secret_value() == "s3cret"


def test_clickhouse_password_not_in_repr():
    """SecretStr keeps the password out of repr/str so it can't leak to logs."""
    from clusterer.config import Settings

    s = Settings(clickhouse_user="logweave", clickhouse_password="s3cret")
    assert "s3cret" not in repr(s)
    assert "s3cret" not in str(s.clickhouse_password)


def test_client_kwargs_includes_credentials_when_user_set():
    from clusterer.config import Settings
    from clusterer.main import build_clickhouse_client_kwargs

    s = Settings(
        clickhouse_url="http://clickhouse:8123/logweave",
        clickhouse_user="logweave",
        clickhouse_password="s3cret",
    )
    kwargs = build_clickhouse_client_kwargs(s)
    assert kwargs["dsn"] == "http://clickhouse:8123/logweave"
    assert kwargs["username"] == "logweave"
    assert kwargs["password"] == "s3cret"


def test_client_kwargs_omits_credentials_when_user_unset():
    from clusterer.config import Settings
    from clusterer.main import build_clickhouse_client_kwargs

    s = Settings(clickhouse_url="clickhouse://localhost:9000/logweave")
    kwargs = build_clickhouse_client_kwargs(s)
    assert kwargs == {"dsn": "clickhouse://localhost:9000/logweave"}
    assert "username" not in kwargs
    assert "password" not in kwargs


def test_password_not_leaked_in_config_loaded_event():
    """The config.loaded summary (allowlist-only) must never carry the plaintext
    password, even via model_dump(). Locks the end-to-end redaction guarantee."""
    import json

    from clusterer.config import Settings
    from clusterer.internal_events import summarize_config

    s = Settings(clickhouse_user="logweave", clickhouse_password="s3cret-value")
    summary = summarize_config(s.model_dump())
    assert "s3cret-value" not in json.dumps(summary, default=str)


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
