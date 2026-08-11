# Stage 3 — pre-implementation sequencing-impact audit

**Run:** 2026-08-11, against the working tree at `8bf2f94` (branch `master-data-tab`, clean except
the two untracked Stage 2/3 plan docs).
**Scope:** Task 0 of `docs/superpowers/plans/2026-08-11-priority-lists-stage-3.md`, Steps 1-4.
**Purpose:** re-verify, against the *current* code rather than the plan's prose, the load-bearing
assumptions the rest of Stage 3 rests on. Stage 3 is the only stage that changes live sequencing, so
every assumption below is stated as a falsifiable claim with the literal evidence that settles it.

**Overall verdict: CONFIRMED, with corrections — proceed to Task 1.**
No assumption underlying the stage is broken (nothing BLOCKED). Four substantive corrections and one
defect in *planned* (not yet written) code were found; all are fixable inside the tasks that own them
and are recorded per-task in §6. Line-number drift across five tasks is recorded in §7 — Task 8's is
large enough (~340 lines) that blind-replacing the cited range would destroy unrelated code.

---

## 1. Step 1 — have Stage 1+2 changed sequencing? **CONFIRMED (no)**

Literal grep output, not a restatement of the expectation.

```
$ grep -rn "PRT_01\|PRT_02\|PRODUCTION_VERSION" web/schedule-services.mts
507:    const { PRT_01, PRT_02, PRODUCTION_VERSION, ...rest } = t;
```

One match, and it is the exclusion the plan predicted. `web/schedule-services.mts:501-509` is
`Compute._stripPriorityFields`, added in Stage 1 to drop these three fields from the worker snapshot
*before* the `postMessage` structured clone:

```ts
// Alerts/Utilization compute never read these (docs/scheduling_priority.md
// R10) — dropped before the structured-clone postMessage, the documented
// dominant main-thread cost of the Worker.* round trip. Excludes only the
// three fields Stage 1 added; every other field ships exactly as before.
function _stripPriorityFields(t: NimbusTask): NimbusTask {
  const { PRT_01, PRT_02, PRODUCTION_VERSION, ...rest } = t;
  return rest as NimbusTask;
}
```

Zero matches inside `_sortTerms` (`:994-1029`), `_comparator` (`:1037-1044`), or
`_dispatchDayIntegrity` (`:1069-1320`). The three new fields are *excluded* from compute; they are
never consulted by it.

```
$ grep -n "activeConstraintKeys(plant" web/schedule-services.mts
976:  activeConstraintKeys(plant: string | null): string[] {
1009:      for (const key of Engine.activeConstraintKeys(plant ?? null)) {

$ grep -n "if (key ===" web/schedule-services.mts
1010:        if (key === 'colorWheel') {
1016:        // future: if (key === 'tooling') terms.push({ get: ..., cmp: ... });
```

Exactly one real branch (`:1010`), inside `_sortTerms`, plus the `// future:` placeholder at `:1016`
which is still only a comment. The live term is unchanged from pre-Stage-1:

```ts
get: (t: NimbusTask) => colorMap ? (colorMap[Util.norm(t.COLOR)] ?? 999999) : (t.ORDER_Y ?? 999999),
```

**Verdict: CONFIRMED.** Stage 1 and Stage 2 shipped no sequencing change. The standing claim holds;
nothing needs escalating on this point.

---

## 2. Step 2 — does `_dispatchDayIntegrity` need zero changes? **CONFIRMED**

Re-verified against current code, not against the prior claim. All three sub-claims hold, and the
whole 252-line body was read (not just the three cited hunks) to confirm no field name is hardcoded
anywhere in it.

**(1) `seqCompare` is generic** — `web/schedule-services.mts:1129-1135`:

```ts
const seqCompare = (a: any, b: any): number => {
  for (const tm of tieBreakTerms) { const c = tm.cmp(tm.get(a), tm.get(b)); if (c) return c; }
  const d = dueMs(a) - dueMs(b);
  if (d) return d;
  return String(a.id).localeCompare(String(b.id));
};
```

No field name appears. Term count and identity are entirely the caller's business.

**(2) `rankForDay`'s `wheelFirst` and its decoration are generic** — `:1144-1154`:

