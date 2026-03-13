"""Template registry: stable UUIDv7 template IDs via ClickHouse.

Assigns globally unique, timestamp-sortable template IDs to Drain3 template
patterns. Uses an LRU in-memory cache so known templates (99%+ of lookups)
skip ClickHouse entirely. Only new template discoveries hit the network.

cityHash64 is computed server-side in ClickHouse to avoid a Python dependency.
"""

import asyncio
import logging

import clickhouse_connect.driver
from cachetools import LRUCache
from uuid_utils import uuid7

logger = logging.getLogger(__name__)

_CACHE_MAX_SIZE = 100_000

_CREATE_TABLE_SQL = """\
CREATE TABLE IF NOT EXISTS template_registry (
    tenant_id           LowCardinality(String),
    template_text_hash  UInt64,
    template_text       String,
    template_id         String,
    first_seen          DateTime64(3)
) ENGINE = ReplacingMergeTree()
ORDER BY (tenant_id, template_text_hash)
"""

_SELECT_SQL = """\
SELECT template_id
FROM template_registry FINAL
WHERE tenant_id = {tid:String}
  AND template_text_hash = cityHash64({text:String})
  AND template_text = {text:String}
LIMIT 1
"""

_INSERT_SQL = """\
INSERT INTO template_registry
    (tenant_id, template_text_hash, template_text, template_id, first_seen)
VALUES
    ({tid:String}, cityHash64({text:String}), {text:String}, {template_id:String}, now64(3))
"""


class TemplateRegistry:
    def __init__(self, client: clickhouse_connect.driver.Client) -> None:
        self._client = client
        self._cache: LRUCache = LRUCache(maxsize=_CACHE_MAX_SIZE)
        self._tenant_locks: dict[str, asyncio.Lock] = {}
        self._global_lock = asyncio.Lock()

    async def _get_tenant_lock(self, tenant_id: str) -> asyncio.Lock:
        async with self._global_lock:
            if tenant_id not in self._tenant_locks:
                self._tenant_locks[tenant_id] = asyncio.Lock()
            return self._tenant_locks[tenant_id]

    async def get_or_create(self, tenant_id: str, template_text: str) -> tuple[str, bool]:
        """Return (template_id, is_new). Cache-first, then ClickHouse, then insert."""
        cache_key = (tenant_id, template_text)

        # Fast path: cache hit
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached, False

        # Slow path: acquire per-tenant lock
        lock = await self._get_tenant_lock(tenant_id)
        async with lock:
            # Double-check cache (another coroutine may have populated it)
            cached = self._cache.get(cache_key)
            if cached is not None:
                return cached, False

            # Query ClickHouse
            existing_id = await asyncio.to_thread(self._query_registry, tenant_id, template_text)
            if existing_id is not None:
                self._cache[cache_key] = existing_id
                return existing_id, False

            # Not found — assign new UUIDv7
            new_id = str(uuid7())
            await asyncio.to_thread(self._insert_template, tenant_id, template_text, new_id)
            self._cache[cache_key] = new_id
            logger.info(
                "New template for tenant %s: %s -> %s",
                tenant_id,
                template_text[:80],
                new_id,
            )
            return new_id, True

    def _query_registry(self, tenant_id: str, template_text: str) -> str | None:
        """Sync ClickHouse query. Returns template_id or None."""
        result = self._client.query(
            _SELECT_SQL,
            parameters={"tid": tenant_id, "text": template_text},
        )
        if result.result_rows:
            return result.result_rows[0][0]
        return None

    def _insert_template(self, tenant_id: str, template_text: str, template_id: str) -> None:
        """Sync ClickHouse insert."""
        self._client.command(
            _INSERT_SQL,
            parameters={"tid": tenant_id, "text": template_text, "template_id": template_id},
        )

    def ensure_schema(self) -> None:
        """Create template_registry table if not exists. Idempotent.

        TODO: Replace with versioned migration runner in Week 1b.
        """
        self._client.command(_CREATE_TABLE_SQL)
