import pytest
from httpx import ASGITransport, AsyncClient

from clusterer.main import app


@pytest.mark.asyncio
async def test_health_returns_ok():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_ready_returns_503_without_lifespan():
    """Without lifespan (no ch_client on app.state), /ready should return 503."""
    # Set up minimal state for middleware
    app.state.ready_cache = {"ok": False, "ts": 0.0}
    app.state.ch_client = None

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/ready")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
