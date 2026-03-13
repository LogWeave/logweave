"""Atomic checkpoint persistence for Drain3 state.

Saves and loads per-tenant Drain3 state as files with atomic rename to
prevent corruption from crashes mid-write. Optional HMAC-SHA256 integrity
verification when checkpoint_hmac_key is configured.

Security note: checkpoint files use jsonpickle (Drain3's native format),
which can execute arbitrary code on deserialization. Only load checkpoints
from the trusted checkpoint volume — never from external/user sources.
"""

import hashlib
import hmac
import logging
import os
import re
from pathlib import Path

logger = logging.getLogger(__name__)

_EXTENSION = ".drain3"
_TMP_SUFFIX = ".drain3.tmp"
_VALID_TENANT_ID = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
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
        if not _VALID_TENANT_ID.match(tenant_id):
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

        If hmac_key is set, verifies HMAC before returning data.
        """
        path = self._dir / f"{tenant_id}{_EXTENSION}"
        if not path.exists():
            return None
        data = path.read_bytes()
        if not data:
            logger.warning("Corrupt checkpoint for tenant %s (empty file), skipping", tenant_id)
            return None

        if self._hmac_key:
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

        return data

    def load_all(self) -> dict[str, bytes]:
        """Load all tenant checkpoints. Skips corrupt files with a warning."""
        result: dict[str, bytes] = {}
        for path in self._dir.glob(f"*{_EXTENSION}"):
            tenant_id = path.name.removesuffix(_EXTENSION)
            if not _VALID_TENANT_ID.match(tenant_id):
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

    def cleanup_stale_tmp(self) -> None:
        """Remove all .drain3.tmp files — they are always stale leftovers."""
        for tmp_path in self._dir.glob(f"*{_TMP_SUFFIX}"):
            tmp_path.unlink()
            logger.info("Removed stale tmp checkpoint: %s", tmp_path.name)

    def ensure_dir(self) -> None:
        """Create the checkpoint directory if it doesn't exist."""
        self._dir.mkdir(parents=True, exist_ok=True)
