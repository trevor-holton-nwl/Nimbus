# Setup Matrix List View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Changeover-minutes grid's "grid-only" view with a List view (From/To/Minutes/Plant value/Source, inline edit, revert-to-plant arrow, Add-pair row, Mass upload) as the *default*, keeping the existing cartesian grid as a secondary "Matrix" view behind a toggle — because a real signature is ~1,600 states per axis and the full grid is millions of cells.

**Architecture:** `SetupAdmin` (`web/plant-and-administration.mts`) gains a `_setupView` toggle ('list' default | 'matrix'), a new paginated, from-state-scoped backend endpoint (`GET /setup/{plant}/matrix-rows`) that the List view fetches instead of relying on the full `get_setup_snapshot()` payload, and a Mass-upload modal that parses pasted rows into the *same* `_gridDirty` staging map the grid already uses — so Save/Discard/dirty-count logic is shared unchanged between both views. Nothing new is invented for validation or persistence; the List/Mass-upload work is UI plus one new read endpoint.

**Tech Stack:** TypeScript (`.mts` compiled by `tsc`, see `docs/typescript_migration.md`), FastAPI (`brain.py`), `setup_data.py` (Postgres access), vanilla-JS IIFE module pattern (no framework), existing `.setup-*` CSS token system.

**Spec:** `Setup Matrix Redesign v2.dc.html` (visual/interaction target — a throwaway prototype; do not copy its markup or its `support.js` runtime, both are prototype-only). This plan's code is authored directly against the real `SetupAdmin` module read at `web/plant-and-administration.mts:128-1277` (current "four-band" layout, commit `9576055`, **not** the stale two-panel draft that was in this project's root as a bare `plant-and-administration.mts` copy — that file predates the four-band redesign and must not be merged from).

## Global Constraints

- Schema bound for setup minutes is **0–10080** (`setup_data.MAX_SETUP_MINUTES`) — both server (`validate_matrix_rows`) and client validation must use this exact bound.
- **Nothing writes to the backend until Save.** Every edit — grid cell, List row, mass-upload row — stages into the existing `_gridDirty: Map<string, SetupGridEdit>` and is only sent by the existing `saveGridEdits()` → `buildSaveRequests()` → `POST/DELETE /setup/{plant}/matrix...` pipeline.
- Follow the **two label treatments only** rule already established in this module (`.mono-eyebrow` for structural readouts, `.label` for form labels) — do not add a third.
- All new user-facing strings go through `Util.t()` / `web/locales/en.js` — no hardcoded English (per `nimbus-i18n-preference` convention already used everywhere else in this module).
- The root-level scratch files `plant-and-administration.mts`, `en.js`, `styles.css`, and both `*.dc.html` mockups in the project root are **prototype/reference material only** (per user instruction). Do not read them as source of truth for current module structure — always read `web/plant-and-administration.mts` directly. Delete the root scratch copies in the final task once no longer needed for comparison.

---

### Task 1: Backend — paginated, from-state-scoped matrix-row endpoint

**Files:**
- Modify: `setup_data.py` (add `page_matrix_rows` near `page_missing_pairs` at `setup_data.py:784`)
- Modify: `brain.py` (add `GET /setup/{plant}/matrix-rows` near `get_setup_coverage` at `brain.py:2416`)
- Test: `tests/test_setup_endpoints.py`, `tests/test_setup_data.py`

**Interfaces:**
- Produces: `setup_data.page_matrix_rows(plant: str, line: str, signature_version: int, *, from_key: list[dict] | None = None, offset: int = 0, limit: int = 100) -> dict` returning `{"plant": str, "line": str, "signature_version": int, "rows": list[EffectiveRow], "meta": {"total": int, "offset": int, "limit": int}}` where each `EffectiveRow` is `{"from_key": list, "to_key": list, "setup_min": int, "source": str, "inherited": bool, "plant_value": int | None}`.
- Consumes: `_require_definition`, `_pool` (both already in `setup_data.py`), `Jsonb` from `psycopg.types.json`.

The endpoint scopes its SQL `WHERE` to `line IN ('', :line)` (plant-default rows plus the one requested line's overrides) and, when `from_key` is supplied, an exact JSONB equality filter on `from_key` — this is the "from-state-scoped" fetch the current `GET /setup/{plant}` snapshot cannot do (it always loads every line's rows for the whole plant/version in one query, see `setup_data.py:627-679`). This endpoint is purely additive; it does not touch `get_setup_snapshot`, `get_setup_coverage`, or the grid's existing data flow.

- [ ] **Step 1: Write the failing endpoint test**

Add to `tests/test_setup_endpoints.py` (follow the existing `_SetupService` double pattern at the top of that file):

```python
class _SetupServiceWithMatrixRows(_SetupService):
    def page_matrix_rows(self, plant, line, signature_version, from_key=None, offset=0, limit=100):
        assert plant == "PLANT-A"
        rows = [
            {"from_key": [{"fieldKey": "colorWheel", "value": "BLUE"}],
             "to_key": [{"fieldKey": "colorWheel", "value": "RED"}],
             "setup_min": 35, "source": "manual", "inherited": False, "plant_value": 30},
            {"from_key": [{"fieldKey": "colorWheel", "value": "BLUE"}],
             "to_key": [{"fieldKey": "colorWheel", "value": "WHITE"}],
             "setup_min": 40, "source": "manual", "inherited": True, "plant_value": 40},
        ]
        if from_key is not None:
            rows = [r for r in rows if r["from_key"] == from_key]
        return {"plant": plant, "line": line, "signature_version": signature_version,
                "rows": rows[offset:offset + limit],
                "meta": {"total": len(rows), "offset": offset, "limit": limit}}


def test_get_setup_matrix_rows_scopes_by_line_and_from_state(monkeypatch):
    monkeypatch.setattr(brain, "setup_data", _SetupServiceWithMatrixRows())
    monkeypatch.setattr(auth, "require_authenticated", lambda: "tester@example.com")
    client = TestClient(brain.api)
    response = client.get(
        "/setup/PLANT-A/matrix-rows",
        params={"line": "LINE-1", "from_key": '[{"fieldKey":"colorWheel","value":"BLUE"}]', "limit": 1},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["meta"]["total"] == 2
    assert len(body["rows"]) == 1
    assert body["rows"][0]["setup_min"] == 35


def test_get_setup_matrix_rows_rejects_bad_limit(monkeypatch):
    monkeypatch.setattr(brain, "setup_data", _SetupServiceWithMatrixRows())
    monkeypatch.setattr(auth, "require_authenticated", lambda: "tester@example.com")
    client = TestClient(brain.api)
    response = client.get("/setup/PLANT-A/matrix-rows", params={"limit": 0})
    assert response.status_code in (400, 422)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m pytest tests/test_setup_endpoints.py -k matrix_rows -v`
