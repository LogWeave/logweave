from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LOGWEAVE_")

    drain3_checkpoint_dir: str = Field(default="/data/drain3", min_length=1)
    drain3_checkpoint_interval: int = Field(default=60, ge=1)
    drain3_sim_th: float = Field(default=0.4, gt=0.0, le=1.0)
    drain3_depth: int = Field(default=4, ge=2)
    clickhouse_url: str = Field(default="clickhouse://localhost:9000/logweave", min_length=1)
    drain3_max_clusters: int = Field(default=10_000, ge=1)
    max_concurrent_requests: int = Field(default=4, ge=1)
    request_timeout_seconds: float = Field(default=0.45, gt=0.0)
    max_tenants: int = Field(default=200, ge=1)
    checkpoint_hmac_key: SecretStr = SecretStr("")


@lru_cache
def get_settings() -> Settings:
    return Settings()
