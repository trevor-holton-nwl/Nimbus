"""
NIMBUS 2.0 — scheduling domain Pydantic models (GET /tasks family).

P5 relocation: pure move from brain.py, verbatim, per
docs/architecture/domain-refactor-plan.md §4. These carry the `response_model=`
contracts pinned by FastAPI's own runtime validation — field/type shapes are
byte-identical to the originals.
"""
import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


# =========================
# Response models (Phase 4 Task 1 — response_model= additions)
# =========================
class LinkDTO(BaseModel):
    """One finish-to-start link in GET /tasks's `links` array."""
    id: int
    source: str
    target: str
    type: str


class ScheduleSegmentDTO(BaseModel):
    """One productive child interval of a logical production order."""
    sequence: int
    start_date: str
    end_date: str


class PlanningReason(BaseModel):
    code: str
    message: str
    step: str | None = None


class TaskDTO(BaseModel):
    """One row of GET /tasks's `data` array. Field set mirrors the dict literal
    built in get_tasks (backend/scheduling/routes.py, the `data.append({...})` block)
    verbatim — see docs/archive/typescript_migration.md §F/§C. Optional fields are
    exactly the ones read via `row.get(...)` with no coercing default (i.e. can be
    None from a NaN source row); non-optional fields either have a code-level
    default (e.g. `text`, `ecc_firmed`, `user_scheduled`) or come from a groupby
    key that can't be null."""
    model_config = ConfigDict(populate_by_name=True)

    id: str
    text: str
    start_date: str | None
    end_date: str | None
    original_start_date: str | None = None
    original_end_date: str | None = None
    user_scheduled: bool
    MACHINE: str
    MATERIAL_DESCRIPTION: str
    MATERIAL_NUMBER: str | None = None
    order_quantity_gmein: float | None = Field(default=None, alias="ORDER_QUANTITY_(GMEIN)")
    COLOR: str | None = None
    PRT_01: str | None = None
    PRT_02: str | None = None
    PRODUCTION_VERSION: str | None = None
    PLANT: str | None = None
    ORDER: str | None = None
    ORDER_Y: float | None = None
    RUN_TIME: float | None = None
    FORM_SIZE: str | None = None
    notes: str | None = None
    ecc_firmed: bool
    # Planner's manual firm (orders.manual_firmed); SAP's own firming indicator
    # stays in ecc_firmed and never locks an order.
    firmed: bool = False
    planned_order_initial_quantity_gmein: float | None = Field(default=None, alias="PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)")
    reduced_quantity_gmein: float | None = Field(default=None, alias="REDUCED_QUANTITY_(GMEIN)")
    ORDER_CATEGORY: str | None = None
    ORDER_TYPE: str | None = None
    BOM_ALTERNATIVE: int | None = None
    BOM_USAGE: int | None = None
    labor_hours_meinh: float | None = Field(default=None, alias="LABOR_HOURS_(MEINH)")
    machine_hours_meinh: float | None = Field(default=None, alias="MACHINE_HOURS_(MEINH)")
    no_of_fte_meinh: float | None = Field(default=None, alias="NO_OF_FTE_(MEINH)")
    PARENT_ORDER: str | None = None
    DISTRIBUTION_LETTER: str | None = None
    row_version: int | None = None
    schedule_segments: list[ScheduleSegmentDTO] = Field(default_factory=list)
    runtime_schedule_mismatch: bool = False
    # Why the planner's bar deliberately differs from the run time (backward scheduling OQ50):
    # 'overtime' (placed on non-working time) or 'overlong' (wider than the run time). NULL = a
    # normal bar; the server's width check is skipped for a marked bar.
    placement_exception: Literal["overtime", "overlong"] | None = None
    planning_status: Literal["scheduled", "needs_planning"] = "scheduled"
    planning_reason: PlanningReason | None = None
    # Routing runtime (ROUTING_RUNTIME_DESIGN.md §8.2/§13) — server-computed
    # provenance for RUN_TIME; never client-supplied.
    run_time_source: str | None = None
    run_time_basis: dict[str, Any] | None = None


class TasksResponse(BaseModel):
    """GET /tasks's full envelope. `meta` stays a loose dict: it's `DIAGNOSTICS`
    merged with per-request color-merge stats (backend/scheduling/routes.py's
    `meta = dict(DIAGNOSTICS, **cm_stats)`),
    a large, evolving diagnostics bag with no single fixed schema — modeling every
    key precisely is out of scope for this phase and would need to track
    DIAGNOSTICS's shape by hand forever. The empty-result path also returns a
    smaller `meta` subset (see get_tasks's `empty_meta`), which a strict schema
    would reject. Both paths carry `meta.server_now` (ISO-8601 UTC): the one clock the browser
    projects into each plant's zone (backward scheduling OQ52); it is not a TaskDTO field."""
    data: list[TaskDTO]
    links: list[LinkDTO]
    meta: dict[str, Any]


