"""Internal operator event feed for the clusterer service.

Mirrors services/api/src/internal-events/* contracts. Single sanctioned path
into the operator event sinks: stdout (JSON line) plus best-effort ClickHouse
insert into logweave.internal_events. ClickHouse failures are swallowed so the
caller (often a hot path) is never disrupted.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import sys
from datetime import UTC, datetime
from typing import Any

# MVP event catalog. Mirrors services/api/src/internal-events/types.ts.
# Clusterer only emits a subset, but the catalog stays full for symmetry.
EVENT_CATALOG: frozenset[str] = frozenset(
    {
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
)


# Field names that, regardless of event, must never appear with their value.
# Case-insensitive substring match on the key.
_UNIVERSAL_FORBIDDEN_SUBSTRINGS: tuple[str, ...] = (
    "apikey",
    "api_key",
    "token",
    "secret",
    "password",
    "passwd",
    "webhook_url",
    "webhookurl",
    "authorization",
    "cookie",
    "sessionid",
    "session_id",
    "bearer",
    "private",
    "credential",
)

# Allowlist for config.loaded values. Includes both snake_case (Python) and
# camelCase (TypeScript) variants so the contract matches across services.
_CONFIG_VALUE_ALLOWLIST: frozenset[str] = frozenset(
    {
        "port",
        "log_level",
        "logLevel",
        "clickhouse_host",
        "clickhouseHost",
        "clickhouse_url",  # clusterer config uses *_url
        "clusterer_url",
        "clustererUrl",
        "node_env",
        "nodeEnv",
        "service_version",
        "serviceVersion",
    }
)

_STACK_LIKE = re.compile(r"\n\s+at\s|\n\s+File\s\"")
_TOKEN_PATTERN = re.compile(r"\b[a-zA-Z0-9_\-]{24,}\b")


def _is_forbidden_key(key: str) -> bool:
    lower = key.lower()
    return any(needle in lower for needle in _UNIVERSAL_FORBIDDEN_SUBSTRINGS)


def _redacted_placeholder(value: Any) -> str:
    if isinstance(value, str):
        return f"<redacted:len={len(value)}>"
    if value is None:
        return "<redacted>"
    return f"<redacted:type={type(value).__name__}>"


def redact_fields(fields: dict[str, Any]) -> dict[str, Any]:
    """Scrub forbidden keys at the top level and one level deep into nested dicts."""
    out: dict[str, Any] = {}
    for key, value in fields.items():
        if _is_forbidden_key(key):
            out[key] = _redacted_placeholder(value)
            continue
        if isinstance(value, dict):
            nested: dict[str, Any] = {}
            for k2, v2 in value.items():
                nested[k2] = _redacted_placeholder(v2) if _is_forbidden_key(k2) else v2
            out[key] = nested
            continue
        out[key] = value
    return out


def summarize_config(config: dict[str, Any]) -> dict[str, Any]:
    """Allowlist-only passthrough for config.loaded. Non-allowlisted -> placeholder."""
    out: dict[str, Any] = {}
    for key, value in config.items():
        if key in _CONFIG_VALUE_ALLOWLIST:
            out[key] = value
        else:
            out[key] = _redacted_placeholder(value)
    return out


def strip_stack_traces(fields: dict[str, Any]) -> dict[str, Any]:
    """Drop stack keys and collapse multi-line stack-looking strings to their first line."""
    out: dict[str, Any] = {}
    for key, value in fields.items():
        if key in ("stack", "stackTrace", "stack_trace", "traceback"):
            continue
        if isinstance(value, str) and _STACK_LIKE.search(value):
            out[key] = value.split("\n", 1)[0]
            continue
        out[key] = value
    return out


def sanitize_message(message: str) -> str:
    """Strip long opaque tokens from a message and cap length."""
    return _TOKEN_PATTERN.sub("<redacted:token>", message)[:240]


def _is_prod() -> bool:
    return os.environ.get("CLUSTERER_ENV", "").lower() == "production"


class InternalEventEmitter:
    """Single sanctioned path to the operator event feed.

    Dual-sink: always writes a JSON line to stdout, then best-effort insert
    into logweave.internal_events. ClickHouse failures are caught and dropped;
    stdout already has the event, and re-emitting through this class would
    recurse.
    """

    SERVICE: str = "clusterer"

    def __init__(
        self,
        ch_client: Any | None = None,
        *,
        stdout: Any = None,
        now: Any = None,
        is_prod: bool | None = None,
    ) -> None:
        self._ch_client = ch_client
        self._stdout = stdout if stdout is not None else sys.stdout
        self._now = now if now is not None else (lambda: datetime.now(UTC))
        self._is_prod = is_prod if is_prod is not None else _is_prod()

    def emit(
        self,
        event: str,
        severity: str,
        code: str,
        summary: str,
        fields: dict[str, Any] | None = None,
    ) -> None:
        if event not in EVENT_CATALOG:
            if not self._is_prod:
                raise ValueError(f"unknown internal event: {event}")
            return  # silent drop in prod

        raw_fields = fields or {}
        redacted = redact_fields(raw_fields)
        safe_summary = sanitize_message(summary)

        ts = self._now().isoformat()
        stdout_event = {
            "ts": ts,
            "service": self.SERVICE,
            "event": event,
            "severity": severity,
            "code": code,
            "summary": safe_summary,
            "fields": redacted,
        }
        try:
            self._stdout.write(json.dumps(stdout_event) + "\n")
            flush = getattr(self._stdout, "flush", None)
            if callable(flush):
                flush()
        except Exception:  # noqa: BLE001, S110 — never throw from the emitter
            pass

        ch_fields = strip_stack_traces(redacted)
        ch_event = dict(stdout_event)
        ch_event["fields"] = json.dumps(ch_fields)
        self._ship_to_clickhouse(ch_event)

    def emit_config_loaded(self, config: dict[str, Any]) -> None:
        self.emit(
            event="config.loaded",
            severity="info",
            code="CONFIG_LOADED",
            summary="config loaded",
            fields=summarize_config(config),
        )

    def _ship_to_clickhouse(self, event: dict[str, Any]) -> None:
        if self._ch_client is None:
            return
        # stdout already has the event; CH insert is best-effort. We must not
        # re-emit on failure or we recurse, hence the bare swallow.
        with contextlib.suppress(Exception):
            self._ch_client.insert(
                "logweave.internal_events",
                [
                    [
                        event["ts"],
                        event["service"],
                        event["event"],
                        event["severity"],
                        event["code"],
                        event["summary"],
                        event["fields"],
                    ]
                ],
                column_names=[
                    "ts",
                    "service",
                    "event",
                    "severity",
                    "code",
                    "summary",
                    "fields",
                ],
            )


class _NoopEmitter(InternalEventEmitter):
    """Returned by get_internal_events when init was never called."""

    def __init__(self) -> None:  # noqa: D401
        super().__init__(ch_client=None, stdout=_NullStdout(), is_prod=True)


class _NullStdout:
    def write(self, _: str) -> int:
        return 0

    def flush(self) -> None:
        return None


_singleton: InternalEventEmitter | None = None


def init_internal_events(ch_client: Any | None) -> InternalEventEmitter:
    """Initialize the process-wide emitter. Call once at startup."""
    global _singleton
    _singleton = InternalEventEmitter(ch_client=ch_client)
    return _singleton


def get_internal_events() -> InternalEventEmitter:
    """Process-wide accessor. Returns a no-op emitter if init was never called."""
    global _singleton
    if _singleton is None:
        _singleton = _NoopEmitter()
    return _singleton


def emit_config_loaded(config: dict[str, Any]) -> None:
    """Convenience: emit a config.loaded event via the singleton emitter."""
    get_internal_events().emit_config_loaded(config)


def _reset_for_tests() -> None:
    """Test-only: reset the singleton between test cases."""
    global _singleton
    _singleton = None
