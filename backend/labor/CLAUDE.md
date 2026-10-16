# Labor — aggregate and line-level available-labor-hours planning

## What lives here

- `routes.py` (5 routes) — `GET /labor-plan` (aggregate line-group × ISO-week cells), `POST /labor-plan` (upsert/delete aggregate cells), `GET /labor-plan/line` (line-level machine × calendar-day cells, optionally filtered by group/date range), `POST /labor-plan/line` (upsert/delete line-level cells). `POST /labor-plan/batch` atomically persists aggregate and derived line cells, including Undo. The routes are thin wrappers over `master_data.py` functions — no logic of its own beyond payload unpacking, a 400 on missing `plant`, and the per-user plant-scope check (`md._assert_plant_allowed`, 403 out of scope). Reads and writes need an authenticated user, not an admin.

This is a small, self-contained domain by route count, but it earns its own folder anyway: it has its **own tables** (the aggregate labor-plan table and the line-level labor-cell table, both owned by `master_data.py`), which is the source plan's stated reasoning for giving it a dedicated home rather than folding it into `master_data`.

## Counterpart

Frontend half: `frontend/labor/labor-planning.mts` (`LaborPlanning` — the labor plan editor UI).

Deferred split: the actual data functions (`load_labor_plan`, `upsert_labor_plan`, `load_labor_plan_machine`, `upsert_labor_plan_machine`) live in root `master_data.py`, imported here as `master_data as md`. This domain's `routes.py` is a pure route layer over them.

## Key invariants & hazards

- Both POST routes take `{ subnetwork, plant, cells: [...] }` — `subnetwork` is required by the underlying `master_data` upsert even though the GET routes only need `plant` (plants are keyed by `(subnetwork, plant)`, matching the composite-key convention documented in `backend/master_data/CLAUDE.md`).
- Cell keys are validated server-side before they reach the TEXT primary-key columns: `period` must be an ISO week (`YYYY-Www`) and `day` a real ISO date (`YYYY-MM-DD`), else the POST returns 400 (`master_data._validate_labor_cells`, commit 18822fe).
- `GET /labor-plan/line` accepts optional `group`/`from_date`/`to_date` filters; omitting them returns the full plant's line-level cells.
- **Known frontend coupling worth re-checking, not asserted as still-open:** a prior refactor phase (CQ-1, the module-extraction effort) tracked `frontend/labor/labor-planning.mts` reading `Store._state.masterData` directly (rather than through a narrower accessor) as a known exception it deliberately left open rather than closed. A grep of the live file still shows several direct `Store._state.masterData?.plants`/`.lines` reads (e.g. resolving a plant's subnetwork, or a plant's line list) — so the exception is still live; `frontend/labor/CLAUDE.md` is only a pointer and carries nothing on it.
- Frontend: the week-column cells carry the raw ISO week key in `data-period` (not CSS-escaped — escaping corrupted leading-digit keys, aa3a920); pasting N lines into the line picker selects all N.

## Integration points

**Imports in:** `master_data as md` only.

**Imported by:** nothing outside `brain.py`'s router registration — no other domain imports `backend.labor.routes`.

**Endpoints:** `GET /labor-plan`, `POST /labor-plan`, `GET /labor-plan/line`, `POST /labor-plan/line`, `POST /labor-plan/batch`.

## Tests

`tests/test_labor_plan.py` covers the atomic batch, validation, RBAC and actual PostgreSQL rollback. `tests/test_labor_persistence_workflows.py` and `tests/test_api_labor_coverage.py` cover the legacy endpoints; the latter retains known malformed-payload xfails. Plant-scope checks also live in `tests/test_rbac_plant_scoping.py`. Frontend behavior is covered by `tests/modules/labor/labor-planning.test.mjs` and `labor-audit.test.mjs`.

## Atomic edit contract (2026-10-16)

The frontend uses `/labor-plan/batch` with `{subnetwork, plant, cells, line_cells, intent}` (`reconcile`, `explicit`, or `undo`). The batch validates ISO keys, finite nonnegative hours and `auto_split`/`override` provenance; both tables and audit rows commit in one transaction. Automatic reconciliation conditions its upsert/delete mutations on the current row not being an override, including after concurrent row-lock waits. Explicit daily reset and Undo intentionally can replace a pin. The response includes canonical `lines.rows`, actual `lines.applied` keys and preserved `lines.skipped` rows; frontend cache and Undo follow the acknowledgement. Audits count actual affected rows. Legacy POST routes retain their compatibility behavior. No table migration is required.

Frontend automatic splits preserve pinned daily cells; clearing an aggregate deletes only automatic descendants. Undo restores both levels including cell absence and source. The split denominator still includes every open line/day slot; overrides may make line totals differ from group totals. All five views use the selected horizon (up to 112 days), and daily views/KPIs share group/line scope. Aggregate cells always edit the full group, even when selected lines narrow which groups are visible. The in-page write queue orders rapid edits and defers plant-cache invalidation until queued writes finish. Daily save acknowledgements patch existing inputs to preserve subsequent drafts/focus. Cross-client version checking for explicit edits/Undo remains a follow-up, documented in `docs/frontend-audit/2026-10-16/labor.md`.


## Gotchas

- Despite the small route count, don't be tempted to merge this back into `backend/master_data` — the source plan explicitly keeps it separate because of the dedicated tables, and the frontend module (`frontend/labor/labor-planning.mts`) is already its own file.
