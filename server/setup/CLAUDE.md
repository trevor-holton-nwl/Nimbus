# server/setup — plant-scoped, versioned, observation-only setup (changeover) persistence

## What lives here

- **`routes.py`** (379 lines) — 15 routes: 14 under `/setup/{plant}/*` plus `PUT /plant/{plant}/setup-active`:
  - `PUT /setup/{plant}/active` (`set_setup_active`) — **vestigial but retained** (Workstream D2, 2026-08-20): used to be the "Include setup times in optimizer" write path; see Key invariants below.
  - `GET /setup/{plant}` (`get_setup`) — one authorized plant's complete setup snapshot (definition + matrix + machine states), never a cross-plant aggregate; attaches `plant_active` (from `plants.setup_active`, the real activation gate).
  - `PUT /plant/{plant}/setup-active` (`set_plant_setup_active_route`) — the **current** "include setup times in optimizer" write path, persisting the plant-level flag onto `plants.setup_active`.
  - `GET /setup/{plant}/coverage` (`get_setup_coverage`) — bounded Stage 0 transition coverage.
  - `GET /setup/{plant}/matrix-rows` (`get_setup_matrix_rows`) — bounded, from-state-scoped page of effective matrix rows (the O(states²)-avoidance endpoint).
  - `GET /setup/{plant}/missing-pairs.csv` (`export_setup_missing_pairs`) — CSV export of one bounded, selectable page of missing canonical pairs.
  - `PUT /setup/{plant}/definition` (`save_setup_definition`) — master-data-owner write for a plant's ordered signature definition.
  - `POST /setup/{plant}/matrix/import` (`import_setup_matrix`) — validated mass-upload, plant-wide or single-machine-scoped.
  - `DELETE /setup/{plant}/matrix` (`delete_setup_matrix_rows`) — deletes only selected cells (a sparse machine deletion exposes inherited plant truth).
  - `PUT /setup/{plant}/lines/{machine}/state` (`save_setup_line_state`) — authorized plant schedulers assert current physical machine state.
  - `PUT|GET /setup/{plant}/lines/{machine}/compatibility` (`save_setup_line_compatibility`/`get_setup_line_compatibility`) — admin-only per-machine setup-signature opt-out, distinct from the global `excl_optimizer` flag.
  - `POST|PUT|DELETE /setup/{plant}/overrides[/{id}]` (`create_setup_override`/`save_setup_override`/`clear_setup_override`) — one-off occurrence-specific adjustments.
  - Local helpers used only within this domain: `_setup_plant_guard`, `_setup_error` (409 for stale signature version, else 400), `_setup_freshness` (attaches `{signature_version, request_id}` to every response), `_setup_observed_at`.
