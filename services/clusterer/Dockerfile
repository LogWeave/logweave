FROM python:3.11-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:0.6 /uv /uvx /bin/

# Copy project metadata first for layer caching
COPY pyproject.toml uv.lock ./

# Install dependencies only (cached unless pyproject.toml/uv.lock change)
RUN uv sync --frozen --no-install-project --no-dev

# Copy source code
COPY src/ src/

# Install the project itself (no deps, just the package)
RUN uv sync --frozen --no-dev

RUN addgroup --system app && adduser --system --ingroup app app

# The checkpoint dir (LOGWEAVE_DRAIN3_CHECKPOINT_DIR, default /data/drain3) must be
# writable by the non-root user. Create + own it so the clusterer can start with
# no volume mounted (default compose) and so a named volume mounted here (prod
# compose) inherits writable ownership on first init.
RUN mkdir -p /data/drain3 && chown -R app:app /data

USER app

EXPOSE 8000

# Run uvicorn straight from the venv uv built at install time. Using `uv run`
# here re-resolves the environment and needs a writable uv cache under $HOME,
# which the non-root `app` user does not have (/nonexistent) — so the container
# exited on start. The project is already installed, so invoke uvicorn directly.
CMD [".venv/bin/uvicorn", "clusterer.main:app", "--host", "0.0.0.0", "--port", "8000"]
