from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    drain3_checkpoint_dir: str = "/data/drain3"
    drain3_checkpoint_interval: int = 60
    logweave_clickhouse_url: str = "clickhouse://localhost:9000/logweave"


@lru_cache
def get_settings() -> Settings:
    return Settings()
