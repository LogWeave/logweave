from dataclasses import dataclass
from typing import Annotated

from pydantic import BaseModel, Field


@dataclass(frozen=True, slots=True)
class DrainResult:
    """Result from Drain3 clustering — internal representation.

    This is the raw Drain3 output. The production template_id (UUIDv7) is
    assigned separately by the TemplateRegistry. The endpoint response model
    maps DrainResult + registry lookup into the API contract.
    """

    drain_cluster_id: int
    template_text: str
    is_new: bool


class ClusterRequest(BaseModel):
    tenant_id: Annotated[
        str,
        Field(min_length=1, max_length=128, pattern=r"^[a-zA-Z0-9_-]+$"),
    ]
    messages: Annotated[
        list[Annotated[str, Field(min_length=1)]],
        Field(min_length=1, max_length=10_000),
    ]


class ClusterResultItem(BaseModel):
    template_id: str
    template_text: str
    is_new: bool


class ClusterResponse(BaseModel):
    results: list[ClusterResultItem]