Expected: FAIL — `AttributeError` or 404, since the endpoint doesn't exist yet.

- [ ] **Step 3: Implement `setup_data.page_matrix_rows`**

Insert into `setup_data.py` immediately after `page_missing_pairs` (currently ending at line 792):

```python
def page_matrix_rows(plant: str, line: str, signature_version: int, *, from_key: list | None = None,
                     offset: int = 0, limit: int = 100) -> dict:
    """Return one bounded, from-state-scoped page of effective matrix rows.

    Scoped by line (plant-default rows plus this one line's overrides) so a
    List view never has to load every line's recorded rows for the whole
    plant, unlike get_setup_snapshot. When from_key is supplied the SQL WHERE
    filters on it directly (JSONB equality on the canonical, deterministically
    ordered key), so the common "rows starting from one state" case is a
    narrow, indexed lookup rather than a fetch-then-filter.
    """
    plant = _required_text(plant, "Plant")
    line = line or ""
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise ValueError("offset must be a nonnegative integer")
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    with _pool.connection() as conn, conn.cursor() as cur:
        _require_definition(cur, plant, signature_version, lock=False)
        where = ["plant = %s", "signature_version = %s", "line IN ('', %s)"]
        params: list = [plant, signature_version, line]
        if from_key is not None:
            where.append("from_key = %s")
            params.append(Jsonb(from_key))
        clause = " AND ".join(where)
        cur.execute(
            f"SELECT line, from_key, to_key, setup_min, source FROM setup_matrix "
            f"WHERE {clause} ORDER BY from_key, to_key, line DESC",
            params,
        )
        raw = cur.fetchall()
    # Merge line-over-plant inheritance in Python — the raw set is already
    # bounded to one line's scope (plus plant-default) by the SQL above, so
    # this mirrors the client's effectiveRows() at a scale the query already
    # narrowed, not a second unbounded fetch.
    plant_by_key: dict[str, dict] = {}
    line_by_key: dict[str, dict] = {}
    for r in raw:
        key = f"{json.dumps(r[1], sort_keys=True)}\x00{json.dumps(r[2], sort_keys=True)}"
        entry = {"from_key": r[1], "to_key": r[2], "setup_min": int(r[3]), "source": r[4]}
        if r[0] == "":
            plant_by_key[key] = entry
        else:
            line_by_key[key] = entry
    merged: dict[str, dict] = {}
    for key, entry in plant_by_key.items():
        merged[key] = {**entry, "inherited": not line, "plant_value": entry["setup_min"]}
    for key, entry in line_by_key.items():
        plant_value = plant_by_key.get(key, {}).get("setup_min")
        merged[key] = {**entry, "inherited": False, "plant_value": plant_value}
    rows = list(merged.values())
    total = len(rows)
    return {"plant": plant, "line": line, "signature_version": signature_version,
            "rows": rows[offset:offset + limit],
            "meta": {"total": total, "offset": offset, "limit": limit}}
```

- [ ] **Step 4: Add the endpoint to `brain.py`**

Insert after `get_setup_coverage` (currently ending at `brain.py:2425`):

```python
@api.get("/setup/{plant}/matrix-rows", dependencies=[Depends(auth.require_authenticated)])
def get_setup_matrix_rows(plant: str, line: str = Query(default=""), from_key: str | None = Query(default=None),
                          offset: int = Query(default=0, ge=0), limit: int = Query(default=100, ge=1, le=500),
                          allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Bounded, from-state-scoped page of effective matrix rows for the List view."""
    _setup_plant_guard(plant, allowed_plants)
    try:
        parsed_from_key = json.loads(from_key) if from_key else None
        snapshot = setup_data.get_setup_snapshot(plant)
        definition = snapshot.get("definition")
        if definition is None:
            return _setup_freshness({"plant": plant, "line": line, "signature_version": None, "rows": [],
                                     "meta": {"total": 0, "offset": offset, "limit": limit}})
        return _setup_freshness(setup_data.page_matrix_rows(
            plant, line, definition["signature_version"], from_key=parsed_from_key, offset=offset, limit=limit,
        ))
    except (ValueError, json.JSONDecodeError) as exc:
        raise _setup_error(exc) from exc
```

Note: this calls `get_setup_snapshot` once only to resolve the *current* `signature_version` (a cheap, already-existing lookup — the definition row alone, not the full row set, since `_definition()` inside it is the only part exercised before `page_matrix_rows` does its own bounded query). If this extra round-trip is later found to be measurable, resolve the version via a small dedicated `setup_data._current_signature_version(plant)` helper instead — out of scope for this task.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m pytest tests/test_setup_endpoints.py -k matrix_rows -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add setup_data.py brain.py tests/test_setup_endpoints.py
git commit -m "feat: add from-state-scoped setup matrix row endpoint"
```

---

### Task 2: Frontend — List/Matrix view toggle, List defaults to on

**Files:**
- Modify: `web/plant-and-administration.mts` (`SetupAdmin` module, `renderSnapshot` at line 582, module state block at line 128)
- Modify: `web/locales/en.js`
- Modify: `web/styles.css`

**Interfaces:**
- Consumes: existing `_gridFilterFrom`/`_gridFilterTo` (line 144-145), `_lineScope` (135), `effectiveRows()` (220), `fieldValueSet()` (274), `stateSig()` (251), `esc()` (168), `Util.t()`.
- Produces: `_setupView: 'list' | 'matrix'` module state (defaults `'list'`); `renderListView(target, snapshot, definition, rows, permissions)` function that later tasks extend; a `setup-view-toggle` DOM region inside the existing `.setup-band.setup-grid-band` header, replacing the toolbar's bare filter inputs with a tab bar + filters.

- [ ] **Step 1: Add view-state module variable**

In `web/plant-and-administration.mts`, near `_signaturePopoverOpen` (line 155), add:

```typescript
  // List/Matrix toggle (Setup_matrix_redesign v2): List is the default because
  // a real signature is ~1,600 states per axis — the cartesian grid is a
  // secondary, opt-in view for spot-checking a narrow slice, not the primary
  // editing surface.
  let _setupView: 'list' | 'matrix' = 'list';
  let _hideEmptyStates = true;
  let _listRows: Array<{ from_key: SetupStateKey; to_key: SetupStateKey; setup_min: number; source: string; inherited: boolean; plant_value: number | null }> = [];
  let _listMeta = { total: 0, offset: 0, limit: 50 };
  let _listNewRows: Array<{ id: number; from: string; to: string; minutes: string }> = [];
  let _listNextRowId = 1;
