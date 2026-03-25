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
USER app

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "clusterer.main:app", "--host", "0.0.0.0", "--port", "8000"]
