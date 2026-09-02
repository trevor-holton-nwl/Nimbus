"""
NIMBUS 2.0 — scheduling domain Pydantic models (GET /tasks family).

P5 relocation: pure move from brain.py, verbatim, per
docs/architecture/domain-refactor-plan.md §4. These carry the `response_model=`
contracts pinned by FastAPI's own runtime validation — field/type shapes are
byte-identical to the originals.
"""
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


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
    start_date: str
    end_date: str
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
    planned_order_initial_quantity_gmein: float | None = Field(default=None, alias="PLANNED_ORDER_INITIAL_QUANTITY_(GMEIN)")
    reduced_quantity_gmein: float | None = Field(default=None, alias="REDUCED_QUANTITY_(GMEIN)")
    ORDER_CATEGORY: str | None = None
    ORDER_TYPE: str | None = None
    BOM_ALTERNATIVE: int | None = None
    BOM_USAGE: int | None = None
    labor_hours_meinh: float | None = Field(default=None, alias="LABOR_HOURS_(MEINH)")
    machine_hours_meinh: float | None = Field(default=None, alias="MACHINE_HOURS_(MEINH)")
    no_of_fte_meinh: float | None = Field(default=None, alias="NO_OF_FTE_(MEINH)")
    row_version: int | None = None
    schedule_segments: list[ScheduleSegmentDTO] = Field(default_factory=list)
    runtime_schedule_mismatch: bool = False


class TasksResponse(BaseModel):
    """GET /tasks's full envelope. `meta` stays a loose dict: it's `DIAGNOSTICS`
    merged with per-request color-merge stats (backend/scheduling/routes.py's
    `meta = dict(DIAGNOSTICS, **cm_stats)`),
    a large, evolving diagnostics bag with no single fixed schema — modeling every
    key precisely is out of scope for this phase and would need to track
    DIAGNOSTICS's shape by hand forever. The empty-result path also returns a
    smaller `meta` subset (see get_tasks's `empty_meta`), which a strict schema
    would reject."""
    data: list[TaskDTO]
    links: list[LinkDTO]
    meta: dict[str, Any]


class TaskUpdateResult(BaseModel):
    """Response for POST /task/update (singular). Narrower than the bulk
    shape — this endpoint also raises 404/400 (response_model only applies
    to the 200 path)."""
    status: str
    persisted: int
    failed: int
    stale: list[str]
    versions: dict[str, int]


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
    error_code: str | None = None
    cause: str | None = None


class TaskVersionRow(BaseModel):
    """One row of GET-equivalent /tasks/refresh's `data` array — db.get_task_versions'
    shape exactly (db.py:437-445)."""
    id: str
    start_date: str | None = None
    end_date: str | None = None
    row_version: int | None = None
    schedule_segments: list[ScheduleSegmentDTO] = Field(default_factory=list)
    runtime_schedule_mismatch: bool = False


class TasksRefreshResponse(BaseModel):
    data: list[TaskVersionRow]


class BaselineCorrectResult(BaseModel):
    """Response for POST /tasks/baseline-correct — db.correct_due_date_baselines'
    shape (db.py:604+) plus the same status/error_code/cause failure fields as
    BulkUpdateResult."""
    status: str
    applied: int
    persisted: int
    skipped: int
    not_matched: int
    versions: dict[str, int]
    error_code: str | None = None
    cause: str | None = None


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

    Optimistic concurrency: `base_version` is the xmin the client last saw for this
    row. The write is rejected (reported as `stale`) if the row's current xmin differs,
    unless `force` is set. `force=True` is used for authoritative bulk reschedules
    (the optimizer), which intentionally overwrite regardless of concurrent edits.
    """
    id: str
    start_date: str | None = None
    end_date: str | None = None
    PRT_01: str | None = None
    PRT_02: str | None = None
    PRODUCTION_VERSION: str | None = None
    RUN_TIME: float | None = None
    schedule_segments: list[ScheduleSegmentInput] | None = None
    base_version: int | None = None
    force: bool = False


class TasksUpdatePayload(BaseModel):
    """Frontend autosave payload: { tasks, blocks?, calendars? }. Only `tasks` is
    consumed here. Calendars and blackout blocks now persist through the dedicated
    /plant-calendar/* endpoints (backend-authoritative); any blocks/calendars sent
    here are ignored (legacy ride-along, harmless)."""
    tasks: list[TaskDateUpdate] = []


class TaskRefreshPayload(BaseModel):
    """Ids the client needs to reconcile after a concurrency conflict."""
    ids: list[str] = []


class DueDateCorrection(BaseModel):
    """One order's due-date-baseline correction, computed client-side by
    Persistence._snapToWorkingHours's due-date-baseline phase in app.js.
    `base_version` is the row's xmin as of the client's last load/save of it —
    used server-side to pin the write against ANY concurrent change to the row
    (a SAP re-upload, a normal scheduling save, or another tab's correction).
    Deliberately not a raw date value: a date round-trips through JS
    Date/JSON.stringify, which would re-label a naive local timestamp as UTC
    and never match Postgres's naive basic_start_date for a non-UTC client.
    See db.correct_due_date_baselines."""
    id: str
    basic_finish_date: str
    base_version: int


class DueDateCorrectionPayload(BaseModel):
    corrections: list[DueDateCorrection] = []
