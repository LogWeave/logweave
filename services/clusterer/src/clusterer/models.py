from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class DrainResult:
    """Result from Drain3 clustering — internal representation.

    This is the raw Drain3 output. The production template_id (UUIDv7) is
    assigned separately by the TemplateRegistry. The endpoint response model
    (issue #9) will map DrainResult + registry lookup into the API contract.
    """

    drain_cluster_id: int
    template_text: str
    is_new: bool
