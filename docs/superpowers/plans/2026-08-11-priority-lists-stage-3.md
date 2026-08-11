# Scheduling Priority — Stage 3 (Priority Tree + Optimizer Wiring) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin arrange the four rankable fields into a per-plant priority tree (with per-line overrides already uploaded in Stage 2), see the exact effective sort sequence that tree produces, and have the optimizer actually honor it — while proving, not assuming, that this is the *only* stage that changes sequencing and that it does so correctly.

**Architecture:** A term-factory rewrite of `Engine._sortTerms` reads a new `Store.priorityRankMaps` cache (fetched once per plant, refreshed after any Stage 2 upload) instead of the single hardcoded `colorMap`. `Engine.flattenConstraints` turns a nested `ConstraintConfig` tree into the same flat ordered key list `_sortTerms` already consumes — meaning `_dispatchDayIntegrity`, `runAndApply`, and every other optimizer entry point need **zero** changes (proven below, not assumed). `Plant._renderSettingsPane` is rebuilt from a flat on/off list into an indented tree with a live effective-sequence readout, sourced from the now-dynamic `GET /priority-fields` registry.

**Tech Stack:** Same as Stage 2 — TypeScript compiled to `.mjs`, FastAPI/Pydantic, `node --test`, `pytest`.

**Depends on:** Stage 2 must be deployed first — the tree UI needs real uploaded lists to be meaningful, and the rank-maps endpoint (Task 3) reads `brain.PLANT_LISTS`, which Stage 2's upload endpoints populate.

## Task 0 audit outcome — read this before any task below

Task 0 ran 2026-08-11. Full record:
`docs/superpowers/plans/2026-08-11-stage-3-sequencing-audit.md`. Verdict: **CONFIRMED, with
corrections — proceed.** Nothing is BLOCKED. The corrections that change a task below are folded
into those tasks inline and summarized here:

- **Task 1/2/6/8/9 line-number citations have drifted** (Stage 2 grew these files). Corrected in
  each task's Files list. **Task 8's drift is ~340 lines** — blind-replacing its originally-cited
  `:986-1084` would destroy unrelated code.
- **Task 6 must also modify `web/schedule-workbench.mts`** — it holds 11 `colorMap` references that
  Task 6's own compat note says to delete and Task 10 Step 1 expects to be gone.
- **Task 6's `_taskFieldFor` fallback is wrong as drafted** (`key.toUpperCase()` yields `PRT01`, not
  `PRT_01`). Fixed in Task 6 Step 3.
- **Task 6 Step 4's "existing tests WILL fail" is wrong** — no test anywhere references
  `_sortTerms`/`_comparator`/`colorMap`. The new tests are additive and are that function's first
  coverage.
- **Task 5 must not delete `OptimizeDialog`'s rank-map race handling without replacing it.**
- Task 3's shape resolution (line-first) is **confirmed correct** against `brain.PLANT_LISTS`.
- `_dispatchDayIntegrity` and `runAndApply` confirmed to need **zero** changes, as assumed.

## Global Constraints

