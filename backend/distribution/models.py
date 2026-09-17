"""
Response DTO for backend/distribution/routes.py's
`PUT /distribution/{plant}/workcenters/{wc}` -- the first route in this
domain (aggregate_to_detail.md §4.3/§7). Mirrors backend/setup/models.py's
flat, fully-typed style: this shape has no branch-dependent key-set
variance (unlike that domain's `SetupEnvelope`), so no `extra="allow"`
escape hatch is needed here.
"""
from pydantic import BaseModel


class WorkCenterSaveResult(BaseModel):
    """backend/distribution/data.py's `save_workcenter()` return shape."""
    plant: str
    sap_workcenter: str
    description: str | None = None
    distribution_mode: str
    default_machine: str | None = None
    max_separation: str
    review_required: bool
    distribute_tooled: bool
    weights: dict[str, float | None] = {}
