import asyncio
from unittest.mock import MagicMock, patch

import pytest

from clusterer.template_registry import TemplateRegistry


@pytest.fixture
def mock_client() -> MagicMock:
    return MagicMock()


@pytest.fixture
def registry(mock_client: MagicMock) -> TemplateRegistry:
    return TemplateRegistry(mock_client)


class TestCacheHit:
    async def test_returns_cached_id_without_db_call(
        self, registry: TemplateRegistry, mock_client: MagicMock
    ) -> None:
        # Pre-populate cache
        registry._cache[("t1", "Connection timeout to <*>")] = "uuid-123"

        template_id, is_new = await registry.get_or_create("t1", "Connection timeout to <*>")

        assert template_id == "uuid-123"
        assert is_new is False
        mock_client.query.assert_not_called()


class TestCacheMissFoundInDb:
    async def test_queries_db_and_caches(
        self, registry: TemplateRegistry, mock_client: MagicMock
    ) -> None:
        # Mock _query_registry to return an existing ID
        with patch.object(registry, "_query_registry", return_value="uuid-existing"):
            template_id, is_new = await registry.get_or_create("t1", "Connection timeout")

        assert template_id == "uuid-existing"
        assert is_new is False
        # Should be cached now
        assert registry._cache[("t1", "Connection timeout")] == "uuid-existing"


class TestNewTemplateInsert:
    async def test_inserts_and_caches(
        self, registry: TemplateRegistry, mock_client: MagicMock
    ) -> None:
        with (
            patch.object(registry, "_query_registry", return_value=None),
            patch.object(registry, "_insert_template") as mock_insert,
        ):
            template_id, is_new = await registry.get_or_create("t1", "New error pattern")

        assert is_new is True
        assert len(template_id) > 0  # UUIDv7 string
        mock_insert.assert_called_once()
        # Cached
        assert ("t1", "New error pattern") in registry._cache

    async def test_uuid7_format(
        self, registry: TemplateRegistry, mock_client: MagicMock
    ) -> None:
        with (
            patch.object(registry, "_query_registry", return_value=None),
            patch.object(registry, "_insert_template"),
        ):
            template_id, _ = await registry.get_or_create("t1", "test")

        # UUIDv7 is 36 chars: 8-4-4-4-12
        assert len(template_id) == 36
        assert template_id.count("-") == 4


class TestIsNewFlag:
    async def test_new_then_cached(
        self, registry: TemplateRegistry, mock_client: MagicMock
    ) -> None:
        with (
            patch.object(registry, "_query_registry", return_value=None),
            patch.object(registry, "_insert_template"),
        ):
            _, is_new1 = await registry.get_or_create("t1", "pattern A")

        # Second call hits cache
        _, is_new2 = await registry.get_or_create("t1", "pattern A")

        assert is_new1 is True
        assert is_new2 is False


class TestSelectUsesFinal:
    def test_query_contains_final(
        self, registry: TemplateRegistry, mock_client: MagicMock
    ) -> None:
        mock_client.query.return_value = MagicMock(result_rows=[])
        registry._query_registry("t1", "test template")
        call_args = mock_client.query.call_args
        query_str = call_args[0][0]
        assert "FINAL" in query_str


class TestConcurrentCreates:
    async def test_single_insert_for_concurrent_requests(
        self, registry: TemplateRegistry, mock_client: MagicMock
    ) -> None:
        insert_count = 0

        def mock_query(tid: str, text: str) -> str | None:
            # First call: not found. Subsequent calls: still not found
            # (simulates no prior entry in DB)
            return None

        def mock_insert(tid: str, text: str, template_id: str) -> None:
            nonlocal insert_count
            insert_count += 1

        with (
            patch.object(registry, "_query_registry", side_effect=mock_query),
            patch.object(registry, "_insert_template", side_effect=mock_insert),
        ):
            # Fire 10 concurrent requests for the same template
            tasks = [
                registry.get_or_create("t1", "same template text") for _ in range(10)
            ]
            results = await asyncio.gather(*tasks)

        # All should return the same template_id
        ids = {r[0] for r in results}
        assert len(ids) == 1
        # Only one INSERT should have happened (others hit the cache after the first)
        assert insert_count == 1


class TestEnsureSchema:
    def test_creates_table(
        self, registry: TemplateRegistry, mock_client: MagicMock
    ) -> None:
        registry.ensure_schema()
        mock_client.command.assert_called_once()
        sql = mock_client.command.call_args[0][0]
        assert "CREATE TABLE IF NOT EXISTS" in sql
        assert "template_registry" in sql
        assert "ReplacingMergeTree" in sql

    def test_idempotent(
        self, registry: TemplateRegistry, mock_client: MagicMock
    ) -> None:
        registry.ensure_schema()
        registry.ensure_schema()
        assert mock_client.command.call_count == 2  # called twice, no error
