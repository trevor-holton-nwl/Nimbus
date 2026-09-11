# Code Review 09-01 "Now" Items (N1–N8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per the owner's standing rule, implementation code is written by Sonnet (logic-heavy tasks) or Haiku (pinned-spec helpers, locale keys, doc edits) subagents; the orchestrator reviews and never codes.

**Goal:** Ship the eight schema-free pilot-hardening workstreams (N1–N8) from `Code_Review_09_01.md` §5 as independently reviewable, tested, committed tasks on `main`.

**Architecture:** Every item edits existing modules in place; no new tabs, tables, or suites beyond the one intelligence-layer test file that has to exist because nothing tests `Diff` today. Backend changes stay inside the never-4xx `BulkUpdateResult` contract. Frontend changes follow the domain `CLAUDE.md` invariants (worker/core parity for alerts, `.mts` compiled via `npm run build`, all new UI text through `Util.t()` in all five locales).

**Tech Stack:** FastAPI + psycopg (`db.py`, `backend/*/routes.py`), TypeScript `.mts` compiled by `tsc`, plain-JS `nimbus-compute-core.js` / `nimbus-intelligence.js`, node:test (`tests/js`, `tests/modules`), pytest (`tests/`).

**Spec:** `Code_Review_09_01.md` §5 (workstreams N1–N8), with the corrections recorded in "Spec corrections" below. Executors read both.

## Global Constraints

- **Schema-free.** No new columns or tables. N8 uses the existing unwired `plants.setup_policy_config` JSONB (`schema.sql:268`).
- **Never-4xx save contract.** `/tasks/update`, `/tasks/bulk_update` report everything (stale, errors, conflicts) in a 200 body. `response_model` silently drops undeclared keys: any new response field goes into `backend/scheduling/models.py` AND both route dict literals.
- **Never-freeze (2026-08-18).** Missing setup data never freezes a line. N8's `excludeFromSearch` queues the order into `needs_planning`; it never blocks its line.
- **i18n.** Every new or changed user-visible string goes through `Util.t()` / `t()` with keys in all five files `frontend/locales/{en,de,es,fr,pt}.js`. Pre-existing hardcoded neighbors are out of scope unless the task says otherwise.
- **Preview outcome regex.** `optimize-ui.mts:1104` stamps any reason whose code or message contains `unavailable|unknown|uncovered|infeasible|missing|disabled|fail` as "rejected". New explanation codes/messages for admitted orders must avoid those tokens.
- **Worker parity.** `nimbus-compute-core.js` runs in the worker and the sync fallback; alert rules live there only. Type unions in `nimbus-compute-core.d.ts` and `frontend/platform/types.mts` are hand-synced.
- **Build/test discipline.** `npm run build` after any `.mts` edit before running node tests. Run scoped test files, not full sweeps (`node --test <file>`, `python -m pytest <file> -q`). Postgres-gated pytest cases are `@pytest.mark.pg` and skip in this environment; DB-free tests must actually run.
- **Legacy surface.** `npm run check:legacy-surface` pins inline `onclick` handlers; new UI actions use delegated `data-*` attributes.
- **Branching.** Fork a feature branch from `main` tip (`git checkout -b feature/review-0901-now main`). One commit per task; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Spec corrections (verified 2026-09-11 against the working tree)

| Spec said | Actually | Effect on plan |
|---|---|---|
| N1: "extend the existing intelligence tests under `tests/js/`" | No test anywhere exercises `Diff`; `tests/js/` has only compute-core and timezone tests. The only intelligence test is `tests/modules/insights/confidence-lifecycle.test.mjs` (VM harness). | N1 adds one new file `tests/modules/insights/diff.test.mjs` using that harness. |
| N2: "require `require_api_key` for `force:true`" as an alternative | Owner chose: strip `force` entirely on `bulk_update`. No in-repo caller uses `bulk_update` at all. | N2 strips; no auth surface added. |
| N3: "index use on `(machine, scheduled_start)` should already exist" | The index is `idx_orders_machine_eff_start ON orders(machine, COALESCE(scheduled_start, basic_start_date))`. No end-date index exists. | Conflict query predicate uses that exact COALESCE expression; ends compared in Python. |
| N4: "add i18n strings for the alert title/description" | Alert `msg` is an English sentence built inside the worker-side core; no rule is localized. | New rule emits `msg` (fallback) plus `msgKey`/`msgVars`; drawer renders the key when present. |
| N5: "Optimize dialog hint text that `due-date` mode ranks lateness ahead of tiers, other modes the reverse" | There is no `combined` mode. Modes are `spt/changeover/duedate/backlog`; hints are `tip.<mode>_mode` in locales. | Reword `tip.duedate_mode` and `tip.changeover_mode` in five locales. |
| N6: codes `admitted-unknown-state` / `admitted-uncovered-row`, keep `admitted-without-setup` as alias | Both proposed codes contain regex-banned tokens and would mis-stamp admitted orders as rejected. Uncovered rows already emit the distinct code `admitted-without-setup` (zero consumers). The unknown-state admission reuses `initial-state-unknown`, which the regex also flags. | Keep `admitted-without-setup`; add `admitted-state-unrecorded` for the unknown-state admission; no alias. Split UI on the already-distinct edge reasons. |
| N7: "Ripple Preview … permanently disabled" | It is live; the only trigger is Alt+hover on a Gantt bar. It ghost-highlights the next five same-line orders; it computes no shifted positions. | Owner chose: keep it, add a discoverability hint, correct both docs. |
| N7: `docs/SAP_APO_Opportunities.md` "notes that reason codes shipped, `needs_planning` queue exists" | That doc (2026-08-22) predates `needs_planning`; zero mentions. The Orders grid already has a `needs_planning` status chip filter and three planning columns, all hardcoded English. | N7 localizes them and makes the queued KPI tile jump to the filtered grid. |
| N8: dropdown "in the plant's setup admin page" | Repo precedent (`frontend/setup/CLAUDE.md` last gotcha, D2) puts plant-level setup flags in the master-data Scheduling Rules pane (`admin-ui.mts`). | Dropdown + minutes input land in `admin-ui.mts` beside split-order policy. |

## Sequencing

```
N5a (scheduler test baseline capture) ──► N6a ──► N6b ──► N8a ──► N8b ──► N8c ──► N5b ──► N5c ──► N5d
N2a ──► N2b
N3a ──► N3b
N1a ──► N1b ──► N1c
N4a ──► N4b
N7a, N7b, N7c (N7c's doc edit records that the before/after table waits on N1 + N3 usage)
```

Recommended order for a single executor: **N2 → N3 → N1 → N4 → N7 → N5a → N6 → N8 → N5b/c/d.** N2/N3 share backend files and go first. Every task that edits `setup-scheduler.mts` diffs its `node --test` failure list against the N5a capture; N5a must run before the first such edit (N6a). Comparator changes (N5b/N5c) go last because they can reorder golden outputs.

**Plan file location.** On approval, copy this file to `docs/superpowers/plans/2026-09-11-code-review-0901-now-items.md` and check the boxes there as tasks land.

**Task sizing for delegation.** Sonnet: N3a, N4a, N5b, N5c, N6b, N8b. Haiku: N2a, N2b, N3b, N1a, N1b, N1c, N4b, N7a, N7b, N7c, N5d, N6a, N8a, N8c (pinned spec, small diffs).

---

## Backend save path — N2, N3

**Findings that shaped these tasks.** `update_task_dates_bulk` only accepts `PRT_01/PRT_02/PRODUCTION_VERSION` attributes, so a save never moves an order to another machine: the touched machine is always the row's current `o.machine`. `persistence.mts` must never import `insights/services.mjs` (its header rule), so conflicts reach Alerts via a new Store event. The frontend `BulkUpdateResult` type is OpenAPI-generated (`frontend/types/api-generated.d.mts`); regenerate, don't hand-edit. Widening the `FOR UPDATE` row tuple to 8 columns breaks two existing fake-cursor tests, which the task updates. The only usable index is start-based, so an order starting more than a day before the touched window and running into it is missed; accepted pilot risk.

### Task N2a: Strip `force` from the external alias, log forced writes, fix stale docs

**Files:**
- Modify: `backend/scheduling/routes.py:487-497` (`bulk_update`), `:354-366` (`_apply_task_date_updates` item loop)
- Modify: `backend/scheduling/models.py:181-188` (`TaskDateUpdate` docstring)
- Modify: `backend/scheduling/CLAUDE.md` (line 37 invariant bullet; "Tests" section last bullet)
- Test: `tests/test_task_response_models.py` (append)

**Interfaces:**
- Consumes: `_apply_task_date_updates(items, allowed_plants=None, *, atomic_optimizer=False) -> dict` (unchanged); `_log_event(level, category, msg, **ctx)` from `backend.admin_ops.logbuffer` (request id auto-attached).
- Produces: `POST /tasks/bulk_update` never forwards `force=True`. `_apply_task_date_updates` emits one `warn` `_log_event` with `event="forced_write"` whenever a non-atomic batch contains forced items.

- [ ] **Step 1: Write the two failing tests** (append to `tests/test_task_response_models.py`)

```python
from backend.scheduling import routes as scheduling_routes


def test_bulk_update_alias_strips_a_caller_supplied_force_flag(monkeypatch):
    """N2: the flat-list alias is the one route where an external caller could
    send force:true and overwrite another planner's edit. It must reach the db
    layer as force=False regardless of the payload."""
    captured = {}

    def fake_update(items, allowed_plants=None):
        captured["items"] = items
        return {"applied": 1, "persisted": 1, "failed": 0, "invalid": 0,
                "not_found": 0, "invalid_ids": [], "not_found_ids": [],
                "stale": [], "versions": {"abc123": 43}}

    monkeypatch.setattr(brain.db, "update_task_dates_bulk", fake_update)
    result = scheduling_routes.bulk_update(
        [brain.TaskDateUpdate(id="abc123", start_date="2026-08-01T07:00:00",
                              end_date="2026-08-01T15:00:00", base_version=42, force=True)],
        allowed_plants=None,
    )

    assert result["persisted"] == 1
    assert captured["items"][0]["force"] is False


def test_apply_task_date_updates_logs_a_forced_non_atomic_write(monkeypatch):
    """Every force=True write NOT under atomic_optimizer leaves an auditable
    warn line in the _BACKEND_LOG ring buffer."""
    events = []
    monkeypatch.setattr(scheduling_routes, "_log_event",
                        lambda level, category, msg, **ctx: events.append((level, category, msg, ctx)))
    monkeypatch.setattr(brain.db, "update_task_dates_bulk",
                        lambda items, allowed_plants=None: {
                            "applied": 1, "persisted": 1, "failed": 0, "invalid": 0,
                            "not_found": 0, "invalid_ids": [], "not_found_ids": [],
                            "stale": [], "versions": {"abc123": 43}})

    scheduling_routes._apply_task_date_updates([
        brain.TaskDateUpdate(id="abc123", start_date="2026-08-01T07:00:00",
                             end_date="2026-08-01T15:00:00", base_version=42, force=True),
    ])

    forced = [e for e in events if e[3].get("event") == "forced_write"]
    assert len(forced) == 1
    assert forced[0][0] == "warn"
    assert forced[0][3]["count"] == 1
    assert forced[0][3]["ids"] == ["abc123"]
```

- [ ] **Step 2: Run to confirm they fail**

```powershell
$env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python -m pytest tests/test_task_response_models.py -q -k "force"
```
Expected: 2 failed.

- [ ] **Step 3: Strip `force` in the alias route** (`routes.py:491-497`, replace the docstring and first line of the body)

```python
    """
    Alias for /tasks/update with a flat list payload (used by external tooling/Postman).
    Payload: [{ id, start_date?, end_date?, base_version? }]
    Response: { status, updated, persisted, failed, invalid, not_found,
                invalid_ids, not_found_ids, stale, versions }

    `force` is accepted for wire compatibility but ignored (N2, 2026-09): an
    external caller may not bypass the base_version check. A stale row is
    reported in `stale`, never overwritten.
    """
    stripped = [it.model_copy(update={"force": False}) if it.force else it for it in tasks]
    res = _apply_task_date_updates(stripped, allowed_plants=allowed_plants)
```

- [ ] **Step 4: Log forced non-atomic writes** (in `_apply_task_date_updates`, immediately before `if atomic_optimizer and invalid:` at `:366`)

```python
    forced_ids = [it["id"] for it in norm if it.get("force")]
    if forced_ids and not atomic_optimizer:
        # Auditable trail for every last-write-wins write (the client's
        # Config.CONCURRENCY_CHECK=false path). rid is attached by _log_event.
        _log_event("warn", "db", "Forced task write bypasses the base_version check",
                   event="forced_write", count=len(forced_ids), ids=forced_ids[:20])
```

Rewrite the docstring sentence at `:283-285`:

```
    counted as `invalid`; unknown ids are counted as `not_found`. Edits whose
    `base_version` no longer matches the row (a concurrent write landed first) are
    rejected and reported in `stale` unless `force` is set — which only the
    /tasks/update path can do (client CONCURRENCY_CHECK=false, non-atomic), and
    which is logged as a warn `forced_write` event. /tasks/bulk_update strips it.
```

- [ ] **Step 5: Fix the stale docs**

`backend/scheduling/models.py:184-187`, replace the concurrency paragraph:

```
    Optimistic concurrency: `base_version` is the xmin the client last saw for this
    row. The write is rejected (reported as `stale`) if the row's current xmin differs,
    unless `force` is set. The optimizer does NOT use `force` — it sends
    `atomic_optimizer: true` on /tasks/update, under which `force` is ignored and any
    stale row rolls back the whole batch. `force` is honored only by /tasks/update in
    non-atomic mode (the client's Config.CONCURRENCY_CHECK=false escape hatch) and is
    stripped by /tasks/bulk_update.
```

`backend/scheduling/CLAUDE.md` line 37, replace the bullet:

```
- **A version conflict is never a 4xx.** Under `SELECT … FOR UPDATE`, a `base_version` mismatch reports the id in a `stale` list inside a 200 response (see `TaskUpdateResult`/`BulkUpdateResult`), never an HTTP error. `force=True` bypasses the check only on `/tasks/update` in non-atomic mode (the client sends it when `Config.CONCURRENCY_CHECK` is false) and is logged as a warn `forced_write` event. The optimizer never uses `force` — it uses `atomic_optimizer`, under which `force` is ignored. `/tasks/bulk_update` strips `force` from every item.
```

Same file, "Tests" section, replace the last bullet:

```
- `tests/test_planning_exceptions.py` and `tests/test_task_response_models.py` import `backend.scheduling.models`/`backend.scheduling.routes` directly; older files go through `brain` (back-compat re-exports) or a live `TestClient`.
```

- [ ] **Step 6: Run the scoped tests**

```powershell
$env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python -m pytest tests/test_task_response_models.py tests/test_planning_exceptions.py tests/test_to_pydt.py -q
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add backend/scheduling/routes.py backend/scheduling/models.py backend/scheduling/CLAUDE.md tests/test_task_response_models.py
git commit -m "fix(scheduling): strip force on /tasks/bulk_update and log forced writes (N2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N2b: Visible banner when the client runs last-write-wins

**Files:**
- Modify: `frontend/app.js:445-447` (inside `_bootMain`, after `SessionUIAdapter._applyGates();`)
- Modify: `frontend/index.html:2944` (sibling div after `#sandbox-banner`)
- Modify: `frontend/styles.css:2450-2473` (rules after the sandbox-banner block)
- Modify: `frontend/locales/{en,de,es,fr,pt}.js` (one key each, near `'ui.what_if_title'`, `en.js:711`)

**Interfaces:**
- Consumes: `Config.CONCURRENCY_CHECK` (`foundation.mts:143`), `ErrorLog.warn(scope, msg)`, `Util.t(key)` — all already destructured in `app.js:273`.
- Produces: `#concurrency-banner` element, body class `concurrency-off`, locale key `ui.concurrency_off_banner`.

- [ ] **Step 1: Add the banner slot** (`frontend/index.html`, after line 2944)

```html
<!-- Last-write-wins warning (shown by app.js _bootMain when Config.CONCURRENCY_CHECK is false) -->
<div id="concurrency-banner" hidden></div>
```

- [ ] **Step 2: Style it** (`frontend/styles.css`, after line 2473)

```css
/* Concurrency-guard-off banner — same band as #sandbox-banner (z 450) */
#concurrency-banner {
  position: fixed;
  top: var(--chrome-h); left: 0; right: 0;
  z-index: 451;
  background: var(--warn-soft);
  border-bottom: 1px solid var(--warn);
  padding: 6px 16px;
  font-size: 12.5px; font-weight: 500;
  color: var(--warn);
}
#concurrency-banner[hidden] { display: none; }
.concurrency-off .tab-panel,
.concurrency-off .alert-drawer { margin-top: 34px; }
```

- [ ] **Step 3: Show it at boot** (`frontend/app.js`, after `SessionUIAdapter._applyGates();` at line 446)

```js
    // N2: Config.CONCURRENCY_CHECK=false makes every manual save force:true
    // (last-write-wins). Documented escape hatch, but nobody should run the
    // pilot in that mode without seeing it. Logged once per boot + a
    // persistent banner (same chrome band as the What-If sandbox banner).
    if (Config.CONCURRENCY_CHECK === false) {
      ErrorLog.warn('concurrency', 'Config.CONCURRENCY_CHECK is false — task saves run last-write-wins');
      const _ccBanner = document.getElementById('concurrency-banner');
      if (_ccBanner) {
        _ccBanner.textContent = Util.t('ui.concurrency_off_banner');
        _ccBanner.hidden = false;
        document.body.classList.add('concurrency-off');
      }
    }
```

