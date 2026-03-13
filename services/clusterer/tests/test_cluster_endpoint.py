"""HTTP-level tests for POST /cluster endpoint.

Uses a mocked ClusterPipeline to test request validation,
response shape, and error handling without real Drain3/ClickHouse.
"""

import asyncio
from unittest.mock import AsyncMock, PropertyMock

import pytest
from httpx import ASGITransport, AsyncClient

from clusterer.config import Settings
from clusterer.drain_service import TenantLimitExceeded
from clusterer.models import ClusterResultItem


@pytest.fixture
def mock_pipeline():
    pipeline = AsyncMock()
    pipeline.cluster.return_value = [
        ClusterResultItem(
            template_id="019abc12-3456-7890-abcd-ef1234567890",
            template_text="Connection timeout to <*>",
            is_new=False,
        )
    ]
    return pipeline


@pytest.fixture
async def client(mock_pipeline):
    """Create test client with mocked pipeline injected into app.state."""
    from clusterer.main import app

    app.state.pipeline = mock_pipeline
    app.state.settings = Settings()
    app.state.semaphore = asyncio.Semaphore(4)
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestValidRequest:
    @pytest.mark.asyncio
    async def test_valid_request_returns_200(self, client, mock_pipeline) -> None:
        response = await client.post(
            "/cluster",
            json={"tenant_id": "customer_abc", "messages": ["Connection timeout to host1"]},
        )
        assert response.status_code == 200
        body = response.json()
        assert "results" in body
        assert len(body["results"]) == 1
        result = body["results"][0]
        assert "template_id" in result
        assert "template_text" in result
        assert "is_new" in result

    @pytest.mark.asyncio
    async def test_batch_100_messages(self, client, mock_pipeline) -> None:
        mock_pipeline.cluster.return_value = [
            ClusterResultItem(template_id=f"id-{i}", template_text=f"tmpl-{i}", is_new=False)
            for i in range(100)
        ]
        response = await client.post(
            "/cluster",
            json={"tenant_id": "t1", "messages": [f"msg {i}" for i in range(100)]},
        )
        assert response.status_code == 200
        assert len(response.json()["results"]) == 100

    @pytest.mark.asyncio
    async def test_same_messages_same_ids(self, client, mock_pipeline) -> None:
        fixed_result = [
            ClusterResultItem(template_id="stable-id", template_text="tmpl", is_new=False)
        ]
        mock_pipeline.cluster.return_value = fixed_result

        r1 = await client.post("/cluster", json={"tenant_id": "t1", "messages": ["msg"]})
        r2 = await client.post("/cluster", json={"tenant_id": "t1", "messages": ["msg"]})

        assert r1.json()["results"][0]["template_id"] == r2.json()["results"][0]["template_id"]


class TestValidation:
    @pytest.mark.asyncio
    async def test_missing_tenant_id(self, client) -> None:
        response = await client.post("/cluster", json={"messages": ["msg"]})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_empty_tenant_id(self, client) -> None:
        response = await client.post("/cluster", json={"tenant_id": "", "messages": ["msg"]})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_invalid_tenant_id_chars(self, client) -> None:
        response = await client.post(
            "/cluster", json={"tenant_id": "../../evil", "messages": ["msg"]}
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_empty_messages_list(self, client) -> None:
        response = await client.post("/cluster", json={"tenant_id": "t1", "messages": []})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_missing_messages(self, client) -> None:
        response = await client.post("/cluster", json={"tenant_id": "t1"})
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_empty_string_in_messages(self, client) -> None:
        response = await client.post(
            "/cluster", json={"tenant_id": "t1", "messages": ["valid", ""]}
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_too_many_messages(self, client) -> None:
        response = await client.post(
            "/cluster",
            json={"tenant_id": "t1", "messages": ["m"] * 1_001},
        )
        assert response.status_code == 422


class TestErrorHandling:
    @pytest.mark.asyncio
    async def test_value_error_returns_422(self, client, mock_pipeline) -> None:
        mock_pipeline.cluster.side_effect = ValueError("Invalid tenant_id")
        response = await client.post(
            "/cluster", json={"tenant_id": "valid_id", "messages": ["msg"]}
        )
        assert response.status_code == 422

    @pytest.mark.asyncio
    async def test_internal_error_returns_500(self, client, mock_pipeline) -> None:
        mock_pipeline.cluster.side_effect = RuntimeError("ClickHouse down")
        response = await client.post(
            "/cluster", json={"tenant_id": "valid_id", "messages": ["msg"]}
        )
        assert response.status_code == 500

    @pytest.mark.asyncio
    async def test_tenant_limit_exceeded_returns_503(self, client, mock_pipeline) -> None:
        mock_pipeline.cluster.side_effect = TenantLimitExceeded("Max tenants reached")
        response = await client.post(
            "/cluster", json={"tenant_id": "valid_id", "messages": ["msg"]}
        )
        assert response.status_code == 503