```

- [ ] **Step 2: Add en.js keys**

In `web/locales/en.js`, alongside the existing `ui.setup_*` block (near line 1402 onward), add:

```javascript
  'ui.setup_view_list':                'List',
  'ui.setup_view_matrix':              'Matrix',
  'ui.setup_list_col_from':            'From',
  'ui.setup_list_col_to':              'To',
  'ui.setup_list_col_minutes':         'Minutes',
  'ui.setup_list_col_plant_value':     'Plant value',
  'ui.setup_list_col_source':          'Source',
  'ui.setup_list_source_override':     'Line override · {{line}}',
  'ui.setup_list_source_inherited':    'Inherited from plant',
  'ui.setup_list_source_gap':          'Gap — no recorded value',
  'ui.setup_list_hide_empty':          'Hide states with no value',
  'ui.setup_list_add_pair':            'Add pair',
  'ui.setup_list_showing':             'Showing {{shown}} of {{total}} recorded pairs for {{from}}',
  'ui.setup_list_revert_title':        'Revert to the plant value',
  'ph.setup_list_from':                'e.g. BLUE | T1',
  'ph.setup_list_to':                  'e.g. GREEN | T3',
  'ph.setup_list_minutes':             'min',
  'ui.setup_list_row_needs_states':    'Needs both states',
  'ui.setup_list_row_needs_minutes':   'Needs minutes',
  'ui.setup_list_row_bad_minutes':     'Minutes must be 0–10080',
  'ui.setup_list_row_staged':          'Staged — unsaved',
  'ui.setup_list_row_unknown_state':   'Unknown state value for this signature',
```

- [ ] **Step 3: Add the toggle + reroute `renderSnapshot`'s grid band**

In `web/plant-and-administration.mts`, replace the `setup-grid-band` block (lines 665-671):

```typescript
        <div class="setup-band setup-grid-band">
          <div class="setup-grid-toolbar">
            <input type="text" class="input setup-grid-filter" data-setup-grid-filter-from placeholder="${esc(Util.t('ui.setup_grid_filter_from_placeholder'))}" value="${esc(_gridFilterFrom)}">
            <input type="text" class="input setup-grid-filter" data-setup-grid-filter-to placeholder="${esc(Util.t('ui.setup_grid_filter_to_placeholder'))}" value="${esc(_gridFilterTo)}">
          </div>
          <div id="setup-grid-table-mount"></div>
        </div>
```

with:

```typescript
        <div class="setup-band setup-grid-band">
          <div class="setup-view-toolbar">
            <span class="mono-eyebrow">${esc(Util.t('ui.setup_section_matrix'))}</span>
            <div class="setup-view-tabs" role="tablist">
              <button type="button" role="tab" aria-selected="${_setupView === 'list'}" class="setup-view-tab${_setupView === 'list' ? ' active' : ''}" data-setup-view="list">${esc(Util.t('ui.setup_view_list'))}</button>
              <button type="button" role="tab" aria-selected="${_setupView === 'matrix'}" class="setup-view-tab${_setupView === 'matrix' ? ' active' : ''}" data-setup-view="matrix">${esc(Util.t('ui.setup_view_matrix'))}</button>
            </div>
            <div class="setup-view-actions">
              <button type="button" class="btn btn-primary sm" data-setup-mass-upload-open>${esc(Util.t('btn.setup_mass_upload'))}</button>
              <button type="button" class="btn btn-ghost sm" data-setup-export-matrix ${permissions.export ? '' : 'disabled'}>${esc(Util.t('btn.setup_export_matrix'))}</button>
              <button type="button" class="btn btn-ghost sm" data-setup-history-open>${esc(Util.t('btn.setup_audit_toggle', { count: overrides.length }))}</button>
            </div>
          </div>
          <div class="setup-grid-toolbar">
            <input type="text" class="input setup-grid-filter" data-setup-grid-filter-from placeholder="${esc(Util.t('ui.setup_grid_filter_from_placeholder'))}" value="${esc(_gridFilterFrom)}">
            <input type="text" class="input setup-grid-filter" data-setup-grid-filter-to placeholder="${esc(Util.t('ui.setup_grid_filter_to_placeholder'))}" value="${esc(_gridFilterTo)}">
            ${_setupView === 'list' ? `<label class="setup-check"><input type="checkbox" data-setup-list-hide-empty ${_hideEmptyStates ? 'checked' : ''}>${esc(Util.t('ui.setup_list_hide_empty'))}</label>` : ''}
          </div>
          <div id="setup-list-mount" ${_setupView === 'list' ? '' : 'hidden'}></div>
          <div id="setup-grid-table-mount" ${_setupView === 'matrix' ? '' : 'hidden'}></div>
        </div>
```

Note: this moves `Export CSV`/`History` out of the `⋯` overflow menu into plain buttons (matching the mockup's flat toolbar) and adds the Mass-upload entry point. Leave the `setup-menu` (`⋯`) block at lines 679-687 in place for `Copy CSV`/`Import CSV` only (still useful, less prominent actions) — remove the now-duplicated `Export`/`History` menu items from it so each action has exactly one home:

```typescript
        <div class="setup-band setup-action-bar">
          <span data-setup-grid-dirty-count>${esc(Util.t('ui.setup_grid_dirty_count', { count: _gridDirty.size }))}</span>
          <div class="setup-action-buttons">
            <button class="btn btn-ghost sm" data-setup-grid-discard ${_gridDirty.size ? '' : 'disabled'}>${esc(Util.t('btn.discard'))}</button>
            <button class="btn btn-primary sm" data-setup-grid-save ${_gridDirty.size ? '' : 'disabled'}>${esc(Util.t('btn.save'))}</button>
          </div>
          <div class="setup-menu">
            <button type="button" class="btn btn-ghost sm" data-setup-menu-toggle aria-haspopup="true" aria-expanded="${_setupMenuOpen}">&#8943;</button>
            <div class="setup-menu-list" data-setup-menu-list role="menu" ${_setupMenuOpen ? '' : 'hidden'}>
              <button type="button" role="menuitem" data-setup-copy-matrix ${permissions.copy ? '' : 'disabled'}>${esc(Util.t('btn.setup_copy_matrix'))}</button>
              ${permissions.matrixWrite && definition ? `<label class="setup-menu-item" role="menuitem">${esc(Util.t('ui.setup_import_csv'))}<input type="file" accept=".csv,text/csv" data-setup-import hidden></label>` : ''}
            </div>
          </div>
        </div>
```

- [ ] **Step 4: Wire the view toggle in `wire()`**

In `wire()` (starting `web/plant-and-administration.mts:737`), add near the other toggle buttons:

```typescript
    target.querySelectorAll<HTMLButtonElement>('[data-setup-view]').forEach(button => {
      button.addEventListener('click', () => {
        const next = button.dataset.setupView as 'list' | 'matrix';
        if (next === _setupView) return;
        _setupView = next;
        renderSnapshot(target, snapshot);
      });
    });