- [ ] **Step 4: Locale keys** (all five files, next to `'ui.what_if_title'`)

```js
// en.js
  'ui.concurrency_off_banner': '⚠ Concurrency guard is OFF — saves overwrite other planners\' edits without warning (Config.CONCURRENCY_CHECK)',
// de.js
  'ui.concurrency_off_banner': '⚠ Gleichzeitigkeitsschutz AUS — Speichern überschreibt Änderungen anderer Planer ohne Warnung (Config.CONCURRENCY_CHECK)',
// es.js
  'ui.concurrency_off_banner': '⚠ Protección de concurrencia DESACTIVADA — guardar sobrescribe cambios de otros planificadores sin aviso (Config.CONCURRENCY_CHECK)',
// fr.js
  'ui.concurrency_off_banner': '⚠ Protection de concurrence DÉSACTIVÉE — l\'enregistrement écrase les modifications des autres planificateurs sans avertissement (Config.CONCURRENCY_CHECK)',
// pt.js
  'ui.concurrency_off_banner': '⚠ Proteção de concorrência DESLIGADA — salvar sobrescreve alterações de outros planejadores sem aviso (Config.CONCURRENCY_CHECK)',
```

- [ ] **Step 5: Lint, legacy-surface pin, manual check**

```bash
npm run lint && npm run check:legacy-surface && node --test tests/modules/locale-completeness.test.mjs
```
Expected: clean. Manual: set `CONCURRENCY_CHECK: false` in `foundation.mts:143`, `npm run build`, load the app, confirm banner + ErrorLog badge; revert and rebuild.

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js frontend/index.html frontend/styles.css frontend/locales/
git commit -m "feat(shell): banner + ErrorLog warn when CONCURRENCY_CHECK is off (N2)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N3a: Detect same-machine overlaps inside the save transaction

**Files:**
- Modify: `db.py:888-889` (signature), `:929-953` (FOR UPDATE SELECT), `:1064-1077` (update_rows), `:1142-1151` (commit → scan → return); two new helpers `_detect_interval_conflicts`, `_scan_conflicts_for_rows` directly above `update_task_dates_bulk`
- Modify: `backend/scheduling/models.py:107-134` (`ScheduleConflict`, `conflicts` fields), `:203-209` (`strict_conflicts`)
- Modify: `backend/scheduling/routes.py:274-275`, `:366-395` (kwargs + empty `conflicts` in early returns), `:415-416`, `:458-459`, `:469-484`, `:505-520` (pass-through)
- Regenerate: `frontend/types/api-generated.d.mts` via `npm run generate:api-types`
- Test: `tests/test_task_response_models.py` (update two 7-tuples → 8-tuples; add pure + fake-cursor tests); `tests/test_task_concurrency.py` (one `@pytest.mark.pg` case)

**Interfaces:**
- Produces: `db._detect_interval_conflicts(intervals: list[tuple[str, str, datetime, datetime]], touched: set[str]) -> list[dict]`; tuples are `(machine, order_id, start, end)`; results `{"machine", "order_a", "order_b", "overlap_minutes"}` with `order_a < order_b`.
- Produces: `update_task_dates_bulk(..., *, atomic_optimizer=False, strict_conflicts=False)`; result dict gains `"conflicts": list[dict]`; strict rollback returns `{"status": "error", "error_code": "schedule.conflicts", "cause": ..., "conflicts": [...]}`.
- Produces: Pydantic `ScheduleConflict(machine: str, order_a: str, order_b: str, overlap_minutes: float)`; `BulkUpdateResult.conflicts` and `TaskUpdateResult.conflicts` default `[]`; `TasksUpdatePayload.strict_conflicts: bool = False`.

- [ ] **Step 1: Write the failing pure-logic test** (append to `tests/test_task_response_models.py`; `datetime` import needed)

```python
def test_detect_interval_conflicts_reports_strict_overlaps_only():
    """N3: same-instant touching is not a conflict (SAP midnight snaps are
    intentional), segments of one order never conflict with each other, pairs
    on different machines never conflict, and only pairs involving a touched
    order are reported."""
    t = lambda h, m=0: datetime(2026, 8, 17, h, m)
    intervals = [
        ("L1", "a", t(8), t(10)),
        ("L1", "b", t(9), t(11)),          # overlaps a by 60 min
        ("L1", "c", t(11), t(12)),         # touches b, no conflict
        ("L1", "d", t(8, 30), t(9)),       # segment 1 of d
        ("L1", "d", t(9, 30), t(9, 45)),   # segment 2 of d
        ("L2", "e", t(8), t(10)),          # other machine
        ("L1", "f", t(13), t(14)), ("L1", "g", t(13, 30), t(14)),  # untouched pair
    ]
    out = brain.db._detect_interval_conflicts(intervals, touched={"a", "d"})
    keyed = {(c["order_a"], c["order_b"]): c for c in out}
    assert ("a", "b") in keyed and keyed[("a", "b")]["overlap_minutes"] == 60
    assert keyed[("a", "b")]["machine"] == "L1"
    assert ("a", "d") in keyed and keyed[("a", "d")]["overlap_minutes"] == 45  # 30 + 15
    assert ("b", "d") in keyed
    assert ("b", "c") not in keyed
    assert ("f", "g") not in keyed
    assert all("e" not in k for k in keyed)
```

- [ ] **Step 2: Run to confirm it fails**

```powershell
$env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python -m pytest tests/test_task_response_models.py -q -k "detect_interval"
```
Expected: FAIL, `AttributeError: module 'db' has no attribute '_detect_interval_conflicts'`.

- [ ] **Step 3: Add the pure helper to `db.py`** (directly above `def update_task_dates_bulk`)

```python
def _detect_interval_conflicts(intervals: list[tuple], touched: set[str]) -> list[dict]:
    """Pairwise strict overlaps (`start < other_end`, never `<=`) between orders on
    the same machine. `intervals` are (machine, order_id, start, end); an order with
    child segments contributes one tuple per segment. Same-order pairs are skipped;
    overlap minutes are summed per (machine, pair). Only pairs where at least one
    order is in `touched` (ids this save wrote) are reported, so pre-existing
    overlaps between untouched orders don't show up as consequences of this save.
    """
    by_machine: dict[str, list[tuple]] = {}
    for machine, oid, start, end in intervals:
        if not machine or start is None or end is None or end <= start:
            continue
        by_machine.setdefault(machine, []).append((start, end, oid))
    totals: dict[tuple, float] = {}
    for machine, rows in by_machine.items():
        rows.sort(key=lambda r: (r[0], r[1], r[2]))
        active: list[tuple] = []          # (end, oid) still open at the current start
        for start, end, oid in rows:
            active = [(e, o) for e, o in active if e > start]
            for e, o in active:
                if o == oid:
                    continue
                overlap = (min(e, end) - start).total_seconds() / 60.0
                if overlap <= 0:
                    continue
                a, b = sorted((o, oid))
                if a not in touched and b not in touched:
                    continue
                totals[(machine, a, b)] = totals.get((machine, a, b), 0.0) + overlap
            active.append((end, oid))
    return [{"machine": m, "order_a": a, "order_b": b, "overlap_minutes": round(v, 1)}
            for (m, a, b), v in sorted(totals.items())]
```

- [ ] **Step 4: Run the pure test** — same command as Step 2. Expected: PASS.

- [ ] **Step 5: Fetch `o.machine` under the lock**

`db.py:932-938`: add `o.machine` after `o.plant` in the SELECT list. `db.py:947-953`:

```python
        eff = {
            r[0]: {
                "start": r[1], "end": r[2], "run_time": r[3],
                "row_version": r[4], "segment_count": int(r[5] or 0), "plant": r[6],
                "machine": r[7],
            }
            for r in cur.fetchall()
        }
```

Update the two existing fake-cursor tests (`tests/test_task_response_models.py:257`, `:277`) to 8-tuples:

```python
    eff_rows = [("seg-default", None, None, 1.0, 100, 0, "PLANT-A", "L1")]
    ...
    eff_rows = [("seg-override", None, None, 1.0, 100, 0, "PLANT-B", "L1")]
```

- [ ] **Step 6: Signature flag, pre-commit scan, strict rollback**

`db.py:888-889`:

```python
def update_task_dates_bulk(items: list[dict], allowed_plants: list[str] | None = None,
                           *, atomic_optimizer: bool = False,
                           strict_conflicts: bool = False) -> dict:
```

Docstring addition (after the concurrency paragraph):

```
    Schedule conflicts (N3, 2026-09): before commit, every machine touched by a
    date/segment write is scanned for same-machine strict overlaps within
    [min new start - 1 day, max new end + 1 day] (start-indexed via
    idx_orders_machine_eff_start; queued rows excluded). Pairs involving at least
    one written id are returned in `conflicts` — advisory by default (commit and
    report). `strict_conflicts=True` is honored only together with
    `atomic_optimizer`: a non-empty scan rolls the batch back and returns
    status 'error' / error_code 'schedule.conflicts'.
```

On each `update_rows` entry (`db.py:1064-1077`) add two keys:

```python
                "machine": current["machine"],
                "moved": has_segments or start is not None or end is not None or has_planning,
```

Initialize `conflicts: list[dict] = []` beside `versions` (`:922`); add `"conflicts": []` to the early-return dicts at `:924-926` and `:1081-1084`. Replace `conn.commit()` at `:1142`:

```python
                conflicts = _scan_conflicts_for_rows(cur, update_rows, eff)
                if strict_conflicts and atomic_optimizer and conflicts:
                    conn.rollback()
                    return {"applied": 0, "persisted": 0, "failed": len(update_rows),
                            "invalid": len(invalid_ids), "not_found": len(not_found_ids),
                            "invalid_ids": invalid_ids, "not_found_ids": not_found_ids,
                            "stale": stale, "versions": {}, "conflicts": conflicts,
                            "status": "error", "error_code": "schedule.conflicts",
                            "cause": f"{len(conflicts)} schedule conflict(s) on the written machines (strict mode)"}
                conn.commit()
```

Add `"conflicts": conflicts` to the final return (`:1148-1151`). Add the scan helper above `update_task_dates_bulk` (below `_detect_interval_conflicts`; `datetime`/`timedelta` already imported at `db.py:17`):

```python
def _scan_conflicts_for_rows(cur, update_rows: list[dict], eff: dict) -> list[dict]:
    """Runs inside the still-open save transaction so the scan sees this batch's
    own UPDATEs. Window bounds come from the rows that actually moved."""
    moved = [r for r in update_rows if r["moved"] and not r["queued"] and r["machine"]]
    if not moved:
        return []
    machines = sorted({r["machine"] for r in moved})
    starts = [s for s in (r["start"] or eff[r["id"]]["start"] for r in moved) if s is not None]
    ends = [e for e in (r["end"] or eff[r["id"]]["end"] for r in moved) if e is not None]
    if not starts or not ends:
        return []
    lo = min(starts) - timedelta(days=1)
    hi = max(ends) + timedelta(days=1)
    cur.execute(
        f"""
        SELECT o.machine, o.id,
               COALESCE(seg.schedule_segments, '[]'::jsonb) AS segments,
               COALESCE(o.scheduled_start, o.basic_start_date) AS eff_start,
               {_EFF_END_SQL} AS eff_end
        FROM orders o
        {_SCHEDULE_SEGMENTS_LATERAL_SQL}
        WHERE o.machine = ANY(%s)
          AND o.planning_status <> 'needs_planning'
          AND COALESCE(o.scheduled_start, o.basic_start_date) BETWEEN %s AND %s
        """,
        (machines, lo, hi),
    )
    intervals: list[tuple] = []
    for machine, oid, segments, eff_start, eff_end in cur.fetchall():
        if segments:
            for seg in segments:
                intervals.append((machine, oid,
                                  datetime.fromisoformat(str(seg["start_date"])),
                                  datetime.fromisoformat(str(seg["end_date"]))))
        else:
            intervals.append((machine, oid, eff_start, eff_end))
    return _detect_interval_conflicts(intervals, touched={r["id"] for r in moved})
```

> Verified 2026-09-11: `_SCHEDULE_SEGMENTS_LATERAL_SQL` (`db.py:212-213`) emits segment objects keyed `start_date` / `end_date`, matching the loop above.

- [ ] **Step 7: Fake-cursor tests for the wired scan** (append to `tests/test_task_response_models.py`; adapt the dispatch to how `_FakeSegmentCursor` at `:175-210` actually stores pending results)

```python
class _FakeConflictCursor(_FakeSegmentCursor):
    """Adds the N3 conflict-scan SELECT (dispatched on 'o.machine = ANY(%s)')."""

    def __init__(self, eff_rows, plant_rows, conflict_rows):
        super().__init__(eff_rows, plant_rows)
        self.conflict_rows = conflict_rows

    def execute(self, statement, params=None):
        sql = str(statement)
        if "o.machine = ANY(%s)" in sql:
            self.executed.append((sql, params))
            self._pending = ("all", list(self.conflict_rows))   # same tuple shape _FakeSegmentCursor uses (:187-199)
            return
        super().execute(statement, params)


def test_update_task_dates_bulk_returns_advisory_conflicts_and_still_commits(monkeypatch):
    t = lambda h: datetime(2026, 8, 17, h, 0)
    eff_rows = [("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
    conflict_rows = [("L1", "mv-a", [], t(8), t(10)), ("L1", "mv-b", [], t(9), t(11))]
    cursor = _FakeConflictCursor(eff_rows, plant_rows=[], conflict_rows=conflict_rows)
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))

    result = brain.db.update_task_dates_bulk([{"id": "mv-a", "start": t(8), "end": t(10)}])

    assert result["persisted"] == 1
    assert result["conflicts"] == [{"machine": "L1", "order_a": "mv-a", "order_b": "mv-b", "overlap_minutes": 60}]
    scan = next(p for s, p in cursor.executed if "o.machine = ANY(%s)" in s)
    assert scan[0] == ["L1"]


def test_update_task_dates_bulk_strict_conflicts_rolls_back_only_with_atomic_optimizer(monkeypatch):
    t = lambda h: datetime(2026, 8, 17, h, 0)
    eff_rows = [("mv-a", t(6), t(8), 2.0, 100, 0, "PLANT-A", "L1")]
    conflict_rows = [("L1", "mv-a", [], t(8), t(10)), ("L1", "mv-b", [], t(9), t(11))]
    item = {"id": "mv-a", "start": t(8), "end": t(10), "base_version": 100}

    cursor = _FakeConflictCursor(eff_rows, plant_rows=[], conflict_rows=conflict_rows)
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))
    strict = brain.db.update_task_dates_bulk([item], atomic_optimizer=True, strict_conflicts=True)
    assert strict["status"] == "error"
    assert strict["error_code"] == "schedule.conflicts"
    assert strict["persisted"] == 0 and strict["versions"] == {}
    assert len(strict["conflicts"]) == 1

    cursor = _FakeConflictCursor(eff_rows, plant_rows=[], conflict_rows=conflict_rows)
    monkeypatch.setattr(brain.db, "_pool", _FakeSegmentPool(cursor))
    manual = brain.db.update_task_dates_bulk([item], strict_conflicts=True)  # no atomic flag → advisory
    assert manual["persisted"] == 1
    assert len(manual["conflicts"]) == 1
```

Run with `-k "conflicts"`. Expected: PASS after Steps 5–6.

- [ ] **Step 8: Response models and route pass-through**

`backend/scheduling/models.py`, above `TaskUpdateResult`:

```python
class ScheduleConflict(BaseModel):
    """One same-machine strict overlap detected inside the save transaction (N3).
    order_a < order_b lexicographically; overlap_minutes is summed across segments."""
    machine: str
    order_a: str
    order_b: str
    overlap_minutes: float
```

Add `conflicts: list[ScheduleConflict] = Field(default_factory=list)` to `TaskUpdateResult` (after `versions`) and `BulkUpdateResult` (after `versions`, before `error_code`). `TasksUpdatePayload`:

```python
    tasks: list[TaskDateUpdate] = []
    atomic_optimizer: bool = False
    # N3: roll back when the written machines end up with overlaps. Honored only
    # together with atomic_optimizer; manual saves are never blocked.
    strict_conflicts: bool = False
```

`backend/scheduling/routes.py`:
- `_apply_task_date_updates`: add `strict_conflicts: bool = False` keyword; the db call at `:377-378` becomes

```python
        res = db.update_task_dates_bulk(
            norm, allowed_plants=allowed_plants,
            **({"atomic_optimizer": True} if atomic_optimizer else {}),
            **({"strict_conflicts": True} if (atomic_optimizer and strict_conflicts) else {}))
```
- Add `"conflicts": []` to the exception-path dict (`:387-392`) and the early returns (`:367-369`, `:372-374`).
- `tasks_update` (`:458-459`): pass `atomic_optimizer=payload.atomic_optimizer, strict_conflicts=payload.strict_conflicts`. After the partial-persist warn:

```python
    conflicts = res.get("conflicts", [])
    if conflicts:
        _log_event("info", "db", "Bulk update produced schedule conflicts",
                   event="schedule_conflicts", count=len(conflicts),
                   machines=sorted({c["machine"] for c in conflicts}),
                   strict=bool(payload.strict_conflicts and payload.atomic_optimizer))
```
  and `"conflicts": conflicts,` in the `out` dict. Same in `bulk_update` (`res.get("conflicts", [])`, same info log minus `strict`). `update_task` (`:415-416`): add `"conflicts": res.get("conflicts", [])`.