```ts
const wheelFirst = (a: any, b: any): number => {
  for (let i = 0; i < tieBreakTerms.length; i++) {
    const c = tieBreakTerms[i].cmp(a.k[i], b.k[i]);
    if (c) return c;
  }
  return 0;
};
const decorated = list.map(t => {
  const dk = dueDayKey(t);
  const tier = dk === null ? 3 : (dk === dayKeyD ? 0 : (dk < dayKeyD ? 1 : 2));
  return { t, tier, due: dueMs(t), k: tieBreakTerms.map(tm => tm.get(t)) };
});
```

Index-parallel over `tieBreakTerms`. Growing the array grows `k` with it; nothing else changes.
The name `wheelFirst` is now a misnomer (it means "all configured priority terms first"), but that is
cosmetic — worth a rename comment in Task 6, not a behavior change.

**(3) `tieBreakTerms` is injected by the caller** — signature at `:1069-1076`:

```ts
_dispatchDayIntegrity(
  line: string, freeTasksIn: NimbusTask[], fixedTasks: NimbusTask[], cursorInit: Date,
  opts: { respectCalendar: boolean; tieBreakTerms: SortTerm[]; mode: string }
): Array<{ id: string; changes: Partial<NimbusTask> }> {
  const { respectCalendar, tieBreakTerms, mode } = opts;
```

Sole caller is `runAndApply`, `:1413-1415`, forwarding `_sortTerms`' own output verbatim
(`sortTerms` is bound at `:1345` as `Engine._sortTerms(mode, { plant, colorMap })`):

```ts
patches.push(...Engine._dispatchDayIntegrity(line, freeTasks, fixedTasks, cursor, {
  respectCalendar, tieBreakTerms: sortTerms, mode,
}));
```

`grep -n "_dispatchDayIntegrity"` returns only the definition (`:1069`), this call (`:1413`), and
three doc-comment mentions (`:1035`, `:1139`, `:1423`) — one caller, no other entry point.

The remainder of the body (`fitsAt` `:1112-1124`, phase-1 admission `:1213-1233`, the no-admission
cursor jump `:1235-1268`, phase-2 placement `:1278-1289`, the 90-day force-place escape
`:1295-1309`, and the day advance `:1311-1318`) references only `Util.runHours`, `Util.sapDueDate`,
`Calendar.*`, `start_date`/`end_date`/`id`. **No priority field, and no `tieBreakTerms` arity
assumption, anywhere.**

**Verdict: CONFIRMED, no changes needed.** Growing `_sortTerms` from 1 conditional term to N is
invisible to `_dispatchDayIntegrity`, and Task 4/6's premise stands.

> **Correction to the brief and the plan:** both cite the body as `web/schedule-services.mts:1069-1230`.
> It is **`:1069-1320`** — the citation stops ~90 lines short, mid-way through phase 1, and omits
> phase-2 placement, the force-place escape hatch, and the day advance. The three hunk citations
> (`:1129-1134`, `:1144-1150`, `:1154`, `:1074`) are all exact.

---

## 3. Step 3 — the alert auto-fix path. **CONFIRMED, with a nuance and a new risk**

The call is exactly as claimed — `web/schedule-services.mts:706`, inside `Alerts.autoFix`'s
`overload` branch:

```ts
Engine.runAndApply('combined', { lines: [line], startDate: dayStart, endDate: dayEnd });
```

No `colorMap`, no `plant`, no `respectFixed`/`respectCalendar`.

**Why it is safe today.** `_sortTerms`' colorWheel branch (`:1012`) falls back to
`t.ORDER_Y ?? 999999` when `colorMap` is absent, and `ORDER_Y` is stamped fresh on every `/tasks`
fetch: `brain.py:1368` calls `apply_priority_merge(df, plant=plant)` on the scoped read path, which
resolves the plant-wide `colorWheel` list and then lets a line-specific list win for its own line
(`brain.py:976-1013`, stamp helper `:933-936`), with unlisted colors set to `999999` at `:1013`.

**Nuance the brief slightly overstates — worth knowing before Task 6.** "no `plant`" is true of the
*call site*, but `runAndApply` defaults it at `web/schedule-services.mts:1332`:

