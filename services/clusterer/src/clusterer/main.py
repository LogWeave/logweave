import asyncio
import contextlib
import logging
import re
import time
import uuid
from contextlib import asynccontextmanager

import clickhouse_connect
from fastapi import FastAPI, HTTPException, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from clusterer.checkpoint import CheckpointManager
from clusterer.config import get_settings
from clusterer.drain_service import DrainService, TenantLimitError
from clusterer.models import ClusterRequest, ClusterResponse
from clusterer.pipeline import ClusterPipeline
from clusterer.template_registry import TemplateRegistry

logger = logging.getLogger(__name__)

_REQUEST_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
_READY_CACHE_TTL = 5.0  # seconds


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.settings = settings

    # Connect to ClickHouse with retry (Docker Compose startup race)
    ch_client = None
    for attempt in range(5):
        try:
            ch_client = await asyncio.to_thread(
                clickhouse_connect.get_client,
                dsn=settings.clickhouse_url,
            )
            break
        except Exception:
            if attempt == 4:
                logger.exception("Failed to connect to ClickHouse after 5 attempts")
                raise
            logger.warning(
                "ClickHouse not ready (attempt %d/5), retrying in %ds",
                attempt + 1,
                2**attempt,
            )
            await asyncio.sleep(2**attempt)

    app.state.ch_client = ch_client

    drain_service = DrainService(
        sim_th=settings.drain3_sim_th,
        depth=settings.drain3_depth,
        max_clusters=settings.drain3_max_clusters,
        max_tenants=settings.max_tenants,
    )
    registry = TemplateRegistry(ch_client)
    checkpoint_mgr = CheckpointManager(
        settings.drain3_checkpoint_dir, hmac_key=settings.checkpoint_hmac_key
    )

    pipeline = ClusterPipeline(
        drain_service=drain_service,
        registry=registry,
        checkpoint_manager=checkpoint_mgr,
    )
    app.state.pipeline = pipeline

    # Ready check cache
    app.state.ready_cache = {"ok": False, "ts": 0.0}

    # Backpressure semaphore
    app.state.semaphore = asyncio.Semaphore(settings.max_concurrent_requests)

    # Initialize: schema, checkpoint dir, restore state
    await asyncio.to_thread(registry.ensure_schema)
    await asyncio.to_thread(checkpoint_mgr.ensure_dir)
    await asyncio.to_thread(checkpoint_mgr.cleanup_stale_tmp)
    await pipeline.restore_checkpoints()

    # Start background checkpoint loop
    checkpoint_task = asyncio.create_task(
        pipeline.checkpoint_loop(settings.drain3_checkpoint_interval)
    )

    logger.info("Clusterer started")
    yield

    # Shutdown: cancel loop, final flush
    checkpoint_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await checkpoint_task
    await pipeline.flush_checkpoints()
    logger.info("Clusterer stopped, checkpoints flushed")


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        # Extract or generate request ID
        request_id = request.headers.get("x-request-id", "")
        if not request_id or not _REQUEST_ID_PATTERN.match(request_id):
            request_id = str(uuid.uuid4())
        request.state.request_id = request_id

        start = time.monotonic()
        response = await call_next(request)
        elapsed_ms = (time.monotonic() - start) * 1000

        # Log request completion (skip health/ready to avoid noise)
        if request.url.path not in ("/health", "/ready"):
            logger.info(
                "request_id=%s method=%s path=%s status=%d elapsed_ms=%.1f",
                request_id,
                request.method,
                request.url.path,
                response.status_code,
                elapsed_ms,
            )

        response.headers["x-request-id"] = request_id
        return response


class ExceptionHandlerMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        try:
            return await call_next(request)
        except Exception:
            request_id = getattr(request.state, "request_id", "unknown")
            logger.exception(
                "Unhandled error: request_id=%s method=%s path=%s",
                request_id,
                request.method,
                request.url.path,
            )
            raise


app = FastAPI(title="LogWeave Clusterer", version="0.1.0", lifespan=lifespan)
app.add_middleware(ExceptionHandlerMiddleware)
app.add_middleware(RequestLoggingMiddleware)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/ready")
async def ready() -> Response:
    """Readiness probe: checks ClickHouse connectivity. Cached for 5s."""
    from fastapi.responses import JSONResponse

    cache = app.state.ready_cache
    now = time.monotonic()

    if cache["ok"] and (now - cache["ts"]) < _READY_CACHE_TTL:
        return JSONResponse({"status": "ready"})

    try:
        ch_client = app.state.ch_client
        result = await asyncio.wait_for(
            asyncio.to_thread(ch_client.query, "SELECT 1"),
            timeout=2.0,
        )
        if result.result_rows:
            cache["ok"] = True
            cache["ts"] = now
            return JSONResponse({"status": "ready"})
    except Exception:
        logger.warning("Readiness check failed", exc_info=True)

    cache["ok"] = False
    return JSONResponse({"status": "not_ready"}, status_code=503)


@app.post("/cluster", response_model=ClusterResponse)
async def cluster(request: ClusterRequest) -> ClusterResponse:
    pipeline: ClusterPipeline = app.state.pipeline
    settings = app.state.settings
    semaphore: asyncio.Semaphore = app.state.semaphore

    # Backpressure: reject if too many concurrent requests
    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=0.1)
    except TimeoutError:
        raise HTTPException(
            status_code=503,
            detail="Server busy",
            headers={"Retry-After": "1"},
        ) from None

    try:
        results = await asyncio.wait_for(
            pipeline.cluster(request.tenant_id, request.messages),
            timeout=settings.request_timeout_seconds,
        )
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Request timeout") from None
    except TenantLimitError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception:
        logger.exception("Internal error in /cluster")
        raise HTTPException(status_code=500, detail="Internal server error") from None
    finally:
        semaphore.release()

    return ClusterResponse(results=results)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)  # noqa: S104