Same design-system rules as `docs/superpowers/plans/2026-08-11-priority-lists-stage-2.md`'s Global Constraints section — copied here by reference, not relaxed for this stage:
- Searchable comboboxes over plain selects for anything plant/line-scoped (not directly triggered this stage — no new line picker — but the tree UI's field-add control must still not become a bubble/chip selector if it ever lists more than a handful of fields).
- CTA/Chrome Color Rule, Hairline-over-shadow, no colored side-stripes, Mono-Means-Machine for generated numbers (rank badges, coverage figures repeated in the tree), 4px/8px radius discipline, fast transitions, full i18n via `Util.t()`.
- **New for this stage:** `DESIGN.md` §5's KPI-tile top-border pattern is the one sanctioned colored-accent exception — if the effective-sequence panel wants a severity cue (e.g. "this field has no list uploaded"), reuse that exact pattern rather than inventing a new one.

## Task 0: Sequencing-impact audit (do this before writing any optimizer code)

This is the explicit "comprehensive review of Stage 1 and Stage 2's impact on actual sequencing logic" the plan was asked to include as a first-class deliverable, not an afterthought. It has two halves: (A) verify the standing claim that Stage 1+2 have changed **nothing** about sequencing yet, and (B) pre-verify, by direct code reading, exactly what Stage 3's own change will and will not touch — so the implementation tasks below are executing a *verified* plan, not a hoped-for one. Findings get written into `docs/scheduling_priority.md` regardless of outcome (confirming *or* correcting prior claims).

**Files:**
- Create: `docs/superpowers/plans/2026-08-11-stage-3-sequencing-audit.md` (the audit's findings — a permanent record, not a scratch file)
- Modify: `docs/scheduling_priority.md` (correct anything the audit finds wrong, per the doc's own stated policy: "when a stage lands, correct anything here that turned out wrong rather than letting it rot")

- [x] **Step 1: Confirm Stage 1+2 have made zero sequencing changes so far** — CONFIRMED

Grep-based, not exploratory — these are falsifiable claims:

```bash
# Claim: nothing in the optimizer reads PRT_01/PRT_02/PRODUCTION_VERSION yet.
grep -rn "PRT_01\|PRT_02\|PRODUCTION_VERSION" web/schedule-services.mts
# Expected: zero matches inside Engine._sortTerms/_comparator/_dispatchDayIntegrity
# (matches in Compute._stripPriorityFields, added Stage 1 to KEEP them out of the
# worker snapshot, are expected and prove the opposite point — they're excluded,
# not consulted).

# Claim: the optimizer still only branches on 'colorWheel'.
grep -n "activeConstraintKeys(plant" web/schedule-services.mts
grep -n "if (key ===" web/schedule-services.mts
# Expected: exactly one branch, 'colorWheel', inside _sortTerms — confirms the
# "// future: if (key === 'tooling')" placeholder is still just a comment.
```

Record actual output (not "expected to pass" — the literal grep results) in the audit doc. If anything contradicts the claim, STOP and escalate to the user before proceeding — it means Stage 1 or 2 shipped a sequencing change nobody signed off on.

- [x] **Step 2: Confirm `_dispatchDayIntegrity` genuinely needs zero changes** — CONFIRMED

This was asserted in `docs/scheduling_priority.md`'s "Vs. due dates" decision ("Verified: zero dispatch changes needed") — re-verify it against the CURRENT code, not the claim, since Stage 1/2 may have touched nearby lines. Read `web/schedule-services.mts:1069-1320` (the full `_dispatchDayIntegrity` body — originally given as `:1069-1230`, which stops ~90 lines short; corrected by the audit) and confirm in the audit doc, quoting line numbers:
1. `seqCompare` (`:1129-1134`) iterates `tieBreakTerms` generically via `tm.cmp(tm.get(a), tm.get(b))` — no field name is hardcoded.
2. `rankForDay`'s `wheelFirst` (`:1144-1150`) and the `k: tieBreakTerms.map(tm => tm.get(t))` decoration (`:1154`) are equally generic.
3. `tieBreakTerms` itself is passed in from the caller as `opts.tieBreakTerms` (`:1074`), and `runAndApply` (`:1413-1414`) passes `Engine._sortTerms(mode, {...})`'s own output straight through — meaning growing `_sortTerms` from 1 conditional term to N is entirely invisible to `_dispatchDayIntegrity`.

If all three hold (they did as of this plan's research — see this plan's own "Architecture" section above, which cites the exact line numbers), record "CONFIRMED, no changes needed" in the audit doc with the quoted excerpts. If any of the three no longer holds, the plan's Task 4 below must be revised before proceeding — do not silently patch around a broken assumption.

- [x] **Step 3: Confirm the alert auto-fix path is the one path Stage 3 must not forget** — CONFIRMED (+ new race risk, see Task 5)

Read `web/schedule-services.mts:690-710`. Confirm the exact call: `Engine.runAndApply('combined', { lines: [line], startDate: dayStart, endDate: dayEnd })` — no `colorMap`, no `plant`. Under the *current* mechanism this is safe: `_sortTerms`'s colorWheel branch falls back to `t.ORDER_Y ?? 999999` when no `colorMap` is passed, and `ORDER_Y` is kept fresh by `apply_priority_merge` on every `/tasks` fetch. Record in the audit doc: **this fallback is exactly what Task 5 below removes** ("`ORDER_Y` is no longer consulted by the optimizer" per the Decisions table) — so this call site is the one place that will silently break (fall back to `999999` for every order, every field) if Task 3's `Store.priorityRankMaps` isn't correctly populated by the time this path runs. Task 4's tests must include a test that calls this exact code path with no explicit map argument and confirms it still resolves real ranks from `Store` state.

- [x] **Step 4: Confirm the value-materialization chain end to end for a non-color field** — CONFIRMED (+ `_taskFieldFor` defect, fixed in Task 6)

Trace one field (`prt01`) from upload to optimizer input, quoting each hop: `POST /priority-list/{plant}/prt01` (Stage 2) → `priority_list.entries` JSONB → `brain.PLANT_LISTS[plant][line]['prt01']` (loaded by `load_all_priority_lists`) → the new `GET /priority-rank-maps` (Task 3 below) → `Store.priorityRankMaps.prt01` → `Engine._valueOf(t, 'PRT_01')` reading `t.PRT_01` → which was materialized onto the order by Stage 1's `_stamp_order_attributes` from `material_plants.prt_01`. Confirm each arrow with a grep/read citation, not from memory. This is the chain most likely to have a silent break (e.g., a field-key vs. task-field mismatch), and it's exactly the kind of thing "comprehensive review" should catch before, not after, shipping.

- [x] **Step 5: Write the audit doc** — done

`docs/superpowers/plans/2026-08-11-stage-3-sequencing-audit.md` — one section per step above, each ending in a clear **CONFIRMED** / **CORRECTED** / **BLOCKED** verdict with the evidence. If everything is CONFIRMED, proceed to Task 1. If anything is CORRECTED, update this plan's affected task(s) before implementing them. If anything is BLOCKED, stop and raise it with the user — per the standing "don't take big risks not scoped" instruction, do not improvise a fix to a broken assumption underlying the whole stage.

- [x] **Step 6: Commit** — done, `a7fc3cd`

```bash
git add docs/superpowers/plans/2026-08-11-stage-3-sequencing-audit.md docs/scheduling_priority.md
git commit -m "docs: pre-implementation sequencing-impact audit for Stage 3"
```

(This plan file itself was updated per Step 5 but deliberately **not** committed — it is untracked
and outside Step 6's stated stage list.)

---

### Task 1: `web/types.mts` — nested `ConstraintConfig`, rank-map types

**Files:**
- Modify: `web/types.mts:116-120` (`ConstraintConfig`) — *line numbers corrected by Task 0's audit;
  the plan originally said `:117-121`.*

**Interfaces:**
- Produces: `ConstraintConfig.children?: ConstraintConfig[]`, `PriorityRankMaps` type — consumed by Tasks 2-6.

- [ ] **Step 1: Implement**

```ts
export interface ConstraintConfig {
  key: string;
  enabled: boolean;
  order?: number;
  /** Stage 3: a field nested under a field is mathematically identical to the
   *  next key in a lexicographic sort (docs/scheduling_priority.md "Sub-sort
   *  model" decision) — Engine.flattenConstraints (Task 4) turns this into the
   *  same flat key list _sortTerms already consumes. Purely additive: cached
   *  `plants` rows with no `children` still parse as leaf nodes, so this is
   *  NOT a SCHEMA_VERSION bump (N17). */
  children?: ConstraintConfig[];
}

/** {field_key: {line|'': {NORMALIZED_VALUE: RANK}}} — GET /priority-rank-maps
 *  response, cached on Store and read by Engine._sortTerms. */
export type PriorityRankMaps = Record<string, Record<string, Record<string, number>>>;
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck` — passes (additive change).

- [ ] **Step 3: Commit**

```bash
git add web/types.mts
git commit -m "feat: add nested ConstraintConfig.children and PriorityRankMaps type"
```

---

### Task 2: `master_data.py` — preserve `children` in `set_plant_constraints`

**Files:**
- Modify: `master_data.py:988-1030` (`set_plant_constraints`) — **the normalization loop to replace
  is `:997-1005`**, not `:994-1002` as originally written (corrected by Task 0's audit).
- Test: `tests/test_priority_lists.py`

**Interfaces:**
- Consumes: `master_data.RANKABLE_FIELDS` (key validation).
- Produces: `set_plant_constraints(...)` now recursively normalizes `children`, capped at depth 3, instead of silently dropping the key.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.pg
def test_set_plant_constraints_preserves_nested_children(pg):
    import master_data as md
    sub, plant = "ZZTEST_TREE_SUB", "ZZTEST_TREE_PLANT"
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (sub, sub))
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING", (sub, plant))
        conn.commit()
    try:
        tree = [
            {"key": "colorWheel", "enabled": True, "order": 1, "children": [
                {"key": "prt01", "enabled": True, "order": 1},
            ]},
        ]
        md.set_plant_constraints(subnetwork=sub, plant=plant, constraints=tree)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT constraints FROM plants WHERE plant = %s", (plant,))
            stored = cur.fetchone()[0]
        assert stored[0]["children"][0]["key"] == "prt01"
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM plants WHERE plant = %s", (plant,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (sub,))
            conn.commit()


def test_set_plant_constraints_rejects_depth_beyond_three():
    import master_data as md
    deep = {"key": "colorWheel", "enabled": True, "order": 1, "children": [
        {"key": "prt01", "enabled": True, "order": 1, "children": [
            {"key": "prt02", "enabled": True, "order": 1, "children": [
                {"key": "productionVersion", "enabled": True, "order": 1},
            ]},
        ]},
    ]}
    with pytest.raises(ValueError, match="depth"):
        md.set_plant_constraints(subnetwork="", plant="ZZANY", constraints=[deep])
```

- [ ] **Step 2: Run to verify they fail**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k "preserves_nested_children or rejects_depth" -v`
Expected: `preserves_nested_children` FAILs (`children` missing from stored row); `rejects_depth_beyond_three` FAILs (no `ValueError` raised — `set_plant_constraints` doesn't reach the DB call to fail on `plant='ZZANY'` not existing, because today it never validates depth at all).

- [ ] **Step 3: Implement**

Replace the normalization block (`master_data.py:997-1005`):

```python
def _normalize_constraint_tree(nodes: list, depth: int = 1) -> list[dict]:
    """Recursive normalize+validate for the priority tree (Stage 3). Depth
    cap of 3 mirrors the UI's own cap (docs/scheduling_priority.md: with 4
    registered fields the effective sequence saturates at 4 keys regardless
    of nesting depth, so a deeper tree is never meaningful, not just
    disallowed for its own sake)."""
    if depth > 3:
        raise ValueError(f"constraint tree depth exceeds 3 (Stage 3 cap)")
    clean: list[dict] = []
    for c in nodes:
        if not isinstance(c, dict) or "key" not in c:
            raise ValueError("each constraint requires a 'key'")
        node = {
            "key":     str(c["key"]),
            "enabled": bool(c.get("enabled", False)),
            "order":   int(c.get("order", 0)),
        }
        children = c.get("children")
        if children:
            if not isinstance(children, list):
                raise ValueError("'children' must be a list")
            node["children"] = _normalize_constraint_tree(children, depth + 1)
        clean.append(node)
    return clean
```

And in `set_plant_constraints`, replace the loop (`master_data.py:997-1005`) with:

```python
    clean = _normalize_constraint_tree(constraints)
```

- [ ] **Step 4: Run to verify they pass**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k "preserves_nested_children or rejects_depth" -v`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add master_data.py tests/test_priority_lists.py
git commit -m "feat: preserve and depth-cap nested children in set_plant_constraints"
```

---

### Task 3: Backend — `GET /priority-rank-maps?plant=`

**Files:**
- Modify: `brain.py`
- Test: `tests/test_priority_lists.py`

**Interfaces:**
- Consumes: `brain.PLANT_LISTS` (in-process cache, already populated by Stage 1's `load_priority_lists`/`_reload_one_plant_lists`, itself fed by Stage 2's uploads).
- Produces: `GET /priority-rank-maps?plant=X` → `PriorityRankMaps` shape `{field_key: {line_or_empty: {VALUE: RANK}}}`, read directly from memory (no DB hit) — the fastest of all the endpoints in this feature, by design, since it's on the optimizer's hot path (every optimize run, every alert auto-fix).

- [ ] **Step 1: Write the failing test**

```python
def test_priority_rank_maps_endpoint_reads_in_memory_cache(client, monkeypatch):
    monkeypatch.setitem(brain.PLANT_LISTS, "ZZTEST_PRM_PLANT",
                        {"": {"colorWheel": {"RED": 1.0}}, "L01": {"prt01": {"DOG": 1.0}}})
    r = client.get("/priority-rank-maps?plant=ZZTEST_PRM_PLANT")
    assert r.status_code == 200
    body = r.json()
    assert body == {"": {"colorWheel": {"RED": 1.0}}, "L01": {"prt01": {"DOG": 1.0}}}


def test_priority_rank_maps_endpoint_empty_for_unknown_plant(client):
    r = client.get("/priority-rank-maps?plant=ZZ_TOTALLY_UNKNOWN")
    assert r.status_code == 200
    assert r.json() == {}
```

Note the response shape is `{line: {field_key: {...}}}` (matching `brain.PLANT_LISTS`'s own native shape exactly, zero reshaping — `line`-keyed outer, `field_key`-keyed inner) rather than the `{field_key: {line: {...}}}` shape `PriorityRankMaps`'s TS type suggests. **Resolve this before implementing**, don't let the two silently diverge — either transpose server-side to match the TS type (consistent API shape, small server-side cost) or flip `PriorityRankMaps` in Task 1 to `Record<line, Record<field_key, Record<value, rank>>>` (zero server cost, matches the existing in-memory cache verbatim). This plan picks the latter — **update Task 1's `PriorityRankMaps` type to `Record<string, Record<string, Record<string, number>>>` keyed `{line: {field_key: {value: rank}}}`** before writing Task 5's `_sortTerms` lookup, since that lookup order (line, then field_key) is what the code below assumes.

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_priority_lists.py -k priority_rank_maps_endpoint -v`
Expected: FAIL with 404.

- [ ] **Step 3: Implement**

```python
@api.get("/priority-rank-maps")
def get_priority_rank_maps(plant: str = Query(..., min_length=1)):
    """In-memory rank-map read for the optimizer's hot path (Stage 3) — zero DB
    hit, since brain.PLANT_LISTS is already kept current by every priority-list
    upload/delete (Stage 2) and POST /reload. Shape: {line_or_empty:
    {field_key: {VALUE: RANK}}} — the exact native shape of PLANT_LISTS, no
    reshaping, since this runs on every optimize call and every alert auto-fix."""
    return PLANT_LISTS.get(plant, {})
```

- [ ] **Step 4: Run to verify they pass**

Run: `python -m pytest tests/test_priority_lists.py -k priority_rank_maps_endpoint -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add brain.py tests/test_priority_lists.py
git commit -m "feat: add GET /priority-rank-maps hot-path endpoint for the optimizer"
```

---

### Task 4: `web/types.mts` fix-up — correct `PriorityRankMaps` key order

**Files:**
- Modify: `web/types.mts` (the type added in Task 1)

- [ ] **Step 1: Implement**

```ts
/** {line_or_empty: {field_key: {NORMALIZED_VALUE: RANK}}} — matches
 *  brain.PLANT_LISTS' native shape verbatim (GET /priority-rank-maps does no
 *  reshaping, since it's on the optimizer's hot path). Line-first because
 *  Engine._valueOf's caller resolves "this order's line, else plant-wide"
 *  before it knows which field it's looking up. */
export type PriorityRankMaps = Record<string, Record<string, Record<string, number>>>;
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add web/types.mts
git commit -m "fix: correct PriorityRankMaps key order to line-then-field, matching PLANT_LISTS"
```

---

### Task 5: `web/schedule-state.mts` + `web/schedule-data.mts` — `Store.priorityRankMaps`

**Files:**
- Modify: `web/schedule-state.mts` (add state + getter near other plant-scoped caches)
- Modify: `web/schedule-data.mts` (`Persistence` or `Session` — add the fetch, following whichever module already fetches plant-scoped data on `'plant:selected'`)
- Test: `tests/modules/schedule-state.test.mjs` (or the equivalent file for this module — grep for an existing `Store` state test to confirm the right file)

**Interfaces:**
- Produces: `Store.priorityRankMaps: PriorityRankMaps`, `Store.setPriorityRankMaps(maps: PriorityRankMaps): void`, and a fetch function (name TBD by whichever existing module owns plant-scoped fetches — follow its established naming, e.g. if calendars are loaded by `CalendarSync.loadForPlant(plant)`, mirror that as `Session.loadPriorityRankMaps(plant)` or similar) called (a) on `'plant:selected'` and (b) exposed for Stage 2's upload/delete handlers to call directly.

- [ ] **Step 1: Write the failing test**

```js
test('Store exposes priorityRankMaps state and setter', () => {
  assert.deepEqual(Store.priorityRankMaps, {});
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } });
  assert.deepEqual(Store.priorityRankMaps, { '': { colorWheel: { RED: 1 } } });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test tests/modules/schedule-state.test.mjs`
Expected: FAIL — `setPriorityRankMaps` doesn't exist.

- [ ] **Step 3: Implement**

In `web/schedule-state.mts`, add near other plant-scoped state (follow the exact pattern used for whichever sibling cache — e.g. calendars — already does "state field + setter + emit" for a per-plant fetched value):

```ts
priorityRankMaps: {} as PriorityRankMaps,

setPriorityRankMaps(maps: PriorityRankMaps): void {
  this.priorityRankMaps = maps || {};
  this.emit({ type: 'priority-rank-maps:updated' });
},
```

In `web/schedule-data.mts`, find the module (`Persistence`, `CalendarSync`, or `Session` — whichever already subscribes to plant selection to fetch plant-scoped data, e.g. calendars) and add a sibling fetch, wired the same way that module wires its existing plant-scoped fetch:

```ts
async function loadPriorityRankMaps(plant: string | null): Promise<void> {
  if (!plant) { Store.setPriorityRankMaps({}); return; }
  try {
    const r = await fetch(`${Config.API_BASE}/priority-rank-maps?plant=${encodeURIComponent(plant)}`);
    Store.setPriorityRankMaps(r.ok ? await r.json() : {});
  } catch {
    Store.setPriorityRankMaps({});
  }
}
```

Wire `loadPriorityRankMaps` to run on the same trigger the sibling fetch already uses (grep for that sibling function's own subscription — likely `Store.on('plant:selected', ...)` or an equivalent called from `App`'s plant-switch handler) so it fires at the same moment, not a separately-invented one.

**Task 0 audit — do not drop the race guard.** `OptimizeDialog` today handles "the rank source
hasn't loaded yet" explicitly: before Run it uses `_wheelCache` if it matches the selected plant, and
otherwise does a synchronous 1.5s fallback fetch (`web/schedule-workbench.mts:6517-6539`, comment:
*"Fall back to a quick fetch only if the cache hasn't filled yet (race on first open)"*). Task 6
deletes that block. A fire-and-forget `loadPriorityRankMaps` with a `catch → {}` has no equivalent, so
a Run — or an alert auto-fix — issued before the fetch resolves (or after it fails) would silently
sequence every order at rank 999999 on every field. **Return the promise** from
`loadPriorityRankMaps` and track which plant the cache holds (e.g. a `_rankMapsPlant` marker), so
`OptimizerPreview.runWithPreview` can await/re-fetch when the cache is empty or belongs to another
plant. The audit confirmed a single non-plant-keyed cache is otherwise safe: every `runAndApply`
caller's effective plant is always `Store.selectedPlant` (defaulted at
`web/schedule-services.mts:1332`; `OptimizeDialog.selectPlant` sets it at
`web/schedule-workbench.mts:6197`).

Export `loadPriorityRankMaps` (or whatever name matches the module's established convention) from the module's return object, so Stage 2's Task 12 upload/delete handlers can call it directly to refresh the cache immediately after a list changes — without waiting for a full plant reselect.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && node --test tests/modules/schedule-state.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire the Stage 2 refresh hook**

In `web/plant-and-administration.mts`, at the end of `Plant._handleUploadResult` and `Plant._confirmDeletePriorityList` (both added in Stage 2's Task 12, right where they already call `Plant._fetchAndRenderOptimization(plantName)`), add a call to the new fetch function so the optimizer's in-browser rank-map cache is never stale relative to what the Optimization tab just showed:

```ts
    Plant._fetchAndRenderOptimization(plantName);
    Session.loadPriorityRankMaps(plantName);  // keep Store in sync with what just changed
```

(Use whichever exported name Step 3 actually settled on.)

- [ ] **Step 6: Commit**

```bash
git add web/schedule-state.mts web/schedule-data.mts web/plant-and-administration.mts tests/modules/schedule-state.test.mjs
git commit -m "feat: add Store.priorityRankMaps, fetched on plant select and after list changes"
```

---

### Task 6: `web/schedule-services.mts` — the term factory (`_sortTerms` rewrite) + `flattenConstraints`

The core seam-3 change. Per Task 0's audit, `_dispatchDayIntegrity` and `runAndApply` need **no** changes — this task is scoped entirely to `_sortTerms`, `_comparator`'s shared call, and the new `flattenConstraints`.

**Files:**
- Modify: `web/schedule-services.mts:952-1029` (`Engine.CONSTRAINT_CATALOG` at `:952` through the end
  of `_sortTerms` at `:1029`; `export const Engine = {` is `:944`). `_comparator`'s signature is
  `:1037`; `runAndApply`'s `_sortTerms` call is `:1345`. *(Verified by Task 0's audit.)*
- Modify: **`web/schedule-workbench.mts`** — **added by Task 0's audit.** Holds 11 `colorMap`
  references this task's own compat note requires deleting, and which Task 10 Step 1's
  `grep -n "colorMap" web/*.mts` expects to return zero: `_wheelCache` type `:6037`,
  `OptimizerRunOptions.colorMap` `:6074`, the badge's `/color-wheel/{plant}` prefetch `:6378-6397`,
  and the pre-Run resolve + fallback fetch `:6519-6553`. **See Task 5's note before deleting
  `:6517-6539` — that block is today's race guard and needs a replacement, not just removal.**
- Test: `tests/modules/schedule-services.test.mjs` — **R19 was wrong (Task 0 audit):** no test
  anywhere references `_sortTerms`, `_comparator`, or `colorMap`
  (`grep -rn "colorMap\|_sortTerms\|_comparator" tests/` → zero matches), and that file's Engine test
  (`:128-133`) makes only positive `typeof` assertions, so adding methods won't break it. Nothing
  breaks; the new tests below are purely additive **and are `_sortTerms`' first-ever coverage.**

**Interfaces:**
- Consumes: `Store.priorityRankMaps` (Task 5), `Util.norm`, `Util.t`.
- Produces: `Engine.flattenConstraints(plant: string | null): string[]` (pre-order DFS, dedup, disabled-subtree-skip), `_sortTerms`'s new signature `(mode: string, opts: { plant?: string | null } = {})` — **`colorMap` is dropped from the public signature** (superseded by `Store.priorityRankMaps`; see the compat note in Step 3 below for callers that still pass it).

- [ ] **Step 1: Write the failing tests**

```js
import { Engine } from '../../web/schedule-services.mjs';
import { Store } from '../../web/schedule-state.mjs';

test('flattenConstraints does pre-order DFS, drops duplicates, skips disabled subtrees', () => {
  Store.masterData = { plants: [{ plant: 'P1', constraints: [
    { key: 'colorWheel', enabled: true, order: 1, children: [
      { key: 'prt01', enabled: true, order: 1 },
      { key: 'colorWheel', enabled: true, order: 2 },  // duplicate — must be dropped
    ] },
    { key: 'prt02', enabled: false, order: 2, children: [
      { key: 'productionVersion', enabled: true, order: 1 },  // whole subtree skipped (parent disabled)
    ] },
  ] }] };
  assert.deepEqual(Engine.flattenConstraints('P1'), ['colorWheel', 'prt01']);
});

test('flattenConstraints falls back to CONSTRAINT_CATALOG order when plant has no stored tree', () => {
  Store.masterData = { plants: [{ plant: 'P2', constraints: null }] };
  const keys = Engine.flattenConstraints('P2');
  assert.deepEqual(keys, ['colorWheel']); // only colorWheel defaults enabled, per constraintEnabled's existing rule
});

test('_sortTerms resolves rank via Store.priorityRankMaps, line override winning over plant-wide', () => {
  Store.masterData = { plants: [{ plant: 'P3', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }] };
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 5 } }, L01: { colorWheel: { RED: 1 } } });
  const terms = Engine._sortTerms('changeover', { plant: 'P3' });
  const key = terms[0].get({ COLOR: 'red', PRODUCTION_LINE: 'L01' });
  assert.equal(key, '0000001|RED');  // line override (rank 1), not plant-wide (rank 5)
  const keyNoLine = terms[0].get({ COLOR: 'red', PRODUCTION_LINE: 'L99' });
  assert.equal(keyNoLine, '0000005|RED');  // falls back to plant-wide for an unmapped line
});

test('_sortTerms groups unranked values together, after ranked ones, instead of interleaving (N12)', () => {
  Store.masterData = { plants: [{ plant: 'P4', constraints: [{ key: 'colorWheel', enabled: true, order: 1 }] }] };
  Store.setPriorityRankMaps({ '': { colorWheel: { RED: 1 } } });
  const terms = Engine._sortTerms('changeover', { plant: 'P4' });
  const redKey    = terms[0].get({ COLOR: 'RED',    PRODUCTION_LINE: 'L1' });
  const blueKey   = terms[0].get({ COLOR: 'BLUE',   PRODUCTION_LINE: 'L1' });   // unranked
  const greenKey  = terms[0].get({ COLOR: 'GREEN',  PRODUCTION_LINE: 'L1' });   // unranked
  assert.ok(redKey < blueKey);            // ranked sorts before unranked
  assert.notEqual(blueKey, greenKey);     // both rank 999999 but keys still differ by value
  assert.ok(blueKey.startsWith('0999999|') && greenKey.startsWith('0999999|'));  // grouped under the same rank prefix
});

test('_sortTerms with no rank map for the field falls back to 999999 for every value (no crash)', () => {
  Store.masterData = { plants: [{ plant: 'P5', constraints: [{ key: 'prt01', enabled: true, order: 1 }] }] };
  Store.setPriorityRankMaps({});
  const terms = Engine._sortTerms('changeover', { plant: 'P5' });
  assert.equal(terms[0].get({ PRT_01: 'DOG', PRODUCTION_LINE: 'L1' }), '0999999|DOG');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run build && node --test tests/modules/schedule-services.test.mjs`
Expected: `flattenConstraints` tests FAIL (method doesn't exist); `_sortTerms` tests FAIL (current implementation only branches on `colorMap`/`ORDER_Y`, produces raw numbers not padded-string keys).

- [ ] **Step 3: Implement**

Replace `web/schedule-services.mts:944-1029` (the whole block from `CONSTRAINT_CATALOG` through the end of `_sortTerms`):

```ts
export const Engine = {
  /** Now sourced dynamically from GET /priority-fields (App boot, cached here
   *  as the offline/loading-state fallback — R8). Order matches the backend
   *  registry (master_data.RANKABLE_FIELDS' declaration order). */
  CONSTRAINT_CATALOG: [
    { key: 'colorWheel', label: 'Color wheel',
      desc: 'Sequence orders by color-wheel priority to minimize color changeovers.' },
  ] as Array<{ key: string; label: string; desc: string }>,

  /** Called once at boot (after GET /priority-fields resolves) to replace the
   *  hardcoded single-entry fallback above with the real registry. Safe to
   *  call multiple times (e.g. on /reload). */
  setConstraintCatalog(fields: Array<{ field_key: string; default_label: string }>): void {
    if (!fields || !fields.length) return; // keep the offline fallback rather than emptying the list
    Engine.CONSTRAINT_CATALOG = fields.map(f => ({
      key: f.field_key, label: f.default_label, desc: '',
    }));
  },

  constraintsFor(plant: string | null): ConstraintConfig[] | null {
    const row = Store.masterData?.plants?.find(p => p.plant === plant);
    const list = row && row.constraints;
    return Array.isArray(list) ? list : null;
  },

  constraintEnabled(plant: string | null, key: string): boolean {
    const c = Engine.constraintsFor(plant)?.find(x => x.key === key);
    if (c) return !!c.enabled;
    return key === 'colorWheel';
  },

  /** Pre-order DFS flatten of the (possibly nested) constraint tree — a field
   *  nested under a field is mathematically identical to the next key in a
   *  lexicographic sort (docs/scheduling_priority.md "Sub-sort model"
   *  decision), so this is the ONLY tree-aware function in the optimizer;
   *  every existing caller of activeConstraintKeys (including _sortTerms)
   *  gets tree support for free. A disabled node skips its ENTIRE subtree
   *  (an unreachable priority is not "half-configured," it's off). An
   *  already-emitted key is skipped on a later occurrence (duplicates
   *  collapse — the UI marks these "(no effect)"). Falls back to the flat
   *  CONSTRAINT_CATALOG default (today: colorWheel only) when the plant has
   *  no stored tree at all, matching activeConstraintKeys' old behavior
   *  exactly for a never-configured plant. */
  flattenConstraints(plant: string | null): string[] {
    const tree = Engine.constraintsFor(plant);
    if (!tree || !tree.length) {
      return Engine.CONSTRAINT_CATALOG
        .filter(c => Engine.constraintEnabled(plant, c.key))
        .map(c => c.key);
    }
    const seen = new Set<string>();
    const out: string[] = [];
    const walk = (nodes: ConstraintConfig[]): void => {
      for (const node of [...nodes].sort((a, b) => (a.order ?? 99) - (b.order ?? 99))) {
        if (!node.enabled) continue; // disabled -> whole subtree skipped
        if (!seen.has(node.key)) { seen.add(node.key); out.push(node.key); }
        if (node.children && node.children.length) walk(node.children);
      }
    };
    walk(tree);
    return out;
  },

  /** Delegates to flattenConstraints — every existing caller (this file's
   *  _sortTerms, and anything else that asked "which constraints are active,
   *  in order") picks up tree support with no call-site change. */
  activeConstraintKeys(plant: string | null): string[] {
    return Engine.flattenConstraints(plant);
  },

  /** Reads the task field a rankable key maps to. Sourced from the same
   *  GET /priority-fields registry as setConstraintCatalog — cached
   *  alongside it so this stays a pure lookup, no fetch.
   *
   *  CORRECTED by Task 0's audit: the earlier draft fell back to
   *  `key.toUpperCase()`, which is WRONG for 3 of the 4 registered fields
   *  ('prt01' -> 'PRT01', not 'PRT_01'; 'productionVersion' ->
   *  'PRODUCTIONVERSION', not 'PRODUCTION_VERSION'). That fallback is
   *  reachable — flattenConstraints sources keys from the plant's STORED tree
   *  (Store.masterData), not from CONSTRAINT_CATALOG, so a plant with prt01
   *  configured emits that key whether or not Task 7's /priority-fields fetch
   *  ever resolved (it has a .catch(() => {})). The result would be
   *  Util.norm(t['PRT01']) === '' -> rank 999999 for every order: configured,
   *  inert, silent. So the four known mappings are hardcoded as the offline
   *  fallback — the same pattern CONSTRAINT_CATALOG already uses — and the
   *  registry MERGES over them rather than replacing them. */
  _fieldTaskFields: {
    colorWheel:        'COLOR',
    prt01:             'PRT_01',
    prt02:             'PRT_02',
    productionVersion: 'PRODUCTION_VERSION',
  } as Record<string, string>,

  _taskFieldFor(key: string): string {
    const f = Engine._fieldTaskFields[key];
    if (f) return f;
    // No known mapping: warn rather than guess a field name that will
    // silently resolve to undefined for every order.
    ErrorLog.warn('engine', `No task field registered for priority field "${key}" — orders will not rank on it.`, { key });
    return '';
  },

  setFieldTaskFields(fields: Array<{ field_key: string; task_field: string }>): void {
    if (!fields || !fields.length) return; // keep the offline fallback
    for (const f of fields) {
      if (f.field_key && f.task_field) Engine._fieldTaskFields[f.field_key] = f.task_field;
    }
  },

  /** Ordered list of sort terms for a mode — single source of truth for
   *  optimizer ordering, shared by _comparator and runAndApply's decorate
   *  sort. Term-factory rewrite (Stage 3, seam 3): each active constraint key
   *  (from flattenConstraints, so tree-aware for free) gets an ordinalTerm
   *  reading Store.priorityRankMaps — no more single hardcoded colorMap
   *  branch. Key encoding is pad(rank,7)+'|'+value (N12): a fixed-width
   *  zero-padded rank so equal/unranked values GROUP by value instead of
   *  interleaving (999999 unranked sorts after any real rank; two orders
   *  both at 999999 still sort deterministically against each other by
   *  value). One scalar string key keeps _dispatchDayIntegrity's Schwartzian
   *  decorate allocation-free (R11) — same shape as before, just built
   *  generically instead of only for color.
   *
   *  opts.plant selects which line's rank maps to prefer (falling back to
   *  plant-wide, '') — resolved PER TASK inside each term's get(), off the
   *  task's *current* PRODUCTION_LINE, which is what makes a cross-line drag
   *  or Orders-grid line edit picked up with no refetch (the N2 fix — see
   *  docs/scheduling_priority.md's Seam 1). */
  _sortTerms(mode: string, opts: { plant?: string | null } = {}): SortTerm[] {
    const { plant } = opts;
    const numCmp = (a: number, b: number) => a - b;
    const strCmp = (a: string, b: string) => a.localeCompare(b);

    if (mode === 'spt') {
      return [{ get: (t: NimbusTask) => Util.runHours(t), cmp: numCmp }];
    }
    if (mode === 'changeover' || mode === 'combined') {
      const terms: SortTerm[] = [];
      for (const key of Engine.activeConstraintKeys(plant ?? null)) {
        const taskField = Engine._taskFieldFor(key);
        terms.push({
          get: (t: NimbusTask): string => {
            const v = Util.norm((t as unknown as Record<string, unknown>)[taskField]);
            const byLine = Store.priorityRankMaps || {};
            const line = t.PRODUCTION_LINE || '';
            const scoped = byLine[line]?.[key] ?? byLine['']?.[key];
            const rank = scoped?.[v] ?? 999999;
            return String(rank).padStart(7, '0') + '|' + v;
          },
          cmp: strCmp,
        });
      }
      terms.push({ get: (t: NimbusTask) => Util.norm(t.FORM_SIZE), cmp: strCmp });
      if (mode === 'combined') {
        terms.push({ get: (t: NimbusTask) => Util.runHours(t), cmp: numCmp });
        terms.push({ get: (t: NimbusTask) => Util.norm(t.MATERIAL_NUMBER), cmp: strCmp });
      } else {
        terms.push({ get: (t: NimbusTask) => Util.norm(t.MATERIAL_NUMBER), cmp: strCmp });
        terms.push({ get: (t: NimbusTask) => Util.runHours(t), cmp: numCmp });
      }
      return terms;
    }
    return [];
  },
```

Also update `_comparator`'s type signature (`web/schedule-services.mts:1037`) from `opts: { plant?: string | null; colorMap?: Record<string, number> | null }` to `opts: { plant?: string | null }`, matching `_sortTerms`' new signature exactly — it only forwards `opts`, but leaving a dead `colorMap?` field in its type would be exactly the kind of small, silent drift this feature's own review findings (R17) exist to prevent.

**Compat note on dropping `colorMap` from the public signature:** grep every existing caller of `_sortTerms`/`_comparator` (`runAndApply` at `:1345`, any `OptimizeDialog`/`OptimizerPreview` call, the alert auto-fix path implicitly via `runAndApply`) and remove `colorMap` from each call site's `opts` — they no longer need to pre-fetch a color map at all, since `_sortTerms` now reads `Store.priorityRankMaps` directly. This is a net simplification: whichever function previously fetched `/color-wheel/{plant}` just to build `colorMap` before calling `runAndApply` can delete that fetch entirely, since `Store.priorityRankMaps` is already kept current by Task 5. Search for `colorMap` across `web/*.mts` and remove every remaining reference — a leftover unused fetch is exactly the kind of debt R17 exists to prevent from accumulating silently.

- [ ] **Step 4: Run to verify they pass, and fix what breaks**

Run: `npm run build && node --test tests/modules/schedule-services.test.mjs`
Expected: the new tests PASS, and **all 15 pre-existing tests in this file keep passing untouched.**
R19's prediction that existing tests would break was falsified by Task 0's audit — none of them
reference `_sortTerms`, `_comparator`, or `colorMap`. If one *does* break, that is a real
unanticipated coupling: investigate it rather than editing the test to match the new behavior.
(Also run `node --test tests/modules/schedule-workbench.test.mjs` — this task now edits that module
too, to strip `colorMap`.)

- [ ] **Step 5: Commit**

```bash
git add web/schedule-services.mts web/schedule-workbench.mts tests/modules/schedule-services.test.mjs
git commit -m "feat: term-factory rewrite of _sortTerms; flattenConstraints for the priority tree"
```

---

### Task 7: Wire `GET /priority-fields` into `Engine`'s catalog at boot

**Files:**
- Modify: wherever app boot currently fetches master data / plant list at startup (grep for the existing boot sequence in `application-shell.mts`'s `App` module — the same place that would already fetch plants/lines on load)

**Interfaces:**
- Consumes: `GET /priority-fields` (Stage 2 Task 3). Its rows are **already typed** as
  `PriorityFieldMeta` (`web/types.mts:123-129`, carrying `field_key`, `mp_column`, `orders_column`,
  `task_field`, `default_label`) — use that type here and in Task 6 rather than inline structural
  types. *(Task 0 audit: confirmed the endpoint spreads the whole `RANKABLE_FIELDS` spec at
  `brain.py:1878-1881`, so `task_field` really is in the payload.)*
- Produces: calls `Engine.setConstraintCatalog(...)` and `Engine.setFieldTaskFields(...)` (both added Task 6) once, at boot.
- Note (Task 0 audit): `web/plant-and-administration.mts:811` **already** fetches
  `/priority-fields` for the Stage 2 Optimization tab. This boot fetch is still justified — `Engine`
  needs the registry before any optimize, not only when the Plant tab opens — but the duplication
  should be deliberate (or the two should share a cached promise), not accidental.

- [ ] **Step 1: Implement**

Find `App`'s boot sequence (grep for where it currently loads `Store.masterData` at startup) and add, alongside that fetch:

```ts
fetch(`${Config.API_BASE}/priority-fields`)
  .then(r => r.ok ? r.json() : { fields: [] })
  .then(body => {
    Engine.setConstraintCatalog(body.fields || []);
    Engine.setFieldTaskFields(body.fields || []);
  })
  .catch(() => {}); // offline fallback: Engine.CONSTRAINT_CATALOG's hardcoded colorWheel entry stands
```

This is a **loading-state consideration** (R8): until this resolves, `Engine.CONSTRAINT_CATALOG` is the one-entry `colorWheel` fallback, exactly matching today's synchronous behavior — nothing regresses for a plant opened before this fetch completes; the tree UI (Task 8) just needs to re-render once the fetch resolves if the Scheduling Constraints pane is already open.

- [ ] **Step 2: Verify**

Manual: reload the app, confirm `Engine.CONSTRAINT_CATALOG` (inspect via browser console) has 4 entries after boot completes, and confirm throttling the network in devtools to simulate a slow fetch doesn't break the Settings pane's initial render (it should just show `colorWheel` until the fetch resolves, then re-render with all 4 once Task 8 wires the re-render).

- [ ] **Step 3: Commit**

```bash
git add web/application-shell.mts
git commit -m "feat: load the priority-field registry into Engine.CONSTRAINT_CATALOG at boot"
```

---

### Task 8: `web/plant-and-administration.mts` — rebuild `_renderSettingsPane`'s tree UI

**Files:**
- Modify: `web/plant-and-administration.mts` — **line numbers CORRECTED by Task 0's audit; the
  originally-cited `:868-1085` / `:986-1084` are ~340 lines stale (Stage 2 grew this file), and
  blind-replacing that range would destroy unrelated code.** Current landmarks:
  `_renderSettingsPane` begins `:1211`; the `#sys-constraints-list` markup is `:1260`; `consListEl`
  is bound `:1333`; the `cons-warn` / `ui.constraint_no_wheel` hint is `:1350`; per-row handler
  wiring is `:1365-1368`; `moveConstraint` `:1372`; `saveConstraints` `:1397`; the synchronous
  `initConstraints` IIFE (R8) `:1416`. **Re-grep these before editing** — this file is still moving.
- Modify: `web/plant-and-administration.mts` also needs a `#sys-effective-sequence` element added to
  the panel-body markup alongside `#sys-constraints-list` (`:1260`).
- Test: `tests/modules/plant-and-administration.test.mjs`
- Regenerate: `tests/contracts/cq1-legacy-surface.json` — this task adds inline handlers, so run
  `node scripts/legacy-surface.mjs --write` and commit the fixture. *(Task 0 audit: that contract test
  currently passes 10/10, so any failure here is newly introduced by this task, not a Stage 2
  leftover.)*

**Interfaces:**
- Consumes: `Engine.CONSTRAINT_CATALOG` (now dynamic, Task 6/7), `Engine.flattenConstraints` (Task 6), `POST /master-data/plants/{plant}/constraints` (existing, now accepting `children` per Task 2).
- Produces: an indented tree replacing the flat `.constraint-list`; a live "Effective sequence" panel.

- [ ] **Step 1: Write the failing test**

```js
test('Plant Settings pane exposes tree-rendering internals', () => {
  // Smoke-level, matching this file's existing thin public-API-shape style —
  // the actual tree behavior is covered by Engine.flattenConstraints' own
  // tests in Task 6, since the render function is a thin consumer of it.
  assert.equal(typeof Plant._renderSettingsPane, 'function');
});
```

(This module's existing test convention is a thin "does the function exist" smoke check per `tests/modules/plant-and-administration.test.mjs`'s current style — the actual tree-flattening logic is exhaustively covered in Task 6's `schedule-services.test.mjs`, not duplicated here.)

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/modules/plant-and-administration.test.mjs`
Expected: PASSES already (the function already exists) — this step exists to confirm the test harness runs; the real verification for this task is manual (Step 4) plus the module-level compile check.

- [ ] **Step 3: Implement**

Replace the "Scheduling constraints" block (`web/plant-and-administration.mts:1333-1420` — see the
corrected landmarks in Files above; **not** the stale `:986-1084`) — key structural changes from the
flat version:

```ts
    const consListEl = pane.querySelector('#sys-constraints-list') as HTMLElement | null;
    const seqPanelEl = pane.querySelector('#sys-effective-sequence') as HTMLElement | null; // new element — add to the panel-body HTML alongside #sys-constraints-list
    let consTree: ConstraintConfig[] = [];

    function renderEffectiveSequence(): void {
      if (!seqPanelEl) return;
      const flat = Engine.flattenConstraints(plantName);
      const seen = new Set<string>();
      const allKeysInTreeOrder: string[] = [];
      const collect = (nodes: ConstraintConfig[]): void => {
        for (const n of nodes) { allKeysInTreeOrder.push(n.key); if (n.children) collect(n.children); }
      };
      collect(consTree);
      seqPanelEl.innerHTML = allKeysInTreeOrder.map(key => {
        const cat = Engine.CONSTRAINT_CATALOG.find(c => c.key === key);
        const label = Util.t(`constraint.${key}`);
        const isEffective = flat.includes(key) && !seen.has(key);
        if (isEffective) seen.add(key);
        return `<span class="pl-seq-chip${isEffective ? '' : ' pl-seq-chip-noeffect'}">${label}${isEffective ? '' : ` <em>(${Util.t('ui.no_effect')})</em>`}</span>`;
      }).join(' <span class="pl-seq-arrow">&rarr;</span> ');
      if (!allKeysInTreeOrder.length) {
        seqPanelEl.innerHTML = `<span class="pl-seq-empty">${Util.t('ui.no_constraints_configured')}</span>`;
      }
    }

    function countConfiguredKeys(nodes: ConstraintConfig[]): number {
      const keys = new Set<string>();
      const walk = (ns: ConstraintConfig[]): void => { for (const n of ns) { keys.add(n.key); if (n.children) walk(n.children); } };
      walk(nodes);
      return keys.size;
    }

    function renderConstraints(): void {
      if (!consListEl) return;
      const totalFields = Engine.CONSTRAINT_CATALOG.length;
      const renderNode = (node: ConstraintConfig, siblings: ConstraintConfig[], depth: number): string => {
        const cat = Engine.CONSTRAINT_CATALOG.find(c => c.key === node.key) || { label: node.key, desc: '' };
        const label = Util.t(`constraint.${node.key}`);
        const idx = siblings.indexOf(node);
        const configuredCount = countConfiguredKeys(consTree);
        const canAddChild = configuredCount < totalFields;
        const childrenHtml = (node.children || []).map(c => renderNode(c, node.children!, depth + 1)).join('');
        return `
          <div class="constraint-row" data-key="${node.key}" style="margin-left:${depth * 24}px">
            <div class="cons-reorder">
              <button class="cons-up" ${idx === 0 ? 'disabled' : ''} title="${Util.t('ui.move_up')}">&#9650;</button>
              <button class="cons-dn" ${idx === siblings.length - 1 ? 'disabled' : ''} title="${Util.t('ui.move_down')}">&#9660;</button>
            </div>
            <div class="cons-meta">
              <div class="cons-label">${label}</div>
              <div class="cons-desc">${cat.desc || ''}</div>
            </div>
            <label class="cons-toggle">
              <input type="checkbox" ${node.enabled ? 'checked' : ''}>
              <span>${node.enabled ? Util.t('ui.constraint_on') : Util.t('ui.constraint_off')}</span>
            </label>
            <button class="btn btn-ghost sm" data-add-child="${node.key}" ${canAddChild ? '' : 'disabled'}
                    title="${canAddChild ? Util.t('ui.add_sub_priority') : Util.t('ui.all_fields_used')}">+ ${Util.t('ui.add_sub_priority')}</button>
            <button class="btn btn-ghost sm" data-remove="${node.key}">${Util.t('btn.remove')}</button>
          </div>
          ${childrenHtml}`;
      };
      consListEl.innerHTML = consTree.map(n => renderNode(n, consTree, 0)).join('');
      renderEffectiveSequence();
      // Wire toggle/reorder/add-child/remove handlers per row — same
      // addEventListener pattern as the flat version (:1365-1368), just
      // operating on a node found by walking consTree rather than a flat
      // array's find(). Omitted here for brevity — mirror the existing
      // moveConstraint/saveConstraints wiring exactly, generalized to walk
      // the tree by key instead of indexing a flat array.
    }
```

- [ ] **Step 4: Manual verification**

Boot the app, open Plant → System Settings for a plant with a stored flat config (pre-Stage-3 shape, no `children`) — confirm it still renders (as a depth-0 tree, since a flat array IS a degenerate tree). Build `Color → PRT01(→Color) → PRT02(→Color, PRT01)`, confirm the Effective Sequence panel reads `Color, PRT (01), PRT (02)` with repeats marked "(no effect)". Confirm "+ Add sub-priority" disables once all 4 fields are consumed anywhere in the tree, with the "all fields used" tooltip. Confirm a different tree on a second plant doesn't affect the first. Confirm Save round-trips through `POST /master-data/plants/{plant}/constraints` (Task 2's `children`-preserving backend) and reloading the page shows the same tree.

- [ ] **Step 5: Commit**

```bash
git add web/plant-and-administration.mts tests/modules/plant-and-administration.test.mjs
git commit -m "feat: rebuild Scheduling Constraints as an indented tree with an effective-sequence panel"
```

---

### Task 9: `web/styles.css` + `web/locales/*.js` — tree UI polish and new strings

**Files:**
- Modify: `web/styles.css` (near `.constraint-*`, **`web/styles.css:5649-5667`** — corrected by
  Task 0's audit; the plan originally said `:5577-5596`)
- Modify: `web/locales/{en,de,es,fr,pt}.js`

- [ ] **Step 1: Add tree/sequence CSS**

```css
/* Stage 3 — indented priority tree + effective-sequence readout */
.pl-seq-chip {
  display: inline-block; padding: 3px 10px; border-radius: var(--r-sm);
  background: var(--bg-elev); border: 1px solid var(--line);
  font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; color: var(--fg);
}
.pl-seq-chip-noeffect { color: var(--fg-faint); background: var(--bg-subtle); text-decoration: line-through; }
.pl-seq-chip-noeffect em { font-style: normal; text-decoration: none; margin-left: 4px; }
.pl-seq-arrow { color: var(--fg-faint); }
.pl-seq-empty { font-size: 12px; color: var(--fg-mute); }
```

No `body.dark` overrides needed — every token used already flips in `body.dark`, matching this section's existing zero-dark-override pattern.

- [ ] **Step 2: Add locale keys** (all 5 files)

```js
  'ui.no_effect':                    'no effect',
  'ui.no_constraints_configured':    'No constraints configured — orders sequence in upload order within each day.',
  'ui.add_sub_priority':             'Add sub-priority',
  'ui.all_fields_used':              'All rankable fields are already in the tree',
```

- [ ] **Step 3: Extend Task 15 (Stage 2)'s locale-completeness test**

Add these 4 keys to the `REQUIRED` array (or a second array) in `tests/modules/locale-completeness.test.mjs` — the test infrastructure already exists from Stage 2, this is just more coverage, not a new test file.

- [ ] **Step 4: Verify and commit**

Run: `npm run lint && node --test tests/modules/locale-completeness.test.mjs`

```bash
git add web/styles.css web/locales/en.js web/locales/de.js web/locales/es.js web/locales/fr.js web/locales/pt.js tests/modules/locale-completeness.test.mjs
git commit -m "style: add priority-tree and effective-sequence i18n and CSS"
```

---

### Task 10: Final comprehensive sequencing verification (closes the loop from Task 0)

This is where Task 0's pre-implementation audit gets re-run *post*-implementation, against the real, shipped code — the second half of "comprehensive review of the previous stages' impact on actual sequencing logic." Task 0 verified assumptions before writing code; this task verifies outcomes after.

**Files:**
- Modify: `docs/superpowers/plans/2026-08-11-stage-3-sequencing-audit.md` (append a "Post-implementation verification" section)
- Modify: `docs/scheduling_priority.md` (mark Stage 3 status, record Risk 2's before/after)

- [ ] **Step 1: Re-run Task 0's grep claims against the finished code**

```bash
grep -n "if (key ===" web/schedule-services.mts   # expect: ZERO matches now — the term factory replaced every hardcoded branch
grep -n "colorMap" web/*.mts                       # expect: ZERO matches — fully superseded by Store.priorityRankMaps
grep -n "ORDER_Y" web/schedule-services.mts        # expect: ZERO matches inside Engine — ORDER_Y is retired from the optimizer path entirely
```

Record actual output. If `colorMap` or `ORDER_Y` still appear anywhere in `Engine`, that's a real finding — track it down (a missed call site is exactly the kind of thing this verification exists to catch) rather than closing the task with a stray reference left in.

**Task 0 audit — three things that will otherwise make these greps fail spuriously:**
- `web/schedule-workbench.mts` holds 11 of the 16 current `colorMap` references (see Task 6's Files);
  they must be removed there too, not just in `schedule-services.mts`.
- `web/schedule-services.mts:111` mentions `colorMap` in the `SortTerm` **doc comment** ("number for
  runHours/colorMap") — update that prose or the grep never reaches zero.
- The `grep` targets `web/*.mts` only; the compiled `web/*.mjs` outputs carry the same strings until
  `npm run build` is re-run. Build first, or the `.mjs` copies will look like live references.

- [ ] **Step 2: Build the Risk 2 before/after** (`docs/scheduling_priority.md` Risk 2: "N12 changes existing color sequencing... capture a before/after for one real plant")

Pick one plant with a real, incomplete color wheel (fewer ranked colors than distinct colors in its orders — visible via the Stage 2 coverage readout). Run Smart optimize before this stage's changes (checked out at the Stage 2 tip) and after (this stage's tip), on the same order snapshot, and diff the resulting sequence. Confirm every difference traces to either (a) an unranked color that now groups with other unranked colors instead of interleaving, or (b) a newly-active PRT/production-version term the plant has since configured. Record the diff and its explanation in the audit doc — this is the concrete evidence the doc's own Risk 2 asks for, not a restatement of the risk.

- [ ] **Step 3: Confirm the alert auto-fix path specifically**

Trigger an overlap alert's auto-fix on a plant with a configured tree (per Task 0 Step 3's identified risk: this path passes no explicit map, so it depends entirely on `Store.priorityRankMaps` being populated). Confirm the resulting sequence honors the plant's configured priority order, not a 999999-for-everything fallback. This is the single highest-value manual check in this task — it's the one path Task 0 flagged as silently breakable.

- [ ] **Step 4: Cross-line drag verification (the N2 fix)**

Drag an order from a line with a line-override list to a line without one (or with a different override). Re-run optimize and confirm the order now sequences by the *destination* line's rank (or plant-wide, if the destination has no override) — not the stale rank from where it started. This is the concrete test of Seam 1's whole reason for existing.

- [ ] **Step 5: Performance sanity check (R11)**

With all 4 fields enabled on one plant, run Smart optimize on a realistic order count and compare wall-clock against the same run with only `colorWheel` enabled (today's baseline). Record the delta in the audit doc. R11 anticipated ~1.75x allocation on the hot dispatch loop as an accepted, opt-in cost — confirm it's in that ballpark, not a surprise regression.

- [ ] **Step 6: Write the final verdict and update `docs/scheduling_priority.md`**

Update the Stage table (`docs/scheduling_priority.md:14-20`) — Stage 3's status cell — and add a "Stage 3 status" paragraph mirroring Stage 1's, stating plainly what was verified against live data versus what still needs a human with production access to confirm (following the exact honesty precedent Stage 1's status paragraph set — "not yet applied," "explicitly waived," etc. — don't claim more certainty than the verification actually produced).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/2026-08-11-stage-3-sequencing-audit.md docs/scheduling_priority.md
git commit -m "docs: post-implementation sequencing verification for Stage 3"
```

---

## Cross-cutting verification (run once all tasks land)

- [ ] `npm run build && npm run typecheck` — clean.
- [ ] `npm run lint:errors` — clean.
- [ ] `npm test` — clean, including Task 6's updated `schedule-services.test.mjs` and Task 9's extended locale-completeness test.
- [ ] `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -v` — all Stage 1+2+3 tests pass.
- [ ] `docs/MIGRATION.md` — confirm R13 (per-process `PLANT_LISTS`) and R17 (compat shims) still read accurately now that the rank-maps endpoint depends on the same cache; add a note if Stage 3 changes either risk's scope (it widens R13's blast radius slightly: a stale `PLANT_LISTS` on one replica now affects live sequencing, not just the Optimization tab's display, on a multi-replica deploy — the pilot is still single-replica, so not urgent, but the note should say so explicitly rather than let R13 read as display-only).
- [ ] `CLAUDE.md`/`AGENTS.md` — update the Key Patterns → Optimization section: `_sortTerms` no longer has a single hardcoded `colorWheel` branch; document the term-factory + `Store.priorityRankMaps` + `flattenConstraints` mechanism at the same level of detail the current day-integrity-dispatch paragraph uses.
