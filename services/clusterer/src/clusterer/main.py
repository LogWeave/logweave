import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

import clickhouse_connect
from fastapi import FastAPI, HTTPException

from clusterer.checkpoint import CheckpointManager
from clusterer.config import get_settings
from clusterer.drain_service import DrainService
from clusterer.models import ClusterRequest, ClusterResponse
from clusterer.pipeline import ClusterPipeline
from clusterer.template_registry import TemplateRegistry

logger = logging.getLogger(__name__)


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
                logger.error("Failed to connect to ClickHouse after 5 attempts")
                raise
            logger.warning(
                "ClickHouse not ready (attempt %d/5), retrying in %ds",
                attempt + 1,
                2**attempt,
            )
            await asyncio.sleep(2**attempt)
    drain_service = DrainService(sim_th=settings.drain3_sim_th, depth=settings.drain3_depth)
    registry = TemplateRegistry(ch_client)
    checkpoint_mgr = CheckpointManager(settings.drain3_checkpoint_dir)

    pipeline = ClusterPipeline(
        drain_service=drain_service,
        registry=registry,
        checkpoint_manager=checkpoint_mgr,
    )
    app.state.pipeline = pipeline

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


app = FastAPI(title="LogWeave Clusterer", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/cluster", response_model=ClusterResponse)
async def cluster(request: ClusterRequest) -> ClusterResponse:
    pipeline: ClusterPipeline = app.state.pipeline
    try:
        results = await pipeline.cluster(request.tenant_id, request.messages)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except Exception:
        logger.exception("Internal error in /cluster")
        raise HTTPException(status_code=500, detail="Internal server error") from None
    return ClusterResponse(results=results)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
