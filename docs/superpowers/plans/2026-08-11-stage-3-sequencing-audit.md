# Stage 3 — sequencing-impact audit (pre- and post-implementation)

> **Two parts.** **§1-8** is the *pre-implementation* audit (Task 0, run against `8bf2f94` before any
> Stage 3 code existed) — it establishes why the stage was built the way it was. **§9-14** is the
> *post-implementation* verification (Task 10, run against `e71e986` after all 11 tasks landed) — it
> re-runs those same checks against the shipped code and records what is genuinely verified versus
> what still needs a human with production access. If the two parts disagree, §9-14 wins.

---

# Part 1 — pre-implementation audit

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
  drag check, and the R11 perf delta — is untouched by design. **→ now covered in Part 2 below.**

---
---

# Part 2 — post-implementation verification

**Run:** 2026-08-11, against `e71e986` (branch `master-data-tab`; working tree clean apart from one
untracked Stage 2 plan doc). All 11 Stage 3 tasks landed in `de2f528`..`e71e986`.
**Scope:** Task 10 of the Stage 3 plan, Steps 1-7 plus the plan's cross-cutting checklist.

## 9. The honesty frame for this half — read this first

Task 10's brief specifies five checks (Steps 1-5). **Step 1 is a pure code check and was performed as
specified.** Steps 2-5 as written all require a running app with real data:

> Step 2 "Run Smart optimize before this stage's changes … and after … on the same order snapshot".
> Step 3 "Trigger an overlap alert's auto-fix on a plant with a configured tree".
> Step 4 "Drag an order from a line with a line-override list to a line without one".
> Step 5 "run Smart optimize on a realistic order count and compare wall-clock".

**None of those were performed, and this document does not claim they were.** This session had no
browser and no working Postgres: local Postgres is reachable, but `.env` carries leftover Azure-pilot
settings (`PG_SSLMODE=require` against a local server with no SSL, plus Azure credentials) — a
standing, documented gap recorded by every task in this stage.

What was done instead, following the same method Task 0's audit, Task 6's report and Task 8's Step 4
all used: **the real shipped modules were loaded and executed under Node** (the same harness
`tests/modules/schedule-services.test.mjs` uses — a `createRequire` bootstrap of
`nimbus-compute-core.js` plus minimal `window`/`document` stubs), driven against synthetic orders, and
every claim below states its confidence and what a human still has to confirm. Two throwaway scripts
were used (their fixtures and full output are reproduced in §11.2/§11.3 and §12); both import
`web/schedule-services.mjs`, `web/schedule-state.mjs` and `web/application-foundation.mjs` directly —
**the logic under test is never reimplemented**, only the deleted pre-Stage-3 comparison term is, and
that is copied verbatim from `git show`.

**The distinction that matters:** this verifies the *sequencing rules* Stage 3 shipped, exactly as
shipped. It does **not** verify that any real plant's `priority_list` rows, `plants.constraints` tree,
or `material_plants` attribute population are what anyone expects. Those are data facts and only
production access settles them.

## 10. Step 1 — Task 0's greps re-run against the finished code