- [ ] **Step 9: Regenerate OpenAPI types; run the Python slice**

```powershell
$env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python -m pytest tests/test_task_response_models.py tests/test_planning_exceptions.py -q
npm run generate:api-types
git diff --stat frontend/types/api-generated.d.mts
```
Expected: tests pass; diff shows `ScheduleConflict`, `conflicts` on both result schemas, `strict_conflicts` on `TasksUpdatePayload`.

- [ ] **Step 10: Postgres-gated end-to-end case** (append to `TestUpdateTaskDatesBulkXminConflict` in `tests/test_task_concurrency.py`; extend `_seed` with a second order `self.oid2 = db_.make_id(self.ORDER + "_B", self.MATERIAL)` on the same `MACHINE`, `basic_start_date = self.start + 6h`, `basic_finish_date = self.start + 10h`, deleted in teardown)

```python
    def test_saving_into_an_occupied_slot_reports_the_conflict_and_strict_atomic_rolls_back(self, pg):
        db_ = pg
        base = self._current_version(db_)
        new_start = self.start + dt.timedelta(hours=7)   # inside oid2's 6h-10h window
        new_end = new_start + dt.timedelta(hours=2)

        advisory = db_.update_task_dates_bulk([
            {"id": self.oid, "start": new_start, "end": new_end, "base_version": base},
        ])
        assert advisory["persisted"] == 1
        assert [(c["order_a"], c["order_b"]) for c in advisory["conflicts"]] == [tuple(sorted((self.oid, self.oid2)))]
        assert advisory["conflicts"][0]["overlap_minutes"] == 120

        base = self._current_version(db_)
        strict = db_.update_task_dates_bulk([
            {"id": self.oid, "start": new_start + dt.timedelta(minutes=30), "end": new_end + dt.timedelta(minutes=30),
             "base_version": base},
        ], atomic_optimizer=True, strict_conflicts=True)
        assert strict["status"] == "error" and strict["error_code"] == "schedule.conflicts"
        assert db_.get_task_versions([self.oid])[0]["start_date"] == new_start.strftime("%Y-%m-%dT%H:%M:%S")
```

Runs only with a local Postgres and `NIMBUS_TEST_DB=1`; auto-skipped otherwise. Do not point `.env` at Azure to run it.

- [ ] **Step 11: Commit**

```bash
git add db.py backend/scheduling/models.py backend/scheduling/routes.py frontend/types/api-generated.d.mts tests/test_task_response_models.py tests/test_task_concurrency.py
git commit -m "feat(scheduling): report same-machine conflicts from the save path, opt-in strict rollback (N3)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N3b: Surface save-time conflicts in the client

**Files:**
- Modify: `frontend/platform/types.mts:452` (`StoreEventType` member)
- Modify: `frontend/scheduling/persistence.mts:1358-1363` (atomic error branch), `:1403-1407` (after the stale block)
- Modify: `frontend/insights/services.mts:542-544` (subscriber)
- Modify: `frontend/locales/{en,de,es,fr,pt}.js` (two `toast.` keys next to `'toast.concurrent_edit_conflict'`, `en.js:75`)
- Test: `tests/modules/scheduling/persistence.test.mjs` (append one test)

**Interfaces:**
- Consumes: `result.conflicts` (regenerated type from N3a), `Alerts.scheduleRecomputeLines(lines: Set<string>)`.
- Produces: Store event `{ type: 'schedule:conflicts', lines: string[], source: 'persistence' }`; locale keys `toast.save_conflicts`, `toast.optimizer_conflicts` (both take `{{count}}`).

- [ ] **Step 1: Write the failing test** (append to `tests/modules/scheduling/persistence.test.mjs`; add `import { Toast } from '../../../frontend/platform/foundation.mjs';`; check `Store.subscribe`'s return/unsubscribe mechanism in `store.mts` first)

```js
test('a save response carrying conflicts toasts a count and emits schedule:conflicts for the machines', async () => {
  Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  Store.setTasks([{ id: 'cf-a', MACHINE: 'L1', RUN_TIME: 2, row_version: 3,
    start_date: new Date('2026-09-09T08:00:00'), end_date: new Date('2026-09-09T10:00:00') }], 'unit-test');
  Persistence._dirtyIds.add('cf-a');
  const originalFetch = globalThis.fetch;
  const originalToast = Toast.show;
  const toasts = []; const events = [];
  Toast.show = (msg, type) => { toasts.push({ msg, type }); };
  const unsub = Store.subscribe(evt => { if (evt.type === 'schedule:conflicts') events.push(evt); }, 'test-conflicts');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({
    status: 'ok', updated: 1, persisted: 1, failed: 0, invalid: 0, not_found: 0,
    invalid_ids: [], not_found_ids: [], stale: [], versions: { 'cf-a': 4 },
    conflicts: [{ machine: 'L1', order_a: 'cf-a', order_b: 'cf-b', overlap_minutes: 60 }],
  }) });
  try {
    Persistence.saveAll();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].lines, ['L1']);
    assert.ok(toasts.some(t => t.type === 'warn' && /1/.test(t.msg)), 'a warn toast naming the conflict count');
    assert.equal(Store.tasks['cf-a'].row_version, 4, 'advisory conflicts never block the re-stamp');
  } finally {
    globalThis.fetch = originalFetch; Toast.show = originalToast;
    if (typeof unsub === 'function') unsub();
    Persistence._dirtyIds.clear(); Persistence._forceIds.clear();
  }
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npm run build && node --test tests/modules/scheduling/persistence.test.mjs
```
Expected: new test fails (`events.length` is 0).

- [ ] **Step 3: Add the event type** (`frontend/platform/types.mts:452`)

```ts
  | 'sandbox:reverted' | 'schedule:hydrated' | 'schedule:conflicts' | 'session:changed'
```

- [ ] **Step 4: Handle conflicts in `saveAll`**

Inside the atomic-rejection branch (`persistence.mts:1358-1363`), replace the `Toast.show(...)` line:

```ts
          if (result.error_code === 'schedule.conflicts') {
            Toast.show(Util.t('toast.optimizer_conflicts', { count: (result.conflicts || []).length }), 'warn', 8000);
          } else {
            Toast.show('Optimizer changes remain unsaved. Resolve the conflict or reload and optimize again.', 'warn', 8000);
          }
```

After the `if (stale.length) { ... }` block (`:1403-1407`):

```ts
        // N3: the server scanned the written machines inside the save
        // transaction. Advisory — rows are persisted; surface the overlaps now
        // instead of waiting for the next full alert recompute. Emitted as a
        // Store event because this file must never import insights/services.
        const conflicts = result.conflicts || [];
        if (conflicts.length) {
          const lines = [...new Set(conflicts.map(c => c.machine))];
          ErrorLog.warn('persistence', `Save produced ${conflicts.length} schedule conflict(s)`, conflicts);
          Toast.show(Util.t('toast.save_conflicts', { count: conflicts.length }), 'warn', 7000);
          Store.emit({ type: 'schedule:conflicts', lines, source: 'persistence' });
        }
```

- [ ] **Step 5: Subscribe in services** (`frontend/insights/services.mts:542-544`, replace the existing subscriber body)

```ts
Store.subscribe(evt => {
  if (evt.type === 'schedule:hydrated') Alerts.scheduleRecompute();
  // N3: server-reported save conflicts — scoped recompute for just those lines.
  if (evt.type === 'schedule:conflicts') {
    const lines = (evt as { lines?: string[] }).lines;
    if (lines?.length) Alerts.scheduleRecomputeLines(new Set(lines)); else Alerts.scheduleRecompute();
  }
}, 'insights-services.hydrated');
```

- [ ] **Step 6: Locale keys** (all five files, next to `'toast.concurrent_edit_conflict'`)

```js
// en.js
  'toast.save_conflicts':      '⚠ Saved, but {{count}} order(s) now overlap another order on the same machine — see Alerts',
  'toast.optimizer_conflicts': 'Optimizer changes were not saved: {{count}} machine conflict(s) detected. Re-run the optimizer.',
// de.js
  'toast.save_conflicts':      '⚠ Gespeichert, aber {{count}} Auftrag/Aufträge überlappen nun einen anderen Auftrag auf derselben Maschine — siehe Warnungen',
  'toast.optimizer_conflicts': 'Optimierer-Änderungen nicht gespeichert: {{count}} Maschinenkonflikt(e) erkannt. Optimierer erneut ausführen.',
// es.js
  'toast.save_conflicts':      '⚠ Guardado, pero {{count}} pedido(s) ahora se superponen con otro pedido en la misma máquina — ver Alertas',
  'toast.optimizer_conflicts': 'Los cambios del optimizador no se guardaron: {{count}} conflicto(s) de máquina detectados. Vuelva a ejecutar el optimizador.',
// fr.js
  'toast.save_conflicts':      '⚠ Enregistré, mais {{count}} ordre(s) chevauchent maintenant un autre ordre sur la même machine — voir Alertes',
  'toast.optimizer_conflicts': 'Modifications de l\'optimiseur non enregistrées : {{count}} conflit(s) machine détecté(s). Relancez l\'optimiseur.',
// pt.js
  'toast.save_conflicts':      '⚠ Salvo, mas {{count}} ordem(ns) agora se sobrepõem a outra ordem na mesma máquina — ver Alertas',
  'toast.optimizer_conflicts': 'Alterações do otimizador não foram salvas: {{count}} conflito(s) de máquina detectado(s). Execute o otimizador novamente.',
```

- [ ] **Step 7: Build, test, lint**

```bash
npm run build && node --test tests/modules/scheduling/persistence.test.mjs tests/modules/locale-completeness.test.mjs && npm run typecheck && npm run lint
```
Expected: all pass; `typecheck` confirms `result.conflicts` resolves from the regenerated schema.

- [ ] **Step 8: Commit**

```bash
git add frontend/platform/types.mts frontend/scheduling/persistence.mts frontend/insights/services.mts frontend/locales/ tests/modules/scheduling/persistence.test.mjs
git commit -m "feat(scheduling): toast + scoped alert recompute for server-reported save conflicts (N3)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**N3 risks carried forward.** Start-indexed window misses an order that begins more than a day before the touched range and runs into it. Verify with `EXPLAIN` on a large machine that the scan uses `idx_orders_machine_eff_start`. The frontend never sends `strict_conflicts` yet; it exists for the deferred publication step (X2).

## Intelligence and insights — N1, N4, N7

**Findings that shaped these tasks.** No keyboard-shortcuts help exists anywhere; the only shortcut hints are the Cmd+K palette footer, so Ripple discoverability is a palette entry. The Dashboard has exactly four tiles by design (`insights-ui.mts:407-409`); the queued count is only a hardcoded English suffix on the Orders Today tile. Two sites parse the peer out of the `ovl-a-b` alert id (`services.mts:408`, `insights-ui.mts:1280`); the id format is pinned by `tests/js/compute-core.test.js:80` and stays; `peerId` is additive. `tests/contracts/cq1-legacy-surface.json` pins `Diff._*` and `RipplePreview._*` private names, so new helpers in `nimbus-intelligence.js` are module-scope functions, never new `Diff._x` properties. The tool-conflict scan must use the horizon-filtered but NOT line-filtered pool (`activeTasks` is already narrowed by `opts.lines`), or an incremental recompute for one line never sees the peer on the other.

### Task N1a: Snapshot rows carry normalized `scheduleSegments`

**Files:**
- Modify: `frontend/nimbus-intelligence.js:1270-1287` (`TimeMachine.snapshot`), `:2284-2294` (`runDiff` current side)

**Interfaces:**
- Produces: snapshot task field `scheduleSegments: Array<[startMs, endMs]> | null` (`null` = continuous order; key absent = legacy snapshot).

- [ ] **Step 1: Add a module-scope normalizer above `const TimeMachine = {`** (a bare function, not a `TimeMachine._x` property)

```js
  // Snapshot/diff encoding of a split order: sorted [startMs, endMs] pairs, or
  // null for a continuous (unsplit) order. Snapshots written before this field
  // existed have no key at all; Diff.compute treats "absent" as unknown.
  function snapshotSegments(t) {
    const segs = Array.isArray(t.scheduleSegments) ? t.scheduleSegments : [];
    if (segs.length < 2) return null;
    const ms = v => (v instanceof Date ? v.getTime() : (v ? new Date(v).getTime() : NaN));
    return segs
      .map(s => [ms(s.startDate ?? s.start_date), ms(s.endDate ?? s.end_date)])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .sort((a, b) => a[0] - b[0]);
  }
```

> Executor check: confirm the live segment key names on `NimbusTask.scheduleSegments` in `frontend/platform/types.mts` and keep only the matching accessor.

- [ ] **Step 2: Persist it in `TimeMachine.snapshot`** — after `FIRMED: !!t.firmed,` at `:1285`:

```js
          scheduleSegments: snapshotSegments(t),
```

- [ ] **Step 3: Mirror it on the "current" side in `runDiff`** — after `FIRMED: !!t.firmed,` at `:2293`, the identical line.

- [ ] **Step 4: Lint and surface check**

```bash
npm run lint && npm run check:legacy-surface
```

- [ ] **Step 5: Commit**

```bash
git add frontend/nimbus-intelligence.js
git commit -m "feat(intel): persist normalized scheduleSegments in Time Machine snapshots (N1)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N1b: `Diff.compute` detects finish, machine, and split changes

**Files:**
- Modify: `frontend/nimbus-intelligence.js:2092-2148` (`Diff._enrich`, `Diff.compute`)
- Create: `tests/modules/insights/diff.test.mjs`

**Interfaces:**
- Consumes: snapshot rows from N1a.
- Produces: each `moved` row gains `startDelta`, `endDelta`, `segmentsChanged`, `kinds: Array<'start'|'finish'|'machine'|'split'>`, `oldEnd`, `newEnd`; `delta` kept (= `startDelta`) for the renderer.

- [ ] **Step 1: Write the failing test** at `tests/modules/insights/diff.test.mjs`

```js
// Pure-function tests for the classic-script Diff module. The VM harness runs
// the production nimbus-intelligence.js with the boot gate closed (no
// IndexedDB, no command palette); Diff.compute only needs Store.tasks for a
// live-row enrichment fallback, which is empty here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { loadLegacyApp, ROOT } from '../helpers/load-legacy-app.mjs';

const { nimbus, context } = await loadLegacyApp();
context.document.readyState = 'loading';
context.document.addEventListener = () => {};
runInContext(readFileSync(`${ROOT}/frontend/nimbus-intelligence.js`, 'utf8'), context);
const Diff = nimbus.Diff;

const H = 3600000;
const T0 = Date.UTC(2026, 8, 14, 8);
const row = (over = {}) => ({
  id: 'o1', start_date: T0, end_date: T0 + 4 * H, MACHINE: 'L1', PRODUCTION_ORDER: 'PO1',
  text: 'Order 1', COLOR: '', FORM_SIZE: '', FIRMED: false, scheduleSegments: null, ...over,
});

test('Diff.compute reports a finish-only change as one moved row of kind finish', () => {
  const d = Diff.compute([row()], [row({ end_date: T0 + 6 * H })]);
  assert.equal(d.moved.length, 1);
  assert.deepEqual(d.moved[0].kinds, ['finish']);
  assert.equal(d.moved[0].startDelta, 0);
  assert.equal(d.moved[0].endDelta, 2 * H);
  assert.equal(d.lineImpact.L1.moved, 1);
});

test('Diff.compute reports a re-segmentation with identical envelope as kind split', () => {
  const a = row({ scheduleSegments: [[T0, T0 + 2 * H], [T0 + 3 * H, T0 + 4 * H]] });
  const b = row({ scheduleSegments: [[T0, T0 + 1 * H], [T0 + 2 * H, T0 + 4 * H]] });
  const d = Diff.compute([a], [b]);
  assert.equal(d.moved.length, 1);
  assert.deepEqual(d.moved[0].kinds, ['split']);
});

test('Diff.compute reports nothing for identical snapshots', () => {
  const d = Diff.compute([row()], [row()]);
  assert.equal(d.moved.length, 0);
  assert.equal(d.added.length, 0);
  assert.equal(d.removed.length, 0);
});

test('Diff.compute treats a legacy snapshot without scheduleSegments as unknown, not split', () => {
  const legacy = row(); delete legacy.scheduleSegments;
  const d = Diff.compute([legacy], [row({ scheduleSegments: [[T0, T0 + 2 * H], [T0 + 2 * H, T0 + 4 * H]] })]);
  assert.equal(d.moved.length, 0);
});

