# LogWeave Clusterer

Python/FastAPI service powered by [Drain3](https://github.com/logpai/Drain3). Clusters log messages into template patterns and assigns stable UUIDv7 template IDs.

## Quick Start

```bash
uv sync --dev
uv run poe serve    # dev server with hot reload
uv run poe test     # run tests
uv run poe check    # lint + format check
```

## Configuration

All settings use the `LOGWEAVE_` env prefix. See `.env.example` for the full list.