```

Also route `paintGrid`'s call site: when `_setupView === 'matrix'`, keep calling `paintGrid` as today; when `'list'`, call the new `renderListView` (built in Task 3) instead. At the bottom of `renderSnapshot` (line 696-697):

```typescript
    wire(target, snapshot, permissions, rows, definition);
    if (_setupView === 'matrix') paintGrid(target, snapshot, definition, rows, permissions);
    else renderListView(target, snapshot, definition, permissions);
```

- [ ] **Step 5: Add toggle + toolbar CSS**

In `web/styles.css`, after `.setup-grid-cap-note` (line 6113):

```css
.setup-view-toolbar { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; justify-content: space-between; }
.setup-view-tabs { display: flex; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
.setup-view-tab { height: 26px; padding: 0 12px; border: 0; background: var(--bg-elev); color: var(--fg-mute); font: 600 11px/1 var(--body-font, inherit); cursor: pointer; transition: background .14s ease-out, color .14s ease-out; }
.setup-view-tab.active { background: var(--accent); color: var(--bg-elev); }
.setup-view-actions { display: flex; gap: 6px; flex-wrap: wrap; }
```

- [ ] **Step 6: Compile and manually verify the toggle**

Run: `npm run build`
Then start the app (`uvicorn brain:api --port 8000 --reload`), open Master Data → a plant → Setup Matrix, and confirm: the List/Matrix tabs render, List is selected by default, clicking Matrix shows the existing grid unchanged, clicking back to List does not crash (an empty `#setup-list-mount` is fine at this step — `renderListView` doesn't exist until Task 3).

- [ ] **Step 7: Commit**

```bash
git add web/plant-and-administration.mts web/locales/en.js web/styles.css
git commit -m "feat: add List/Matrix view toggle to Setup Matrix, defaulting to List"
```

---

### Task 3: Frontend — List view rendering, fetch, and inline edit

**Files:**
- Modify: `web/plant-and-administration.mts`

**Interfaces:**
- Consumes: `_listRows`, `_listMeta`, `_listNewRows`, `_setupView`, `_lineScope`, `_gridFilterFrom`, `_gridFilterTo`, `_hideEmptyStates` (Task 2); `_gridDirty: Map<string, SetupGridEdit>`, `gridEditKey()`, `stateSig()`, `keyText()`, `parseGridMinutes()`, `esc()`, `Util.t()`, `Session.actor()`, `Config.API_BASE`.
- Produces: `renderListView(target, snapshot, definition, permissions): void` — fetches the new endpoint, paints the table, and wires row-level inputs/revert buttons that write into `_gridDirty` (so `saveGridEdits`/`paintGrid`'s dirty-count/Save-Discard bar, already wired in Task 2's `renderSnapshot`, work unchanged for List-originated edits too).

- [ ] **Step 1: Fetch helper**

Add near `loadCoverage` (`web/plant-and-administration.mts:540`):

```typescript
  async function fetchListRows(plant: string, definition: SetupDefinition, fromKey: SetupStateKey | null): Promise<void> {
    const params = new URLSearchParams({ line: _lineScope, offset: String(_listMeta.offset), limit: String(_listMeta.limit) });
    if (fromKey) params.set('from_key', JSON.stringify(fromKey));
    try {
      const response = await Util.fetchTraced(`${API}/setup/${encodeURIComponent(plant)}/matrix-rows?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { rows: typeof _listRows; meta: typeof _listMeta };
      _listRows = data.rows;
      _listMeta = data.meta;
    } catch (error) {
      ErrorLog.warn('setup-admin', `Setup matrix rows unavailable: ${(error as Error).message}`);
      _listRows = []; _listMeta = { ..._listMeta, total: 0 };
    }
  }
```

`fromKey` resolution: the List view's "From" filter (`_gridFilterFrom`) is free text (matching the existing grid filter's UX), while the endpoint's `from_key` param wants a canonical key. Resolve it only when the typed text exactly matches one known state's joined parts (via the same `fieldValueSet`/`cartesianStates` machinery already in this file) — otherwise fetch unfiltered and let the client narrow the *displayed* page by substring, same fallback behavior as the grid's own filters today. Add:

```typescript
  function resolveFromKey(definitionFields: string[], filterText: string): SetupStateKey | null {
    const q = filterText.trim();
    if (!q) return null;
    const valuesByField: Record<string, string[]> = {};
    definitionFields.forEach(field => { valuesByField[field] = fieldValueSet(Store.priorityRankMaps, field, _lineScope); });
    const candidates = cartesianStates(definitionFields, valuesByField);
    const match = candidates.find(state => state.parts.join(' · ').toLowerCase() === q.toLowerCase() || state.sig === q);
    return match ? match.key : null;
  }
```

- [ ] **Step 2: Row-state helper (mirrors the mockup's `rowVals`)**

```typescript
  interface ListRowView {
    fromText: string; toText: string; minutes: string; plantValue: string;
    sourceLabel: string; sourceClass: string; isOverride: boolean; isGap: boolean; key: string;
  }
  function listRowView(row: typeof _listRows[number], line: string): ListRowView {
    const key = `${stateSig(row.from_key)} ${stateSig(row.to_key)}`;
    const dirty = _gridDirty.get(key);
    const isOverride = dirty ? dirty.setup_min !== row.plant_value : (!!line && !row.inherited);
    const gap = !isOverride && row.plant_value === null && dirty === undefined;
    const minutes = dirty ? (dirty.setup_min === null ? '' : String(dirty.setup_min)) : String(row.setup_min);
    return {
      fromText: keyText(row.from_key), toText: keyText(row.to_key), minutes,
      plantValue: row.plant_value === null ? '—' : String(row.plant_value),
      sourceLabel: isOverride ? Util.t('ui.setup_list_source_override', { line }) : gap ? Util.t('ui.setup_list_source_gap') : Util.t('ui.setup_list_source_inherited'),
      sourceClass: isOverride ? 'setup-list-source-override' : gap ? 'setup-list-source-gap' : 'setup-list-source-inherited',
      isOverride, isGap: gap, key,
    };
  }
