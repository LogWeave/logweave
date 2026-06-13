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
from clusterer.config import Settings, get_settings
from clusterer.drain_service import DrainService, TenantLimitError
from clusterer.embedding import EmbeddingService
from clusterer.internal_events import (
    _safe_url_host,
    emit_clickhouse_failure,
    emit_config_loaded,
    get_internal_events,
    init_internal_events,
)
from clusterer.models import (
    ClusterRequest,
    ClusterResponse,
    EmbedRequest,
    EmbedResponse,
    PreviewRequest,
    PreviewResponse,
    ResetRequest,
    ResetResponse,
)
from clusterer.pipeline import ClusterPipeline
from clusterer.template_registry import TemplateRegistry

logger = logging.getLogger(__name__)

_REQUEST_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,128}$")
_READY_CACHE_TTL = 5.0  # seconds


def build_clickhouse_client_kwargs(settings: Settings) -> dict[str, object]:
    """Assemble clickhouse_connect.get_client kwargs from settings.

    Credentials are passed explicitly so they take precedence over anything in
    the DSN. An empty user means anonymous (dev compose, no users.xml); prod
    compose mounts a users.xml that requires authentication.
    """
    kwargs: dict[str, object] = {"dsn": settings.clickhouse_url}
    if settings.clickhouse_user:
        kwargs["username"] = settings.clickhouse_user
        kwargs["password"] = settings.clickhouse_password.get_secret_value()
    return kwargs


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    app.state.settings = settings

    # Initialize the internal-events emitter without a CH client first so we can
    # emit clickhouse.unreachable from the connection-failure path itself.
    init_internal_events(None)

    # Connect to ClickHouse with retry (Docker Compose startup race).
    client_kwargs = build_clickhouse_client_kwargs(settings)
    if not settings.clickhouse_user:
        logger.warning(
            "LOGWEAVE_CLICKHOUSE_USER is not set — connecting to ClickHouse "
            "anonymously. This fails against a users.xml that requires auth "
            "(the production compose). Set it in production."
        )

    ch_client = None
    for attempt in range(5):
        try:
            ch_client = await asyncio.to_thread(
                clickhouse_connect.get_client,
                **client_kwargs,
            )
            break
        except Exception:
            if attempt == 4:
                logger.exception("Failed to connect to ClickHouse after 5 attempts")
                get_internal_events().emit(
                    event="clickhouse.unreachable",
                    severity="error",
                    code="CH_UNREACHABLE",
                    summary="clickhouse unreachable after 5 attempts",
                    fields={"host": _safe_url_host(settings.clickhouse_url)},
                )
                raise
            logger.warning(
                "ClickHouse not ready (attempt %d/5), retrying in %ds",
                attempt + 1,
                2**attempt,
            )
            await asyncio.sleep(2**attempt)

    app.state.ch_client = ch_client

    # Re-init the emitter now that we have a CH client for the dual sink.
    init_internal_events(ch_client)
    emit_config_loaded(settings.model_dump())

    drain_service = DrainService(
        sim_th=settings.drain3_sim_th,
        depth=settings.drain3_depth,
        max_clusters=settings.drain3_max_clusters,
        max_tenants=settings.max_tenants,
    )
    embedding_service = EmbeddingService()
    app.state.embedding_service = embedding_service
    app.state.backfill_running = False
    registry = TemplateRegistry(ch_client)
    hmac_key = settings.checkpoint_hmac_key.get_secret_value()
    checkpoint_mgr = CheckpointManager(settings.drain3_checkpoint_dir, hmac_key=hmac_key)
    if not hmac_key:
        logger.warning(
            "LOGWEAVE_CHECKPOINT_HMAC_KEY is not set — checkpoint integrity "
            "verification is disabled. Set this in production."
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
    get_internal_events().emit(
        event="service.started",
        severity="info",
        code="SERVICE_STARTED",
        summary="clusterer started",
        fields={"service_version": app.version},
    )
    yield

    # Shutdown: cancel loop, final flush
    get_internal_events().emit(
        event="service.stopping",
        severity="info",
        code="SERVICE_STOPPING",
        summary="clusterer stopping",
    )
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
    except Exception as exc:
        logger.warning("Readiness check failed", exc_info=True)
        emit_clickhouse_failure("query", exc)

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
            pipeline.cluster(request.tenant_id, request.messages, sim_th=request.sim_th),
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


@app.post("/cluster/preview", response_model=PreviewResponse)
async def cluster_preview(request: PreviewRequest) -> PreviewResponse:
    pipeline: ClusterPipeline = app.state.pipeline
    settings = app.state.settings
    semaphore: asyncio.Semaphore = app.state.semaphore

    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=0.1)
    except TimeoutError:
        raise HTTPException(
            status_code=503, detail="Server busy", headers={"Retry-After": "1"}
        ) from None

    try:
        pattern_count, compression_ratio, sample_templates = await asyncio.wait_for(
            pipeline.preview(request.messages, sim_th=request.sim_th),
            timeout=settings.request_timeout_seconds * 4,
        )
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Preview timeout") from None
    except Exception:
        logger.exception("Internal error in /cluster/preview")
        raise HTTPException(status_code=500, detail="Internal server error") from None
    finally:
        semaphore.release()

    return PreviewResponse(
        pattern_count=pattern_count,
        compression_ratio=round(compression_ratio, 1),
        sample_templates=sample_templates,
    )


