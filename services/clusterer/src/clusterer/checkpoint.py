"""Atomic checkpoint persistence for Drain3 state.

Saves and loads per-tenant Drain3 state as files with atomic rename to
prevent corruption from crashes mid-write. Optional HMAC-SHA256 integrity
verification when checkpoint_hmac_key is configured.

Security note: checkpoint files use jsonpickle (Drain3's native format),
which can execute arbitrary code on deserialization. Only load checkpoints
from the trusted checkpoint volume — never from external/user sources.

CVE-2020-22083 (jsonpickle <= 2.0.0, code execution on decoding untrusted
data) is ACCEPTED as mitigated, not fixed, and here's why the fix is deferred:
Drain3 hard-pins jsonpickle to 1.5.1 (its latest 0.9.11 still does, and there
is no Drain3 >= 1.0), so `jsonpickle >= 3` is an unsatisfiable dependency. The
CVE's attack vector — decoding attacker-controlled data — does not apply here:
the only bytes ever deserialized are this service's OWN checkpoints, read from
a trusted local volume and gated by HMAC verification (load() below refuses to
deserialize without a verified HMAC, and fails closed with no key). Re-evaluate
if Drain3 relaxes the pin or is replaced.
"""

import hashlib
import hmac
import logging
import os
from pathlib import Path

from clusterer.models import TENANT_ID_PATTERN

logger = logging.getLogger(__name__)

_EXTENSION = ".drain3"
_TMP_SUFFIX = ".drain3.tmp"
_HMAC_SIZE = 32  # SHA-256 produces 32 bytes


class CheckpointManager:
    def __init__(self, checkpoint_dir: str, *, hmac_key: str = "") -> None:
        self._dir = Path(checkpoint_dir)
        self._hmac_key = hmac_key.encode("utf-8") if hmac_key else b""

    def _compute_hmac(self, data: bytes) -> bytes:
        return hmac.new(self._hmac_key, data, hashlib.sha256).digest()

    def save(self, tenant_id: str, state: bytes) -> None:
        """Atomic save: write to .tmp, then os.replace() to .drain3.

        If hmac_key is set, appends a 32-byte HMAC-SHA256 tag.
        """
        if not TENANT_ID_PATTERN.match(tenant_id):
            raise ValueError(f"Invalid tenant_id for checkpoint: {tenant_id!r}")
        tmp_path = self._dir / f"{tenant_id}{_TMP_SUFFIX}"
        final_path = self._dir / f"{tenant_id}{_EXTENSION}"
        try:
            payload = state
            if self._hmac_key:
                payload = state + self._compute_hmac(state)
            tmp_path.write_bytes(payload)
            os.replace(tmp_path, final_path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    def load(self, tenant_id: str) -> bytes | None:
        """Load checkpoint for tenant. Returns None if missing or corrupt.

        Fail-closed: when no hmac_key is configured we refuse to return
        checkpoint bytes at all. The caller deserializes these via jsonpickle
        (arbitrary-code-execution on load), so an unverified checkpoint must
        never reach that path. A keyless deployment therefore starts fresh
        rather than trusting on-disk state.

        When hmac_key is set, verifies the HMAC before returning data.
        """
        path = self._dir / f"{tenant_id}{_EXTENSION}"
        if not path.exists():
            return None

        if not self._hmac_key:
            logger.error(
                "Refusing to load checkpoint for tenant %s: "
                "LOGWEAVE_CHECKPOINT_HMAC_KEY is not set, so checkpoint integrity "
                "cannot be verified before jsonpickle deserialization. Starting fresh. "
                "Set the key to enable checkpoint restore.",
                tenant_id,
            )
            return None

        data = path.read_bytes()
        if not data:
            logger.warning("Corrupt checkpoint for tenant %s (empty file), skipping", tenant_id)
            return None

        if len(data) < _HMAC_SIZE:
            logger.warning(
                "Checkpoint for tenant %s too short for HMAC verification, skipping",
                tenant_id,
            )
            return None
        state = data[:-_HMAC_SIZE]
        stored_hmac = data[-_HMAC_SIZE:]
        expected_hmac = self._compute_hmac(state)
        if not hmac.compare_digest(stored_hmac, expected_hmac):
            logger.warning(
                "HMAC verification failed for tenant %s checkpoint, skipping",
                tenant_id,
            )
            return None
        return state

    def load_all(self) -> dict[str, bytes]:
        """Load all tenant checkpoints. Skips corrupt files with a warning."""
        result: dict[str, bytes] = {}
        for path in self._dir.glob(f"*{_EXTENSION}"):
            tenant_id = path.name.removesuffix(_EXTENSION)
            if not TENANT_ID_PATTERN.match(tenant_id):
                logger.warning("Skipping checkpoint with invalid tenant_id: %s", path.name)
                continue
            try:
                data = self.load(tenant_id)
                if data is not None:
                    result[tenant_id] = data
            except Exception:
                logger.warning(
                    "Failed to load checkpoint for tenant %s, skipping",
                    tenant_id,
                    exc_info=True,
                )
        return result

    def list_tenants(self) -> list[str]:
        """Return tenant_ids with a valid checkpoint file, oldest-first by mtime.

        Used by capped restore so the memory ceiling holds across restarts:
        the caller restores only the first ``max_tenants`` and skips the rest.
        """
        entries: list[tuple[float, str]] = []
        for path in self._dir.glob(f"*{_EXTENSION}"):
            tenant_id = path.name.removesuffix(_EXTENSION)
            if not TENANT_ID_PATTERN.match(tenant_id):
                logger.warning("Skipping checkpoint with invalid tenant_id: %s", path.name)
                continue
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            entries.append((mtime, tenant_id))
        entries.sort()
        return [tenant_id for _, tenant_id in entries]

    def delete(self, tenant_id: str) -> bool:
        """Delete checkpoint for a tenant. Returns True if file existed."""
        path = self._dir / f"{tenant_id}{_EXTENSION}"
        if path.exists():
            path.unlink()
            logger.info("Deleted checkpoint for tenant %s", tenant_id)
            return True
        return False

    def cleanup_stale_tmp(self) -> None:
        """Remove all .drain3.tmp files — they are always stale leftovers."""
        for tmp_path in self._dir.glob(f"*{_TMP_SUFFIX}"):
            tmp_path.unlink()
            logger.info("Removed stale tmp checkpoint: %s", tmp_path.name)

    def ensure_dir(self) -> None:
        """Create the checkpoint directory if it doesn't exist."""
        self._dir.mkdir(parents=True, exist_ok=True)