class HorizonsResponse(BaseModel):
    """GET /tasks/horizons — the plant's resolved horizon instants (ISO strings, naive plant-local
    like GET /tasks' meta) plus the alert-flag horizon in minutes; every field None when off/unknown."""
    visibility_horizon_end: str | None
    frozen_horizon_end: str | None
    alert_horizon_minutes: int | None
    # Opaque fingerprint of the plant's calendar (hours, periods, blackouts); the Gantt re-fetches the plant
    # calendar when it differs from the last one it hydrated. Optional and additive: None for an unknown plant.
    calendar_version: str | None = None


class ScheduleConflict(BaseModel):
    """One same-machine strict overlap detected inside the save transaction (N3).
    order_a < order_b lexicographically; overlap_minutes is summed across segments.
    `plant` scopes the pair (machine names are per-plant — machine_state is keyed
    (plant, machine) — so two different plants sharing a machine name are never
    pooled into the same conflict)."""
    machine: str
    plant: str
    order_a: str
    order_b: str
    overlap_minutes: float


class TaskUpdateResult(BaseModel):
    """Response for POST /task/update (singular). Narrower than the bulk
    shape — this endpoint also raises 404/400 (response_model only applies
    to the 200 path)."""
    status: str
    persisted: int
    failed: int
    stale: list[str]
    versions: dict[str, int]
    conflicts: list[ScheduleConflict] = Field(default_factory=list)
    rejection_reasons: dict[str, str] = Field(default_factory=dict)
    start_derived: dict[str, bool] = Field(default_factory=dict)


class BulkUpdateResult(BaseModel):
    """Shared response shape for POST /tasks/update and POST /tasks/bulk_update.
    Never 4xx — a version conflict or a rolled-back transaction is reported here,
    not as an HTTP error status. error_code/cause are only populated when status
    == 'error' (a whole-transaction rollback)."""
    status: str
    updated: int
    persisted: int
    failed: int
    invalid: int
    not_found: int
    invalid_ids: list[str]
    not_found_ids: list[str]
    stale: list[str]
    versions: dict[str, int]
    conflicts: list[ScheduleConflict] = Field(default_factory=list)
    error_code: str | None = None
    cause: str | None = None
    # ROUTING_RUNTIME_DESIGN.md §8.5: sparse {id: reason} map, purely additive —
    # populated ONLY for an invalid_ids entry rejected by db.update_task_dates_bulk's
    # routing-eligibility re-check (reason is one of resolve_one's own failure
    # steps, e.g. "no_operation_at_workcenter"). Every other invalid_ids cause in
    # that same validation loop has no entry here; invalid_ids itself is
    # unchanged (still a plain id list) so this never breaks a consumer that
    # treats invalid_ids elements as bare ids.
    rejection_reasons: dict[str, str] = Field(default_factory=dict)
    # Backward scheduling OQ59: sparse {id: True} -- the ids saved with `trust_start: false`. The server
    # stored the sent finish as the placed finish and flagged the row stale, so the BROWSER re-derives
    # its start from that finish on the next load. Absent id = the start was trusted.
    start_derived: dict[str, bool] = Field(default_factory=dict)


class TaskVersionRow(BaseModel):
    """Current task aggregate and runtime inputs from one versioned database read."""
    model_config = ConfigDict(populate_by_name=True)
    id: str
    start_date: str | None = None
    end_date: str | None = None
    row_version: int | None = None
    MACHINE: str | None = None
    PRT_01: str | None = None
    PRT_02: str | None = None
    PRODUCTION_VERSION: str | None = None
    RUN_TIME: float | None = None
    order_quantity_gmein: float | None = Field(default=None, alias="ORDER_QUANTITY_(GMEIN)")
    MATERIAL_NUMBER: str | None = None
    PLANT: str | None = None
    firmed: bool = False
    original_start_date: str | None = None
    # The locked SAP finish (the due date): COALESCE(original_finish_received, basic_finish_date).
    original_end_date: str | None = None
    schedule_segments: list[ScheduleSegmentDTO] = Field(default_factory=list)
    runtime_schedule_mismatch: bool = False
    # Why the planner's bar deliberately differs from the run time (backward scheduling OQ50):
    # 'overtime' (placed on non-working time) or 'overlong' (wider than the run time). NULL = a
    # normal bar; the server's width check is skipped for a marked bar.
    placement_exception: Literal["overtime", "overlong"] | None = None
    # Someone placed this order (db._PLACED_SQL): the client must not re-derive a placed row from its due date.
    user_scheduled: bool = False
    planning_status: Literal["scheduled", "needs_planning"] = "scheduled"
    planning_reason: PlanningReason | None = None
    # Routing runtime (ROUTING_RUNTIME_DESIGN.md §8.2/§13) — server-computed
    # provenance for RUN_TIME; never client-supplied.
    run_time_source: str | None = None
    run_time_basis: dict[str, Any] | None = None


