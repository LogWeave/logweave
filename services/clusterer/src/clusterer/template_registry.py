"""Template registry: stable UUIDv7 template IDs via ClickHouse.

Assigns globally unique, timestamp-sortable template IDs to Drain3 template
patterns. Uses an LRU in-memory cache so known templates (99%+ of lookups)
skip ClickHouse entirely. Only new template discoveries hit the network.

cityHash64 is computed server-side in ClickHouse to avoid a Python dependency.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

import clickhouse_connect.driver
from cachetools import LRUCache
from uuid_utils import uuid7

from clusterer.internal_events import emit_clickhouse_failure

if TYPE_CHECKING:
    from clusterer.embedding import EmbeddingService

logger = logging.getLogger(__name__)

_CACHE_MAX_SIZE = 100_000

_CREATE_TABLE_SQL = """\
CREATE TABLE IF NOT EXISTS template_registry (
    tenant_id           LowCardinality(String),
    template_text_hash  UInt64 DEFAULT cityHash64(template_text),
    template_text       String,
    template_id         String,
    first_seen          DateTime64(3) DEFAULT now64(3),
    embedding           Array(Float32) DEFAULT [],
    embedding_model     LowCardinality(String) DEFAULT ''
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

_BATCH_SELECT_SQL = """\
SELECT template_text, template_id
FROM template_registry FINAL
WHERE tenant_id = {tid:String}
  AND template_text IN {texts:Array(String)}
"""

_INSERT_SQL = """\
INSERT INTO template_registry
    (tenant_id, template_text_hash, template_text, template_id, first_seen, embedding, embedding_model)
VALUES
    ({tid:String}, cityHash64({text:String}), {text:String}, {template_id:String}, now64(3),
     {embedding:Array(Float32)}, {embedding_model:String})
"""


class TemplateRegistry:
    def __init__(
        self,
        client: clickhouse_connect.driver.Client,
        embedding_service: EmbeddingService | None = None,
    ) -> None:
        self._client = client
        self._embedding = embedding_service
        self._cache: LRUCache = LRUCache(maxsize=_CACHE_MAX_SIZE)
        self._tenant_locks: dict[str, asyncio.Lock] = {}
        self._global_lock = asyncio.Lock()
        self._cache_hits: int = 0
        self._cache_misses: int = 0

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
            self._cache_hits += 1
            return cached, False

        # Slow path: acquire per-tenant lock
        lock = await self._get_tenant_lock(tenant_id)
        async with lock:
            # Double-check cache (another coroutine may have populated it)
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache_hits += 1
                return cached, False

            self._cache_misses += 1

            # Query ClickHouse
            existing_id = await asyncio.to_thread(self._query_registry, tenant_id, template_text)
            if existing_id is not None:
                self._cache[cache_key] = existing_id
                return existing_id, False

            # Not found — assign new UUIDv7 (cache after INSERT to prevent ghost entries)
            new_id = str(uuid7())
            await asyncio.to_thread(self._insert_template, tenant_id, template_text, new_id)
            self._cache[cache_key] = new_id
            logger.debug(
                "New template for tenant %s: %s -> %s",
                tenant_id,
                template_text[:40],
                new_id,
            )
            return new_id, True

    async def batch_get_or_create(
        self, tenant_id: str, template_texts: list[str]
    ) -> dict[str, tuple[str, bool]]:
        """Batch lookup/create. Returns {template_text: (template_id, is_new)}.

        1. Check cache for all texts, collect misses
        2. Single batch SELECT for cache misses
        3. Batch INSERT for genuinely new templates
        4. Holds per-tenant lock for the entire batch
        """
        result: dict[str, tuple[str, bool]] = {}
        cache_misses: list[str] = []

        # Fast path: check cache for all texts
        for text in template_texts:
            cache_key = (tenant_id, text)
            cached = self._cache.get(cache_key)
            if cached is not None:
                self._cache_hits += 1
                result[text] = (cached, False)
            else:
                cache_misses.append(text)

        if not cache_misses:
            return result

        # Slow path: acquire per-tenant lock for all misses
        lock = await self._get_tenant_lock(tenant_id)
        async with lock:
            # Double-check cache under lock
            still_missing: list[str] = []
            for text in cache_misses:
                cache_key = (tenant_id, text)
                cached = self._cache.get(cache_key)
                if cached is not None:
                    self._cache_hits += 1
                    result[text] = (cached, False)
                else:
                    still_missing.append(text)

            if not still_missing:
                return result

            self._cache_misses += len(still_missing)

            # Batch SELECT from ClickHouse
            found = await asyncio.to_thread(self._batch_query_registry, tenant_id, still_missing)

            new_texts: list[str] = []
            for text in still_missing:
                if text in found:
                    self._cache[(tenant_id, text)] = found[text]
                    result[text] = (found[text], False)
                else:
                    new_texts.append(text)

            # Batch INSERT for genuinely new templates
            if new_texts:
                new_entries: list[tuple[str, str]] = []
                for text in new_texts:
                    new_id = str(uuid7())
                    new_entries.append((text, new_id))

                await asyncio.to_thread(self._batch_insert_templates, tenant_id, new_entries)

                # Cache only after INSERT succeeds — prevents ghost entries on failure
                for text, new_id in new_entries:
                    self._cache[(tenant_id, text)] = new_id
                    result[text] = (new_id, True)
                    logger.debug(
                        "New template for tenant %s: %s -> %s",
                        tenant_id,
                        text[:40],
                        new_id,
                    )

        return result

    def _query_registry(self, tenant_id: str, template_text: str) -> str | None:
        """Sync ClickHouse query. Returns template_id or None."""
        try:
            result = self._client.query(
                _SELECT_SQL,
                parameters={"tid": tenant_id, "text": template_text},
            )
        except Exception as exc:
            emit_clickhouse_failure("query", exc)
            raise
        if result.result_rows:
            return result.result_rows[0][0]
        return None

    def _batch_query_registry(self, tenant_id: str, template_texts: list[str]) -> dict[str, str]:
        """Sync batch ClickHouse query. Returns {template_text: template_id}."""
        try:
            result = self._client.query(
                _BATCH_SELECT_SQL,
                parameters={"tid": tenant_id, "texts": template_texts},
            )
        except Exception as exc:
            emit_clickhouse_failure("query", exc)
            raise
        return {row[0]: row[1] for row in result.result_rows}

    def _embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Best-effort embedding. Returns empty vectors on failure."""
        if self._embedding is None:
            return [[] for _ in texts]
        try:
            return self._embedding.embed(texts)
        except Exception:
            logger.warning("Embedding failed, inserting without vectors", exc_info=True)
            return [[] for _ in texts]

    def _get_model_name(self) -> str:
        if self._embedding is None:
            return ""
        return self._embedding.MODEL_NAME

    def _insert_template(self, tenant_id: str, template_text: str, template_id: str) -> None:
        """Sync ClickHouse insert."""
        embeddings = self._embed_texts([template_text])
        try:
            self._client.command(
                _INSERT_SQL,
                parameters={
                    "tid": tenant_id,
                    "text": template_text,
                    "template_id": template_id,
                    "embedding": embeddings[0],
                    "embedding_model": self._get_model_name(),
                },
            )
        except Exception as exc:
            emit_clickhouse_failure("command", exc)
            raise

    def _batch_insert_templates(self, tenant_id: str, entries: list[tuple[str, str]]) -> None:
        """Batch INSERT via client.insert(). cityHash64 and first_seen computed by DEFAULT."""
        texts = [text for text, _ in entries]
        embeddings = self._embed_texts(texts)
        model_name = self._get_model_name()
        rows = [
            [tenant_id, text, template_id, emb, model_name]
            for (text, template_id), emb in zip(entries, embeddings)
        ]
        try:
            self._client.insert(
                "template_registry",
                rows,
                column_names=["tenant_id", "template_text", "template_id", "embedding", "embedding_model"],
            )
        except Exception as exc:
            emit_clickhouse_failure("insert", exc)
            raise

    def ensure_schema(self) -> None:
        """Create template_registry table if not exists. Idempotent."""
        try:
            self._client.command(_CREATE_TABLE_SQL)
        except Exception as exc:
            emit_clickhouse_failure("command", exc)
            raise
