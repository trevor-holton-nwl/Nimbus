"""
Response DTOs for backend/routing/routes.py -- P1 (data foundation) slice of
ROUTING_RUNTIME_DESIGN.md. Deliberately minimal: this phase only ships the
two Excel-upload routes, so `RoutingUploadResult` is the one shape that
matters right now. `resolver.py`'s real detail models (the per-order
resolution outcome, the recompute report, the rate-map payload) are P2/P3
work and land with that later task -- don't pre-build them here.
"""
from pydantic import BaseModel


class UploadWarning(BaseModel):
    """One informational-or-rejection finding from an ingest parse
    (backend/routing/ingest.py) -- e.g. an unknown/ignored header, or a
    per-row rejection reason. `row` is the 1-based source row number when
    the finding is row-scoped; omitted for a file-level finding (e.g. an
    unknown-header list)."""
    level: str = "warn"
    msg: str
    row: int | None = None


class RoutingUploadResult(BaseModel):
    """Shape returned by both POST /routing/upload/production-versions and
    POST /routing/upload/operations (ROUTING_RUNTIME_DESIGN.md §6)."""
    inserted: int
    updated: int
    rejected: int
    warnings: list[UploadWarning] = []
    # Distinct plants the file touched, sorted, so the UI can sync its plant filter.
    plants: list[str] = []


class RoutingValidateRequest(BaseModel):
    """Body of POST /routing/validate/{table}: pasted rows keyed by template
    header or NIMBUS column name."""
    rows: list[dict] = []


class RoutingValidateResult(BaseModel):
    """Shape returned by POST /routing/validate/{table}: the cleaned rows the
    Excel upload would have kept, with its rejection warnings. Never writes."""
    rows: list[dict]
    rejected: int
    warnings: list[UploadWarning] = []