class TasksRefreshResponse(BaseModel):
    """`missing` mirrors BulkUpdateResult's `not_found_ids` convention: ids the
    client asked about (in the request payload) that no longer exist server-side
    — deleted by another session, a purge, a re-upload, etc. — or that fell
    outside the caller's `allowed_plants` scope (folded in the same way
    update_task_dates_bulk folds an out-of-scope row into not_found_ids, so the
    response can't be used to distinguish "not found" from "not yours"). The
    client removes these from Store instead of silently leaving them as ghosts."""
    data: list[TaskVersionRow]
    missing: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Task date updates — shared model + validation + apply/persist/rollback
# ---------------------------------------------------------------------------
class ScheduleSegmentInput(BaseModel):
    """A value-only child interval. Extra keys are rejected so callers cannot
    smuggle child identities or unrelated writable fields into the aggregate."""
    model_config = ConfigDict(extra="forbid")

    sequence: int
    start_date: str
    end_date: str


class TaskDateUpdate(BaseModel):
    """One task's optional schedule/attribute edit. Unknown fields are ignored.

    `start_date` and `end_date` are both-or-neither: a payload carrying only one
    edge is rejected as `single_edge`. `trust_start` semantics are unchanged.

    Optimistic concurrency: `base_version` is the xmin the client last saw for this
    row. The write is rejected (reported as `stale`) if the row's current xmin differs,
    unless `force` is set. The optimizer does NOT use `force` — it sends
    `atomic_optimizer: true` on /tasks/update, under which `force` is ignored and any
    stale row rolls back the whole batch. `force` is honored only by /tasks/update in
    non-atomic mode (the client's Config.CONCURRENCY_CHECK=false escape hatch) and is
    stripped by /tasks/bulk_update.
    """
    id: str
    start_date: str | None = None
    end_date: str | None = None
    PRT_01: str | None = None
    PRT_02: str | None = None
    PRODUCTION_VERSION: str | None = None
    MACHINE: str | None = None
    RUN_TIME: float | None = None
    # Planner's manual firm, sent only for rows whose firm the planner toggled.
    FIRMED: bool | None = None
    schedule_segments: list[ScheduleSegmentInput] | None = None
    # Marker on a bar the planner placed on purpose off its run-time width. Sent only when the
    # marker changed; an explicit null clears it (read through model_fields_set, like the
    # attributes), an omitted field leaves the stored marker alone.
    placement_exception: Literal["overtime", "overlong"] | None = None
    base_version: int | None = None
    force: bool = False
    # Backward scheduling OQ59 (external date writers): False says the `start_date` sent is a best guess the
    # caller did not derive from the run time. The save then skips the width check, stores `end_date` as the
    # placed finish, forces the row's stale flag, and lists the id in the response's `start_derived`.
    # Default True (the browser's own save sends starts it derived itself).
    trust_start: bool = True
    planning_status: str | None = None
    planning_reason: dict[str, Any] | None = None
    # schedule_event history: the UI surface that produced this edit (drag, keyboard, grid, ...).
    # Advisory only: an unknown value is ignored server-side (never a 400) and recorded as 'planner'.
    source: str | None = Field(default=None, max_length=32)

    @field_validator("RUN_TIME")
    @classmethod
    def _run_time_must_be_finite_and_bounded(cls, value: float | None) -> float | None:
        """H8: an unvalidated RUN_TIME (e.g. NaN from a crafted request) reaches
        SQL interval arithmetic in db.py (`_EFF_END_SQL` et al.) and crashes
        `GET /tasks`/`/tasks/refresh`/the save-lock query for the whole plant.
        Bounds mirror the DB-level CHECK constraint (a representation bound:
        migrations/2026-10-15-2-orders-run-time-bounds-336.sql raised it from 168
        to 8760 hours; first added by migrations/2026-09-25-orders-run-time-bounds.sql),
        which is the backstop for the separate Excel/SAP ingest write path (db.py's
        bulk upsert) that this pydantic model never sees. The LIMIT an order is
        scheduled with is the flat 336 h cap (db.cap_hours),
        enforced per id in db.update_task_dates_bulk, not here."""
        if value is None:
            return value
        if not math.isfinite(value) or value < 0 or value >= 8760:
            raise ValueError("RUN_TIME must be a finite number of hours in [0, 8760)")
        return value


class TasksUpdatePayload(BaseModel):
    """Frontend autosave payload: { tasks, blocks?, calendars? }. Only `tasks` is
    consumed here. Calendars and blackout blocks now persist through the dedicated
    /plant-calendar/* endpoints (backend-authoritative); any blocks/calendars sent
    here are ignored (legacy ride-along, harmless)."""
    tasks: list[TaskDateUpdate] = []
    atomic_optimizer: bool = False
    # schedule_event history: the browser tab's id, stored on each history row (reserved for a change feed).
    client_id: str | None = Field(default=None, max_length=64)
    # N3: roll back when the written machines end up with overlaps. Honored only
    # together with atomic_optimizer; manual saves are never blocked.
    strict_conflicts: bool = False


class TaskRefreshPayload(BaseModel):
    """Ids the client needs to reconcile after a concurrency conflict."""
    ids: list[str] = []
