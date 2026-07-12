"""Tests for the internal event emitter (operator event feed)."""

from __future__ import annotations

import json
from typing import Any

import pytest

from clusterer.internal_events import (
    EVENT_CATALOG,
    InternalEventEmitter,
    _reset_for_tests,
    emit_clickhouse_failure,
    get_internal_events,
    init_internal_events,
    redact_fields,
    strip_stack_traces,
    summarize_config,
)


@pytest.fixture(autouse=True)
def _reset_singleton() -> None:
    _reset_for_tests()
    yield
    _reset_for_tests()


class _FakeCh:
    def __init__(self, raise_on_insert: bool = False) -> None:
        self.raise_on_insert = raise_on_insert
        self.inserts: list[tuple[str, list[Any], list[str]]] = []

    def insert(self, table: str, rows: list[Any], column_names: list[str]) -> None:
        if self.raise_on_insert:
            raise RuntimeError("ch unavailable")
        self.inserts.append((table, rows, column_names))


# ----------------------------- redaction ----------------------------- #


def test_redact_fields_flat_forbidden_keys() -> None:
    out = redact_fields(
        {
            "api_key": "abcdef",
            "Authorization": "Bearer abc",
            "password": "hunter2",
            "tenant_id": "t1",
        }
    )
    assert out["api_key"] == "<redacted:len=6>"
    assert out["Authorization"] == "<redacted:len=10>"
    assert out["password"] == "<redacted:len=7>"
    assert out["tenant_id"] == "t1"


def test_redact_fields_case_insensitive() -> None:
    out = redact_fields({"MyToKEN": "x", "SessionID": "y"})
    assert out["MyToKEN"] == "<redacted:len=1>"
    assert out["SessionID"] == "<redacted:len=1>"


def test_redact_fields_nested_one_level() -> None:
    out = redact_fields(
        {
            "config": {"port": 8000, "secret": "shh", "BEARER": "tok"},
            "okay": "fine",
        }
    )
    assert out["config"]["port"] == 8000
    assert out["config"]["secret"] == "<redacted:len=3>"
    assert out["config"]["BEARER"] == "<redacted:len=3>"
    assert out["okay"] == "fine"


def test_redact_fields_non_string_values_get_typed_placeholder() -> None:
    out = redact_fields({"token": 42, "secret": None})
    assert out["token"] == "<redacted:type=int>"
    assert out["secret"] == "<redacted>"


# --------------------------- config summary --------------------------- #


def test_summarize_config_allowlist_passthrough() -> None:
    out = summarize_config(
        {
            "port": 8000,
            "log_level": "INFO",
            "service_version": "0.1.0",
        }
    )
    assert out == {
        "port": 8000,
        "log_level": "INFO",
        "service_version": "0.1.0",
    }


def test_summarize_config_url_keys_become_host_only() -> None:
    out = summarize_config(
        {
            "clickhouse_url": "clickhouse://user:hunter2@db.internal:9000/logweave",
            "port": 8000,
        }
    )
    assert out["port"] == 8000
    assert out["clickhouse_url_host"] == "db.internal:9000"
    # No userinfo, no full URL anywhere in the JSON.
    serialized = json.dumps(out)
    assert "hunter2" not in serialized
    assert "user:hunter2" not in serialized
    assert "clickhouse://user:hunter2@db.internal:9000/logweave" not in serialized
    assert "clickhouse_url" not in out  # original key removed in favor of _host


def test_summarize_config_unparseable_url_does_not_crash() -> None:
    out = summarize_config({"clickhouse_url": "not a url"})
    # urlparse returns no hostname for "not a url"; we emit the unparseable marker.
    assert out["clickhouse_url_host"] == "<unparseable>"


def test_summarize_config_redacts_non_allowlisted() -> None:
    out = summarize_config(
        {
            "port": 8000,
            "drain3_sim_th": 0.4,
            "checkpoint_hmac_key": "supersecretkey",
            "internal_secret": "topsecretvalue",
        }
    )
    assert out["port"] == 8000
    assert out["drain3_sim_th"] == "<redacted:type=float>"
    assert out["checkpoint_hmac_key"] == "<redacted:len=14>"
    assert out["internal_secret"] == "<redacted:len=14>"


# ------------------------------ emit --------------------------------- #