```

- [ ] **Step 3: `renderListView`**

```typescript
  function renderListView(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition | null, permissions: SetupPermissions): void {
    const mount = target.querySelector<HTMLElement>('#setup-list-mount');
    if (!mount) return;
    if (!definition) { mount.innerHTML = emptyState(Util.t('ui.setup_no_definition')); return; }
    const fromKey = resolveFromKey(definition.fields, _gridFilterFrom);
    fetchListRows(snapshot.plant, definition, fromKey).then(() => paintListView(target, snapshot, definition, permissions));
    // Paint immediately with whatever's cached (e.g. after an edit) so the
    // table never flashes empty while the fetch is in flight.
    paintListView(target, snapshot, definition, permissions);
  }

  function paintListView(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition, permissions: SetupPermissions): void {
    const mount = target.querySelector<HTMLElement>('#setup-list-mount');
    if (!mount || _setupView !== 'list') return;
    const toQuery = _gridFilterTo.trim().toLowerCase();
    let rows = _listRows;
    if (toQuery) rows = rows.filter(r => keyText(r.to_key).toLowerCase().includes(toQuery));
    if (_hideEmptyStates) rows = rows.filter(r => r.plant_value !== null || _gridDirty.has(`${stateSig(r.from_key)} ${stateSig(r.to_key)}`));
    const bodyRows = rows.map(row => {
      const v = listRowView(row, _lineScope);
      return `<tr data-setup-list-row="${esc(v.key)}">
        <td class="mono">${esc(v.fromText)}</td>
        <td class="mono">${esc(v.toText)}</td>
        <td class="setup-num"><input type="text" class="input setup-list-minutes-input" inputmode="numeric" value="${esc(v.minutes)}" data-setup-list-minutes ${permissions.matrixWrite ? '' : 'disabled'}></td>
        <td class="setup-num">${esc(v.plantValue)}</td>
        <td><span class="${v.sourceClass}">${esc(v.sourceLabel)}</span></td>
        <td class="setup-num">${v.isOverride ? `<button type="button" class="setup-list-revert" data-setup-list-revert title="${esc(Util.t('ui.setup_list_revert_title'))}">&#8630;</button>` : ''}</td>
      </tr>`;
    }).join('');
    const newRowsHtml = _listNewRows.map(row => {
      const status = listNewRowStatus(row, definition);
      return `<tr data-setup-list-new-row="${row.id}" class="setup-list-new-row">
        <td><input type="text" class="input" placeholder="${esc(Util.t('ph.setup_list_from'))}" value="${esc(row.from)}" data-setup-list-new-from></td>
        <td><input type="text" class="input" placeholder="${esc(Util.t('ph.setup_list_to'))}" value="${esc(row.to)}" data-setup-list-new-to></td>
        <td><input type="text" class="input" placeholder="${esc(Util.t('ph.setup_list_minutes'))}" value="${esc(row.minutes)}" data-setup-list-new-minutes></td>
        <td class="setup-num">—</td>
        <td class="setup-list-new-status">${esc(status)}</td>
        <td class="setup-num"><button type="button" class="setup-list-remove" data-setup-list-new-remove>&times;</button></td>
      </tr>`;
    }).join('');
    mount.innerHTML = `
      <table class="setup-table setup-list-table">
        <thead><tr>
          <th>${esc(Util.t('ui.setup_list_col_from'))}</th>
          <th>${esc(Util.t('ui.setup_list_col_to'))}</th>
          <th class="setup-num">${esc(Util.t('ui.setup_list_col_minutes'))}</th>
          <th class="setup-num">${esc(Util.t('ui.setup_list_col_plant_value'))}</th>
          <th>${esc(Util.t('ui.setup_list_col_source'))}</th>
          <th></th>
        </tr></thead>
        <tbody>${bodyRows}${newRowsHtml}</tbody>
      </table>
      <div class="setup-list-footer">
        ${permissions.matrixWrite ? `<button type="button" class="btn btn-ghost sm" data-setup-list-add-pair>${esc(Util.t('ui.setup_list_add_pair'))}</button>` : '<span></span>'}
        <span class="setup-list-count">${esc(Util.t('ui.setup_list_showing', { shown: rows.length, total: _listMeta.total, from: _gridFilterFrom || Util.t('ui.setup_plant_default') }))}</span>
      </div>`;
    wireListView(target, snapshot, definition, permissions);
  }

  function listNewRowStatus(row: { from: string; to: string; minutes: string }, definition: SetupDefinition): string {
    if (!row.from.trim() || !row.to.trim()) return Util.t('ui.setup_list_row_needs_states');
    if (!row.minutes.trim()) return Util.t('ui.setup_list_row_needs_minutes');
    const parsed = parseGridMinutes(row.minutes);
    if (parsed === 'invalid') return Util.t('ui.setup_list_row_bad_minutes');
    const fromKey = resolveFromKey(definition.fields, row.from);
    const toKey = resolveFromKey(definition.fields, row.to);
    if (!fromKey || !toKey) return Util.t('ui.setup_list_row_unknown_state');
    return Util.t('ui.setup_list_row_staged');
  }
```

- [ ] **Step 4: Wire List-view interactions**

```typescript
  function wireListView(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition, permissions: SetupPermissions): void {
    const mount = target.querySelector<HTMLElement>('#setup-list-mount');
    if (!mount) return;
    mount.querySelectorAll<HTMLInputElement>('[data-setup-list-minutes]').forEach(input => {
      input.addEventListener('change', () => {
        const tr = input.closest<HTMLElement>('[data-setup-list-row]')!;
        const [rowSig, colSig] = tr.dataset.setupListRow!.split(' ');
        const row = _listRows.find(r => stateSig(r.from_key) === rowSig && stateSig(r.to_key) === colSig);
        if (!row) return;
        const parsed = parseGridMinutes(input.value);
        if (parsed === 'invalid') { Toast.show(Util.t('ui.setup_grid_invalid_minutes'), 'error'); input.value = String(row.setup_min); return; }
        const key = `${rowSig} ${colSig}`;
        if (parsed === row.plant_value && !!_lineScope) _gridDirty.delete(key);
        else if (!_lineScope && parsed === row.setup_min) _gridDirty.delete(key);
        else _gridDirty.set(key, { row: { key: row.from_key, sig: rowSig, parts: [] }, col: { key: row.to_key, sig: colSig, parts: [] }, setup_min: parsed, line: _lineScope });
        paintGrid(target, snapshot, definition, [], permissions); // refreshes dirty-count + Save/Discard bar
        paintListView(target, snapshot, definition, permissions);
      });
    });
    mount.querySelectorAll<HTMLButtonElement>('[data-setup-list-revert]').forEach(button => {
      button.addEventListener('click', () => {
        const tr = button.closest<HTMLElement>('[data-setup-list-row]')!;
        _gridDirty.delete(tr.dataset.setupListRow!);
        paintGrid(target, snapshot, definition, [], permissions);
        paintListView(target, snapshot, definition, permissions);
      });
    });
    mount.querySelector<HTMLButtonElement>('[data-setup-list-add-pair]')?.addEventListener('click', () => {
      _listNewRows.push({ id: _listNextRowId++, from: '', to: '', minutes: '' });
      paintListView(target, snapshot, definition, permissions);
    });
    mount.querySelectorAll<HTMLElement>('[data-setup-list-new-row]').forEach(tr => {
      const id = Number(tr.dataset.setupListNewRow);
      const row = _listNewRows.find(r => r.id === id);
      if (!row) return;
      tr.querySelector<HTMLInputElement>('[data-setup-list-new-from]')?.addEventListener('input', e => { row.from = (e.target as HTMLInputElement).value; refreshNewRowStatus(tr, row, definition); });
      tr.querySelector<HTMLInputElement>('[data-setup-list-new-to]')?.addEventListener('input', e => { row.to = (e.target as HTMLInputElement).value; refreshNewRowStatus(tr, row, definition); });
      tr.querySelector<HTMLInputElement>('[data-setup-list-new-minutes]')?.addEventListener('input', e => { row.minutes = (e.target as HTMLInputElement).value; refreshNewRowStatus(tr, row, definition); });
      tr.querySelector<HTMLButtonElement>('[data-setup-list-new-remove]')?.addEventListener('click', () => {
        _listNewRows = _listNewRows.filter(r => r.id !== id);
        paintListView(target, snapshot, definition, permissions);
      });
    });
    mount.querySelector<HTMLInputElement>('[data-setup-list-hide-empty]');
  }

  function refreshNewRowStatus(tr: HTMLElement, row: { from: string; to: string; minutes: string }, definition: SetupDefinition): void {
    const statusCell = tr.querySelector('.setup-list-new-status');
    if (statusCell) statusCell.textContent = listNewRowStatus(row, definition);
    const status = listNewRowStatus(row, definition);
    if (status === Util.t('ui.setup_list_row_staged')) {
      const fromKey = resolveFromKey(definition.fields, row.from)!;
      const toKey = resolveFromKey(definition.fields, row.to)!;
      const parsed = parseGridMinutes(row.minutes) as number;
      const key = `${stateSig(fromKey)} ${stateSig(toKey)}`;
      _gridDirty.set(key, { row: { key: fromKey, sig: stateSig(fromKey), parts: fromKey.map(p => p.value) },
                            col: { key: toKey, sig: stateSig(toKey), parts: toKey.map(p => p.value) },
                            setup_min: parsed, line: _lineScope });
    }
  }
```

- [ ] **Step 5: Wire `data-setup-list-hide-empty` and the toolbar's From/To filter inputs to also repaint the List view**

In `wire()`, the existing `[data-setup-grid-filter-from]`/`[data-setup-grid-filter-to]` handlers (lines 805-812) currently call `paintGrid` only. Change both to branch on `_setupView`:

```typescript
    target.querySelector<HTMLInputElement>('[data-setup-grid-filter-from]')?.addEventListener('input', event => {
      _gridFilterFrom = (event.target as HTMLInputElement).value;
      if (_setupView === 'matrix') paintGrid(target, snapshot, definition, rows, permissions);
      else renderListView(target, snapshot, definition, permissions);
    });
    target.querySelector<HTMLInputElement>('[data-setup-grid-filter-to]')?.addEventListener('input', event => {
      _gridFilterTo = (event.target as HTMLInputElement).value;
      if (_setupView === 'matrix') paintGrid(target, snapshot, definition, rows, permissions);
      else paintListView(target, snapshot, definition, permissions);
    });
    target.querySelector<HTMLInputElement>('[data-setup-list-hide-empty]')?.addEventListener('change', event => {
      _hideEmptyStates = (event.target as HTMLInputElement).checked;
      paintListView(target, snapshot, definition, permissions);
    });
```

- [ ] **Step 6: CSS for the List table**

In `web/styles.css`, after the `.setup-menu-list` rules (line 6124):

```css
.setup-list-table { margin-top: 8px; }
.setup-list-table .mono { font-family: var(--font-mono); }
.setup-list-minutes-input { height: 26px; width: 76px; text-align: right; font-family: var(--font-mono); }
.setup-list-source-override { color: var(--accent); font-weight: 600; }
.setup-list-source-gap { color: var(--warn); }
.setup-list-source-inherited { color: var(--fg-mute); }
.setup-list-new-row td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
.setup-list-new-row input { height: 26px; }
.setup-list-remove { border: 0; background: none; color: var(--fg-faint); cursor: pointer; font-size: 14px; line-height: 1; }
.setup-list-revert { border: 0; background: none; color: var(--fg-mute); cursor: pointer; font-size: 14px; line-height: 1; }
.setup-list-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 10px 0 0; font-size: 11.5px; color: var(--fg-mute); }
```

- [ ] **Step 7: Compile and manually verify**

Run: `npm run build`
Manual check: open Setup Matrix on a plant with a saved definition and at least one recorded matrix row. Confirm: List view loads rows from the network (check Network tab for `GET /setup/{plant}/matrix-rows`), editing Minutes on an inherited row turns it into an override and shows the revert arrow, the revert arrow drops it back and shows "Inherited from plant", "Add pair" appends an editable row whose status text updates live, and the dirty count / Save button in the existing action bar reacts to all of the above. Save, then confirm the row persisted via a page reload.

- [ ] **Step 8: Commit**

```bash
git add web/plant-and-administration.mts web/styles.css
git commit -m "feat: implement Setup Matrix List view with inline edit and revert"
```

---

### Task 4: Frontend — Mass upload modal

**Files:**
- Modify: `web/plant-and-administration.mts`
- Modify: `web/locales/en.js`
- Modify: `web/styles.css`

**Interfaces:**
- Consumes: `parseGridMinutes()`, `resolveFromKey()` (Task 3), `stateSig()`, `_gridDirty`, `esc()`, `Util.t()`, `Toast`.
- Produces: `openMassUploadModal(target, snapshot, definition, permissions): void`, wired to the `[data-setup-mass-upload-open]` button added in Task 2.

- [ ] **Step 1: en.js keys**

```javascript
  'btn.setup_mass_upload':             'Mass upload',
  'ui.setup_mass_upload_title':        'Mass upload changeover minutes',
  'ui.setup_mass_upload_step1':        '1 · Paste from Excel',
  'ui.setup_mass_upload_hint':         'Three columns, tab or comma separated: from state, to state, minutes. Header row optional.',
  'ui.setup_mass_upload_step2':        '2 · Validation',
  'ui.setup_mass_upload_ready':        'Ready',
  'ui.setup_mass_upload_rejected':     'Rejected',
  'ui.setup_mass_upload_overwrites':   'Overwrites',
  'ui.setup_mass_upload_more_rejected': '+{{count}} more rejected rows — download the report to review',
  'ui.setup_mass_upload_reject_bad_minutes': 'line {{line}} — minutes {{value}} exceeds the 10080 maximum',
  'ui.setup_mass_upload_reject_bad_state':   'line {{line}} — unknown state value {{value}}',
  'ui.setup_mass_upload_reject_columns':     'line {{line}} — expected 3 columns, got {{count}}',
  'ui.setup_mass_upload_clear_blank':   "Clear the existing value when a row's minutes are blank",
  'btn.setup_mass_upload_download_rejected': 'Download rejected rows',
  'btn.setup_mass_upload_stage':        'Stage {{count}} rows',
```

- [ ] **Step 2: Parser + validator**

```typescript
  interface MassUploadOutcome {
    ready: Array<{ line: number; from: SetupStateKey; to: SetupStateKey; minutes: number | null }>;
    rejected: Array<{ line: number; message: string }>;
    overwrites: number;
  }

  /** Positional pipe-joined state text ("BLUE|T1"), one value per definition
   *  field in order — same convention as the mockup's textarea. Header row is
   *  optional and detected by "doesn't parse as a valid row" on line 1. */
  function parseMassUploadText(text: string, definition: SetupDefinition, existing: EffectiveSetupRow[], clearOnBlank: boolean): MassUploadOutcome {
    const lookup = buildCellLookup(existing);
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const outcome: MassUploadOutcome = { ready: [], rejected: [], overwrites: 0 };
    lines.forEach((raw, index) => {
      const lineNo = index + 1;
      const cols = raw.includes('\t') ? raw.split('\t') : raw.split(',');
      if (cols.length !== 3) {
        if (lineNo === 1) return; // tolerate an optional header row
        outcome.rejected.push({ line: lineNo, message: Util.t('ui.setup_mass_upload_reject_columns', { line: lineNo, count: cols.length }) });
        return;
      }
      const [fromText, toText, minutesText] = cols.map(c => c.trim());
      const fromKey = resolveFromKey(definition.fields, fromText.replace(/\|/g, ' · '));
      const toKey = resolveFromKey(definition.fields, toText.replace(/\|/g, ' · '));
      if (!fromKey || !toKey) {
        outcome.rejected.push({ line: lineNo, message: Util.t('ui.setup_mass_upload_reject_bad_state', { line: lineNo, value: !fromKey ? fromText : toText }) });
        return;
      }
      const minutes = clearOnBlank && !minutesText ? null : parseGridMinutes(minutesText);
      if (minutes === 'invalid') {
        outcome.rejected.push({ line: lineNo, message: Util.t('ui.setup_mass_upload_reject_bad_minutes', { line: lineNo, value: minutesText }) });
        return;
      }
      if (lookup.get(stateSig(fromKey))?.get(stateSig(toKey))) outcome.overwrites++;
      outcome.ready.push({ line: lineNo, from: fromKey, to: toKey, minutes });
    });
    return outcome;
  }
```

Reuses `resolveFromKey` from Task 3 for state-token resolution (so mass-upload rows are validated against the *same* known-value set as manual list rows), and `buildCellLookup`/`parseGridMinutes` already in this module — no duplicated validation logic.

- [ ] **Step 3: Modal open/close + live re-validation**

```typescript
  function openMassUploadModal(target: HTMLElement, snapshot: SetupSnapshot, definition: SetupDefinition | null, rows: EffectiveSetupRow[], permissions: SetupPermissions): void {
    if (!definition || !permissions.matrixWrite) return;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `<div class="modal setup-mass-upload-modal" role="dialog" aria-modal="true" aria-labelledby="setup-mass-upload-title">
      <header class="modal-head"><h3 id="setup-mass-upload-title">${esc(Util.t('ui.setup_mass_upload_title'))}</h3><button type="button" class="btn btn-ghost sm" data-setup-mass-upload-close aria-label="${esc(Util.t('btn.close'))}">&times;</button></header>
      <div class="modal-body setup-mass-upload-body">
        <div class="setup-mass-upload-section">
          <span class="label">${esc(Util.t('ui.setup_mass_upload_step1'))}</span>
          <p class="setup-panel-hint">${esc(Util.t('ui.setup_mass_upload_hint'))}</p>
          <textarea class="input setup-mass-upload-textarea" data-setup-mass-upload-text rows="6"></textarea>
        </div>
        <div class="setup-mass-upload-section">
          <span class="label">${esc(Util.t('ui.setup_mass_upload_step2'))}</span>
          <div class="setup-mass-upload-kpis" data-setup-mass-upload-kpis></div>
          <div class="setup-mass-upload-rejects" data-setup-mass-upload-rejects></div>
        </div>
        <label class="setup-check"><input type="checkbox" data-setup-mass-upload-clear-blank>${esc(Util.t('ui.setup_mass_upload_clear_blank'))}</label>
      </div>
      <footer class="modal-foot">
        <button type="button" class="btn btn-ghost sm" data-setup-mass-upload-download disabled>${esc(Util.t('btn.setup_mass_upload_download_rejected'))}</button>
        <button type="button" class="btn btn-ghost sm" data-setup-mass-upload-close>${esc(Util.t('btn.cancel'))}</button>
        <button type="button" class="btn btn-primary sm" data-setup-mass-upload-stage disabled>${esc(Util.t('btn.setup_mass_upload_stage', { count: 0 }))}</button>
      </footer>
    </div>`;
    let lastOutcome: MassUploadOutcome = { ready: [], rejected: [], overwrites: 0 };
    const revalidate = (): void => {
      const text = backdrop.querySelector<HTMLTextAreaElement>('[data-setup-mass-upload-text]')!.value;
      const clearOnBlank = backdrop.querySelector<HTMLInputElement>('[data-setup-mass-upload-clear-blank]')!.checked;
      lastOutcome = parseMassUploadText(text, definition, rows, clearOnBlank);
      backdrop.querySelector('[data-setup-mass-upload-kpis]')!.innerHTML = `
        <div class="setup-mass-upload-kpi ok"><span>${esc(Util.t('ui.setup_mass_upload_ready'))}</span><strong>${lastOutcome.ready.length}</strong></div>
        <div class="setup-mass-upload-kpi err"><span>${esc(Util.t('ui.setup_mass_upload_rejected'))}</span><strong>${lastOutcome.rejected.length}</strong></div>
        <div class="setup-mass-upload-kpi"><span>${esc(Util.t('ui.setup_mass_upload_overwrites'))}</span><strong>${lastOutcome.overwrites}</strong></div>`;
      const shown = lastOutcome.rejected.slice(0, 12);
      const more = lastOutcome.rejected.length - shown.length;
      backdrop.querySelector('[data-setup-mass-upload-rejects]')!.innerHTML = shown.map(r => `<div class="setup-mass-upload-reject-row">${esc(r.message)}</div>`).join('')
        + (more > 0 ? `<div class="setup-mass-upload-reject-row muted">${esc(Util.t('ui.setup_mass_upload_more_rejected', { count: more }))}</div>` : '');
      backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-stage]')!.disabled = lastOutcome.ready.length === 0;
      backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-stage]')!.textContent = Util.t('btn.setup_mass_upload_stage', { count: lastOutcome.ready.length });
      backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-download]')!.disabled = lastOutcome.rejected.length === 0;
    };
    backdrop.querySelector<HTMLTextAreaElement>('[data-setup-mass-upload-text]')!.addEventListener('input', revalidate);
    backdrop.querySelector<HTMLInputElement>('[data-setup-mass-upload-clear-blank]')!.addEventListener('change', revalidate);
    const close = (): void => { backdrop.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close(); };
    backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    backdrop.querySelectorAll<HTMLButtonElement>('[data-setup-mass-upload-close]').forEach(button => button.addEventListener('click', close));
    backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-download]')!.addEventListener('click', () => {
      const csv = ['Line,Reason', ...lastOutcome.rejected.map(r => `${r.line},"${r.message.replace(/"/g, '""')}"`)].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'setup-mass-upload-rejected.csv'; link.click(); URL.revokeObjectURL(url);
    });
    backdrop.querySelector<HTMLButtonElement>('[data-setup-mass-upload-stage]')!.addEventListener('click', () => {
      lastOutcome.ready.forEach(entry => {
        const key = `${stateSig(entry.from)} ${stateSig(entry.to)}`;
        _gridDirty.set(key, { row: { key: entry.from, sig: stateSig(entry.from), parts: entry.from.map(p => p.value) },
                              col: { key: entry.to, sig: stateSig(entry.to), parts: entry.to.map(p => p.value) },
                              setup_min: entry.minutes, line: _lineScope });
      });
      Toast.show(Util.t('ui.setup_grid_pasted', { count: lastOutcome.ready.length }), 'success');
      close();
      paintGrid(target, snapshot, definition, rows, permissions);
      if (_setupView === 'list') renderListView(target, snapshot, definition, permissions);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backdrop);
    revalidate();
  }