```ts
const plant: string | null = (opts.plant as string | null | undefined) ?? Store.selectedPlant;
```

So the plant's **constraint tree is already resolved correctly** on this path today — only the
*rank map* is missing. That is a useful narrowing: Task 6 does not have to fix constraint resolution
here, only rank resolution.

**This is confirmed as the one call site Task 6 can silently break.** Task 6 removes the `ORDER_Y`
fallback (Decisions: "`ORDER_Y` is no longer consulted by the optimizer"), so from that commit
onward this path resolves ranks *only* from `Store.priorityRankMaps`. If that cache is empty or
stale when auto-fix runs, every order on every field ranks `999999` — configured, inert, silent.
Task 4/6's test suite **must** include a test that invokes this exact path with no explicit map
argument and asserts real ranks resolve from `Store` state.

**NEW RISK found by this audit — not in the plan.** Two facts together:

1. A single non-plant-keyed `Store.priorityRankMaps` is **safe**, because every `runAndApply`
   caller's effective plant is always `Store.selectedPlant`: the auto-fix path by the `??` default
   above, and `OptimizeDialog` because `selectPlant` (`web/schedule-workbench.mts:6195-6197`) calls
   `Store.setSelectedPlant(plant, 'optimize-dialog')` before anything else, and `_renderPlantList`
   does the same at `:6127`. Good news for Task 5 — no plant key needed on the cache.
