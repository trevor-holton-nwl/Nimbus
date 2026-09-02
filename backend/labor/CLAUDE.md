# Labor — aggregate and line-level available-labor-hours planning

## What lives here

- `routes.py` (57 lines, 4 routes) — `GET /labor-plan` (aggregate line-group × ISO-week cells), `POST /labor-plan` (upsert/delete aggregate cells), `GET /labor-plan/line` (line-level machine × calendar-day cells, optionally filtered by group/date range), `POST /labor-plan/line` (upsert/delete line-level cells). All four are thin wrappers over `master_data.py` functions — no logic of its own beyond payload unpacking and a 400 on missing `plant`.

This is a small, self-contained domain by route count, but it earns its own folder anyway: it has its **own tables** (the aggregate labor-plan table and the line-level labor-cell table, both owned by `master_data.py`), which is the source plan's stated reasoning for giving it a dedicated home rather than folding it into `master_data`.

## Counterpart

Frontend half: `frontend/labor/labor-planning.mts` (`LaborPlanning` — the labor plan editor UI).

Deferred split: the actual data functions (`load_labor_plan`, `upsert_labor_plan`, `load_labor_plan_machine`, `upsert_labor_plan_machine`) live in root `master_data.py`, imported here as `master_data as md`. This domain's `routes.py` is a pure route layer over them.

## Key invariants & hazards

- Both POST routes take `{ subnetwork, plant, cells: [...] }` — `subnetwork` is required by the underlying `master_data` upsert even though the GET routes only need `plant` (plants are keyed by `(subnetwork, plant)`, matching the composite-key convention documented in `backend/master_data/CLAUDE.md`).
- `GET /labor-plan/line` accepts optional `group`/`from_date`/`to_date` filters; omitting them returns the full plant's line-level cells.
- **Known frontend coupling worth re-checking, not asserted as still-open:** a prior refactor phase (CQ-1, the module-extraction effort) tracked `frontend/labor/labor-planning.mts` reading `Store._state.masterData` directly (rather than through a narrower accessor) as a known exception it deliberately left open rather than closed. A grep of the live file at the time of this doc still shows several direct `Store._state.masterData?.plants`/`.lines` reads (e.g. resolving a plant's subnetwork, or a plant's line list) — so the exception still appears live, but this is worth re-confirming against `frontend/labor/CLAUDE.md` / the live file rather than trusting this note indefinitely.

## Integration points

**Imports in:** `master_data as md` only.

**Imported by:** nothing outside `brain.py`'s router registration — no other domain imports `backend.labor.routes`.

**Endpoints:** `GET /labor-plan`, `POST /labor-plan`, `GET /labor-plan/line`, `POST /labor-plan/line`.

## Tests

No dedicated test file exists for this domain (`tests/` has no `test_labor*.py`). Labor-plan endpoints are exercised only indirectly, if at all, through broader master-data test coverage. If you add labor-plan-specific tests, they belong in a new `tests/test_labor_plan.py` rather than folded into `tests/test_master_data.py`.

## Gotchas

- Despite the small route count, don't be tempted to merge this back into `backend/master_data` — the source plan explicitly keeps it separate because of the dedicated tables, and the frontend module (`frontend/labor/labor-planning.mts`) is already its own file.
