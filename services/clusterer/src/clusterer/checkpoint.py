"""Atomic checkpoint persistence for Drain3 state.

Saves and loads per-tenant Drain3 state as files with atomic rename to
prevent corruption from crashes mid-write.

Security note: checkpoint files use jsonpickle (Drain3's native format),
which can execute arbitrary code on deserialization. Only load checkpoints
from the trusted checkpoint volume — never from external/user sources.
"""

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_EXTENSION = ".drain3"
_TMP_SUFFIX = ".drain3.tmp"


class CheckpointManager:
    def __init__(self, checkpoint_dir: str) -> None:
        self._dir = Path(checkpoint_dir)

    def save(self, tenant_id: str, state: bytes) -> None:
        """Atomic save: write to .tmp, then os.replace() to .drain3."""
        tmp_path = self._dir / f"{tenant_id}{_TMP_SUFFIX}"
        final_path = self._dir / f"{tenant_id}{_EXTENSION}"
        tmp_path.write_bytes(state)
        os.replace(tmp_path, final_path)

    def load(self, tenant_id: str) -> bytes | None:
        """Load checkpoint for tenant. Returns None if missing or corrupt."""
        path = self._dir / f"{tenant_id}{_EXTENSION}"
        if not path.exists():
            return None
        data = path.read_bytes()
        if not data:
            logger.warning("Corrupt checkpoint for tenant %s (empty file), skipping", tenant_id)
            return None
        return data

    def load_all(self) -> dict[str, bytes]:
        """Load all tenant checkpoints. Skips corrupt files with a warning."""
        result: dict[str, bytes] = {}
        for path in self._dir.glob(f"*{_EXTENSION}"):
            if path.name.endswith(_TMP_SUFFIX):
                continue
            tenant_id = path.name.removesuffix(_EXTENSION)
            try:
                data = self.load(tenant_id)
                if data is not None:
                    result[tenant_id] = data
            except Exception:
                logger.warning("Failed to load checkpoint for tenant %s, skipping", tenant_id, exc_info=True)
        return result

    def cleanup_stale_tmp(self) -> None:
        """Remove all .drain3.tmp files — they are always stale leftovers."""
        for tmp_path in self._dir.glob(f"*{_TMP_SUFFIX}"):
            tmp_path.unlink()
            logger.info("Removed stale tmp checkpoint: %s", tmp_path.name)

    def ensure_dir(self) -> None:
        """Create the checkpoint directory if it doesn't exist."""
        self._dir.mkdir(parents=True, exist_ok=True)