- **`data.py`** (922 lines, whole-file move of the former root `setup_data.py`) — plant-scoped, versioned persistence across four tables: `setup_definition`, `setup_matrix`, `machine_setup_state`, `setup_occurrence_override`. Key functions: `canonical_state_key`/`derived_order_state_values`/`_normalise_value` (canonicalization — the server-side twin of `web/setup/setup-domain.mts`'s `normalizedValue`), `validate_setup_minutes`/`validate_override_minutes`/`validate_signature_version`/`validate_matrix_rows`, `set_definition_active`/`save_definition`, `replace_plant_matrix`/`upsert_machine_matrix_rows`/`delete_machine_matrix_rows`/`delete_plant_matrix_rows`, `set_machine_state`/`derive_machine_state_before_replacement`/`capture_setup_states_before_schedule_mutation`/`should_replace_machine_state` (the `derived`/`manual`/`actual` trust ordering), `upsert_occurrence_override`/`update_occurrence_override`/`clear_occurrence_override`, `get_setup_snapshot`/`current_signature_version`, `build_setup_coverage`/`get_setup_coverage`/`page_missing_pairs`/`page_matrix_rows`.

Both files' header docstrings confirm a **pure move from `brain.py`** (routes.py: lines 2517-2832 of the pre-split file, per `docs/architecture/domain-refactor-plan.md` §4) — route paths and payload/response shapes are byte-identical to before.

## Counterpart

Frontend half: `web/setup/CLAUDE.md` (`setup-domain.mts`, `setup-admin.mts`).

**`master_data.py` is not split** (deferred, see `docs/MIGRATION.md`) — `routes.py` imports it whole at repo root (`import master_data as md`) for plant/machine authorization and a few genuinely setup-adjacent write paths that live there instead of in `data.py`. Current clean ranges (grepped fresh against this worktree's `master_data.py`, 2,645 lines total):
- `md._assert_plant_allowed()` — line 168 (the shared plant-scope guard `_setup_plant_guard` wraps).
- `md.set_setup_line_compatibility()` / `md.get_setup_line_compatibility()` — lines 1297-1342, a clean, self-contained pair backing the `/setup/{plant}/lines/{machine}/compatibility` routes. Deliberately its own narrow write path (per its own docstring) rather than a generic machine bulk write, so the required incompatibility `reason` can be enforced and this setup-signature exception can't be conflated with the pre-existing global `excl_optimizer` flag.
- `md.set_plant_setup_active()` / `md.get_plant_setup_active()` — lines 1512-1563, a clean, self-contained pair backing `PUT /plant/{plant}/setup-active` and the `plant_active` field on `GET /setup/{plant}`. This is now the **sole** gate the optimizer/frontend read for setup-aware scheduling (see Key invariants).
- `md.plants_for_line()` — line 2580, used elsewhere in the app for plant/machine resolution, not called by this domain's routes directly but worth knowing it's the same file.

The **field-registry import edge is a real, deliberate cross-file dependency, not something this domain owns**: `data.py` does `from master_data import CONFIGURABLE_PRIORITY_FIELDS, RANKABLE_FIELDS` (data.py:16) — `RANKABLE_FIELDS` (master_data.py:120) is the registry of which fields (`colorWheel`/`prt01`/`prt02`/`productionVersion`) can form a plant's setup signature. This module borrows that registry; it does not define its own. See `server/priority_lists/CLAUDE.md` for the registry's own documentation.

## Key invariants & hazards

- **Observation-only, always.** This module never changes an order's schedule — every write here is to setup truth (definitions, matrix minutes, machine state, overrides), never to `orders`. The scheduler (optimization domain) reads this data; nothing in `server/setup/` writes a schedule.
- **`derived < manual < actual` trust ordering** (`data.py`'s `_SOURCE_TRUST = {"derived": 1, "manual": 2, "actual": 3}`) governs `should_replace_machine_state`: a lower-trust source observation never silently overwrites a higher-trust one already on file for `machine_setup_state`.
- **Writes are gated by the `setup_scheduler` role permission.** `auth.require_setup_scheduler` needs `roles.settings.permissions.setup_scheduler === true` **and** at least one `role_plants` row for the caller — see routes.py's `Depends(auth.require_setup_scheduler)` on the machine-state and occurrence-override write routes. Admin-gated routes (definition, matrix import/delete, compatibility) instead use `auth.require_admin`.
- **The activation story has moved, and the wider refactor's own planning materials are dated about it.** `PUT /setup/{plant}/active` (writing `setup_definition.active`, per-signature-version) is **vestigial but retained** — its own docstring says so verbatim: "no UI or optimizer gate reads `setup_definition.active` any more," kept only because removing it means also removing every caller/test, judged higher blast radius than leaving one unread write path in place. The **real** gate as of Workstream D2 (2026-08-20) is `plants.setup_active`, written through `PUT /plant/{plant}/setup-active` (`master_data.set_plant_setup_active`) and read through `GET /setup/{plant}`'s `plant_active` field (`master_data.get_plant_setup_active`). These are three independently inspectable gates, never conflated: `plants.setup_active` (this one), `machine.setup_compatible` (per-machine opt-out), and the frontend's own `setupSnapshot.plant` identity check.
- **Signature-version conflicts are 409, not 400.** `_setup_error()` inspects the exception message for "signature version is stale" (case-insensitive) to distinguish a real optimistic-concurrency conflict on the setup signature from an ordinary malformed-request 400 — every mutating route funnels its `ValueError` through this helper.
- **`data.py` is also consumed outside `server/setup/`:** `server/integration/routes.py` and `server/integration/sap_sync.py` both call `setup_data.capture_setup_states_before_schedule_mutation(...)` before an ingest/SAP-sync run overwrites schedules — capturing a `derived` machine-state snapshot from what's about to be replaced. This is a real cross-domain dependency (integration → setup), not a coupling bug.

## Integration points

**Imports in:** `master_data as md` (root, unsplit — see Counterpart); `server.setup.data as setup_data` (routes.py imports its own domain's data module by the conventional `as setup_data` alias — this is also what external callers use, see below); `server.admin_ops.logbuffer` (`_current_rid`, `_set_admin_log_details`); `server.security.auth` (`require_authenticated`, `require_admin`, `require_setup_scheduler`, `get_allowed_plants_for_request`) and `server.security.auth.require_api_key`.

**Imported by:**
- `brain.py` — `import server.setup.routes as setup_routes` (router registration) and, separately, `import server.setup.data as setup_data  # noqa: F401 — back-compat (brain.setup_data)`. Because Python caches modules by name in `sys.modules`, `brain.setup_data.<fn>` and any `monkeypatch.setattr(brain.setup_data, ...)` resolve to the **same module object** as this routes.py's and `server/integration/routes.py`'s own `import server.setup.data as setup_data` — a monkeypatch made via `brain.setup_data` in a test is visible to the real route handlers too.
- `server/integration/routes.py`, `server/integration/sap_sync.py` — `import server.setup.data as setup_data`, for the pre-mutation state-capture call noted above.
- `tests/test_priority_lists.py`, `tests/test_setup_data.py`, `tests/test_setup_coverage.py` — `import server.setup.data as setup_data` directly.
- No test imports `server.setup.routes` by name (grep-verified) — route coverage goes through a live `TestClient`/`brain` app instance (`tests/test_setup_endpoints.py`).

**Endpoints:** see "What lives here" for the full list; consumed by `web/setup/setup-admin.mts` (all but the two activation routes — see the web-side doc) and by `web/master-data/admin-ui.mts`'s `Plant._renderSettingsPane` (`PUT /plant/{plant}/setup-active` only).

## Tests

- `tests/test_setup_data.py` — direct unit coverage of `server/setup/data.py`'s persistence/validation functions.
- `tests/test_setup_coverage.py` — coverage-computation logic (`build_setup_coverage`/`get_setup_coverage`/paging).
- `tests/test_setup_endpoints.py` — route-level (`TestClient`) coverage of `/setup/{plant}/*` and `/plant/{plant}/setup-active`.
- `tests/test_priority_lists.py` — touches `server.setup.data` for the shared `RANKABLE_FIELDS` registry interaction.
- `tests/test_master_data_setup_policy.py` — exercises `master_data.py`'s side of the setup-adjacent policy functions (see Counterpart).
- `tests/test_static_delivery.py` — pins the `domain_static_asset_mw` route-collision fix for `GET /setup/{plant}` against the `web/setup/` static folder (fixture: `web/setup/_static-delivery-check.mjs`).

Run: `python -m pytest tests/test_setup_data.py tests/test_setup_coverage.py tests/test_setup_endpoints.py -q`

## Gotchas

- Don't describe `PUT /setup/{plant}/active` as "the" activation checkbox in any new doc or code comment — it is dead-but-kept. `PUT /plant/{plant}/setup-active` is current.
- `docs/Setup_matrix_redesign.md` §1.1/§15 (cited by the wider refactor's own planning docs as the corrected activation story) predates the D2 relocation described above and is itself now one step out of date — verify against `set_plant_setup_active_route`/`Plant._renderSettingsPane` in live code, not that doc section.
- `docs/archive/changeover_matrix_stage_{0,1,2}.md` carry stale unchecked boxes even though all three stages shipped (~50 commits) — trust `git log`, not those checkboxes.
- `RANKABLE_FIELDS` is genuinely owned by `master_data.py`, not this domain — resist the urge to "finish the move" by relocating it here; that's an explicitly deferred cross-file edge per the refactor plan.