test('Diff.compute keeps start and machine detection unchanged and sorts by the larger delta', () => {
  const d = Diff.compute(
    [row({ id: 'a' }), row({ id: 'b' })],
    [row({ id: 'a', start_date: T0 + 1 * H, end_date: T0 + 5 * H }), row({ id: 'b', MACHINE: 'L2' })],
  );
  const byId = Object.fromEntries(d.moved.map(m => [m.id, m]));
  assert.deepEqual(byId.a.kinds, ['start']);          // pure move: finish shifts with start, not a finish change
  assert.equal(byId.a.delta, 1 * H);
  assert.deepEqual(byId.b.kinds, ['machine']);
  assert.equal(byId.b.lineChanged, true);
  assert.equal(d.lineImpact.L2.moved, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm run build && node --test tests/modules/insights/diff.test.mjs
```
Expected: FAIL — `kinds` undefined; split/finish cases report 0 moved.

- [ ] **Step 3: Carry `scheduleSegments` through `_enrich`** — after `FIRMED:` at `:2103`:

```js
        scheduleSegments: t.scheduleSegments,   // undefined on pre-field snapshots (unknown), null = unsplit
```

- [ ] **Step 4: Replace the body of `compute` from `const moved = [];` through `moved.sort(...)` (`:2114-2131`)**

```js
      const moved   = [];
      const isNum = v => typeof v === 'number' && Number.isFinite(v);
      // undefined on either side = the snapshot predates the field: unknown, never "changed".
      const sameSegments = (a, b) => {
        if (a === undefined || b === undefined) return true;
        if (a === null || b === null) return a === b;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
        return true;
      };
      Object.keys(mapB).forEach(id => {
        if (!mapA[id]) return;
        const A = mapA[id], B = mapB[id];
        const startDelta   = isNum(A.start_date) && isNum(B.start_date) ? B.start_date - A.start_date : 0;
        const endDelta     = isNum(A.end_date)   && isNum(B.end_date)   ? B.end_date   - A.end_date   : 0;
        const startChanged = isNum(A.start_date) && isNum(B.start_date) ? startDelta !== 0 : A.start_date !== B.start_date;
        const endChanged   = isNum(A.end_date)   && isNum(B.end_date)   ? endDelta   !== 0 : A.end_date   !== B.end_date;
        const lineChanged  = A.MACHINE !== B.MACHINE;
        const segmentsChanged = !sameSegments(A.scheduleSegments, B.scheduleSegments);
        const kinds = [];
        if (startChanged) kinds.push('start');
        // A pure move shifts finish by the same amount as start; only a duration or
        // finish-only change earns the 'finish' kind.
        if (endChanged && endDelta !== startDelta) kinds.push('finish');
        if (lineChanged) kinds.push('machine');
        if (segmentsChanged) kinds.push('split');
        if (!kinds.length) return;
        moved.push({
          ...B,
          delta: startDelta,
          startDelta, endDelta, segmentsChanged, kinds,
          lineFrom:    A.MACHINE,
          lineTo:      B.MACHINE,
          lineChanged,
          newStart:    B.start_date,
          oldStart:    A.start_date,
          newEnd:      B.end_date,
          oldEnd:      A.end_date,
        });
      });
      const magnitude = m => Math.max(Math.abs(m.startDelta), Math.abs(m.endDelta));
      moved.sort((a, b) => magnitude(b) - magnitude(a));
```

Leave the `lineImpact` block (`:2133-2142`) and return untouched.

- [ ] **Step 5: Run the test** — `node --test tests/modules/insights/diff.test.mjs`. Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add frontend/nimbus-intelligence.js tests/modules/insights/diff.test.mjs
git commit -m "fix(intel): snapshot diff detects finish-only, machine and split changes (N1)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N1c: Diff renderer shows kind badges and the finish delta

**Files:**
- Modify: `frontend/nimbus-intelligence.js:2169-2188` (`rowMoved` in `_renderResults`), `:259-291` (injected Diff CSS)
- Modify: `frontend/locales/{en,de,es,fr,pt}.js`

**Interfaces:**
- Consumes: `m.kinds`, `m.endDelta`, `m.startDelta` from N1b.

- [ ] **Step 1: Locale keys** in each of the five files, next to `'ui.hint_close'` (`en.js:349`):

| key | en | de | es | fr | pt |
|---|---|---|---|---|---|
| `ui.diff_kind_start` | Start | Start | Inicio | Début | Início |
| `ui.diff_kind_finish` | Finish | Ende | Fin | Fin | Fim |
| `ui.diff_kind_machine` | Machine | Maschine | Máquina | Machine | Máquina |
| `ui.diff_kind_split` | Split | Geteilt | Dividida | Fractionnée | Dividida |
| `ui.diff_finish_delta` | finish {{delta}} | Ende {{delta}} | fin {{delta}} | fin {{delta}} | fim {{delta}} |

- [ ] **Step 2: Badge CSS** after `.ni-diff-stat.removed ...` (`:288`):

```css
.ni-diff-kind { font-size:9.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em;
  padding:1px 5px; border-radius:3px; background:var(--bg-subtle); color:var(--fg-mute); margin-right:4px; }
.ni-diff-kind.finish, .ni-diff-kind.split { background:color-mix(in srgb,var(--warn,#b57a0a) 16%,transparent); color:var(--warn,#b57a0a); }
.ni-diff-finish { font-size:11px; color:var(--fg-mute); margin-left:6px; }
```

- [ ] **Step 3: Extend `rowMoved`** — replace `:2169-2188`:

```js
      const rowMoved = d.moved.map(m => {
        const dir   = m.delta > 0 ? 'later' : 'earlier';
        const arrow = m.delta > 0 ? '▶' : '◀';
        const linePart = m.lineChanged
          ? `<span class="ni-diff-line-chip">${esc(m.lineFrom)}</span><span style="color:var(--fg-mute);margin:0 3px">→</span><span class="ni-diff-line-chip">${esc(m.lineTo)}</span>`
          : `<span class="ni-diff-line-chip">${esc(m.lineTo)}</span>`;
        const wasStr = Diff._fmtShort(m.oldStart);
        const nowStr = Diff._fmtShort(m.newStart);
        const kinds = (m.kinds || []).map(k => `<span class="ni-diff-kind ${k}">${esc(t('ui.diff_kind_' + k))}</span>`).join('');
        const shift = m.startDelta
          ? `<span class="ni-diff-shift ${dir}">${arrow} ${esc(Diff._fmtDelta(m.delta))}</span>` : '';
        const finish = (m.kinds || []).includes('finish') && m.endDelta
          ? `<span class="ni-diff-finish">${esc(t('ui.diff_finish_delta', { delta: Diff._fmtDelta(m.endDelta) }))}</span>` : '';
        return `<div class="ni-diff-row ni-diff-row-moved">
          <div class="ni-diff-row-top">
            <span class="ni-diff-po">${esc(m.PRODUCTION_ORDER)}</span>
            <span class="ni-diff-desc">${esc(m.text)}</span>
            ${shift}${finish}
          </div>
          <div class="ni-diff-row-bottom">
            ${kinds}${linePart}
            <span class="ni-diff-dates">Was: ${esc(wasStr)} → Now: ${esc(nowStr)}</span>
          </div>
        </div>`;
      }).join('');
```

- [ ] **Step 4: Lint, surface, locale gate**

```bash
npm run lint && npm run check:legacy-surface && node --test tests/modules/locale-completeness.test.mjs tests/modules/insights/diff.test.mjs
```

- [ ] **Step 5: Manual check** — Cmd+K → Compare Schedules against a snapshot where one order's run time was edited: row shows a FINISH badge and `finish +2.0h` with no start arrow.

- [ ] **Step 6: Commit**

```bash
git add frontend/nimbus-intelligence.js frontend/locales/*.js
git commit -m "feat(intel): diff rows show change-kind badges and finish delta (N1)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N4a: `tool-conflict` rule in the compute core (+ `peerId` on overlaps)

**Files:**
- Modify: `frontend/nimbus-compute-core.js:362-383` (rule 1) and insert rule 1b after it
- Modify: `frontend/nimbus-compute-core.d.ts:25-55`
- Modify: `frontend/platform/types.mts:421-424`
- Test: `tests/js/compute-core.test.js`

**Interfaces:**
- Produces alert shape additions: `type:'tool-conflict'`, `peerId?: string` (also set on `overlap`), `msgKey?: string`, `msgVars?: Record<string,string>`. Alert id `` `toolc-${prevId}|${curId}` `` (`|` separator because task ids may contain `-`). `taskId` is the later order; `line` is its line.

- [ ] **Step 1: Write the failing tests** — append to `tests/js/compute-core.test.js`

```js
test('computeAlerts raises one tool-conflict for the same PRT_01 on two lines at once', () => {
  const base = Date.now() + 24 * 3600000;
  const a = { id: 'x-1', PRODUCTION_ORDER: 'PO-A', MACHINE: 'L1', RUN_TIME: 2, PRT_01: 'MOLD-7',
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const b = { id: 'y-2', PRODUCTION_ORDER: 'PO-B', MACHINE: 'L2', RUN_TIME: 2, PRT_02: 'MOLD-7',
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [a, b], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  const hits = res.alerts.filter(al => al.type === 'tool-conflict');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'toolc-x-1|y-2');
  assert.equal(hits[0].taskId, 'y-2');
  assert.equal(hits[0].peerId, 'x-1');
  assert.equal(hits[0].line, 'L2');
  assert.equal(hits[0].msgKey, 'alert.tool_conflict');
  assert.equal(hits[0].msgVars.tool, 'MOLD-7');
});

test('computeAlerts does not raise tool-conflict for the same tool on one line (that is a changeover)', () => {
  const base = Date.now() + 24 * 3600000;
  const a = { id: 'a', MACHINE: 'L1', RUN_TIME: 2, PRT_01: 'MOLD-7',
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const b = { id: 'b', MACHINE: 'L1', RUN_TIME: 2, PRT_01: 'MOLD-7',
    start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({
    tasks: [a, b], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  assert.equal(res.alerts.filter(al => al.type === 'tool-conflict').length, 0);
  assert.equal(res.alerts.filter(al => al.type === 'overlap').length, 1);   // still an overlap
});

test('computeAlerts skips blank and placeholder tool ids', () => {
  const base = Date.now() + 24 * 3600000;
  const mk = (id, line, prt) => ({ id, MACHINE: line, RUN_TIME: 2, PRT_01: prt,
    start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) });
  const res = Core.computeAlerts({
    tasks: [mk('a', 'L1', ''), mk('b', 'L2', ''), mk('c', 'L3', '-'), mk('d', 'L4', '-'), mk('e', 'L5', 'n/a'), mk('f', 'L6', 'N/A')],
    blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {},
  });
  assert.equal(res.alerts.filter(al => al.type === 'tool-conflict').length, 0);
});

test('computeAlerts overlap alerts carry peerId (the earlier order)', () => {
  const base = Date.now() + 24 * 3600000;
  const t1 = { id: 'a', MACHINE: 'L', RUN_TIME: 2, start_date: new Date(base + 1 * 3600000), end_date: new Date(base + 3 * 3600000) };
  const t2 = { id: 'b', MACHINE: 'L', RUN_TIME: 2, start_date: new Date(base + 2 * 3600000), end_date: new Date(base + 4 * 3600000) };
  const res = Core.computeAlerts({ tasks: [t1, t2], blocks: [], plantBlocks: [], calendars: {}, plants: {},
    lineSettings: {}, masterData: noPlant, dismissed: [], opts: {} });
  const ovl = res.alerts.find(a => a.type === 'overlap');
  assert.equal(ovl.id, 'ovl-a-b');      // id format is pinned; peerId is additive
  assert.equal(ovl.peerId, 'a');
});
```

- [ ] **Step 2: Run to verify failure** — `node --test tests/js/compute-core.test.js`. Expected: 4 new tests FAIL.

- [ ] **Step 3: Add `peerId` to the overlap emission** at `:375-380`

```js
          alerts.push({
            id:  `ovl-${prev.task.id}-${cur.task.id}`,
            sev: 'err', type: 'overlap',
            msg: `Orders "${orderNumber(prev.task)}" and "${orderNumber(cur.task)}" overlap on ${line}.`,
            taskId: cur.task.id, peerId: prev.task.id, line, time: cur.start
          });
```

- [ ] **Step 4: Insert rule 1b** immediately after rule 1's closing `}` (`:383`), before `/* 2. OVERLOAD / CLOSED */`

```js
    /* 1b. TOOL CONFLICT — one physical tool (PRT_01 / PRT_02 identify a unique tool,
       confirmed with the pilot plant 2026-09-11) scheduled on two DIFFERENT lines at
       the same instant. Same-line adjacency is a changeover, not a conflict.
       The peer pool is horizon-filtered but NOT line-filtered: an incremental
       recompute for L1 must still see the peer on L2. The alert attaches to the
       later order, on its own line, and is emitted only when that line is in scope. */
    const TOOL_PLACEHOLDERS = new Set(['', '-', '0', 'N/A', 'NONE', 'NULL']);
    const toolIds = task => {
      const out = [];
      for (const key of ['PRT_01', 'PRT_02']) {
        const v = String(task?.[key] ?? '').trim();
        if (!TOOL_PLACEHOLDERS.has(v.toUpperCase())) out.push(v);
      }
      return out;
    };
    const byTool = {};
    for (const t of tasks) {
      if (t.end_date && t.end_date < todayStart) continue;
      for (const tool of toolIds(t)) {
        for (const interval of scheduleIntervals(t)) {
          (byTool[tool] ||= []).push({ task: t, start: interval.start, end: interval.end });
        }
      }
    }
    const toolConflictIds = new Set();
    for (const tool of Object.keys(byTool)) {
      const arr = byTool[tool].slice().sort((a, b) => a.start - b.start);
      for (let i = 1; i < arr.length; i++) {
        const cur = arr[i];
        const curLine = cur.task.MACHINE || 'Unknown';
        if (onlyLines && !onlyLines.has(curLine)) continue;
        // Ends are not monotone in start order, so every earlier interval is a candidate.
        for (let j = i - 1; j >= 0; j--) {
          const prev = arr[j];
          if (prev.task.id === cur.task.id) continue;
          if (prev.end <= cur.start) continue;                 // touching is not overlapping
          const prevLine = prev.task.MACHINE || 'Unknown';
          if (prevLine === curLine) continue;                  // rule 1's territory
          const id = `toolc-${prev.task.id}|${cur.task.id}`;
          if (toolConflictIds.has(id)) continue;               // split segments of the same pair
          toolConflictIds.add(id);
          const vars = { tool, a: orderNumber(prev.task), b: orderNumber(cur.task), lineA: prevLine, lineB: curLine };
          alerts.push({
            id, sev: 'err', type: 'tool-conflict',
            msg: `Tool "${tool}" is needed by "${vars.a}" on ${prevLine} and "${vars.b}" on ${curLine} at the same time.`,
            msgKey: 'alert.tool_conflict', msgVars: vars,
            taskId: cur.task.id, peerId: prev.task.id, line: curLine, time: cur.start,
          });
        }
      }
    }
```

- [ ] **Step 5: Run tests** — `node --test tests/js/compute-core.test.js`. Expected: all pass, including the pre-existing `ovl-a-b` dismissal pin.

- [ ] **Step 6: Update the ambient types** in `frontend/nimbus-compute-core.d.ts`

```ts
  interface NimbusAlert {
    id: string;
    sev: 'err' | 'warn';
    type: 'overlap' | 'overload' | 'near-capacity' | 'closed' | 'blackout' | 'firmed-closed' | 'firmed-out-of-hours' | 'runtime-schedule-mismatch'
      | 'tool-conflict'
      | 'setup-violated' | 'setup-uncovered' | 'initial-state-unknown' | 'current-state-diverged' | 'override-inactive'
      | 'predecessor-state-unknown' | 'successor-state-unknown';
    msg: string;
    /** Optional localized form; the drawer prefers Util.t(msgKey, msgVars) when present. */
    msgKey?: string;
    msgVars?: Record<string, string>;
    taskId?: string;
    /** The other order in a pairwise alert (overlap, tool-conflict). Prefer this over parsing `id`. */
    peerId?: string;
    line: string;
    time: Date;
    requiredMinutes?: number;
    availableMinutes?: number;
    shortMinutes?: number;
  }
```
Add to the local `NimbusTask` (`:39-55`): `PRT_01?: string; PRT_02?: string; PRODUCTION_ORDER?: string; ORDER?: string;`.

- [ ] **Step 7: Update `frontend/platform/types.mts:421-424`**

```ts
export type AlertType =
  | 'overlap' | 'overload' | 'near-capacity' | 'closed'
  | 'blackout' | 'firmed-closed' | 'firmed-out-of-hours'
  | 'runtime-schedule-mismatch' | 'tool-conflict'
  | 'setup-violated' | 'setup-uncovered' | 'initial-state-unknown' | 'current-state-diverged'
  | 'override-inactive' | 'predecessor-state-unknown' | 'successor-state-unknown';
```

- [ ] **Step 8: Typecheck and lint** — `npm run typecheck && npm run lint`.

- [ ] **Step 9: Commit**

```bash
git add frontend/nimbus-compute-core.js frontend/nimbus-compute-core.d.ts frontend/platform/types.mts tests/js/compute-core.test.js
git commit -m "feat(alerts): cross-line tool-conflict rule; peerId on pairwise alerts (N4)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N4b: Drawer rendering, cell briefing, and fix affordance for `tool-conflict`

**Files:**
- Modify: `frontend/insights/insights-ui.mts:1416-1425` (`_renderAlertRow`), `:1278-1285` (`showForCell` overlap branch)
- Modify: `frontend/insights/services.mts:398-412` (`applyFix`)
- Modify: `frontend/locales/*.js`

**Interfaces:**
- Consumes: `a.msgKey`, `a.msgVars`, `a.peerId`, `type:'tool-conflict'` from N4a.

- [ ] **Step 1: Locale keys** (all five files, near `'tip.fix_alert'`, `en.js:796`)

| key | en | de | es | fr | pt |
|---|---|---|---|---|---|
| `alert.tool_conflict` | Tool "{{tool}}" is needed by "{{a}}" on {{lineA}} and "{{b}}" on {{lineB}} at the same time. | Werkzeug "{{tool}}" wird gleichzeitig von "{{a}}" auf {{lineA}} und "{{b}}" auf {{lineB}} benötigt. | La herramienta "{{tool}}" la necesitan "{{a}}" en {{lineA}} y "{{b}}" en {{lineB}} al mismo tiempo. | L'outil "{{tool}}" est requis en même temps par "{{a}}" sur {{lineA}} et "{{b}}" sur {{lineB}}. | A ferramenta "{{tool}}" é necessária ao mesmo tempo por "{{a}}" em {{lineA}} e "{{b}}" em {{lineB}}. |
| `ui.alert_headline_tool_conflict` | Shared tool conflict | Werkzeugkonflikt | Conflicto de herramienta compartida | Conflit d'outil partagé | Conflito de ferramenta compartilhada |

- [ ] **Step 2: `_renderAlertRow`** — change `:1421` and `:1425`

```ts
    const fixable  = ['overlap', 'blackout', 'overload', 'tool-conflict'].includes(a.type);
    ...
    const msg = a.msgKey ? Util.t(a.msgKey, a.msgVars ?? {}) : a.msg;
    ...
      `<span class="alert-msg">${Util.escapeHtml(msg)}</span>` +
```

- [ ] **Step 3: `showForCell`** — replace the overlap branch at `:1278-1285`

```ts
      } else if (a.type === 'overlap' || a.type === 'tool-conflict') {
        headline = a.type === 'overlap' ? 'Order overlap' : Util.t('ui.alert_headline_tool_conflict');
        const m = a.id.match(/^ovl-(.+)-(.+)$/);
        const peer = a.peerId ?? (m ? m[1] : null);
        const later = a.taskId ?? (m ? m[2] : null);
        if (peer && later) {
          chipsHtml = `<div class="ac-chips">${renderChip(peer)}<span class="ac-chip-sep">⇄</span>${renderChip(later)}</div>`;
        } else if (a.taskId) {
          chipsHtml = `<div class="ac-chips">${renderChip(a.taskId)}</div>`;
        }
```

- [ ] **Step 4: `applyFix`** — change `:398` and `:405-412`

```ts
    if (a.type === 'overlap' || a.type === 'blackout' || a.type === 'tool-conflict') {
      ...
      // For pairwise alerts: start searching from the end of the peer (earlier) order.
      // Prefer the structured peerId; the id-parse fallback is wrong for ids containing '-'.
      let searchFrom = task.start_date;
      if (a.type === 'overlap' || a.type === 'tool-conflict') {
        const peerId = a.peerId ?? (a.type === 'overlap' ? a.id.replace(/^ovl-/, '').split('-')[0] : null);
        const peer = peerId ? Store.tasks[peerId] : null;
        searchFrom = peer && peer.end_date ? peer.end_date : task.start_date;
      }
```
The remainder (calendar placement on `line`, `autoReflow`, undo, dismiss, toast) is unchanged: the later order slides right on its own line.

- [ ] **Step 5: Build, typecheck, run insights tests**

```bash
npm run build && npm run typecheck && node --test tests/modules/insights/*.test.mjs tests/modules/locale-completeness.test.mjs
```

- [ ] **Step 6: Manual check** — two orders sharing a PRT_01 value on different lines, overlapping: one red alert in the drawer with the localized sentence and a Fix button; Fix moves the later order to the peer's end on its own line.

- [ ] **Step 7: Commit**

```bash
git add frontend/insights/insights-ui.mts frontend/insights/services.mts frontend/locales/*.js
git commit -m "feat(alerts): render and auto-fix tool-conflict alerts; localized alert text via msgKey (N4)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N7a: Localize the Needs Planning surface in the Orders grid

**Files:**
- Modify: `frontend/scheduling/orders.mts:467-473`, `:798`, `:959`
- Modify: `frontend/locales/*.js`

- [ ] **Step 1: Locale keys** (all five; `col.*` near `en.js:189`, `ui.*` near `:364-372`)

| key | en | de | es | fr | pt |
|---|---|---|---|---|---|
| `col.planning_status` | Planning status | Planungsstatus | Estado de planificación | Statut de planification | Status de planejamento |
| `col.planning_reason` | Planning reason | Planungsgrund | Motivo de planificación | Motif de planification | Motivo de planejamento |
| `col.planning_window` | Allowed window | Zulässiges Fenster | Ventana permitida | Fenêtre autorisée | Janela permitida |
| `ui.needs_planning` | Needs Planning | Planung erforderlich | Requiere planificación | À planifier | Precisa de planejamento |
| `ui.planning_status_scheduled` | Scheduled | Eingeplant | Programada | Planifiée | Programada |
| `ui.status_desc_needs_planning` | unplaced orders awaiting a legal schedule | nicht platzierte Aufträge ohne gültigen Termin | pedidos sin ubicar a la espera de un programa válido | ordres non placés en attente d'un créneau valide | ordens não posicionadas aguardando programação válida |

- [ ] **Step 2: Column defs** (`:467-471`)

```ts
        { headerName: Util.t('col.planning_status'), field: 'planning_status', minWidth: 150, editable: false,
          valueGetter: (p: { data: NimbusTask }) => p.data?.planning_status === 'needs_planning'
            ? Util.t('ui.needs_planning') : Util.t('ui.planning_status_scheduled') },
        { headerName: Util.t('col.planning_reason'), colId: 'planning_reason', minWidth: 240, editable: false,
          valueGetter: (p: { data: NimbusTask }) => p.data?.planning_reason?.message ?? '' },
        { headerName: Util.t('col.planning_window'), colId: 'planning_window', minWidth: 260, editable: false,
```

- [ ] **Step 3: Dropdown entry** (`:798`) and chip label (`:959`)

```ts
      { v: 'needs_planning', k: Util.t('ui.needs_planning'), d: Util.t('ui.status_desc_needs_planning') },
```
```ts
    const STATUS_LABEL: Record<TableStatusFilter, string> = { needs_planning: Util.t('ui.needs_planning'), late: Util.t('ui.late'), conflict: Util.t('ui.conflicting'), atrisk: Util.t('ui.at_risk'), firmed: Util.t('ui.firmed') };
```

- [ ] **Step 4: Verify**

```bash
npm run build && npm run typecheck && node --test tests/modules/scheduling/orders.test.mjs tests/modules/locale-completeness.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add frontend/scheduling/orders.mts frontend/locales/*.js
git commit -m "i18n(orders): localize Needs Planning columns and status filter (N7)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N7b: Dashboard "Needs Planning" tile that opens the filtered worklist

**Files:**
- Modify: `frontend/insights/insights-ui.mts:46` (`DashboardTileAction`), `:410-429` (tiles), `:478-486` (`_tileTooltip`), `:488-525` (`_tileClick`)
- Modify: `frontend/locales/*.js`

**Interfaces:**
- Consumes: `Table._applyChipFilter({ status: 'needs_planning' })` (`orders.mts:924-935`, exists) and `NIMBUS.App.goto('table')`.

- [ ] **Step 1: Locale keys** (near `kpi.*`, `en.js:1314`)

| key | en | de | es | fr | pt |
|---|---|---|---|---|---|
| `kpi.needs_planning` | Needs Planning | Planung erforderlich | Requiere planificación | À planifier | Precisa de planejamento |
| `kpi.needs_planning_demand` | {{h}} h unplaced demand | {{h}} h nicht platzierter Bedarf | {{h}} h de demanda sin ubicar | {{h}} h de demande non placée | {{h}} h de demanda não posicionada |
| `tip.tile_needs_planning` | Open Orders table filtered to orders awaiting a legal schedule | Auftragstabelle gefiltert auf Aufträge ohne gültigen Termin öffnen | Abrir la tabla de pedidos filtrada por pedidos sin programa válido | Ouvrir la table des ordres filtrée sur les ordres à planifier | Abrir a tabela de ordens filtrada por ordens a planejar |

- [ ] **Step 2: Extend the action union** (`:46`)

```ts
type DashboardTileAction = 'orders-today' | 'alerts-today' | 'late' | 'headroom' | 'needs-planning';
```

- [ ] **Step 3: Replace the queued suffix with a conditional tile.** Change `:411-414`:

```ts
      { k: Util.t('kpi.orders_today'),             v: String(todayOrders.length),
        d: Util.t('kpi.orders_total', { n: tasks.length }),
        action: 'orders-today' },
```
After the `headroom` tile (`:428`), before the closing `];`:

```ts
      // Fifth tile only while the queue is non-empty: the row stays at four calm
      // tiles in steady state and gains a red action tile exactly when a
      // scheduler has unplaced demand to deal with.
      ...(queued.length ? [{
        k: Util.t('kpi.needs_planning'), v: String(queued.length),
        d: Util.t('kpi.needs_planning_demand', { h: queuedHours.toFixed(1) }),
        cls: 'err', action: 'needs-planning' as DashboardTileAction,
      }] : []),
```

- [ ] **Step 4: Tooltip and click** — add cases

```ts
      case 'needs-planning': return Util.t('tip.tile_needs_planning');
```
```ts
      case 'needs-planning': {
        NIMBUS!.App!.goto!('table');
        setTimeout(() => {
          if (NIMBUS!.Table && NIMBUS!.Table!._applyChipFilter) {
            NIMBUS!.Table!._applyChipFilter!({ status: 'needs_planning' });
          }
        }, 120);
        break;
      }
```

> Executor check: confirm the Orders tab id used by `App.goto` (grep `goto('table')` / `gotoTable` in `insights-ui.mts` and `application-shell.mts`) and reuse whatever the lateness tile's click handler calls.

- [ ] **Step 5: Verify**

```bash
npm run build && npm run typecheck && node --test tests/modules/insights/*.test.mjs tests/modules/locale-completeness.test.mjs && npm run check:legacy-surface
```

- [ ] **Step 6: Manual check** — with at least one `needs_planning` order in the selected plant, the Dashboard shows a red fifth tile; clicking it lands on the Orders tab with the status chip set to Needs Planning and the reason column visible. Selecting a row opens the Inspector (two clicks total). With zero queued orders the row is back to four tiles.

- [ ] **Step 7: Commit**

```bash
git add frontend/insights/insights-ui.mts frontend/locales/*.js
git commit -m "feat(dashboard): Needs Planning tile opens the filtered Orders worklist (N7)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N7c: Ripple Preview discoverability + review-doc correction

**Files:**
- Modify: `frontend/nimbus-intelligence.js:958` (palette actions)
- Modify: `frontend/locales/*.js`
- Modify: `Code_Review_09_01.md:217`, `:221`, N7 section

- [ ] **Step 1: Locale keys** (near `cmdp.label_compare_schedules`, `en.js:1743`; toast near `toast.snapshot_saved`)

| key | en | de | es | fr | pt |
|---|---|---|---|---|---|
| `cmdp.label_ripple_preview` | Ripple preview | Ripple-Vorschau | Vista previa de arrastre | Aperçu de répercussion | Prévia de repercussão |
| `cmdp.sub_ripple_preview` | Hold Alt and hover an order to outline the next orders on its line | Alt halten und über einen Auftrag fahren, um die nächsten Aufträge der Linie zu markieren | Mantén Alt y pasa sobre un pedido para resaltar los siguientes de su línea | Maintenez Alt et survolez un ordre pour encadrer les suivants sur sa ligne | Segure Alt e passe sobre uma ordem para destacar as próximas na linha |
| `toast.ripple_howto` | Ripple preview: hold Alt and hover an order on the Gantt. | Ripple-Vorschau: Alt halten und über einen Auftrag im Gantt fahren. | Vista previa de arrastre: mantén Alt y pasa sobre un pedido en el Gantt. | Aperçu de répercussion : maintenez Alt et survolez un ordre dans le Gantt. | Prévia de repercussão: segure Alt e passe sobre uma ordem no Gantt. |

- [ ] **Step 2: Palette entry** — after the Compare Schedules action (`:958`)

```js
        { type:'action', label:t('cmdp.label_ripple_preview'), sub:t('cmdp.sub_ripple_preview'), icon:'≋',
          run(){ CommandPalette.close(); NIMBUS.App.gotoGanttTimeline(); Toast.show(t('toast.ripple_howto'), 'info', 4000); } },
```

- [ ] **Step 3: Correct the review doc.** In `Code_Review_09_01.md:217` replace "the Ripple Preview overlay is fully built but permanently disabled" with "the Ripple Preview overlay is fully built and live but has zero affordance (Alt-hover only; `docs/SAP_APO_Opportunities.md` §3.1 item 3 has this right)". Also replace "notes that reason codes shipped, the `needs_planning` queue exists in data" with "predates `needs_planning` (2026-08-22) and describes the deallocation pool it later became". Replace step 2 (`:221`) with: "Ripple Preview decision (2026-09-11): keep the code; add a searchable Cmd+K entry with a how-to toast. It is a shallow same-line highlight of the next five orders, not a computed ripple; a real one waits on demand."

- [ ] **Step 4: Record the deferral.** Append to N7 in `Code_Review_09_01.md`: "Step 3 (before/after affected-orders table) stays deferred until N1 and N3 have shipped and been used; not planned in this cycle."

- [ ] **Step 5: Verify**

```bash
npm run lint && npm run check:legacy-surface && node --test tests/modules/locale-completeness.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add frontend/nimbus-intelligence.js frontend/locales/*.js Code_Review_09_01.md
git commit -m "feat(intel): Ripple preview discoverable from the command palette; correct review doc (N7)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Noticed, left alone by scope discipline:** `Diff._fmtDate`/`_fmtShort` hardcode `'en-US'` and the rest of the Diff dialog is un-localized; `_tileTooltip`'s other four strings are hardcoded English.

## Optimizer — N5, N6, N8

**Findings that shaped these tasks.** (1) Do **not** widen `score[]` to 9: four assertions pin `score.length === 8` (`setup-scheduler.test.mjs:4134,4144,4170,4197`) and the per-line aggregation loops (`setup-scheduler.mts:4502,5307,5491`) **sum** score slots, which is wrong for a maximum. `maxLatenessMinutes` and `instabilityMinutes` become optional `DueDateCandidate` fields (same pattern as `productiveRuntimeKey`), combined at the one fragment-concat site (`:4012-4038`) with `Math.max` / `+`, and compared explicitly after `score[3]`. (2) The N6 code change ripples into eight existing assertions; listed as repair-only edits. (3) The banner tally already counts only uncovered-row edges, so unknown-state admissions are invisible today. (4) **`excludeFromSearch` applies only to the uncovered-row case.** The unknown-predecessor branch fires for every first order on a line whose state is unrecorded; excluding those would queue the whole line, i.e. the forbidden freeze. `plantDefaultMinutes` applies to both cases. (5) An excluded order goes to `unadmitted` and is retried in later fragments; if never placed, `finalizeCandidate` (`:6174`) and the normalizer (`:5761`) emit `noFitReason` today, so a per-run `_setupExclusions` map on `SetupRunContext` carries the real reason, and gap-fill's `transition()` (`:6370-6380`) must also refuse the row or it re-admits at zero. (6) `plantDefaultMinutes` has four charge sites (admission, gap-fill, validation, final facts); one helper `chargedSetupMinutes` serves all four. (7) Two CSV-header pins (`tests/modules/setup/setup-admin.test.mjs:58`, `tests/modules/optimization/optimize-ui.test.mjs:335`) gain `,Remedy`.

**Order inside this section:** N5a (baseline capture) → N6a → N6b → N8a → N8b → N8c → N5b → N5c → N5d. Every scheduler-file task diffs its failure list against the N5a baseline.

### Task N5a: Capture the scheduler test baseline (no code change)

**Files:** none modified. Output: `<scratchpad>/n5-baseline.txt`, `<scratchpad>/n5-baseline-failures.txt` (scratchpad = the session scratchpad directory).

- [ ] **Step 1: Build and run the scheduler file, saving output**

```powershell
npm run build
node --test tests/modules/setup-scheduler.test.mjs 2>&1 | Tee-Object -FilePath "$env:SCRATCHPAD\n5-baseline.txt"
Measure-Command { node --test tests/modules/setup-scheduler.test.mjs > $null 2>&1 } | Select-Object TotalSeconds
```

- [ ] **Step 2: Record the failing test names**

```powershell
Select-String -Path "$env:SCRATCHPAD\n5-baseline.txt" -Pattern '^not ok' | Tee-Object -FilePath "$env:SCRATCHPAD\n5-baseline-failures.txt"
```
This list, and the wall time, are the only acceptable outcomes after every later scheduler edit. No commit.

---

### Task N6a: Distinct explanation code for the unknown-state admission

**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts:2523-2526`, comment at `:2439`
- Test: `tests/modules/setup-scheduler.test.mjs` (new test + repairs at `:1342, 1505, 1735, 2159, 2372, 3266, 3486, 3489`)

**Interfaces:**
- Produces: explanation code `'admitted-state-unrecorded'` (unknown line-initial/predecessor state, order admitted). `'admitted-without-setup'` unchanged (uncovered row). Edge reasons `initial-state-unknown` / `scheduled-without-setup` unchanged.

- [ ] **Step 1: Write the failing test** (append)

```js
test('admission diagnostics distinguish an unrecorded line state from an uncovered matrix row', () => {
  const rejected = /(?:unavailable|unknown|uncovered|infeasible|missing|disabled|fail)/i; // optimize-ui.mts summarizeCandidate
  // Case 1: line state unrecorded (current: null) — first order admitted at zero.
  const stateless = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([scheduledTask('n6-first', 1, 'RED', '2026-08-03T10:00')]),
    dueDateBounds(setupTruth({ current: null, rows: [setupRow('GREEN', 'RED', 5)] })),
  );
  const stateReason = stateless.explanation.find(r => r.code === 'admitted-state-unrecorded' && r.taskId === 'n6-first');
  assert.ok(stateReason, 'unknown incoming state gets its own admitted code');
  assert.equal(rejected.test(`${stateReason.code} ${stateReason.message}`), false, 'must not be stamped rejected in the preview');
  assert.equal(stateless.explanation.some(r => r.code === 'initial-state-unknown' && r.taskId === 'n6-first'), false);
  assert.ok(stateless.missingEdges.some(e => e.reason === 'initial-state-unknown'), 'edge reason is unchanged');
  // Case 2: both states known, no row — existing code still fires.
  const uncovered = SetupScheduler.evaluateDueDateFirst(
    setupSnapshot([scheduledTask('n6-red', 1, 'RED', '2026-08-03T10:00')]),
    dueDateBounds(setupTruth({ current: 'GREEN', rows: [setupRow('GREEN', 'BLUE', 5)] })),
  );
  const rowReason = uncovered.explanation.find(r => r.code === 'admitted-without-setup' && r.taskId === 'n6-red');
  assert.ok(rowReason);
  assert.equal(rejected.test(`${rowReason.code} ${rowReason.message}`), false);
  assert.ok(uncovered.missingEdges.some(e => e.reason === 'scheduled-without-setup' && e.successorOrderId === 'n6-red'));
});
```

- [ ] **Step 2: Run to verify failure**

```powershell
npm run build; node --test tests/modules/setup-scheduler.test.mjs --test-name-pattern="unrecorded line state"
```
Expected: FAIL on `stateReason` (code is `initial-state-unknown` today).

- [ ] **Step 3: Implement** — replace `:2523-2526`

```ts
    if (unknownPredecessor) {
      missingEdges.push(unknownInitialStateEdge(line, task));
      // N6: an ADMITTED order whose incoming state is simply not recorded is
      // not a rejection. `initial-state-unknown` (still the edge reason above,
      // and still used by the preserved-anchor/rejection paths) trips
      // summarizeCandidate's rejected-token regex; this code and message
      // deliberately avoid unavailable|unknown|uncovered|infeasible|missing|
      // disabled|fail so the preview stamps the order accepted.
      if (!suppressExplanations) {
        explanation.push({
          code: 'admitted-state-unrecorded',
          message: `Admitted ${taskId(task)} as the line's first order; the line's current setup state is not recorded, so zero setup minutes were charged.`,
          line,
          taskId: taskId(task),
        });
      }
      setupRequirement = { kind: 'resolved', minutes: 0 };
    } else {
```

- [ ] **Step 4: Repair the existing assertions** (semantics unchanged)

- `:1735`, `:2372`, `:3486`, `:3489`: `reason.code === 'initial-state-unknown'` → `'admitted-state-unrecorded'`.
- `:1342`, `:1505`, `:2159`, `:3266`: `['unknown-setup-tail-placement', 'initial-state-unknown']` → add `'admitted-state-unrecorded'`.
- `:2439` comment: list `'admitted-state-unrecorded'` among suppressed codes.

- [ ] **Step 5: Run the file, diff against baseline, commit**

```powershell
npm run build; node --test tests/modules/setup-scheduler.test.mjs 2>&1 | Tee-Object "$env:SCRATCHPAD\n6a.txt"
Compare-Object (Select-String "$env:SCRATCHPAD\n5-baseline-failures.txt" -Pattern '^not ok') (Select-String "$env:SCRATCHPAD\n6a.txt" -Pattern '^not ok')
```
Expected: `Compare-Object` prints nothing.

```bash
git add frontend/optimization/setup-scheduler.mts tests/modules/setup-scheduler.test.mjs
git commit -m "fix(optimizer): give unrecorded-state admissions their own accepted explanation code (N6)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N6b: Surface the two remedies (preview table, CSVs, banner, review chip, locales)

**Files:**
- Modify: `frontend/optimization/optimize-ui.mts` (`PreviewExplanation` :845-859; `summarizeCandidate` :1109-1125, :1153; `describeMissingPairs` :1169-1189; `missingPairsCsv` :1191-1195; `gapsHtml` :1783; banner :1846-1851, render :1982)
- Modify: `frontend/setup/setup-admin.mts` (`MissingSetupReviewPair` :115; `_missingReview` :145; `missingPairsCsv` :475-480; `reviewMissingPairs` :515; chip :914; handlers :1082-1085; `paintGrid` :1545-1548)
- Modify: `frontend/locales/{en,de,es,fr,pt}.js`
- Test: `tests/modules/optimization/optimize-ui.test.mjs:315-338`, `tests/modules/setup/setup-admin.test.mjs:50-62`, `tests/modules/locale-completeness.test.mjs`

**Interfaces:**
- Produces: `export function remedyKeyForEdgeReason(reason: string): 'ui.setup_missing_remedy_state' | 'ui.setup_missing_remedy_row' | null` in `optimize-ui.mts`; `PreviewExplanation.scheduledStateUnrecorded: { orders: number; lines: number }`; `MissingSetupReviewPair` and `missingPairs[]` rows gain `remedy: string` (localized text, resolved at describe time).

- [ ] **Step 1: Failing tests**

`optimize-ui.test.mjs`, extend the test at `:315`: set the fixture edge `reason` to `'scheduled-without-setup'`, expect the pair to include `remedy: 'Add a setup matrix row for this transition'`, add `assert.match(csv, /Reason,Remedy/);`. Add:

```js
test('summarizeCandidate tallies unrecorded-state and uncovered-row admissions separately', () => {
  const candidate = {
    patches: [{ id: 'a', changes: {} }, { id: 'b', changes: {} }], explanation: [], unchangedLines: [],
    diagnostics: { candidateCount: 1, method: 'due-date-first-exact', termination: 'completed', runtimeMs: 1, limitReached: false, events: [] },
    missingEdges: [
      { line: 'L1', predecessorOrderId: null, successorOrderId: 'a', reason: 'initial-state-unknown' },
      { line: 'L1', predecessorOrderId: 'a', successorOrderId: 'b', reason: 'scheduled-without-setup' },
      { line: 'L2', predecessorOrderId: 'x', successorOrderId: 'zzz-not-patched', reason: 'scheduled-without-setup' },
    ],
  };
  const explanation = OptimizerPreview.summarizeCandidate(candidate, MINIMAL_INPUT); // copy the `input` literal from the existing summarizeCandidate test ending at :313
  assert.deepEqual(explanation.scheduledWithoutSetup, { orders: 1, lines: 1 });
  assert.deepEqual(explanation.scheduledStateUnrecorded, { orders: 1, lines: 1 });
});
```
`setup-admin.test.mjs:53-58`: add `remedy: 'Add a setup matrix row for this transition'` to the pair fixture; header regex gains `,Remedy`.
`locale-completeness.test.mjs`: add a test pinning `['ui.setup_missing_remedy_state','ui.setup_missing_remedy_row','ui.opt_pv_scheduled_state_unrecorded','ui.setup_col_remedy','ui.setup_review_filter_state','ui.setup_review_filter_row','ui.setup_review_filter_all']` in all 5 locales, copying the existing `REQUIRED` test shape at `:32-40`.

- [ ] **Step 2: Run to verify failure**

```powershell
npm run build; node --test tests/modules/optimization/optimize-ui.test.mjs tests/modules/setup/setup-admin.test.mjs tests/modules/locale-completeness.test.mjs
```

- [ ] **Step 3: Locale keys** (`en.js` near `:1565-1567`; de/es/fr/pt with the file's `// MISSING TRANSLATION` marker convention, see `locale-completeness.test.mjs:203-206`)

```js
  'ui.setup_col_remedy':                  'Remedy',
  'ui.setup_missing_remedy_state':        'Record this line\'s current setup state',
  'ui.setup_missing_remedy_row':          'Add a setup matrix row for this transition',
  'ui.opt_pv_scheduled_state_unrecorded': '{{orders}} order(s) on {{lines}} machine(s) were scheduled as the line\'s first order without a recorded current setup state — record the line state to charge their setup.',
  'ui.setup_review_filter_all':           'All',
  'ui.setup_review_filter_state':         'Line state not recorded',
  'ui.setup_review_filter_row':           'Matrix row absent',
```
Reword `ui.opt_pv_scheduled_without_setup` to end "— add a setup matrix row for each transition to charge their setup." (it is now row-only).

- [ ] **Step 4: `optimize-ui.mts`**

Module-level helper near `PREVIEW_MISSING_PAIR_LIMIT` (`:905`):
```ts
/** N6: map a MissingSetupEdge.reason to the planner's remedy. Only the two
 * admitted-at-zero reasons have a remedy; rejection reasons return null. */
export function remedyKeyForEdgeReason(reason: string): 'ui.setup_missing_remedy_state' | 'ui.setup_missing_remedy_row' | null {
  if (reason === 'initial-state-unknown') return 'ui.setup_missing_remedy_state';
  if (reason === 'scheduled-without-setup') return 'ui.setup_missing_remedy_row';
  return null;
}
```
`PreviewExplanation.missingPairs` element type gains `remedy: string`; add after `scheduledWithoutSetup`:
```ts
  /** N6 twin of scheduledWithoutSetup for `'initial-state-unknown'` edges whose
   *  successor was actually patched — orders admitted as a line's first order
   *  with no recorded line state. */
  scheduledStateUnrecorded: { orders: number; lines: number };
```
`summarizeCandidate` `:1109-1125`:
```ts
    const stateUnrecordedOrders = new Set<string>();
    const stateUnrecordedLines = new Set<string>();
    for (const edge of candidate.missingEdges) {
      if (!edge.successorOrderId || !patchedIds.has(String(edge.successorOrderId))) continue;
      if (edge.reason === 'scheduled-without-setup') {
        scheduledWithoutSetupOrders.add(String(edge.successorOrderId)); scheduledWithoutSetupLines.add(edge.line);
      } else if (edge.reason === 'initial-state-unknown') {
        stateUnrecordedOrders.add(String(edge.successorOrderId)); stateUnrecordedLines.add(edge.line);
      }
    }
```
Return adds `scheduledStateUnrecorded: { orders: stateUnrecordedOrders.size, lines: stateUnrecordedLines.size },`.
`describeMissingPairs` row: `remedy: (() => { const key = remedyKeyForEdgeReason(edge.reason); return key ? Util.t(key) : ''; })(),`.
`missingPairsCsv`: header `…,Reason,Remedy`; row appends `pair.remedy`.
`gapsHtml` `:1783`: add `<th>${Util.escapeHtml(Util.t('ui.setup_col_remedy'))}</th>` and `<td>${Util.escapeHtml(pair.remedy || '—')}</td>`.
Banner: beside `scheduledWithoutSetupHtml` add the twin from `explanation.scheduledStateUnrecorded` with key `ui.opt_pv_scheduled_state_unrecorded`; render both at `:1982`.

- [ ] **Step 5: `setup-admin.mts`**

`:115` type gains `remedy?: string`. `missingPairsCsv`: header `…,Reason,Remedy`, row appends `pair.remedy`. Module state beside `_missingReview` (`:145`): `let _missingReviewFilter: 'all' | 'state' | 'row' = 'all';`. Chip `:914` gains `<select data-setup-review-filter>` with the three `ui.setup_review_filter_*` options (values `all|state|row`, current selected). Handler beside `:1082`:
```ts
    target.querySelector<HTMLSelectElement>('[data-setup-review-filter]')?.addEventListener('change', event => {
      const value = (event.target as HTMLSelectElement).value;
      _missingReviewFilter = value === 'state' || value === 'row' ? value : 'all';
      renderSnapshot(target, snapshot);
    });
```
`paintGrid` `:1545`: filter once before building `reviewSigs`:
```ts
    const reviewPairs = review ? review.pairs.filter(pair => _missingReviewFilter === 'all'
      || (_missingReviewFilter === 'state' && pair.reason === 'initial-state-unknown')
      || (_missingReviewFilter === 'row' && pair.reason === 'scheduled-without-setup')) : null;
```
and derive `reviewSigs` from `reviewPairs` exactly as today from `review.pairs`. Reset `_missingReviewFilter = 'all'` inside `reviewMissingPairs` (`:515`) and the clear handler (`:1083`).

- [ ] **Step 6: Build, run, lint, commit**

```powershell
npm run build; node --test tests/modules/optimization/optimize-ui.test.mjs tests/modules/setup/setup-admin.test.mjs tests/modules/locale-completeness.test.mjs; npm run lint
```
```bash
git add frontend/optimization/optimize-ui.mts frontend/setup/setup-admin.mts frontend/locales/*.js tests/modules/optimization/optimize-ui.test.mjs tests/modules/setup/setup-admin.test.mjs tests/modules/locale-completeness.test.mjs
git commit -m "feat(setup): show the remedy per missing-setup reason in preview, CSVs, banner and review chip (N6)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N8a: Backend write route + read-back for `unknownSetupPolicy`

**Files:**
- Modify: `master_data.py` (`list_rows` sidecar `:324-358`; new `set_plant_unknown_setup_policy` after `:1554`)
- Modify: `backend/master_data/models.py` (after `:175`)
- Modify: `backend/master_data/routes.py` (import `:40`; new route after `:507`)
- Modify: `brain.py` audit action map (~`:595-600`, beside `plant.split_order_policy_update`)
- Modify: `backend/master_data/CLAUDE.md` (per-plant policy route list)
- Test: `tests/test_master_data_setup_policy.py`

**Interfaces:**
- Produces: `POST /master-data/plants/{plant}/unknown-setup-policy` body `{ subnetwork?, unknown_setup_policy: 'zero'|'plantDefaultMinutes'|'excludeFromSearch', unknown_setup_default_minutes?: int>=0 }` → `{ status, plant, setup_policy_config }`. Plant rows from `list_rows('plants')` carry `setup_policy_config` (dict; version-1 rows lack the two new keys).

- [ ] **Step 1: Failing tests** (append to `tests/test_master_data_setup_policy.py`)

```python
def test_unknown_setup_policy_write_merges_jsonb_and_audits(monkeypatch):
    cursor = _Cursor()
    monkeypatch.setattr(md, "_pool", _Pool(cursor))

    result = md.set_plant_unknown_setup_policy("SN", "5512", "plantDefaultMinutes", 45, "owner@example.com")

    assert result["status"] == "ok" and result["plant"] == "5512"
    assert result["setup_policy_config"] == {
        "unknownSetupPolicy": "plantDefaultMinutes", "unknownSetupDefaultMinutes": 45, "version": 2,
    }
    update = next((item for item in cursor.executed if "UPDATE plants SET setup_policy_config" in item[0]), None)
    assert update is not None
    assert "setup_policy_config || %s" in update[0]
    assert update[1][1:] == ["5512", "SN"]
    assert any("set_unknown_setup_policy" in statement for statement, _ in cursor.executed)


def test_unknown_setup_policy_rejects_invalid_values():
    for policy, minutes in (("freeze", 0), ("zero", -1), ("zero", 1.5), ("zero", True), ("plantDefaultMinutes", "45")):
        try:
            md.set_plant_unknown_setup_policy("SN", "5512", policy, minutes)
        except ValueError as error:
            assert "unknown_setup" in str(error)
        else:
            raise AssertionError(f"{policy!r}/{minutes!r} must be rejected")
```
Run: `.\.venv\Scripts\python -m pytest tests/test_master_data_setup_policy.py -q` → FAIL `AttributeError`.

- [ ] **Step 2: `master_data.py` — the setter** (after `set_plant_frozen_horizon_days`)

```python
UNKNOWN_SETUP_POLICIES = ("zero", "plantDefaultMinutes", "excludeFromSearch")


def set_plant_unknown_setup_policy(subnetwork: str, plant: str, policy: str, default_minutes: int | None = 0,
                                   user_email: str | None = None) -> dict:
    """N8 (2026-09): persist how the setup-aware optimizer treats an order whose
    setup transition has no data, into the per-plant JSONB sidecar
    plants.setup_policy_config (schema.sql ~:268, unwired until now). A JSONB
    merge (||) keeps the Stage 2 keys already in the column; version bumps to 2.
    'zero' is today's behavior for every plant."""
    if not plant:
        raise ValueError("plant is required")
    clean = str(policy or "").strip()
    if clean not in UNKNOWN_SETUP_POLICIES:
        raise ValueError("unknown_setup_policy must be zero, plantDefaultMinutes, or excludeFromSearch")
    minutes = 0 if default_minutes is None else default_minutes
    if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes < 0:
        raise ValueError("unknown_setup_default_minutes must be a non-negative integer")

    patch = {"unknownSetupPolicy": clean, "unknownSetupDefaultMinutes": minutes, "version": 2}
    params: list = [Jsonb(patch), plant]
    where = "plant = %s"
    if subnetwork:
        where += " AND subnetwork = %s"
        params.append(subnetwork)
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            f"UPDATE plants SET setup_policy_config = setup_policy_config || %s, updated_at = NOW() WHERE {where}",
            params,
        )
        if cur.rowcount == 0:
            raise ValueError(f"Plant {plant!r} not found")
        cur.execute(
            "INSERT INTO admin_audit (table_name, action, details, user_email)"
            " VALUES ('plants', 'set_unknown_setup_policy', %s, %s)",
            (Jsonb({"plant": plant, **patch}), user_email),
        )
        conn.commit()
    return {"status": "ok", "plant": plant, "setup_policy_config": patch}
```
(`Jsonb` is already imported. The test's `update[1][1:]` skips the `Jsonb` wrapper.)

- [ ] **Step 3: `master_data.py` — read-back** (`:333-358`): append `setup_policy_config` to the sidecar SELECT list, extend the `cmap` tuple to `r[2]..r[11]`, add it to the positional unpack with `None` as its default in the `cmap.get` default tuple, then `row['setup_policy_config'] = setup_policy_config or {}`. Update the comment block `:324-326` to list it among unregistered sidecar fields. **Do not** add a `column_metadata` row (that is what keeps the JSONB out of `bulk_apply`, `:784-813`).

- [ ] **Step 4: Model, route, audit name, CLAUDE.md**

`models.py` after `PlantFrozenHorizonDaysResult`:
```python
class PlantUnknownSetupPolicyResult(BaseModel):
    status: str
    plant: str
    setup_policy_config: dict
```
`routes.py`: import it at `:40`; after `:507`:
```python
@router.post("/master-data/plants/{plant}/unknown-setup-policy", response_model=PlantUnknownSetupPolicyResult,
            dependencies=[Depends(require_api_key), Depends(require_admin)])
def md_set_plant_unknown_setup_policy(plant: str, request: Request, body: dict = Body(default={})):
    """N8: per-plant treatment of orders whose setup transition has no data —
    zero | plantDefaultMinutes | excludeFromSearch — stored in the
    plants.setup_policy_config JSONB sidecar (never freezes a line)."""
    try:
        return md.set_plant_unknown_setup_policy(
            subnetwork=body.get("subnetwork", ""),
            plant=plant,
            policy=body.get("unknown_setup_policy", ""),
            default_minutes=body.get("unknown_setup_default_minutes", 0),
            user_email=request.headers.get("x-user-email"),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
```
`brain.py` audit map: `"/master-data/plants/{plant}/unknown-setup-policy": "plant.unknown_setup_policy_update",`. Add the route to `backend/master_data/CLAUDE.md`'s per-plant policy family list.

- [ ] **Step 5: Run, commit**

```powershell
$env:NIMBUS_PG_POOL_MIN='0'; .\.venv\Scripts\python -m pytest tests/test_master_data_setup_policy.py -q
```
```bash
git add master_data.py backend/master_data/models.py backend/master_data/routes.py backend/master_data/CLAUDE.md brain.py tests/test_master_data_setup_policy.py
git commit -m "feat(master-data): per-plant unknown-setup policy route backed by plants.setup_policy_config (N8)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N8b: Scheduler consumes the policy

**Files:**
- Modify: `frontend/platform/types.mts` (`UnknownSetupPolicy` beside `SplitOrderPolicy`; `NimbusMasterPlant` after `:281`)
- Modify: `frontend/optimization/setup-scheduler.mts` (`SetupRunContext` :489-490 & `buildRunContext` :545-546; helpers beside :2298-2312; admission :2523-2568; normalizer :5761; validation :6067; `finalizeCandidate` :6174; gap-fill `transition` :6374-6379; facts :6591)
- Modify: `frontend/optimization/CLAUDE.md` (reason-code list)
- Test: `tests/modules/setup-scheduler.test.mjs`

**Interfaces:**
- Consumes: `NimbusMasterPlant.setup_policy_config` from N8a's sidecar.
- Produces: `planning_reason.code === 'setup_transition_unrecorded'` for excluded-and-never-placed orders; `SetupRunContext.unknownSetupPolicy`, `.unknownSetupDefaultMinutes`, `._setupExclusions`.

- [ ] **Step 1: Failing tests** (append; the `masterData` plant row carries the policy — confirm `setupSnapshot`'s plant/line ids in the helpers at `:1-140` and adjust `'P1'`/`'L1'`)

```js
function policySnapshot(tasks, config) {
  const snapshot = setupSnapshot(tasks);
  snapshot.masterData = { plants: [{ plant: 'P1', setup_policy_config: config }], lines: [{ plant: 'P1', machine: 'L1' }] };
  return snapshot;
}
const UNCOVERED = () => setupTruth({ current: 'GREEN', rows: [setupRow('GREEN', 'BLUE', 5)] }); // GREEN->RED has no row

test('unknownSetupPolicy zero is byte-identical to the default', () => {
  const red = () => scheduledTask('n8-red', 1, 'RED', '2026-08-03T12:00');
  const a = SetupScheduler.evaluateDueDateFirst(setupSnapshot([red()]), dueDateBounds(UNCOVERED()));
  const b = SetupScheduler.evaluateDueDateFirst(policySnapshot([red()], { unknownSetupPolicy: 'zero', version: 2 }), dueDateBounds(UNCOVERED()));
  assert.deepEqual(b.patches, a.patches);
  assert.deepEqual(b.explanation.map(r => r.code), a.explanation.map(r => r.code));
});

test('unknownSetupPolicy plantDefaultMinutes charges the configured minutes and keeps the N6 code', () => {
  const red = scheduledTask('n8-red', 1, 'RED', '2026-08-03T12:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    policySnapshot([red], { unknownSetupPolicy: 'plantDefaultMinutes', unknownSetupDefaultMinutes: 45, version: 2 }),
    dueDateBounds(UNCOVERED()),
  );
  assert.equal(patchFor(result, 'n8-red').changes.start_date.getTime(), at('2026-08-03T08:45').getTime(),
    '45 setup minutes precede the first productive minute');
  assert.equal(result.objective?.setupMinutes, 45);
  assert.ok(result.explanation.some(r => r.code === 'admitted-without-setup' && r.taskId === 'n8-red'));
  assert.ok(result.missingEdges.some(e => e.reason === 'scheduled-without-setup' && e.successorOrderId === 'n8-red'));
});

test('unknownSetupPolicy excludeFromSearch queues the order with a setup_transition_unrecorded reason and never freezes the line', () => {
  const red = scheduledTask('n8-red', 1, 'RED', '2026-08-03T12:00');
  const blue = scheduledTask('n8-blue', 1, 'BLUE', '2026-08-03T12:00');
  const result = SetupScheduler.evaluateDueDateFirst(
    policySnapshot([red, blue], { unknownSetupPolicy: 'excludeFromSearch', version: 2 }),
    dueDateBounds(UNCOVERED()),
  );
  assert.ok(patchFor(result, 'n8-blue'), 'the covered order is still placed (no line freeze)');
  const queued = result.dispositions.find(d => d.id === 'n8-red');
  assert.equal(queued?.status, 'needs_planning');
  assert.equal(queued?.reason?.code, 'setup_transition_unrecorded');
  assert.match(queued.reason.message, /GREEN/); assert.match(queued.reason.message, /RED/);
  assert.deepEqual(result.unchangedLines, []);
});
```

- [ ] **Step 2: Run to verify failure**

```powershell
npm run build; node --test tests/modules/setup-scheduler.test.mjs --test-name-pattern="unknownSetupPolicy"
```
Expected: `plantDefaultMinutes` and `excludeFromSearch` FAIL; `zero` passes trivially (it pins the no-op).

- [ ] **Step 3: `types.mts`**

Beside `SplitOrderPolicy`: `export type UnknownSetupPolicy = 'zero' | 'plantDefaultMinutes' | 'excludeFromSearch';`. After `:281`:
```ts
  /** N8 (2026-09): plants.setup_policy_config JSONB sidecar, attached by
   *  master_data.list_rows like split_order_policy. Only the unknown-setup
   *  keys are read client-side; Stage 2 keys ride along untouched. Version 1
   *  rows lack both keys → readers default to 'zero'/0 (today's behavior). */
  setup_policy_config?: {
    unknownSetupPolicy?: UnknownSetupPolicy;
    unknownSetupDefaultMinutes?: number;
    version?: number;
    [key: string]: unknown;
  } | null;
```

- [ ] **Step 4: `setup-scheduler.mts` — read the policy**

Import `UnknownSetupPolicy` with the other `platform/types.mjs` type imports. Beside `:2312`:
```ts
/** N8: mirrors splitOrderPolicyForSnapshot — Store-free read of the plant's
 * unknown-setup policy; absent/malformed → 'zero' (today's behavior). */
function unknownSetupPolicyForSnapshot(snapshot: Readonly<ScheduleSnapshot>, plant: string): UnknownSetupPolicy {
  const value = snapshot.masterData?.plants.find(candidate => candidate.plant === plant)?.setup_policy_config?.unknownSetupPolicy;
  return value === 'plantDefaultMinutes' || value === 'excludeFromSearch' ? value : 'zero';
}
function unknownSetupDefaultMinutesForSnapshot(snapshot: Readonly<ScheduleSnapshot>, plant: string): number {
  const value = snapshot.masterData?.plants.find(candidate => candidate.plant === plant)?.setup_policy_config?.unknownSetupDefaultMinutes;
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}
/** Minutes to charge for a resolution under the run's unknown-setup policy:
 * covered rows are always their own minutes; an uncovered row (or no row at
 * all) is 0 or the plant default. Shared by admission, gap-fill, validation
 * and final facts so the four never disagree. */
function chargedSetupMinutes(ctx: Readonly<SetupRunContext> | undefined, resolved: { covered: boolean; effectiveMin: number | null } | null): number {
  if (resolved?.covered && resolved.effectiveMin !== null) return resolved.effectiveMin;
  return ctx?.unknownSetupPolicy === 'plantDefaultMinutes' ? ctx.unknownSetupDefaultMinutes : 0;
}
```
`SetupRunContext` (`:490`):
```ts
  unknownSetupPolicy: UnknownSetupPolicy;
  unknownSetupDefaultMinutes: number;
  /** N8: taskId -> planning reason for orders this run refused to admit under
   *  'excludeFromSearch'; read by finalizeCandidate/normalizer when the order
   *  ends the run queued, so the planner sees the missing transition instead
   *  of a generic no_fit_found. */
  _setupExclusions: Map<string, { code: string; message: string }>;
```
`buildRunContext` (`:546`): `unknownSetupPolicy: unknownSetupPolicyForSnapshot(snapshot, plant), unknownSetupDefaultMinutes: unknownSetupDefaultMinutesForSnapshot(snapshot, plant), _setupExclusions: new Map(),`.

- [ ] **Step 5: Admission block** — head of the `if (!resolved.covered || resolved.effectiveMin === null) {` branch (`:2540`)

```ts
      if (!resolved.covered || resolved.effectiveMin === null) {
        const ctx = bounds.runContext;
        if (ctx?.unknownSetupPolicy === 'excludeFromSearch') {
          // N8: refuse to admit here; the order stays eligible for later
          // fragments/sequences where its predecessor may be covered. Only if
          // it is never placed does this reason surface (finalizeCandidate).
          const label = (state: SetupStateKey | null) => state?.map(part => part.value).join(' · ') || '?';
          ctx._setupExclusions.set(taskId(task), {
            code: 'setup_transition_unrecorded',
            message: `No setup transition is recorded from ${label(predecessorState)} to ${label(successorState)} on ${line}; this plant excludes such orders from automatic placement.`,
          });
          unadmitted.push(task);
          continue;   // restore the cursor/locals exactly as the due-work-unadmitted path at :2597-2600 does
        }
        uncoveredAdmission = true;
        uncoveredEdgeCount += 1;
        effectiveSetupMinutes = chargedSetupMinutes(ctx, resolved);
        … existing missingEdges.push / explanation.push unchanged …
        setupRequirement = { kind: 'resolved', minutes: effectiveSetupMinutes };
      } else {
```
In the `unknownPredecessor` branch (N6a), set `effectiveSetupMinutes = chargedSetupMinutes(bounds.runContext, null); setupRequirement = { kind: 'resolved', minutes: effectiveSetupMinutes };` and make both admitted messages say `charged ${effectiveSetupMinutes} setup minutes` (still token-free). Executor check: `SetupStateKey`'s actual element shape (`part.value`) — read the type before writing `label`.

- [ ] **Step 6: Other charge/legality sites**

- Gap-fill `:6379`: `if (!resolution.covered && bounds.runContext?.unknownSetupPolicy === 'excludeFromSearch') return null; return chargedSetupMinutes(bounds.runContext, resolution);`
- Validation `:6067`: `const minutes = chargedSetupMinutes(bounds.runContext, resolution);` (keep the `missing_setup` warning).
- Facts `:6591`: `setupMinutes += chargedSetupMinutes(bounds.runContext, resolved);` (drop the `if (resolved.covered)` guard).
- `finalizeCandidate` `:6174`: `const reason = defect ?? bounds.runContext?._setupExclusions.get(id) ?? noFitReason(candidate);`
- Normalizer `:5761`: `const reason = result.planning_reason?.code ? result.planning_reason : (planningDefect(snapshot, bounds, task) ?? bounds.runContext?._setupExclusions.get(id) ?? reasonFor(task));`
- `frontend/optimization/CLAUDE.md` "Hard-bound candidate and Apply contract": add `setup_transition_unrecorded` to the reason-code list.

- [ ] **Step 7: Build, run file, diff against baseline, commit**

```powershell
npm run build; node --test tests/modules/setup-scheduler.test.mjs 2>&1 | Tee-Object "$env:SCRATCHPAD\n8b.txt"
Compare-Object (Select-String "$env:SCRATCHPAD\n5-baseline-failures.txt" -Pattern '^not ok') (Select-String "$env:SCRATCHPAD\n8b.txt" -Pattern '^not ok')
```
```bash
git add frontend/platform/types.mts frontend/optimization/setup-scheduler.mts frontend/optimization/CLAUDE.md tests/modules/setup-scheduler.test.mjs
git commit -m "feat(optimizer): honor per-plant unknownSetupPolicy (zero | plantDefaultMinutes | excludeFromSearch) (N8)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N8c: Scheduling Rules UI (dropdown + minutes + hint)

**Files:**
- Modify: `frontend/master-data/admin-ui.mts` (`RULE_HELP` :102-110; markup after `:1229`; element handles `:1309-1329`; save handler after `:1534`; `PlantRow` :2442-2457)
- Modify: `frontend/locales/{en,de,es,fr,pt}.js`
- Test: `tests/modules/locale-completeness.test.mjs`

- [ ] **Step 1: Locale pin (failing)** — new test in `locale-completeness.test.mjs` requiring `['ui.unknown_setup_title','ui.unknown_setup_help','ui.unknown_setup_opt_zero','ui.unknown_setup_opt_default','ui.unknown_setup_opt_exclude','ui.unknown_setup_minutes_label','ui.unknown_setup_saved','ui.unknown_setup_failed','ui.unknown_setup_minutes_invalid']` in all 5 locales. Run → FAIL.

- [ ] **Step 2: `en.js`** (beside `ui.split_order_*`, `:571-577`; mirror into de/es/fr/pt with the MISSING TRANSLATION marker)

```js
  'ui.unknown_setup_title':            'Setup data missing',
  'ui.unknown_setup_help':             'How the optimizer treats an order whose setup transition has no matrix row or whose line has no recorded state. The line is never frozen: orders are placed at zero minutes, placed with a plant-default setup time, or sent to the Needs Planning list.',
  'ui.unknown_setup_opt_zero':         'Place at zero setup minutes (default)',
  'ui.unknown_setup_opt_default':      'Place using a plant-default setup time',
  'ui.unknown_setup_opt_exclude':      'Send to Needs Planning until the matrix row exists',
  'ui.unknown_setup_minutes_label':    'Default setup time',
  'ui.unknown_setup_minutes_invalid':  'Enter a whole number of minutes, zero or greater.',
  'ui.unknown_setup_saved':            'Setup-data policy saved for this plant.',
  'ui.unknown_setup_failed':           'Could not save setup-data policy',
```

- [ ] **Step 3: `admin-ui.mts`**

`RULE_HELP`: `unknownSetupPolicy: { title: 'ui.unknown_setup_title', help: ['ui.unknown_setup_help'] },`.
Markup after the split-policy row (`:1229`), same wide-row pattern:
```html
                <div class="sched-rule-row sched-rule-row--wide" data-rule-key="unknownSetupPolicy">
                  <label for="sys-unknown-setup-policy">${Util.t('ui.unknown_setup_title')}</label>
                  <select id="sys-unknown-setup-policy" class="form-input">
                    <option value="zero">${Util.t('ui.unknown_setup_opt_zero')}</option>
                    <option value="plantDefaultMinutes">${Util.t('ui.unknown_setup_opt_default')}</option>
                    <option value="excludeFromSearch">${Util.t('ui.unknown_setup_opt_exclude')}</option>
                  </select>
                  <span class="sched-rule-unit"></span>
                </div>
                <div class="sched-rule-row" data-rule-key="unknownSetupPolicy" id="sys-unknown-setup-minutes-row" hidden>
                  <label for="sys-unknown-setup-minutes">${Util.t('ui.unknown_setup_minutes_label')}</label>
                  <input type="number" id="sys-unknown-setup-minutes" class="form-input" min="0" step="1" inputmode="numeric">
                  <span class="sched-rule-unit">${Util.t('ui.unit_minutes')}</span>
                </div>
```
`PlantRow` gains `setup_policy_config?: { unknownSetupPolicy?: 'zero' | 'plantDefaultMinutes' | 'excludeFromSearch'; unknownSetupDefaultMinutes?: number } | null;`.
Handles + seed (after `:1329`):
```ts
    const unknownSetupSelect = pane.querySelector('#sys-unknown-setup-policy') as HTMLSelectElement;
    const unknownSetupMinutesRow = pane.querySelector('#sys-unknown-setup-minutes-row') as HTMLElement;
    const unknownSetupMinutesInp = pane.querySelector('#sys-unknown-setup-minutes') as HTMLInputElement;
    const readUnknownPolicy = () => {
      const v = plantRow?.setup_policy_config?.unknownSetupPolicy;
      return v === 'plantDefaultMinutes' || v === 'excludeFromSearch' ? v : 'zero';
    };
    const readUnknownMinutes = () => {
      const v = plantRow?.setup_policy_config?.unknownSetupDefaultMinutes;
      return Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0;
    };
    unknownSetupSelect.value = readUnknownPolicy();
    unknownSetupMinutesInp.value = String(readUnknownMinutes());
    unknownSetupMinutesRow.hidden = unknownSetupSelect.value !== 'plantDefaultMinutes';
```
Save handler (after `:1534`), shared by both controls:
```ts
    async function saveUnknownSetupPolicy(): Promise<void> {
      if (!plantRow) { Toast.show(Util.t('toast.no_plant_selected'), 'warn'); return; }
      const previousPolicy = readUnknownPolicy(); const previousMinutes = readUnknownMinutes();
      const policy = unknownSetupSelect.value;
      const raw = unknownSetupMinutesInp.value.trim();
      const minutes = raw === '' ? 0 : Number(raw);
      if (!Number.isInteger(minutes) || minutes < 0) {
        unknownSetupMinutesInp.value = String(previousMinutes);
        Toast.show(Util.t('ui.unknown_setup_minutes_invalid'), 'error');
        return;
      }
      unknownSetupMinutesRow.hidden = policy !== 'plantDefaultMinutes';
      unknownSetupSelect.disabled = true; unknownSetupMinutesInp.disabled = true;
      try {
        const response = await Util.fetchTraced(
          `${Config.API_BASE}/master-data/plants/${encodeURIComponent(plantRow.plant)}/unknown-setup-policy`,
          { method: 'POST', headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
            body: JSON.stringify({ subnetwork: plantRow.subnetwork, unknown_setup_policy: policy, unknown_setup_default_minutes: minutes }) },
        );
        if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.detail || `HTTP ${response.status}`); }
        const saved = await response.json();
        plantRow.setup_policy_config = { ...(plantRow.setup_policy_config ?? {}), ...saved.setup_policy_config };
        Toast.show(Util.t('ui.unknown_setup_saved'), 'success');
      } catch (error) {
        unknownSetupSelect.value = previousPolicy; unknownSetupMinutesInp.value = String(previousMinutes);
        unknownSetupMinutesRow.hidden = previousPolicy !== 'plantDefaultMinutes';
        Toast.show(`${Util.t('ui.unknown_setup_failed')}: ${(error as Error).message}`, 'error');
      } finally { unknownSetupSelect.disabled = false; unknownSetupMinutesInp.disabled = false; }
    }
    unknownSetupSelect.addEventListener('change', saveUnknownSetupPolicy);
    unknownSetupMinutesInp.addEventListener('change', saveUnknownSetupPolicy);
```
Executor check: confirm how `plantRow` is resolved at the top of `_renderSettingsPane`; if it is a copy rather than the `Store.masterData.plants` entry, also patch the Store entry so the next optimizer snapshot sees the new policy without a reload (the split-policy handler at `:1387-1418` shows which it does).

- [ ] **Step 4: Build, lint, run, commit**

```powershell
npm run build; npm run lint; node --test tests/modules/locale-completeness.test.mjs tests/modules/master-data/*.test.mjs
```
```bash
git add frontend/master-data/admin-ui.mts frontend/locales/*.js tests/modules/locale-completeness.test.mjs
git commit -m "feat(master-data): Scheduling Rules control for the per-plant unknown-setup policy (N8)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N5b: `maxLatenessMinutes` objective term

**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts` (`ObjectiveFacts` :367-382; `DueDateCandidate` :783-806; `candidateForSequence` :2453-2467, :2488, :2619-2623, :2649-2653, :2743-2765; concat :4012-4038; `compareDueDateCandidate` :2352-2370; `compareCandidate` :2419-2423; `fragmentObjectiveFacts` :6474-6489; `compareObjectiveFacts` :6506-6534; `objectiveFactsForCandidate` :6561-6577, :6643-6656)
- Test: `tests/modules/setup-scheduler.test.mjs`

**Interfaces:**
- Produces: `ObjectiveFacts.maxLatenessMinutes: number`; `DueDateCandidate.maxLatenessMinutes?: number`. Consumed by N5c (same plumbing shape).

- [ ] **Step 1: Write the failing comparator test** (append after the SPT comparator test, `:384`)

```js
test('objective facts prefer the smaller worst-case lateness when late count and total lateness tie', () => {
  const base = {
    hardErrors: 0, overCap: 0, lateCount: 2, latenessMinutes: 120, uncoveredEdges: 0,
    setupMinutes: 0, scheduledCount: 2, instabilityMinutes: 0, policyKey: '00', sequenceKey: 'A|B',
  };
  const balanced = { ...base, maxLatenessMinutes: 60 };
  const lopsided = { ...base, maxLatenessMinutes: 110 };
  for (const mode of ['due-date-first', 'due-date', 'min-changeover', 'spt', 'throughput']) {
    assert.ok(SetupScheduler.compareObjectiveFacts(balanced, lopsided, mode) < 0,
      `${mode} must rank worst-case lateness immediately after total lateness`);
  }
  // Legacy facts without the field compare as 0 — never NaN.
  assert.equal(SetupScheduler.compareObjectiveFacts(base, base, 'due-date'), 0);
});
```

- [ ] **Step 2: Run to verify it fails**

```powershell
npm run build; node --test tests/modules/setup-scheduler.test.mjs --test-name-pattern="worst-case lateness"
```

- [ ] **Step 3: Add the field to `ObjectiveFacts` and `DueDateCandidate`**

`:371` after `latenessMinutes: number;`:
```ts
  /** Largest single-order lateness in minutes (N5, 2026-09). Compared right
   * after `latenessMinutes` in every mode so equal totals prefer the schedule
   * that does not make one already-late order much later. */
  maxLatenessMinutes: number;
```
`:799` after `productiveRuntimeMinutes?: number;`:
```ts
  /** N5: per-fragment maxima/sums carried beside `score[]` rather than as new
   * score slots — the score vector is pinned 8-wide and is SUMMED across lines
   * (a maximum must not be). Combined with Math.max at fragment concatenation. */
  maxLatenessMinutes?: number;
  instabilityMinutes?: number;
```

- [ ] **Step 4: Track it in `candidateForSequence`**

`:2455` add `let maxLatenessMinutes = 0;`. Checkpoint type (`:2467`) and literal (`:2488`) gain `maxLatenessMinutes`. Replace `:2619-2623`:
```ts
    const due = dueTimestamp(task);
    if (Number.isFinite(due) && last.end.getTime() > due) {
      const lateMinutes = Math.ceil((last.end.getTime() - due) / (60 * 1000));
      lateCount += 1;
      latenessMinutes += lateMinutes;
      maxLatenessMinutes = Math.max(maxLatenessMinutes, lateMinutes);
    }
```
Backtrack restore `:2652`: `maxLatenessMinutes = prior.maxLatenessMinutes;`. Return literal `:2761`: `maxLatenessMinutes,` beside `productiveRuntimeMinutes`.

- [ ] **Step 5: Combine at fragment concatenation** (`:4036`, in the return literal)

```ts
    maxLatenessMinutes: Math.max(preFirmed.maxLatenessMinutes ?? 0, continuation.maxLatenessMinutes ?? 0),
```

- [ ] **Step 6: Compare it**

`compareDueDateCandidate` after `:2360`:
```ts
  const maxLatenessDelta = (left.maxLatenessMinutes ?? 0) - (right.maxLatenessMinutes ?? 0);
  if (maxLatenessDelta) return maxLatenessDelta;
```
`compareCandidate` replace `:2419-2423`:
```ts
  const terms = mode === 'throughput' ? [5, 2, 3, 4] : [2, 3, 4, 5];
  for (const index of terms) {
    const delta = (left.score[index] ?? 0) - (right.score[index] ?? 0);
    if (delta) return delta;
    if (index === 3) {
      const maxLatenessDelta = (left.maxLatenessMinutes ?? 0) - (right.maxLatenessMinutes ?? 0);
      if (maxLatenessDelta) return maxLatenessDelta;
    }
  }
```
`compareObjectiveFacts`: in all five `terms` arrays insert `['maxLatenessMinutes', false],` immediately after `['latenessMinutes', false],`.
`fragmentObjectiveFacts`: `maxLatenessMinutes: candidate.maxLatenessMinutes ?? 0,` after `latenessMinutes`.
`objectiveFactsForCandidate`: `:6561` `let maxLateness = 0;`; in the loop compute each order's lateness into a local for both the `needs_planning` and the scheduled branch and `maxLateness = Math.max(maxLateness, orderLateness)`; return literal adds `maxLatenessMinutes: maxLateness,`.

- [ ] **Step 7: Build, run the whole file, diff against baseline**

```powershell
npm run build; node --test tests/modules/setup-scheduler.test.mjs 2>&1 | Tee-Object -FilePath "$env:SCRATCHPAD\n5b.txt"
Compare-Object (Select-String -Path "$env:SCRATCHPAD\n5-baseline-failures.txt" -Pattern '^not ok') (Select-String -Path "$env:SCRATCHPAD\n5b.txt" -Pattern '^not ok')
```
Expected: new test PASS; `Compare-Object` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add frontend/optimization/setup-scheduler.mts tests/modules/setup-scheduler.test.mjs
git commit -m "feat(optimizer): rank worst-case lateness right after total lateness in every mode (N5)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N5c: Fragment-level instability is no longer hardcoded 0

**Files:**
- Modify: `frontend/optimization/setup-scheduler.mts` (`candidateForSequence` locals/checkpoint/placement/return; concat `:4036`; `fragmentObjectiveFacts` `:6483`; one test-seam export at file bottom)
- Test: `tests/modules/setup-scheduler.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('fragment search charges instability for moved starts instead of a hardcoded zero', () => {
  const stable = { feasible: true, patches: [], score: [0,0,0,0,0,0,0,0], policyKey: '', sequenceKey: 'a|b',
    unadmitted: [], explanation: [], missingEdges: [], instabilityMinutes: 0 };
  const shuffled = { ...stable, sequenceKey: 'b|a', instabilityMinutes: 120 };
  assert.ok(SetupScheduler.compareObjectiveFacts(
    SetupScheduler.fragmentObjectiveFactsForTest(stable),
    SetupScheduler.fragmentObjectiveFactsForTest(shuffled), 'min-changeover') < 0,
    'a fragment that moved starts must lose the instability tie-break');
  // Incumbent order in due sequence: a run that keeps it carries zero instability.
  const first = scheduledTask('stab-a', 1, 'GREEN', '2026-08-03T18:00', '2026-08-03T08:00', '2026-08-03T09:00');
  const second = scheduledTask('stab-b', 1, 'GREEN', '2026-08-03T18:00', '2026-08-03T09:00', '2026-08-03T10:00');
  const result = SetupScheduler.evaluateMinChangeover(setupSnapshot([second, first]), dueDateBounds(setupTruth()));
  assert.equal(result.objective?.instabilityMinutes, 0, 'the incumbent order carries zero instability');
});
```
Add the seam at the bottom of `setup-scheduler.mts` beside the other test exports: `export const fragmentObjectiveFactsForTest = fragmentObjectiveFacts;`.

- [ ] **Step 2: Run to verify failure**

```powershell
npm run build; node --test tests/modules/setup-scheduler.test.mjs --test-name-pattern="instability for moved starts"
```
Expected: FAIL (`fragmentObjectiveFactsForTest` undefined / instability compares 0 vs 0).

- [ ] **Step 3: Implement**

`candidateForSequence`: `let instabilityMinutes = 0;` beside `maxLatenessMinutes`; add to checkpoint type/literal and backtrack restore. After the `patches.push({...})` at `:2617`:
```ts
    const priorStart = timestamp(task.start_date);
    if (priorStart) instabilityMinutes += Math.abs(first.start.getTime() - priorStart.getTime()) / 60000;
```
(`timestamp` is the helper used at `:6575`; `task` is the snapshot's own row, so `task.start_date` is the pre-patch baseline, the same source `objectiveFactsForCandidate` uses.) Return literal: `instabilityMinutes,`. Concat `:4036`: `instabilityMinutes: (preFirmed.instabilityMinutes ?? 0) + (continuation.instabilityMinutes ?? 0),`. `fragmentObjectiveFacts` `:6483` → `instabilityMinutes: candidate.instabilityMinutes ?? 0,`.

- [ ] **Step 4: Measure runtime, run the file, diff against baseline**

```powershell
npm run build
Measure-Command { node --test tests/modules/setup-scheduler.test.mjs > "$env:SCRATCHPAD\n5c.txt" 2>&1 } | Select-Object TotalSeconds
Compare-Object (Select-String -Path "$env:SCRATCHPAD\n5-baseline-failures.txt" -Pattern '^not ok') (Select-String -Path "$env:SCRATCHPAD\n5c.txt" -Pattern '^not ok')
```
Expected: same failure set; wall time within ~10% of the N5a measurement. If it is not, stop and report rather than keep it.

- [ ] **Step 5: Commit**

```bash
git add frontend/optimization/setup-scheduler.mts tests/modules/setup-scheduler.test.mjs
git commit -m "feat(optimizer): score fragment instability from moved starts instead of hardcoded 0 (N5)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task N5d: Document the due-date tier inversion (CLAUDE.md + mode tips, 5 locales)

**Files:**
- Modify: `frontend/optimization/CLAUDE.md` ("Admission and strategy objectives" bullet)
- Modify: `frontend/locales/{en,de,es,fr,pt}.js` (`tip.duedate_mode`, `tip.changeover_mode`)
- Test: `tests/modules/locale-completeness.test.mjs`

- [ ] **Step 1: Locale pin (failing)** — append a test requiring `['tip.duedate_mode', 'tip.changeover_mode']` in all 5 locales (same shape as the `constraint.*` test at `:32-40`). Run → FAIL: de/es/fr/pt lack `tip.duedate_mode` and carry stale `tip.changeover_mode` copy.

- [ ] **Step 2: Reword `en.js:1193-1194`**

```js
  'tip.changeover_mode': "Min Changeover — the plant's priority lists rank first, then fewest orders over the push-forward limit, then fewest late orders and least late hours (never making an already-late order much later), then setup savings. Honors the pull-forward and push-forward limits.",
  'tip.duedate_mode':    'Due Date — lateness ranks first: fewest orders over the push-forward limit, then fewest late orders, then least late hours and smallest worst-case lateness. Only then do priority lists and color/setup grouping break ties. Never starts an order before its pull-forward limit.',
```
Add both keys to de/es/fr/pt beside their existing `tip.changeover_mode`, with the MISSING TRANSLATION marker convention.

- [ ] **Step 3: CLAUDE.md** — append to the "Admission and strategy objectives" bullet:

> **Tier inversion:** `'due-date'` mode compares late count, total lateness and worst-case lateness *before* `policyKey`; every other mode compares `policyKey` first and lateness after (`compareDueDateCandidate` vs `compareCandidate`, setup-scheduler.mts). This is the per-plant "priority tiers vs. lateness" tradeoff — chosen by mode, not by a setting.

- [ ] **Step 4: Run and commit**

```powershell
node --test tests/modules/locale-completeness.test.mjs
```
```bash
git add frontend/optimization/CLAUDE.md frontend/locales/*.js tests/modules/locale-completeness.test.mjs
git commit -m "docs(optimizer): state the due-date vs priority tier order in mode tips and CLAUDE.md (N5)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

**Noted, out of scope:** `orders.mts`/`optimize-ui.mts` show `planning_reason.message` raw, so the new `setup_transition_unrecorded` message appears in English like every other reason code. Weighted lateness (L4) stays deferred.

---

## Verification (end-to-end, after all tasks)

1. **Static:** `npm run typecheck && npm run lint && npm run check:legacy-surface && npm run check:static-assets`.
2. **Scoped tests (must all pass):**
   ```bash
   npm run build
   node --test tests/js/compute-core.test.js
   node --test tests/modules/insights/diff.test.mjs
   node --test tests/modules/setup-scheduler.test.mjs      # diff failures against the N5 baseline capture
   node --test tests/modules/scheduling/persistence.test.mjs
   node --test tests/modules/locale-completeness.test.mjs
   python -m pytest tests/test_task_response_models.py tests/test_master_data_setup_policy.py -q
   ```
   `tests/test_task_concurrency.py` new cases are `@pytest.mark.pg` and skip here; they run only with a local Postgres and `NIMBUS_TEST_DB=1`.
3. **Manual smoke (local `uvicorn brain:api --port 8000`, owner runs):**
   - N1: take a snapshot, change one order's duration only, Cmd+K → Compare Schedules → one row badged *finish*.
   - N2: flip `CONCURRENCY_CHECK` to `false`, rebuild, reload → banner visible and an `ErrorLog` warn entry; flip back.
   - N3: drag order B onto order A's slot on one line, save → warn toast with conflict count and the overlap alert appears without waiting for a manual recompute.
   - N4: set the same PRT_01 on two overlapping orders on different lines → one *tool-conflict* alert; Fix moves the later one right on its own line.
   - N6: run Optimize on a plant with an unrecorded line state and one uncovered transition → Missing setup times table shows two different remedies; CSV has a Remedy column.
   - N8: set policy `plantDefaultMinutes: 45` in Scheduling Rules → preview charges 45 min on an uncovered edge; `excludeFromSearch` → the order lands in the Needs Planning filter with a readable reason; `zero` → identical to before.
   - N5: Optimize dialog hints state the tier order; a run completes within the same wall-clock budget as before (compare `diagnostics.elapsed`).
   - N7: Dashboard queued tile → Orders tab filtered to Needs Planning; shortcut help lists Alt+hover ripple.
4. **Docs:** `Code_Review_09_01.md` N7 corrected (Ripple live, APO doc predates `needs_planning`); `backend/scheduling/CLAUDE.md` force bullet corrected; `frontend/optimization/CLAUDE.md` tier-inversion sentence present.