`npm run build` was run first, so the compiled `.mjs` outputs are current (Task 0 §6.8's trap).
Literal output:

```
$ grep -n "if (key ===" web/schedule-services.mts
(exit 1 — no matches)

$ grep -n "colorMap" web/*.mts
(exit 1 — no matches)

$ grep -rn "colorMap" web/
(exit 1 — no matches anywhere under web/, compiled .mjs included)

$ grep -n "ORDER_Y" web/schedule-services.mts
1177:   *  branch, and ORDER_Y is no longer consulted at all. Key encoding is
```

**All three expectations met.** The term factory replaced every hardcoded branch (`if (key ===` is
gone, including the `// future: if (key === 'tooling')` placeholder). `colorMap` is gone from the whole
tree, not just `schedule-services.mts` — Task 0's warning that `schedule-workbench.mts` held 11 of the
16 references, and that the `SortTerm` doc comment at `:111` held a 17th, were both acted on.

The single `ORDER_Y` match inside `Engine` is a **doc comment stating the retirement**
("…and ORDER_Y is no longer consulted at all"), not a live read. Tracked down in full, the remaining
`ORDER_Y` occurrences under `web/` are:

| Location | Why it is legitimately still there |
|---|---|
| `web/locales/{en,de,es,fr,pt}.js` `ui.drop_hint` | Upload UI copy — the uploaded `.xlsx` still uses an `ORDER_Y` column. Ingest-side, not optimizer-side. |
| `web/types.mts:67` (`ORDER_Y?: number`) | `TaskDTO` still carries it; R17 keeps it as the color-only alias. |
| `web/types/api-generated.d.mts:1625` | Generated from `brain.py`'s Pydantic model — same reason. |
| `web/schedule-services.mts:1177` | Comment recording the retirement. |
| `web/schedule-workbench.mts:6532` | Comment explaining why the old 1500 ms fetch bound was dropped ("back then a missing wheel still left a usable ORDER_Y fallback"). |

**No live `ORDER_Y` read remains on the optimizer path. Confidence: certain** (exhaustive grep of a
static tree).

### 10a. Bonus check the brief did not ask for, worth having: is `_dispatchDayIntegrity` really untouched?

Task 0 §2 predicted zero changes needed. Rather than re-read it, the two versions were diffed
directly:

```
$ git show 8bf2f94:web/schedule-services.mts | sed -n '1060,1311p' > old
$ sed -n '1285,1536p' web/schedule-services.mts        > new
$ diff old new        # (no output)
```

**252 lines, byte-identical.** The day-integrity dispatch survived the stage completely unmodified —
the strongest available confirmation of the "Vs. due dates" decision and of the seam Task 4/6 relied
on. *(Incidentally this also corrects Part 1 §2's own re-pin: the pre-stage body was `:1060-1311`, not
the `:1069-1320` recorded there — the signature line was off by 9.)* **Confidence: certain.**

## 11. Steps 2-4 — what the sequencing rules actually do

### 11.1 Step 3 (alert auto-fix) — CONFIRMED as a mechanism, with a **new residual finding**

The call site is verbatim and unmoved: `web/schedule-services.mts:706`, in `Alerts.applyFix`'s
`overload` branch — `Engine.runAndApply('combined', { lines: [line], startDate: dayStart, endDate:
dayEnd })`. No plant, no map.

**The mechanism works.** `tests/modules/schedule-services.test.mjs:528` exercises exactly this shape
(`runAndApply('combined', …)` with no `plant` and no rank argument) against `Store.setMasterData` +
`Store.setPriorityRankMaps` + `Store.setSelectedPlant`, and asserts rank-1 RED is scheduled before
rank-2 BLUE where BLUE is both first in insertion order **and** the shorter job — so neither input
order nor the SPT tail term could produce the pass by accident, and a 999999-for-everything fallback
would fail it. It passes. **Confidence: high** that when `Store.priorityRankMaps` holds the right
plant's maps, auto-fix honors the configured order rather than a flat fallback.

**FINDING (new, not previously recorded — the single most important output of this task).** Task 6's
report claimed this path is "provably safe rather than safe-in-the-common-case," on the grounds that
`schedule:hydrated` (which triggers the alert recompute that creates the Fix button) is emitted inside
the `.finally()` of the `Promise.all` containing `loadPriorityRankMaps`. **That is only half true, and
the untrue half is worse than "unranked".** Reading `web/schedule-data.mts`:

- `schedule:hydrated` is emitted **twice** on the successful plant-load path: once at **`:404`**,
  immediately after `Store.setTasks(...)`, and again at **`:446`** inside the `.finally()` Task 6
  cited.
- `Persistence.loadPriorityRankMaps(plant)` is only called at **`:445`** — inside the `.finally()` of
  the *master-data* `Promise.all` at `:425`, whose two fetches each carry a 5,000 ms timeout. So the
  rank-map fetch does not even **start** until master data settles.
- `Store.priorityRankMaps` is **never cleared** when the plant changes. `load()` has no
  `setPriorityRankMaps({})` for a real plant (only the `!plant` branch at `:250` clears it).

Consequence: between `:404` and `:446` on a plant switch, `Store.tasks` and `Store.selectedPlant` are
plant **B** while `Store.priorityRankMaps` still holds plant **A**'s maps, and the alert recompute the
`:404` emit triggers has already produced B's alerts and their Fix buttons. An overload auto-fix
clicked in that window sequences B's orders against **A's ranks** — a plausible-looking but wrong
sequence, which is harder to notice than the all-999999 case Task 6 designed for. Two further paths
never load rank maps at all and emit `schedule:hydrated` regardless: `_loadCache()` (`:893`, the
backend-failure fallback) and `_loadDemo()` (`:1003`).

**Severity: low-probability, moderate-consequence.** The window is a few hundred ms to a few seconds,
requires a click inside it (most likely with the alert drawer already open), and `Optimize → Run` is
**not** affected (Task 6's replacement guard awaits `loadPriorityRankMaps` when
`Persistence._rankMapsPlant !== plant` and confirms with the user when it is still not fresh). The
auto-fix path structurally cannot do the same: `schedule-services.mts` must not import
`schedule-data.mts` (layer direction), so it has no access to `_rankMapsPlant`.

**Cheapest mitigation, if wanted** — not applied here, because it changes another task's file and
trades one behavior for another rather than being a single objectively-correct fix: clear the cache at
the top of `Persistence.load()` whenever the requested plant differs from `_rankMapsPlant`
(`Store.setPriorityRankMaps({}); Persistence._rankMapsPlant = null;`). That converts the failure mode
from "silently ranked by the previous plant" to "silently unranked", which is the mode Task 6 already
reasoned about and which the Run-path confirm already catches. Moving the `loadPriorityRankMaps(plant)`
call out of the master-data `.finally()` so it starts immediately would additionally shrink the window
to roughly one round trip. **Needs a human decision, not a silent fix.**

### 11.2 Step 4 (cross-line drag, the N2 fix) — CONFIRMED by execution

Not a browser drag. Instead the real shipped term was asked the same question a drag asks it: the
line changed on the task object, nothing refetched, no `_sortTerms` rebuild.

Setup: plant with `colorWheel` enabled; rank maps `{'': {colorWheel: {WHITE: 1, TAUPE: 2}}, LOVR:
{colorWheel: {WHITE: 9, TAUPE: 1}}}` — i.e. line `LOVR` carries an override, `LNOOVR` does not.
Output, with the **same term closure** reused throughout:

```
on LNOOVR (no override) -> 0000001|WHITE     [plant-wide rank 1]
after drag to LOVR      -> 0000009|WHITE     [the DESTINATION line's rank 9]
dragged back            -> 0000001|WHITE     [plant-wide again]
```

The mechanism is `web/schedule-services.mts:1211-1214` — `byLine[t.PRODUCTION_LINE]?.[key] ??
byLine['']?.[key]`, evaluated **inside `get()`**, per task, per call. No rank is stamped anywhere, so
there is nothing to go stale. The three surfaces that mutate the line all write `PRODUCTION_LINE`
through `Store.updateTask`, and `runAndApply` re-groups from `Store.tasksByPlant(plant)` at `:1581`
on every run, so it always sees the current value: timeline drag (`schedule-workbench.mts:5666`,
multi-drag `:5679`, `:5703`), the Table override modal (`:2429`), and the Orders-grid editable
`PRODUCTION_LINE` column (`:1641`, N2's own citation, still exact). **Confidence: high** on the rank
resolution itself; **what a human still needs to confirm** is only that a real drag reaches
`Store.updateTask` with the new line — which is pre-existing behavior Stage 3 did not touch.

### 11.3 Step 2 (Risk 2 before/after) — the differential, executed

**Method.** The real shipped `Engine._sortTerms('combined', { plant })` was diffed against the
pre-Stage-3 colorWheel term copied **verbatim** from `git show 8bf2f94:web/schedule-services.mts`:

```ts
// BEFORE (8bf2f94)
{ get: t => colorMap ? (colorMap[Util.norm(t.COLOR)] ?? 999999) : (t.ORDER_Y ?? 999999), cmp: numCmp }
```

…with the same three tail terms (`FORM_SIZE`, `runHours`, `MATERIAL_NUMBER`) on both sides, and the
same lexicographic-over-terms comparator both `seqCompare` (`:1345-1351`) and `wheelFirst`
(`:1360-1370`) implement. Since §10a proves the dispatch is byte-identical, diffing the term ordering
isolates precisely what Stage 3 changed.

**Fixture.** One plant, one line, 12 orders, 6 distinct colors, wheel ranks 3 of them
(`{WHITE:1, IVORY:2, BEIGE:3}`; `TAUPE`/`SLATE`/`BLACK` unranked) — the exact Risk 2 shape. `FORM_SIZE`
held uniform so the color term is the discriminator; `MATERIAL_NUMBER`/`RUN_TIME` vary so the tail can
still order.

```
BEFORE: o01:WHITE o10:WHITE o04:IVORY o12:IVORY o07:BEIGE | o03:SLATE o09:BLACK o05:TAUPE o11:TAUPE o02:TAUPE o06:BLACK o08:SLATE
AFTER : o01:WHITE o10:WHITE o04:IVORY o12:IVORY o07:BEIGE | o09:BLACK o06:BLACK o03:SLATE o08:SLATE o05:TAUPE o11:TAUPE o02:TAUPE
```

**Result — 7 positional differences, all attributable to category (a):**

| Claim | Result |
|---|---|
| Every difference involves an unranked color | **true** (all 7) |
| The ranked orders' relative order is unchanged | **true** — `o01,o10,o04,o12,o07` on both sides |
| Unranked colors now form one run each | **true** — 3 runs / 3 distinct colors |
| …and did not before | **true** — 5 runs / 3 distinct colors |

So the whole delta is: `SLATE→BLACK→TAUPE→BLACK→SLATE` became `BLACK→SLATE→TAUPE`. **Two fewer color
changeovers**, among exactly the orders whose changeover cost N12 was written to fix, and the minimum
achievable for that set. Nothing a wheel actually ranks moved at all — which is the sentence to give a
planner who reports "the schedule changed": *only orders whose color is missing from your wheel moved,
and they moved next to their own color; completing the wheel collapses the difference to zero.*

**Category (b) — a newly-configured field.** Second scenario, same wheel plus `prt01` enabled with
`{TOOL-A: 1, TOOL-B: 2}`: term count goes 4 → 5, and within `COLOR=TAUPE` the sequence becomes
`TOOL-A → TOOL-B → TOOL-B`, i.e. the second term discriminates inside the first term's groups exactly
as the flattened-tree model predicts.

**Confidence: high** that this is the complete set of *rule* differences for the within-day
resequence. **Two things a human with production access still has to do:**

1. **Run it on real orders.** 12 synthetic orders prove the rule; they do not tell you how many real
   orders on a real plant are unranked. A plant with a complete wheel sees **no** change; a plant with
   80% unranked colors sees a lot. The Stage 2 coverage readout is the number to look at first.
2. **Check the cross-day second-order effect. It is real in both modes, and larger in `'changeover'`.**
   The differential above measures phase-2 resequencing *within* an admitted fragment. But the same
   terms also drive `rankForDay`'s intra-tier ordering (`:1372-1383`), and admission is by that
   ranking — so if a day fills or fragments, a changed key changes **which order gets admitted and
   which spills to the next day**. Per tier:

   | Tier | Comparator | Sensitivity to the key change |
   |---|---|---|
   | 0 native (due today) | `wheelFirst(a,b)` alone (`:1382`) | **fully sensitive, both modes** |
   | 1 carry (overdue) | `(a.due - b.due) \|\| wheelFirst` (`:1376`) | tie-break only |
   | 2 pull-in (due later) | `'changeover'`: `wheelFirst \|\| due` (`:1379`); `'combined'`: `due \|\| wheelFirst` (`:1380`) | **fully sensitive in `'changeover'`**; tie-break only in `'combined'` |
   | 3 floater (no due date) | `wheelFirst(a,b)` alone (`:1382`) | **fully sensitive, both modes** |

   So the honest statement is: *the within-day rule change is fully characterized above; day assignment
   can also shift, via tier 0 and tier 3 in both modes and additionally via tier 2 in `'changeover'`.*
   Expect `'combined'`/Smart to be the more stable of the two across this upgrade, but do **not** expect
   either to be day-stable on a plant with lots of unranked values or lots of orders with no due date.
   This is the single thing most worth watching on the first real run, and it is not measurable without
   real due dates and real capacity.

## 12. Step 5 — R11 performance

Real `Engine.runAndApply('combined')`, executed, on a synthetic book sized for a plant: **1,200 orders
/ 12 lines / 20-day due-date spread / 8 colors, 4 PRT01, 3 PRT02, 3 production versions**, warm-up pass
then 9 timed reps, median reported. `respectFixed: false`, `respectCalendar: false`.

```
term count:  1 field ->  4 terms;   4 fields -> 7 terms        (R11 predicted 4 -> 7)  ✓
1 field  (colorWheel only): median 12.2 ms   [min  8.8, max 15.8]
4 fields (all enabled)    : median 18.5 ms   [min 16.0, max 28.5]
ratio                     : 1.52x

Isolated tieBreakTerms.map() decoration (:1370), 1,200 tasks x 200 day-passes:
1 field :  70.7 ms
4 fields: 194.3 ms
ratio   : 2.75x
```

**Verdict: in the accepted ballpark end to end (1.52x vs. R11's ~1.75x), but R11's per-term estimate
was low.** R11 derived ~1.75x from term **count** alone. The isolated decoration is **2.75x**, because
a priority term is more expensive *per call* than the tail terms it is counted against: `Util.norm` +
two map lookups + `Number.isFinite` + `Math.round` + two clamps + `String()` + `padStart(7)` + a
concat, versus a bare `Util.norm` or `Util.runHours`. End-to-end still lands under the estimate only
because the decoration is a fraction of total run cost.

**This is not a surprise regression.** +6 ms on a 1,200-order plant, for an opt-in cost that only
applies to fields an admin deliberately configured. And the measured 1.52x is an **upper bound** on the
real figure: `respectCalendar: false` removes all `Calendar.workWindow`/`nextAvailable` work, which is
term-count-**independent** and therefore inflates both arms equally when re-added, pushing the ratio
toward 1.0.

**Confidence: high** on the ratio and the mechanism; **medium** on absolute milliseconds (Node/V8 on
one machine, synthetic data, no calendar work, no browser main-thread contention). **What a human still
needs to confirm:** one wall-clock Smart optimize in a real browser on a real plant with all 4 fields
on, against the same plant with only `colorWheel` on. If that lands far outside ~1.5x, the difference
is calendar/DOM interaction, not the terms. The parked `localeCompare`-vs-`<` note on the padded string
keys (Task 6 review, finding E) is included in these numbers and is not a problem at this scale.

## 13. Cross-cutting verification results

| Check | Result |
|---|---|
| `npm run build` | **clean** (exit 0) |
| `npm run typecheck` | **clean** (both `tsconfig.worker.json` and `tsconfig.json`) |
| `npm run lint:errors` | **47 errors — all pre-existing.** Every one is `no-dupe-keys`, and every one is in `web/locales/{de,en,es,fr,pt}.js`. **Verified as baseline, not asserted:** the same rule run against those five files as they exist at `8bf2f94` also reports exactly 47. Zero lint errors in any `.mts`/`.mjs`/`app.js`. |
| `npm test` → `test:legacy` | **15/15 pass** |
| `npm test` → `test:modules` | **138/139 pass.** The 1 failure is `Engine.autoReflow …` (`tests/modules/schedule-services.test.mjs:158`) — **pre-existing, unrelated, expected.** Its dates are hardcoded to `2026-08-03` and expired on 2026-08-04; Tasks 5-9 each independently reproduced it, including at the pre-stage baseline. Not a Stage 3 regression. Housekeeping follow-up outside this plan. |
| `npm run check:legacy-surface` | **clean** — "Legacy surface matches contract. No drift detected." (Task 0 §6.7's predicted regeneration was handled by Task 8/9.) |
| `npm run check:static-assets` | **clean** — "Static asset boundary OK." |
| `pytest tests/test_priority_lists.py` | **17 passed, 40 skipped, 0 failed.** Both Stage 3 endpoint tests pass (`test_priority_rank_maps_endpoint_reads_in_memory_cache`, `…_empty_for_unknown_plant`), as does Task 2's `test_set_plant_constraints_rejects_depth_beyond_three`. |
| `pytest` (whole suite) | **128 passed, 68 skipped, 0 failed.** |
| pg-marked skips | **Same standing environment gap every task in this stage recorded.** Forced `PG_HOST=localhost NIMBUS_TEST_DB=1`; the probe still fails with `server does not support SSL, but SSL was required` — `.env`'s `PG_SSLMODE=require` against a local server without SSL, plus Azure credentials. Skipping is the harness guard working as designed, not a test defect. `test_set_plant_constraints_preserves_nested_children` is among the skipped. |
| `docs/MIGRATION.md` | Updated — new "Priority lists Stage 3" section revisiting R13 and R17 (see §14). |
| `CLAUDE.md` / `AGENTS.md` | Both updated (Key Patterns → Optimization). Verified the paragraph was byte-identical in the two files before editing, and that both received the same replacement. |

**Drift noticed while checking the twins, not fixed:** `CLAUDE.md` and `AGENTS.md` are the same 230
lines but diverge on **8 substantive lines** predating this stage — most visibly `AGENTS.md` still
says `brain.py` exposes "~38 endpoints" (`CLAUDE.md`: ~77), still places the `Compute` module "in
`app.js`" rather than `schedule-services.mjs`, and carries stale `styles.css`/`nimbus-intelligence.js`
line counts. R18's twin-drift warning has already come true. Out of scope here — resolving it means
adjudicating 8 unrelated claims — but worth its own housekeeping pass.

## 14. Three findings to hand off

**(1) The stale-plant window on the alert auto-fix path.** §11.1 in full. Needs a human decision on
the mitigation, not a silent fix.

**(2) `GET /priority-rank-maps` has no plant-authorization check** — `brain.py:1885-1892`. It is the
**only** plant-scoped endpoint in that block without one: `/priority-lists` (`:1898`),
`/priority-list/{plant}/{field_key}` (`:1942`, `:1995`, `:2028`) and `GET /tasks` (`:1316`) all take
`allowed_plants: … = Depends(auth.get_allowed_plants_for_request)` and gate on it; this one takes only
`plant: str = Query(...)` and returns `PLANT_LISTS.get(plant, {})`. So a plant-restricted user (or any
caller who knows a plant name) can read any plant's rank maps — color names, tool codes and their
ranks.

Two mitigating facts and one aggravating one. Mitigating: actor identity is read from spoofable
`X-User`/`x-user-email` headers anyway until Entra SSO lands (`docs/MIGRATION.md`), so this is a
consistency gap inside an already-acknowledged-weak authorization story rather than a new hole; and
rank maps are low-sensitivity master data. Aggravating: `Persistence.loadPriorityRankMaps`
(`web/schedule-data.mts:1187`) calls this with **bare `fetch`**, not `Util.fetchTraced`. Today that is
*why it works* — no identity header is needed because nothing checks one. Adding the gate therefore
requires switching that call to `Util.fetchTraced` in the same change, or every rank-map load starts
403ing for plant-restricted users. That coupling is precisely the Stage 2 bug class
(`docs/scheduling_priority.md` Stage 2 status, the missing-master-data fetch), so the two edits belong
together. Using `fetchTraced` would also restore `x-request-id` correlation, which this fetch currently
loses.

**(3) The "not yet used in sequencing" badge is now a false statement, and Stage 3 left it up.**
`web/plant-and-administration.mts:878` still renders `<span class="pl-inert-badge">` +
`Util.t('ui.not_yet_used_in_sequencing')` for every field whose `field_key !== 'colorWheel'` — i.e. an
admin who uploads a PRT01 list and enables `prt01` in the tree is told, on the same screen, that it is
not used in sequencing. It is. `docs/MIGRATION.md`'s Stage 2 follow-up #2 anticipated exactly this and
named the two grep strings to remove (`pl-inert-badge`, `not_yet_used_in_sequencing`); Stage 3 wired the
fields and did not do the removal. Three files carry it: the `.mts` above, `web/styles.css:3653`, and
the `ui.not_yet_used_in_sequencing` key in all five `web/locales/*.js`.

**Deliberately not fixed here, and the reason is not purely scope.** A blank deletion is one option, but
there is a real argument for *replacing* rather than removing it: per §13 and the Stage 3 status
paragraph in `docs/scheduling_priority.md`, nobody has yet validated real `prt_01`/`prt_02` values
against a real uploaded list, and Risk 3 (free-text spelling mismatches degrading to all-999999) is now
live. A label like "newly used in sequencing — verify coverage" would be both true *and* useful, where a
bare deletion loses the warning. That is a copy/UX decision, not a mechanical correction.

None of the three findings was fixed by this task: all are code changes outside Task 10's file scope,
and each involves a genuine trade-off rather than one objectively-correct answer — the stage's standing
instruction is to surface those rather than decide them unilaterally.
