"""
Response DTOs for backend/setup/routes.py -- added 2026-09 (Code_Review_09_01.md
§16 / "response_model= typing gaps") so this router stops emitting `unknown` into
frontend/types/api-generated.d.mts, mirroring the pattern backend/scheduling/models.py
already established.

This domain's result dicts (backend/setup/data.py) are deeply nested and, in at
least one function (get_setup_snapshot), the branch for an unset definition
returns a visibly different key set than the populated branch -- verified by
direct read, not assumed. Rather than risk a ResponseValidationError 500 on a
production, observation-only-but-load-bearing domain by over-specifying fields
that could legitimately vary, these models declare only what's genuinely
guaranteed (the shared `freshness` wrapper every route attaches via
routes.py's `_setup_freshness()`, plus a `plant` field most also carry) and
allow every other key through untyped via `model_config = {"extra": "allow"}`.
This still turns `unknown` into a real, if loose, OpenAPI schema -- a
deliberate, documented trade-off, not an oversight (contrast with
backend/scheduling/models.py's fully-typed DTOs, which is possible there
because that domain's shapes are flatter and don't have this domain's
branch-dependent key-set variance).
"""
from pydantic import BaseModel, ConfigDict


class SetupFreshness(BaseModel):
    signature_version: int | None = None
    request_id: str | None = None


class SetupEnvelope(BaseModel):
    """Base for every route that goes through routes.py's _setup_freshness()."""
    model_config = ConfigDict(extra="allow")
    freshness: SetupFreshness


class SetupCsvExportMeta(BaseModel):
    """GET /setup/{plant}/missing-pairs.csv is the one route in this file that
    returns a StreamingResponse-shaped Response, not a _setup_freshness()
    envelope -- no response_model applies there (FastAPI can't validate a
    raw Response body against a Pydantic model); this class exists only so a
    reader scanning this file for "why isn't that route in here" finds the
    answer in one place rather than re-deriving it."""
    model_config = ConfigDict(extra="allow")


class PlantSetupActiveResult(BaseModel):
    """master_data.set_plant_setup_active()'s shape (PUT /plant/{plant}/setup-active).
    Not a _setup_freshness() envelope -- this route returns md.*'s dict directly."""
    status: str
    plant: str
    setup_active: bool


class SetupLineCompatibilityResult(BaseModel):
    """master_data.set_setup_line_compatibility()/get_setup_line_compatibility()'s
    shared shape (PUT|GET /setup/{plant}/lines/{machine}/compatibility). Neither
    route goes through _setup_freshness() -- both return md.*'s dict directly."""
    plant: str
    machine: str
    setup_compatible: bool
    setup_compatibility_reason: str | None = None
