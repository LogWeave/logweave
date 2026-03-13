import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

import clickhouse_connect
from fastapi import FastAPI
from fastapi.responses import JSONResponse

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

    # Create components
    ch_client = await asyncio.to_thread(
        clickhouse_connect.get_client,
        dsn=settings.logweave_clickhouse_url,
    )
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
        return JSONResponse(status_code=422, content={"detail": str(e)})
    except Exception:
        logger.exception("Internal error in /cluster")
        return JSONResponse(status_code=500, content={"detail": "Internal server error"})
    return ClusterResponse(results=results)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