@app.post("/cluster/reset", response_model=ResetResponse)
async def cluster_reset(request: ResetRequest) -> ResetResponse:
    pipeline: ClusterPipeline = app.state.pipeline
    semaphore: asyncio.Semaphore = app.state.semaphore

    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=0.1)
    except TimeoutError:
        raise HTTPException(
            status_code=503, detail="Server busy", headers={"Retry-After": "1"}
        ) from None

    try:
        cleared = await pipeline.reset_tenant(request.tenant_id)
    except Exception:
        logger.exception("Internal error in /cluster/reset")
        raise HTTPException(status_code=500, detail="Internal server error") from None
    finally:
        semaphore.release()

    return ResetResponse(cleared=cleared)


@app.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest) -> EmbedResponse:
    embedding_service: EmbeddingService = app.state.embedding_service
    semaphore: asyncio.Semaphore = app.state.semaphore

    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=0.1)
    except TimeoutError:
        raise HTTPException(
            status_code=503,
            detail="Server busy",
            headers={"Retry-After": "1"},
        ) from None

    try:
        embeddings = await asyncio.wait_for(
            asyncio.to_thread(embedding_service.embed, request.texts),
            timeout=app.state.settings.request_timeout_seconds,
        )
    except TimeoutError:
        raise HTTPException(status_code=504, detail="Embedding timeout") from None
    except Exception:
        logger.exception("Internal error in /embed")
        raise HTTPException(status_code=500, detail="Embedding failed") from None
    finally:
        semaphore.release()

    return EmbedResponse(
        embeddings=embeddings,
        model=EmbeddingService.MODEL_NAME,
        dimensions=EmbeddingService.DIMENSIONS,
    )


@app.post("/embed/backfill")
async def embed_backfill(request: Request) -> dict[str, str]:
    """Backfill embeddings for templates with empty vectors. Non-blocking.

    Internal endpoint — only accessible from within the Docker network.
    """
    if app.state.backfill_running:
        return {"status": "already_running"}

    asyncio.create_task(_run_backfill())
    return {"status": "started"}


_BACKFILL_SELECT = """\
SELECT tenant_id, template_text, template_id, first_seen
FROM template_registry FINAL
WHERE length(embedding) = 0
LIMIT {batch_size:UInt32}
"""


async def _run_backfill() -> None:
    app.state.backfill_running = True
    try:
        ch_client = app.state.ch_client
        embedding_service: EmbeddingService = app.state.embedding_service
        batch_size = 100
        total = 0

        while True:
            try:
                rows = await asyncio.to_thread(
                    ch_client.query,
                    _BACKFILL_SELECT,
                    parameters={"batch_size": batch_size},
                )
            except Exception as exc:
                emit_clickhouse_failure("query", exc)
                raise
            if not rows.result_rows:
                break

            texts = [row[1] for row in rows.result_rows]
            embeddings = await asyncio.to_thread(embedding_service.embed, texts)
            model_name = EmbeddingService.MODEL_NAME

            # Preserve first_seen to avoid ReplacingMergeTree overwrite
            insert_rows = [
                [row[0], row[1], row[2], row[3], emb, model_name]
                for row, emb in zip(rows.result_rows, embeddings)
            ]
            try:
                await asyncio.to_thread(
                    ch_client.insert,
                    "template_registry",
                    insert_rows,
                    column_names=[
                        "tenant_id",
                        "template_text",
                        "template_id",
                        "first_seen",
                        "embedding",
                        "embedding_model",
                    ],
                )
            except Exception as exc:
                emit_clickhouse_failure("insert", exc)
                raise
            total += len(insert_rows)
            logger.info("Backfilled %d template embeddings (%d total)", len(insert_rows), total)

        logger.info("Embedding backfill complete — %d templates processed", total)
    except Exception:
        logger.exception("Embedding backfill failed")
    finally:
        app.state.backfill_running = False


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)  # noqa: S104
