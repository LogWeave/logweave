from contextlib import asynccontextmanager

from fastapi import FastAPI

from clusterer.config import get_settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Validate settings load on startup
    settings = get_settings()
    app.state.settings = settings
    yield


app = FastAPI(title="LogWeave Clusterer", version="0.1.0", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