2. But `OptimizeDialog` **currently** guards the "cache not filled yet" race explicitly, with a
   synchronous fallback fetch before Run (`web/schedule-workbench.mts:6517-6539`, comment: *"Fall
   back to a quick fetch only if the cache hasn't filled yet (race on first open)"*). Task 6's compat
   note deletes that fetch. Task 5's `loadPriorityRankMaps` is fire-and-forget on `'plant:selected'`
   with no await and a `catch → {}`, so **the race today's code handles becomes unhandled**: click
   Run (or trigger an auto-fix) before the fetch resolves, or after it fails, and the run silently
   sequences at 999999-for-everything.

   *Recommendation (Task 5/6, not blocking):* keep an equivalent guard — either have
   `loadPriorityRankMaps` return its promise and have `OptimizerPreview.runWithPreview` await it when
   the cache is empty for the selected plant, or track a `_rankMapsPlant` marker and re-fetch
   on-demand when it doesn't match. Do not simply delete the race handling.

**Verdict: CONFIRMED** as the path Stage 3 must not forget, plus one new unhandled-race risk to fold
into Task 5.

---

## 4. Step 4 — the `prt01` chain, end to end. **CONFIRMED intact; one defect found in planned code**

Every arrow verified by grep/read. Hops 5 and 6 are Stage 3's own work and are confirmed *absent*
(clean slate — `grep -rn "priority-rank-maps\|priorityRankMaps\|_valueOf\|flattenConstraints\|setConstraintCatalog\|_taskFieldFor"`
over `brain.py` and `web/*.mts`/`*.mjs` returns nothing).

| # | Hop | Evidence |
|---|-----|----------|
| 1 | `POST /priority-list/{plant}/prt01` | `brain.py:1927` route; `spec = md.RANKABLE_FIELDS.get(field_key)` `:1945`; unknown key → 400 (`:1995`, `:2025`) |
| 2 | value normalization (UPPER + strip) | `brain.py:776`: `df[resolved_value_col].fillna("").astype(str).str.upper().str.strip()` |
| 3 | → `priority_list.entries` JSONB | `_persist_priority_list` → `db.upsert_priority_list(plant, field_key, entries, line=…)` at `brain.py:823-828` |
| 4 | → `brain.PLANT_LISTS[plant][line]['prt01']` | `db.load_all_priority_lists()` `db.py:2035-2044` returns `{plant: {line: {field_key: {VALUE: RANK}}}}`; assigned `brain.py:899`; per-plant refresh `brain.py:919-925`; declared shape `brain.py:123` |
| 5 | → `GET /priority-rank-maps` | **Does not exist yet** — Task 3. Returning `PLANT_LISTS.get(plant, {})` verbatim is correct: the native shape is line-first, matching Task 4's corrected type |
| 6 | → `Store.priorityRankMaps.prt01` | **Does not exist yet** — Task 5 |
| 7 | field key → task field | `master_data.py:112`: `'prt01': {'mp_column': 'prt_01', 'orders_column': 'prt_01', 'task_field': 'PRT_01', …}` |
| 7b | surfaced to the client | `GET /priority-fields` `brain.py:1871-1883` spreads the whole spec (`{"field_key": key, **spec}`), so `task_field` **is** in the payload; already typed as `PriorityFieldMeta` at `web/types.mts:123-129` |
| 8 | `t.PRT_01` on the task | `db.py:208` `prt_01 AS "PRT_01"` → `TaskDTO.PRT_01` `brain.py:1086` → emitted `brain.py:1399` → `NimbusTask.PRT_01?: string` `web/types.mts:58` |
| 9 | materialized from master data | `db._stamp_order_attributes` `db.py:1276`, `SET … prt_01 = mp.prt_01` `:1313`, keyed `(plant, material_number = material_id)` |
| 10 | client normalization matches server | `Util.norm` = `(s ?? '').toString().trim().toUpperCase()` (`web/application-foundation.mts:365`) vs. server UPPER+strip at hop 2 — **compatible** (trim/upper commute for these ops) |

No field-key vs. task-field mismatch exists in the *shipped* chain. **Verdict: CONFIRMED.**

### 4a. DEFECT in Task 6's planned `_taskFieldFor` — the exact failure class Step 4 was written to catch

The plan's Task 6 Step 3 code:

```ts
_taskFieldFor(key: string): string {
  if (key === 'colorWheel') return 'COLOR';
  const meta = Engine._fieldTaskFields[key];
  return meta || key.toUpperCase();
},
```

The `key.toUpperCase()` fallback is **wrong for three of the four registered fields**:

| `field_key` | `key.toUpperCase()` | real `task_field` | match? |
|---|---|---|---|
| `colorWheel` | (special-cased) | `COLOR` | ✓ |
| `prt01` | `PRT01` | `PRT_01` | ✗ |
| `prt02` | `PRT02` | `PRT_02` | ✗ |
| `productionVersion` | `PRODUCTIONVERSION` | `PRODUCTION_VERSION` | ✗ |

And the fallback **is reachable**, in two ways:

- Task 7 wires `setFieldTaskFields` from a `fetch(...).catch(() => {})` — a failed or slow
  `/priority-fields` leaves `_fieldTaskFields` `{}`.
- `flattenConstraints` sources keys from the plant's **stored tree**
  (`Store.masterData.plants[*].constraints`, loaded by `Store.setMasterData` from
  `/master-data/plants`, `web/schedule-data.mts:247-255`), *not* from `CONSTRAINT_CATALOG`. So a
  plant with `prt01` configured emits that key regardless of whether the registry ever resolved —
  Task 7's "offline fallback: `CONSTRAINT_CATALOG`'s hardcoded colorWheel entry stands" reasoning
  protects the *catalog*, not the *tree*.

Consequence: `Util.norm(t['PRT01'])` → `''` → `scoped['']` → `999999` for every order.
Looks configured, does nothing — the R1-class failure mode this doc names as "the worst class of bug."

*Recommended fix inside Task 6 (not a plan blocker):* seed `_fieldTaskFields` with the four known
mappings as the offline default, exactly mirroring `CONSTRAINT_CATALOG`'s own hardcoded-fallback
pattern, and have `setFieldTaskFields` merge over it rather than replace (and keep its
`if (!fields.length) return` guard). Optionally `ErrorLog.warn` on a key with no known task field
instead of guessing one. Do **not** ship `key.toUpperCase()` as the fallback.

---

## 5. Corrections applied to `docs/scheduling_priority.md`

Per that doc's own policy ("when a stage lands, correct anything here that turned out wrong rather
than letting it rot"), the following were fixed in place as part of this task. Each was verified
against current code before editing.

**Substantive:**

1. **Seam 1's rank-map shape was transposed.** It read `{field_key: {line|'': {VALUE: RANK}}}`
   (field-first). The actual shape everywhere — `brain.PLANT_LISTS` (`brain.py:123`) and
   `db.load_all_priority_lists()` (`db.py:2036`) — is **line-first**,
   `{line|'': {field_key: {VALUE: RANK}}}`. This is precisely the transposition Stage 3's Task 3
   caught mid-plan and Task 4 exists to un-do; fixed at the source so the next reader isn't misled.
2. **R1 is done.** It read "currently `4` → must be `5`". Stage 1 bumped it:
   `Config.SCHEMA_VERSION: 5` at `web/application-foundation.mts:137`. Marked resolved rather than
   left reading as an open landmine.
3. **R19 is false.** It predicted `tests/modules/schedule-services.test.mjs` "will **break** on the
   `_sortTerms` signature change." `grep -rn "colorMap\|_sortTerms\|_comparator" tests/` returns
   **zero matches** — no test anywhere references any of the three. That file is 195 lines / 15
   tests, and its Engine public-API test (`:128-133`) makes only positive `typeof` assertions, so
   adding methods won't break it either. Rewritten to say what's actually true, which is *worse* in
   one respect and better in another: no test breaks, **and `_sortTerms` has never had any test
   coverage at all** — Task 6's new tests are its first.
4. **Stage 2 status item (2) is stale.** It said the `legacy-surface` contract-snapshot test "is
   currently failing" pending `node scripts/legacy-surface.mjs --write`. It now passes 10/10
   (verified by running it); the fixture was regenerated in `f8e7269`. Marked done, with the note
   that Task 8/9's new tree handlers will require regenerating it *again*.

**Stale line-number citations (code drifted; the claims themselves still hold):**

| Claim | Was | Now |
|---|---|---|
| Emitted row sort keyed on `ORDER_Y` (Seam 1, and R6) | `brain.py:823` | `brain.py:1026` (`:823` is now inside `_persist_priority_list`) |
| `PRODUCTION_VERSION` dead catalog entry (R4) | `order-field-catalog.mjs:64` | `:78` |
| `ROW_VERSION` / xmin (xmin-hazard section) | `db.py:215` | `db.py:219` |
| per-task-per-day `tieBreakTerms.map()` (R11) | `schedule-services.mts:1145` | `:1154` (`:1145` is `wheelFirst`'s loop) |
| `wheelFirst` (R7) | `schedule-services.mts:1135` | `:1144` |
| alert auto-fix `runAndApply` (N2) | `schedule-services.mts:697` | `:706` |
| `initConstraints` synchronous (R8) | `plant-and-administration.mts:1073` | `:1416` |

Re-verified as **still exact**: `web/application-foundation.mts:137` (SCHEMA_VERSION),
`web/schedule-data.mts:837` (cache discard), `schema.sql:260`
(`default_production_version`), `web/schedule-workbench.mts:250` (`updateGroup: true`) and `:1641`
(`PRODUCTION_LINE` `editable: true`) — N2's two load-bearing citations both hold.
R11's "term count goes 4 → 7 with all fields enabled" also re-checked and correct (today: 1 color +
`FORM_SIZE` + `MATERIAL_NUMBER` + `runHours` = 4; all four fields → 7).

---

## 6. Corrections the plan's own tasks need (do these before implementing the task)

1. **Task 6's Files list omits `web/schedule-workbench.mts`.** That file holds 11 `colorMap`
   references — the `OptimizerRunOptions.colorMap` field (`:6074`), the `_wheelCache` type
   (`:6037`), the badge's `/color-wheel/{plant}` prefetch (`:6378-6397`), and the pre-Run
   resolve/fallback-fetch (`:6519-6553`) — all of which Task 6's own compat note says to delete and
   Task 10 Step 1's `grep -n "colorMap" web/*.mts` expects to return zero. Add it to Task 6's Files
   and its commit, or Task 10's check fails by construction.
2. **Task 6's `_taskFieldFor` fallback is wrong.** See §4a. Seed the four known mappings.
3. **Task 6 Step 4's expectation is wrong.** No existing test breaks (see §5.3). Replace "existing
   tests … WILL fail — update them" with "no existing test touches `_sortTerms`; the new tests are
   additive and are this function's first coverage."
4. **Task 6's "Produces" cites `Engine._valueOf(t, taskField)`, which its own Step 3 code never
   defines** (it inlines `Util.norm((t as …)[taskField])`). The brief's Step 4 references `_valueOf`
   too. Either add the helper or drop it from the interface list — don't leave the plan describing a
   function that isn't in its own implementation.
5. **Tasks 6/7 should use the existing `PriorityFieldMeta` type** (`web/types.mts:123-129`) instead
   of inline `Array<{ field_key: string; default_label: string }>` / `Array<{ field_key: string;
   task_field: string }>`. The type already exists and already carries both fields.
6. **Task 5 must not delete `OptimizeDialog`'s race handling without replacing it.** See §3's new
   risk.
7. **Task 8/9 will add inline handlers**, so `tests/contracts/cq1-legacy-surface.json` needs
   regenerating (`node scripts/legacy-surface.mjs --write`) and committing. Budget for it; the test
   currently passes, so a regression there will be newly-introduced, not pre-existing.
8. **Task 7 adds a second `/priority-fields` fetch.** `web/plant-and-administration.mts:811`
   already fetches it (Stage 2, for the Optimization tab). Task 7's boot fetch is still justified —
   `Engine` needs the registry before any optimize, not only when the Plant tab opens — but the two
   should be noted as intentional, or share a cached promise.
9. **`wheelFirst` is now a misnomer** (`web/schedule-services.mts:1144`) — it iterates all
   configured priority terms, not a color wheel. Worth a rename or a clarifying comment in Task 6's
   pass, since Stage 3 is exactly when the name stops being true.

## 7. Line-number drift in the plan's own file citations

Stage 2 grew several of these files after the plan was written. Verified current values:

| Task | Plan says | Actual |
|---|---|---|
| 1 | `web/types.mts:117-121` (`ConstraintConfig`) | `:116-120` |
| 2 | `master_data.py:985-1020`; loop to replace `:994-1002` | `set_plant_constraints` `:988-1030`; **normalization loop `:997-1005`** |
| 6 | `web/schedule-services.mts:944-1029` | `:944` is `export const Engine = {`; `CONSTRAINT_CATALOG` `:952`; `_sortTerms` ends `:1029`. `_comparator` `:1037` ✓, `runAndApply`'s `_sortTerms` call `:1345` ✓ |
| 8 | `plant-and-administration.mts:868-1085`; constraints block `:986-1084`; wiring `:1016-1026` | **`_renderSettingsPane` `:1211`**; `#sys-constraints-list` markup `:1260`; `consListEl` `:1333`; row wiring `:1365-1368`; `moveConstraint` `:1372`; `saveConstraints` `:1397`; `initConstraints` `:1416`. **~340-line drift — blind-replacing `:986-1084` would destroy unrelated code.** |
| 9 | `web/styles.css:5577-5596` (near `.constraint-*`) | `.constraint-list` `:5649` through `.cons-toggle input` `:5667` |

Task 2's drift also matters for its test: the plan's `test_set_plant_constraints_rejects_depth_beyond_three`
passes `plant="ZZANY"` and relies on the depth `ValueError` firing *before* the "Plant not found"
error. That works — normalization at `:997` runs before the pool connection at `:1013` — so the test
design is sound as written.

---

## 8. What this audit did **not** verify

Stated plainly so no one reads more certainty into it than it earned:

- **No test suite was run** beyond `tests/modules/legacy-surface.test.mjs` (10/10 pass, used to
  falsify one stale doc claim). No `npm run build`, `typecheck`, `lint`, or `pytest`.
- **Nothing was verified against a live database.** `PLANT_LISTS`' population, the `priority_list`
  table's contents, and `_stamp_order_attributes`' real match rate are all unverified — consistent
  with Stage 1's own status ("not yet applied to any database") and pre-ship check #1 still being
  outstanding.
- **No browser check.** The `Store.masterData.plants[*].constraints` → `flattenConstraints` path was
  verified by reading code, not by observing a real plant's stored tree.
- **Steps 5-6 only.** This audit covers Task 0 Steps 1-4 plus the doc corrections. Task 10's
  post-implementation half — the Risk 2 before/after diff, the manual auto-fix check, the cross-line
  drag check, and the R11 perf delta — is untouched by design.