def test_emit_writes_json_line_to_stdout(capsys: pytest.CaptureFixture[str]) -> None:
    emitter = InternalEventEmitter(ch_client=None, stdout=None, is_prod=False)
    # Replace stdout with sys.stdout via capsys default capture.
    import sys

    emitter._stdout = sys.stdout  # type: ignore[attr-defined]
    emitter.emit(
        event="service.started",
        severity="info",
        code="SERVICE_STARTED",
        summary="up",
        fields={"service_version": "0.1.0"},
    )
    captured = capsys.readouterr()
    line = captured.out.strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload["event"] == "service.started"
    assert payload["service"] == "clusterer"
    assert payload["severity"] == "info"
    assert payload["code"] == "SERVICE_STARTED"
    assert payload["summary"] == "up"
    assert payload["fields"] == {"service_version": "0.1.0"}
    assert "ts" in payload


def test_emit_unknown_event_raises_in_dev() -> None:
    emitter = InternalEventEmitter(ch_client=None, is_prod=False)
    with pytest.raises(ValueError, match="unknown internal event"):
        emitter.emit(event="nope.nope", severity="info", code="X", summary="x")


def test_emit_unknown_event_silent_in_prod(capsys: pytest.CaptureFixture[str]) -> None:
    import sys

    emitter = InternalEventEmitter(ch_client=None, is_prod=True)
    emitter._stdout = sys.stdout  # type: ignore[attr-defined]
    emitter.emit(event="nope.nope", severity="info", code="X", summary="x")
    captured = capsys.readouterr()
    assert captured.out == ""


def test_emit_ch_insert_failure_is_swallowed(capsys: pytest.CaptureFixture[str]) -> None:
    import sys

    fake = _FakeCh(raise_on_insert=True)
    emitter = InternalEventEmitter(ch_client=fake, is_prod=False)
    emitter._stdout = sys.stdout  # type: ignore[attr-defined]

    # Must not raise.
    emitter.emit(
        event="clickhouse.unreachable",
        severity="error",
        code="CH_UNREACHABLE",
        summary="ch down",
        fields={"host": "localhost"},
    )

    captured = capsys.readouterr()
    line = captured.out.strip().splitlines()[-1]
    payload = json.loads(line)
    assert payload["event"] == "clickhouse.unreachable"
    assert payload["fields"] == {"host": "localhost"}


def test_emit_ch_insert_success_writes_row(capsys: pytest.CaptureFixture[str]) -> None:
    import sys

    fake = _FakeCh(raise_on_insert=False)
    emitter = InternalEventEmitter(ch_client=fake, is_prod=False)
    emitter._stdout = sys.stdout  # type: ignore[attr-defined]

    emitter.emit(
        event="service.started",
        severity="info",
        code="SERVICE_STARTED",
        summary="up",
        fields={"service_version": "0.1.0"},
    )
    capsys.readouterr()  # drain

    assert len(fake.inserts) == 1
    table, rows, cols = fake.inserts[0]
    assert table == "logweave.internal_events"
    assert cols == ["ts", "service", "event", "severity", "code", "summary", "fields"]
    assert len(rows) == 1
    row = rows[0]
    # fields column is a JSON string.
    fields_json = json.loads(row[6])
    assert fields_json == {"service_version": "0.1.0"}


def test_emit_redacts_forbidden_keys_in_output(
    capsys: pytest.CaptureFixture[str],
) -> None:
    import sys

    fake = _FakeCh()
    emitter = InternalEventEmitter(ch_client=fake, is_prod=False)
    emitter._stdout = sys.stdout  # type: ignore[attr-defined]
    emitter.emit(
        event="config.invalid",
        severity="error",
        code="CONFIG_INVALID",
        summary="bad",
        fields={"api_key": "abcdef", "ok": "fine"},
    )
    captured = capsys.readouterr()
    payload = json.loads(captured.out.strip().splitlines()[-1])
    assert payload["fields"]["api_key"] == "<redacted:len=6>"
    assert payload["fields"]["ok"] == "fine"


# ---------------------- singleton / module API ----------------------- #


def test_get_internal_events_noop_before_init(
    capsys: pytest.CaptureFixture[str],
) -> None:
    emitter = get_internal_events()
    # Should not raise and should not write anywhere observable.
    emitter.emit(
        event="service.started",
        severity="info",
        code="SERVICE_STARTED",
        summary="up",
    )
    captured = capsys.readouterr()
    assert captured.out == ""


def test_init_internal_events_returns_real_emitter() -> None:
    fake = _FakeCh()
    emitter = init_internal_events(fake)
    assert isinstance(emitter, InternalEventEmitter)
    assert get_internal_events() is emitter


def test_strip_stack_traces_drops_top_level_stack_keys() -> None:
    out = strip_stack_traces({"stack": "Error\n  at foo", "msg": "hi"})
    assert "stack" not in out
    assert out["msg"] == "hi"


