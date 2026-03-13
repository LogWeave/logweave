from clusterer.config import Settings


def test_settings_defaults():
    s = Settings()
    assert s.drain3_checkpoint_dir == "/data/drain3"
    assert s.drain3_checkpoint_interval == 60
    assert s.logweave_clickhouse_url == "clickhouse://localhost:9000/logweave"


def test_settings_from_env(monkeypatch):
    monkeypatch.setenv("DRAIN3_CHECKPOINT_DIR", "/tmp/test")
    monkeypatch.setenv("DRAIN3_CHECKPOINT_INTERVAL", "120")
    monkeypatch.setenv("LOGWEAVE_CLICKHOUSE_URL", "clickhouse://test:9000/db")
    s = Settings()
    assert s.drain3_checkpoint_dir == "/tmp/test"
    assert s.drain3_checkpoint_interval == 120
    assert s.logweave_clickhouse_url == "clickhouse://test:9000/db"