```

Note: staged rows are keyed exactly like every other `_gridDirty` entry, so **Save is still the only thing that writes to the backend** — the modal's "Stage N rows" button only populates the in-memory map and closes; the existing Save/Discard bar (Task 2) is unchanged and already reacts to `_gridDirty.size`.

- [ ] **Step 4: Wire the open button**

In `wire()`, add:

```typescript
    target.querySelector<HTMLButtonElement>('[data-setup-mass-upload-open]')?.addEventListener('click', () => openMassUploadModal(target, snapshot, definition, rows, permissions));
```

- [ ] **Step 5: CSS**

```css
.setup-mass-upload-modal { width: min(720px, 92vw); }
.setup-mass-upload-body { display: flex; flex-direction: column; gap: 16px; }
.setup-mass-upload-section { display: flex; flex-direction: column; gap: 7px; }
.setup-mass-upload-textarea { min-height: 120px; font-family: var(--font-mono); font-size: 12px; line-height: 1.6; resize: vertical; }
.setup-mass-upload-kpis { display: flex; gap: 8px; flex-wrap: wrap; }
.setup-mass-upload-kpi { display: flex; flex-direction: column; gap: 3px; min-width: 96px; padding: 7px 10px; background: var(--bg-elev); border: 1px solid var(--line); border-top: 3px solid var(--line-strong); border-radius: var(--r-sm); font-size: 12px; }
.setup-mass-upload-kpi span { font: 600 9.5px/1.2 var(--font-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--fg-mute); }
.setup-mass-upload-kpi strong { font: 600 17px/1.15 var(--font-mono); letter-spacing: -.02em; }
.setup-mass-upload-kpi.ok { border-top-color: var(--ok); }
.setup-mass-upload-kpi.ok strong { color: var(--ok); }
.setup-mass-upload-kpi.err { border-top-color: var(--err); }
.setup-mass-upload-kpi.err strong { color: var(--err); }
.setup-mass-upload-rejects { border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; max-height: 160px; overflow-y: auto; }
.setup-mass-upload-reject-row { padding: 7px 10px; font-size: 11.5px; color: var(--err); background: var(--err-soft); border-bottom: 1px solid var(--line); }
.setup-mass-upload-reject-row.muted { color: var(--fg-mute); background: none; }
.setup-mass-upload-reject-row:last-child { border-bottom: 0; }
```

Check `var(--err-soft)` exists as a token in `web/styles.css` (it's used elsewhere for e.g. `.setup-status-chip.warn`'s sibling `.ok` treatment via `--ok-soft`/`--warn-soft`); if a `--err-soft` token doesn't already exist, add it next to the existing `--ok-soft`/`--warn-soft` definitions rather than inventing a one-off color.

- [ ] **Step 6: Compile and manually verify**

Run: `npm run build`
Manual check: open Mass upload, paste the exact sample text from the mockup (`BLUE|T1<TAB>RED|T1<TAB>35` etc., using real state values that exist in the current plant's priority lists), confirm Ready/Rejected/Overwrites counts update live as you type, paste a row with minutes `14400` and confirm it's rejected with the 10080 message, click "Stage N rows", confirm the modal closes and the List/Matrix dirty count increased by exactly the ready-row count, then Save and confirm persistence.

- [ ] **Step 7: Commit**

```bash
git add web/plant-and-administration.mts web/locales/en.js web/styles.css
git commit -m "feat: add Setup Matrix mass-upload modal with client-side validation"
```

---

### Task 5: Cleanup scratch files and final review

**Files:**
- Delete: `Setup Matrix Redesign v2.dc.html`, `Optimizer Preview Redesign.dc.html` (root) — only after **both** plans in this pair are implemented, since the optimizer plan's mockup is the second file
- Delete: `plant-and-administration.mts`, `en.js`, `styles.css` (root scratch copies)

- [ ] **Step 1: Confirm both plans are complete**

Do not run this task until `docs/superpowers/plans/2026-08-17-optimizer-preview-reorder.md` is also fully executed — the root `Optimizer Preview Redesign.dc.html` is still the visual reference for that plan.

- [ ] **Step 2: Delete scratch files**

```bash
git rm "Setup Matrix Redesign v2.dc.html" "Optimizer Preview Redesign.dc.html" "plant-and-administration.mts" "en.js" "styles.css"
```

- [ ] **Step 3: Full verification pass**

Run: `npm run build && npm run typecheck && python -m pytest tests/test_setup_endpoints.py tests/test_setup_data.py tests/test_setup_coverage.py -v`
Expected: all PASS, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove Setup Matrix / Optimizer Preview redesign scratch files"
```