def test_strip_stack_traces_recurses_one_level_into_nested_dicts() -> None:
    out = strip_stack_traces(
        {
            "error": {"stack": "Error\n  at foo", "code": "X"},
            "msg": "hi",
        }
    )
    assert out["msg"] == "hi"
    assert "stack" not in out["error"]
    assert out["error"]["code"] == "X"


def test_strip_stack_traces_collapses_multiline_stack_strings_nested() -> None:
    out = strip_stack_traces(
        {
            "error": {"detail": "Error: bad\n    at foo\n    at bar"},
        }
    )
    assert out["error"]["detail"] == "Error: bad"


# --------------------- ch failure emission helper -------------------- #


def test_emit_clickhouse_failure_emits_query_failed(
    capsys: pytest.CaptureFixture[str],
) -> None:
    import sys

    fake = _FakeCh()
    emitter = InternalEventEmitter(ch_client=fake, is_prod=False)
    emitter._stdout = sys.stdout  # type: ignore[attr-defined]
    # Install as singleton so emit_clickhouse_failure picks it up.
    import clusterer.internal_events as ie

    ie._singleton = emitter  # type: ignore[attr-defined]

    class BoomError(RuntimeError):
        pass

    with pytest.raises(BoomError):
        try:
            raise BoomError("boom")
        except BoomError as exc:
            emit_clickhouse_failure("query", exc)
            raise

    captured = capsys.readouterr()
    lines = [line for line in captured.out.strip().splitlines() if line]
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["event"] == "clickhouse.query_failed"
    assert payload["code"] == "CH_QUERY_FAILED"
    assert payload["severity"] == "error"
    assert payload["fields"]["query_kind"] == "query"
    assert payload["fields"]["error_name"] == "BoomError"


def test_emit_clickhouse_failure_detects_connection_errors(
    capsys: pytest.CaptureFixture[str],
) -> None:
    import sys

    fake = _FakeCh()
    emitter = InternalEventEmitter(ch_client=fake, is_prod=False)
    emitter._stdout = sys.stdout  # type: ignore[attr-defined]
    import clusterer.internal_events as ie

    ie._singleton = emitter  # type: ignore[attr-defined]

    class FakeConnectionError(OSError):
        pass

    try:
        raise FakeConnectionError("refused")
    except FakeConnectionError as exc:
        emit_clickhouse_failure("insert", exc)

    captured = capsys.readouterr()
    payload = json.loads(captured.out.strip().splitlines()[-1])
    assert payload["event"] == "clickhouse.unreachable"
    assert payload["code"] == "CH_UNREACHABLE"
    assert payload["fields"]["query_kind"] == "insert"


def test_template_registry_query_failure_emits_and_reraises(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """End-to-end: TemplateRegistry._query_registry wraps client.query with the
    helper, so a stubbed client that raises produces one emission and propagates."""
    import sys

    from clusterer.template_registry import TemplateRegistry

    fake = _FakeCh()
    emitter = InternalEventEmitter(ch_client=fake, is_prod=False)
    emitter._stdout = sys.stdout  # type: ignore[attr-defined]
    import clusterer.internal_events as ie

    ie._singleton = emitter  # type: ignore[attr-defined]

    class StubClient:
        def query(self, *_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError("ch went away")

        def command(self, *_args: Any, **_kwargs: Any) -> None:
            raise AssertionError("should not be called")

        def insert(self, *_args: Any, **_kwargs: Any) -> None:
            raise AssertionError("should not be called")

    registry = TemplateRegistry(StubClient())  # type: ignore[arg-type]

    with pytest.raises(RuntimeError, match="ch went away"):
        registry._query_registry("t1", "some template")

    captured = capsys.readouterr()
    lines = [line for line in captured.out.strip().splitlines() if line]
    # Exactly one ch.query_failed event emitted (no double-emission on the
    # internal-events insert path, which silently swallows).
    events = [json.loads(line) for line in lines]
    failure_events = [e for e in events if e["event"] == "clickhouse.query_failed"]
    assert len(failure_events) == 1
    assert failure_events[0]["fields"]["query_kind"] == "query"
    assert failure_events[0]["fields"]["error_name"] == "RuntimeError"


def test_event_catalog_matches_spec() -> None:
    assert EVENT_CATALOG == {
        "service.started",
        "service.stopping",
        "config.loaded",
        "config.invalid",
        "migration.applied",
        "clickhouse.query_failed",
        "clickhouse.unreachable",
        "clusterer.timeout",
        "clusterer.unreachable",
        "slack.webhook_failed",
        "s3.connector_failed",
        "auth.key_invalid",
        "ratelimit.exceeded",
    }
