# Scheduling Priority — Stage 2 (Upload + Column-Mapping UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin upload, preview, and manage a per-plant (optionally per-line) priority list for each of the four rankable fields (`colorWheel`, `prt01`, `prt02`, `productionVersion`) — with column-mapping for arbitrary spreadsheets, per-field coverage, and a missing-master-data report — without changing what the optimizer actually consults (that's Stage 3).

**Architecture:** Four generic backend endpoints (`GET /priority-fields`, `GET /priority-lists?plant=`, `POST/GET/DELETE /priority-list/{plant}/{field_key}`) generalize the existing color-wheel-only endpoints, reusing `db.py`'s already-generic `priority_list` CRUD (built in Stage 1). The frontend rewrites `Plant._renderOptimization` from a single color-wheel card into one card per rankable field, each with its own dropzone (no shared multi-file drop — see Decisions), a searchable-combobox-driven line-override sub-list, and a coverage readout. A new minimal `PriorityListViewer` module handles "Preview" for the three new fields and delegates to the untouched `ColorWheelViewer` for color. The existing Scheduling Constraints on/off panel (`Plant._renderSettingsPane`, `Engine.CONSTRAINT_CATALOG`) is **not touched this stage** — see Decisions.

**Tech Stack:** FastAPI + Pydantic (backend), TypeScript compiled by `tsc` to `.mjs` (frontend), `node --test` (JS tests), `pytest` with `@pytest.mark.pg` (Python DB tests), pandas for xlsx parsing.

## Global Constraints

Every task's UI work implicitly includes these — copied verbatim from `DESIGN.md`/`PRODUCT.md`/`CLAUDE.md`. This stage is UI-heavy; treat this section as a checklist for every render function you write, not background reading.

- **Never use bubble/chip selectors for plants or lines; use searchable comboboxes.** (`CLAUDE.md` Production Scale Roadmap; `DESIGN.md` §6 Do's.) A concrete, tested implementation already exists: `_mkCombobox(containerEl, options, {value, placeholder, onSelect})` at `web/plant-and-administration.mts:2908-2963` (`hps-combobox`/`hps-input`/`hps-clear`/`hps-dropdown` markup, type-to-filter, keyboard nav). It is a top-level function in the same module `Plant` lives in — call it directly, do not reimplement or introduce a plain `<select>`.
- **CTA/Chrome Color Rule** (`DESIGN.md` §2): in the light content area (everything this stage touches), a primary action is a navy-fill `.btn-primary` (`--primary`), a secondary action is hairline-bordered white (`.btn`), and `--accent` blue is for outlines/focus/active-tab markers only — never a solid content-area CTA fill.
- **Hairline-over-shadow**: separate regions with a 1px `--line` border by default. No new `shadow-lg` on a static panel — only the mapping modal (genuinely floating) gets a shadow.
- **No colored side-stripes** (`DESIGN.md` §6 Don'ts) — the "not yet used in sequencing" marker is a soft-tint badge (`-soft` background + matching text color, per §5 Toasts/Badges), never a `border-left` accent.
- **Mono-Means-Machine Rule** (`DESIGN.md` §3): any generated/measured/timestamped string — relative upload time, row counts, coverage ratios — renders in JetBrains Mono (`--font-mono` / the `Mono-Eyebrow`/`Mono-KPI-Value` patterns). The existing `.cw-active-meta` class does **not** do this today (a pre-existing minor gap); Stage 2's rewritten cards should get it right rather than copy the gap forward.
- **4px radius everywhere, 8px only for modals/large panels** (`DESIGN.md` §5). The existing `.cw-active-card` already uses `--r-lg` (8px) — keep that precedent for the new field cards.
- **Re-skin third-party bits, never ship default look** — not directly triggered this stage (no new third-party component), but the mapping modal must follow the existing Modal structure (`DESIGN.md` §5: head/body/foot, `--r-lg`, `shadow-lg`, navy-tinted backdrop) rather than a bespoke layout.
- **Fast transitions (0.12–0.18s)**, no bounce — reuse `var(--t-med)` as the existing dropzone CSS already does.
- **i18n discipline** (`nimbus-i18n-preference` memory): every new user-visible string routes through `data-i18n`/`Util.t()`. No hardcoded English strings, including tiny badges.

## Decisions specific to this stage

These resolve ambiguity in `docs/scheduling_priority.md`'s Stage 2 description against the real current code, found during pre-implementation research. Recorded here so the next reader doesn't re-derive them.

1. **The Scheduling Constraints panel (`Plant._renderSettingsPane`, `Engine.CONSTRAINT_CATALOG`) is untouched this stage.** Re-reading Stage 3's own section confirms it explicitly: `CONSTRAINT_CATALOG` "becomes the offline fallback" and the flat-list-to-tree rebuild reading from `GET /priority-fields` is Stage 3 work. Stage 2 is the *data entry* surface (upload/manage lists); Stage 3 is the *configuration* surface (arrange them into a sequence, wire into the optimizer). This is why non-color fields are "visibly inert" in Stage 2 — there is no lever to even enable them for sequencing until Stage 3 adds one.
2. **One dropzone per field+scope, not a shared multi-file drop zone.** The original draft's "multi-file drop fans out into staging rows" would require guessing which field an arbitrary dropped file targets. Each field card gets its own dropzone (mirroring today's single color-wheel dropzone exactly), and each line-override row gets its own small uploader once added via the combobox. This makes R14/N14 ("reject two files targeting the same field+scope") true *by construction* — there is no code path where two files could target one scope simultaneously — and is more in keeping with `DESIGN.md`'s "industrial precision over decorative gloss" than a magic auto-detecting drop target.
3. **The missing-master-data report panel is backed by a NEW live, read-only endpoint** (`GET /master-data/{plant}/missing-master-data`), not the existing batch-scoped `GET /upload/{batch_id}/missing-master-data`. Reason: `upload_audit` has no `plant` column (confirmed: `batch_id, filename, row_count, inserted_count, updated_count, uploaded_at, warnings` — `schema.sql:86-94`), so "the current gaps for this plant" cannot be derived from "the last batch" without an unreliable heuristic, and staleness after a resync would be wrong anyway. The new endpoint reuses the exact same JSON/CSV shape as the batch-scoped one (`{unmatched_pairs, unmatched_orders, exceptions: [{plant, material_number, order_count, reason}]}`) so the frontend renders both with one function, but is computed by a fresh SELECT (the read half of `db._stamp_order_attributes`'s plant-scoped branch, no UPDATE).
4. **`constraint.<field_key>` locale keys are added NOW, in Stage 2**, even though the Scheduling Constraints panel that will consume them (per Stage 3's R9/N22) doesn't exist yet. Stage 2's field cards need field-title strings anyway; using the same key namespace Stage 3 already commits to means Stage 3 inherits complete i18n coverage for free, and the new locale-completeness test (Task 14) is written once and covers both stages.
5. **A `Line` column in an uploaded file is a single-value validation/scope-selector, not a per-row fan-out.** Mirrors how the `Plant` column already works (a repeated value used to validate against the upload target, not a splitter). If a file's `Line` column has more than one distinct non-blank value, the upload is rejected with a message telling the admin to upload once per line — "one file per plant" was locked; a per-row multi-line split was never decided and would silently contradict the one-list-per-upload mental model the rest of the design assumes.
6. **The rank column is optional; row order is the implicit rank when omitted.** The legacy color-wheel path is untouched and still requires `COLOR`+`ORDER_Y`. The new generic path additionally accepts a value-only file (no rank column at all), assigning 1-based row order as the rank — useful for a plain "here's my priority order, top to bottom" tooling list with no numbers. Two rows normalizing to the same value with two *different* resolved ranks (explicit or implicit) is always a conflict and is rejected, listing the conflicting rows.
7. **`ColorWheelViewer` is not modified.** `PriorityListViewer` (new) is a thin dispatcher: `PriorityListViewer.open(plant, fieldKey)` calls `ColorWheelViewer.open(plant)` when `fieldKey === 'colorWheel'`, else renders its own generic value/rank/"in current data?" list. This satisfies N21 ("delegates to `ColorWheelViewer` ... when `field_key === 'colorWheel'`") with zero risk to the existing, working, tested color viewer.
8. **Plant-scoped RBAC (`_assert_plant_allowed`) is added to all new endpoints**, closing a gap the legacy `/color-wheel/{plant}` endpoints have today (they only check `require_admin`, no `role_plants` scoping). The legacy endpoints are not touched or fixed this stage — only new endpoints get it right from the start.
9b. **Found during plan review, not the original research — and resolved by explicit user decision to consolidate now.** The first draft of Task 5 independently reimplemented the legacy `POST /color-wheel/{plant}`'s xlsx-parsing logic (`brain.py:1673-1723`, `_cw_df_to_entries`): both endpoints separately (a) read the file via `db.clean(pd.read_excel(...))`, (b) detected value/rank columns, (c) built a `{VALUE: RANK}` entries dict with the same upper/strip/float-or-None normalization, (d) called `db.upsert_priority_list`, appended an audit entry, and reloaded the plant's cache — genuine, previously-untracked debt distinct from the three already-logged in `docs/scheduling_priority.md`'s R17. Consolidating isn't a pure DRY cleanup, since the legacy endpoint has no `needs_mapping` fallback (it 400s outright if no `COLOR` column resolves) and previously *required* `ORDER_Y`. **Resolution: Task 5 now factors the shared logic into two helpers — `_resolve_priority_list_columns` and `_persist_priority_list`** — used by both routes. The legacy endpoint keeps its contract (`file` only, no mapping round-trip, a `needs_mapping` result becomes a 400) and its historical `color_wheel_upload`/`color_wheel_replace` audit action names (via `legacy_action_names=True`), with one deliberate, strictly-permissive loosening: `ORDER_Y` is no longer required — a file with just `COLOR` now falls back to row-order ranking, same as every other field (Decision 6). No previously-valid color-wheel file can start failing; only a subset of previously-invalid ones (missing `ORDER_Y`) now succeed. No existing pytest currently exercises `POST /color-wheel/{plant}` (confirmed by grep — only its `GET` and `/color-wheels` listing are tested), so Task 5 adds a dedicated regression suite for it as part of this consolidation.
9. **The "Resync prompt right after upload" from the original design is deferred, not dropped.** Re-reading the locked decision closely: "Batch-scoped ingest stamp + a Resync prompt right after upload + a manual Resync button" — the "upload" it follows is an **orders** upload (`POST /upload`, batch-scoped stamping is Stage 1's ingest-time hook), not a priority-list upload. That UI lives wherever the Admin Cockpit renders an orders-upload result — a module this plan's research did not cover, and guessing at its current structure would risk exactly the kind of unscoped change the user asked to avoid. This plan ships the other two thirds of that decision in full: the manual Resync button (Task 12, in the missing-master-data panel) and — arguably better than a one-time post-upload toast — a **persistent** missing-master-data panel that stays visible on the Optimization tab until the gap is closed, live-queried rather than tied to whichever batch happened to trigger it (Decision 3). Wiring a toast into the orders-upload flow itself is a small, well-scoped follow-up for whoever next touches that module — call out `Plant._resyncOrderAttributes` and `GET /master-data/{plant}/missing-master-data` as the pieces already built for it to call.

---

### Task 1: `master_data.py` — field labels and plant-scoped line codes

**Files:**
- Modify: `master_data.py:106-120` (the `RANKABLE_FIELDS` dict), and near `master_data.py:1820-1827` (`known_plant_line_codes`)
- Test: `tests/test_priority_lists.py` (append to the existing pure-logic section)

**Interfaces:**
- Produces: `RANKABLE_FIELDS[key]['default_label']: str` (new key on each existing entry) — consumed by Task 3's `GET /priority-fields`.
- Produces: `known_line_codes_for_plant(plant: str) -> set[str]` — consumed by Task 5's line-column validation.

- [ ] **Step 1: Write the failing test**

```python
def test_rankable_fields_now_carry_a_default_label():
    from master_data import RANKABLE_FIELDS
    expected = {
        'colorWheel': 'Color Wheel',
        'prt01': 'Prod. Resource Tool (01)',
        'prt02': 'Prod. Resource Tool (02)',
        'productionVersion': 'Production Version',
    }
    for key, label in expected.items():
        assert RANKABLE_FIELDS[key]['default_label'] == label


@pytest.mark.pg
def test_known_line_codes_for_plant_is_scoped(pg):
    import master_data as md
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO subnetworks (code, name) VALUES ('ZZTEST_SUB','ZZTEST_SUB') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES ('ZZTEST_SUB','ZZTEST_LP') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES ('ZZTEST_SUB','ZZTEST_LP2') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO production_lines (subnetwork, plant, production_line) VALUES ('ZZTEST_SUB','ZZTEST_LP','L01') ON CONFLICT DO NOTHING")
        cur.execute("INSERT INTO production_lines (subnetwork, plant, production_line) VALUES ('ZZTEST_SUB','ZZTEST_LP2','L99') ON CONFLICT DO NOTHING")
        conn.commit()
    try:
        assert md.known_line_codes_for_plant('ZZTEST_LP') == {'L01'}
        assert 'L99' not in md.known_line_codes_for_plant('ZZTEST_LP')
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM production_lines WHERE plant IN ('ZZTEST_LP','ZZTEST_LP2')")
            cur.execute("DELETE FROM plants WHERE plant IN ('ZZTEST_LP','ZZTEST_LP2')")
            cur.execute("DELETE FROM subnetworks WHERE code = 'ZZTEST_SUB'")
            conn.commit()
```

- [ ] **Step 2: Run to verify it fails**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k "default_label or known_line_codes_for_plant" -v`
Expected: `test_rankable_fields_now_carry_a_default_label` FAILs with `KeyError: 'default_label'`; `test_known_line_codes_for_plant_is_scoped` FAILs with `AttributeError: module 'master_data' has no attribute 'known_line_codes_for_plant'`.

- [ ] **Step 3: Implement**

Add `default_label` to each `RANKABLE_FIELDS` entry (`master_data.py:106-120`):

```python
RANKABLE_FIELDS = {
    'colorWheel': {
        'mp_column': 'color', 'orders_column': 'color', 'task_field': 'COLOR',
        'default_label': 'Color Wheel',
    },
    'prt01': {
        'mp_column': 'prt_01', 'orders_column': 'prt_01', 'task_field': 'PRT_01',
        'default_label': 'Prod. Resource Tool (01)',
    },
    'prt02': {
        'mp_column': 'prt_02', 'orders_column': 'prt_02', 'task_field': 'PRT_02',
        'default_label': 'Prod. Resource Tool (02)',
    },
    'productionVersion': {
        'mp_column': 'default_production_version', 'orders_column': 'production_version',
        'task_field': 'PRODUCTION_VERSION', 'default_label': 'Production Version',
    },
}
```

Add near `known_plant_line_codes` (`master_data.py:1820-1827`):

```python
def known_line_codes_for_plant(plant: str) -> set[str]:
    """Return production-line codes for ONE plant — for validating an uploaded
    priority-list file's optional Line column against that specific plant
    (N4), unlike known_plant_line_codes()'s whole-catalog sets used by /upload."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute("SELECT production_line FROM production_lines WHERE plant = %s", (plant,))
        return {r[0] for r in cur.fetchall()}
```

- [ ] **Step 4: Run to verify it passes**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k "default_label or known_line_codes_for_plant" -v`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add master_data.py tests/test_priority_lists.py
git commit -m "feat: add default field labels and plant-scoped line codes for priority lists"
```

---

### Task 2: `db.py` — live missing-master-data query

**Files:**
- Modify: `db.py` (add near `_stamp_order_attributes`, `db.py:1276-1386`)
- Test: `tests/test_priority_lists.py`

**Interfaces:**
- Consumes: same `orders`/`material_plants` join shape as `_stamp_order_attributes`'s plant-scoped branch (`db.py:1338-1364`).
- Produces: `missing_master_data_for_plant(plant: str) -> dict` with shape `{"unmatched_pairs": int, "unmatched_orders": int, "exceptions": [{"plant": str, "material_number": str, "order_count": int, "reason": "no_mp_row"}, ...]}` — consumed by Task 7's endpoint.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.pg
class TestMissingMasterDataForPlant:
    PLANT = "ZZTEST_MMD_PLANT"
    SUB = "ZZTEST_MMD_SUB"

    @pytest.fixture(autouse=True)
    def _seed(self, pg):
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (self.SUB, self.SUB))
            cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING", (self.SUB, self.PLANT))
            cur.execute(
                "INSERT INTO orders (id, production_order, material_number, plant, basic_start_date)"
                " VALUES ('zzmmd1','PO1','MAT-NO-MP',%s, NOW()) ON CONFLICT (id) DO NOTHING",
                (self.PLANT,),
            )
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = 'zzmmd1'")
            cur.execute("DELETE FROM plants WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            conn.commit()

    def test_reports_unmatched_pair_with_no_update(self, pg):
        result = pg.missing_master_data_for_plant(self.PLANT)
        assert result["unmatched_pairs"] == 1
        assert result["unmatched_orders"] == 1
        assert result["exceptions"][0] == {
            "plant": self.PLANT, "material_number": "MAT-NO-MP",
            "order_count": 1, "reason": "no_mp_row",
        }
        # Read-only: confirm the order's color is still untouched (no UPDATE ran)
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT color FROM orders WHERE id = 'zzmmd1'")
            assert cur.fetchone()[0] is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k missing_master_data_for_plant -v`
Expected: FAIL with `AttributeError: module 'db' has no attribute 'missing_master_data_for_plant'`.

- [ ] **Step 3: Implement**

Add to `db.py`, next to `_stamp_order_attributes`:

```python
def missing_master_data_for_plant(plant: str) -> dict:
    """Live, READ-ONLY version of _stamp_order_attributes' plant-scoped
    exception query — no UPDATE. Backs GET /master-data/{plant}/missing-master-data,
    the Optimization tab's report panel (docs/scheduling_priority.md Stage 2
    Decision 3): unlike the batch-scoped GET /upload/{batch_id}/missing-master-data,
    this reflects CURRENT state regardless of when the plant was last uploaded
    to or resynced. Same response shape as the batch-scoped report so the
    frontend renders both with one function."""
    with _pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT o.plant, o.material_number, COUNT(*), 'no_mp_row'
              FROM orders o
              LEFT JOIN material_plants mp
                ON mp.plant = o.plant AND mp.material_id = o.material_number
             WHERE o.plant = %s
               AND mp.material_id IS NULL
             GROUP BY o.plant, o.material_number
            """,
            (plant,),
        )
        rows = cur.fetchall()
    exceptions = [
        {"plant": r[0], "material_number": r[1], "order_count": r[2], "reason": r[3]}
        for r in rows
    ]
    return {
        "unmatched_pairs": len(exceptions),
        "unmatched_orders": sum(e["order_count"] for e in exceptions),
        "exceptions": exceptions,
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k missing_master_data_for_plant -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db.py tests/test_priority_lists.py
git commit -m "feat: add live read-only missing-master-data query for the Optimization tab"
```

---

### Task 3: `brain.py` — `GET /priority-fields`

**Files:**
- Modify: `brain.py` (add near the color-wheel endpoint block, `brain.py:1665-1789`)
- Test: `tests/test_priority_lists.py`

**Interfaces:**
- Consumes: `master_data.RANKABLE_FIELDS` (Task 1's shape).
- Produces: `GET /priority-fields` → `{"fields": [{"field_key": str, "mp_column": str, "orders_column": str, "task_field": str, "default_label": str}, ...]}`, ordered as `RANKABLE_FIELDS` (dict insertion order — `colorWheel, prt01, prt02, productionVersion`).

- [ ] **Step 1: Write the failing test**

```python
def test_priority_fields_endpoint_lists_four_fields(client):
    r = client.get("/priority-fields")
    assert r.status_code == 200
    body = r.json()
    keys = [f["field_key"] for f in body["fields"]]
    assert keys == ["colorWheel", "prt01", "prt02", "productionVersion"]
    color = body["fields"][0]
    assert color == {
        "field_key": "colorWheel", "mp_column": "color", "orders_column": "color",
        "task_field": "COLOR", "default_label": "Color Wheel",
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `PG_HOST=localhost python -m pytest tests/test_priority_lists.py -k priority_fields_endpoint -v`
Expected: FAIL with 404 (route doesn't exist).

- [ ] **Step 3: Implement**

Add to `brain.py`, right before the `# COLOR WHEEL ENDPOINTS` block comment (`brain.py:1665`):

```python
@api.get("/priority-fields")
def list_priority_fields():
    """Registry of rankable fields for the priority-list upload UI (Stage 2)
    and, later, the Scheduling Constraints tree (Stage 3's GET /priority-fields
    consumer, per master_data.py's RANKABLE_FIELDS comment). Order matches
    RANKABLE_FIELDS' declaration order."""
    return {
        "fields": [
            {"field_key": key, **spec}
            for key, spec in md.RANKABLE_FIELDS.items()
        ]
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `PG_HOST=localhost python -m pytest tests/test_priority_lists.py -k priority_fields_endpoint -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add brain.py tests/test_priority_lists.py
git commit -m "feat: add GET /priority-fields registry endpoint"
```

---

### Task 4: `brain.py` — `GET /priority-lists?plant=`

**Files:**
- Modify: `brain.py`
- Test: `tests/test_priority_lists.py`

**Interfaces:**
- Consumes: `db.list_priority_lists_meta(plant=...)` (returns `(rows, total)`, `db.py:2014-2053`), `db.priority_list_coverage(plant, fields)` (`db.py:2056-2109`), `master_data.RANKABLE_FIELDS`, `auth.get_allowed_plants_for_request`, `master_data._assert_plant_allowed`.
- Produces: `GET /priority-lists?plant=X` → `{"plant": str, "fields": {field_key: {"default_label": str, "plant_wide": {...}|null, "line_overrides": [{...}], "coverage": {line_or_empty: {"distinct_values": int, "ranked_values": int}}}}}`.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.pg
def test_priority_lists_endpoint_groups_by_field_with_coverage(client, pg):
    plant = "ZZTEST_PLE_PLANT"
    pg.upsert_priority_list(plant, "colorWheel", {"RED": 1.0}, line="",
                            source_column="color", filename="w.xlsx", row_count=1, uploaded_by="t")
    pg.upsert_priority_list(plant, "colorWheel", {"BLUE": 1.0}, line="L01",
                            source_column="color", filename="w2.xlsx", row_count=1, uploaded_by="t")
    try:
        r = client.get(f"/priority-lists?plant={plant}")
        assert r.status_code == 200
        body = r.json()
        assert body["plant"] == plant
        cw = body["fields"]["colorWheel"]
        assert cw["plant_wide"]["filename"] == "w.xlsx"
        assert len(cw["line_overrides"]) == 1
        assert cw["line_overrides"][0]["line"] == "L01"
        assert "coverage" in cw
        assert body["fields"]["prt01"]["plant_wide"] is None
        assert body["fields"]["prt01"]["line_overrides"] == []
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM priority_list WHERE plant = %s", (plant,))
            conn.commit()
```

- [ ] **Step 2: Run to verify it fails**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k priority_lists_endpoint_groups -v`
Expected: FAIL with 404.

- [ ] **Step 3: Implement**

```python
@api.get("/priority-lists")
def get_priority_lists_for_plant(
        plant: str = Query(..., min_length=1),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Per-field metadata + coverage for one plant's Optimization tab (Stage 2).
    Groups the flat list_priority_lists_meta rows by field_key, splitting
    line='' (plant-wide) from everything else (line overrides), and merges in
    priority_list_coverage's per-line ranked/distinct counts."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    rows, _total = db.list_priority_lists_meta(plant=plant)
    coverage = db.priority_list_coverage(
        plant, {k: v["orders_column"] for k, v in md.RANKABLE_FIELDS.items()}
    )
    fields: dict = {}
    for key, spec in md.RANKABLE_FIELDS.items():
        field_rows = [r for r in rows if r["field_key"] == key]
        plant_wide = next((r for r in field_rows if r["line"] == ""), None)
        line_overrides = [r for r in field_rows if r["line"] != ""]
        fields[key] = {
            "default_label": spec["default_label"],
            "plant_wide": plant_wide,
            "line_overrides": line_overrides,
            "coverage": coverage.get(key, {}),
        }
    return {"plant": plant, "fields": fields}
```

- [ ] **Step 4: Run to verify it passes**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k priority_lists_endpoint_groups -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add brain.py tests/test_priority_lists.py
git commit -m "feat: add GET /priority-lists per-plant metadata+coverage endpoint"
```

---

### Task 5: `brain.py` — shared column-resolution/persist helpers + `POST /priority-list/{plant}/{field_key}`, consolidating the legacy color-wheel upload onto the same path

This is the largest task — the generic upload endpoint with column auto-detection, `needs_mapping` fallback, and validation. **Per Decision 9b (resolved during plan review: consolidate now, not leave as parallel debt), this task also rewrites the legacy `POST /color-wheel/{plant}` endpoint to share the same column-resolution and persist/audit/reload logic**, eliminating what would otherwise be two independent implementations of "parse xlsx, detect value/rank columns, build an entries dict, upsert, audit, reload the plant cache." Split into its own task per the "independently testable deliverable" rule, but kept as one task since the shared helpers and both call sites are tightly coupled (splitting further would leave intermediate steps untestable).

**Files:**
- Modify: `brain.py` (add two new shared helpers near `_cw_df_to_entries`, `brain.py:648-661`; add the new generic endpoint; **rewrite** the existing `POST /color-wheel/{plant}` handler, `brain.py:1673-1723`, to call the same helpers instead of its own independent parsing)
- Test: `tests/test_priority_lists.py`

**Interfaces:**
- Consumes: `master_data.RANKABLE_FIELDS`, `master_data.known_line_codes_for_plant` (Task 1), `db.upsert_priority_list`, `db.clean`, `_reload_one_plant_lists`, `auth.get_allowed_plants_for_request`, `master_data._assert_plant_allowed`.
- Produces:
  - `_resolve_priority_list_columns(df, plant, spec, *, explicit_line="", explicit_value_col=None, explicit_rank_col=None) -> dict` — returns `{"status":"needs_mapping","headers":[...],"sample":[...]}` or `{"status":"resolved","value_col":str,"rank_col":str|None,"line":str,"entries":dict}`; raises `HTTPException(400)` for plant-mismatch, unknown-line, multi-value-LINE, a named-but-absent explicit column, or conflicting-rank failures. Shared by both upload routes below.
  - `_persist_priority_list(plant, field_key, spec, entries, *, line, value_col, rank_col, filename, row_count, user, legacy_action_names=False) -> bool` (returns `is_replace`) — the upsert+audit+cache-reload step, likewise shared. `legacy_action_names=True` keeps the historical `color_wheel_upload`/`color_wheel_replace` audit action strings for `/color-wheel/{plant}`; the generic endpoint always passes `False`, including for `field_key == "colorWheel"` — once Task 12 ships, NIMBUS's own frontend uploads color the same way as every other field, so `priority_list_upload` becomes the standard action name going forward for uploads through the new UI.
  - `POST /priority-list/{plant}/{field_key}` (multipart: `file`, optional form `line`, `value_column`, `rank_column`) → either `{"status":"ok","row_count":int,"line":str,"action":"upload"|"replace","replaced":bool}` or `{"status":"needs_mapping","headers":[str],"sample":[{str:Any}]}` (HTTP 200 for both — mirrors the existing `{"status":"not_found"}` convention) or a 400 with a specific `detail` message for each rejection case.
  - `POST /color-wheel/{plant}` (**rewritten, same contract**: `file` only, no line/mapping params) → `{"status":"ok","row_count":int,"action":"color_wheel_upload"|"color_wheel_replace","replaced":bool}`, or `400` if no `COLOR` column can be resolved. One deliberate, strictly-permissive behavior change: a file with no rank column now falls back to row order (Decision 6) instead of requiring `ORDER_Y`.

- [ ] **Step 1: Write the failing tests**

```python
@pytest.mark.pg
class TestGenericPriorityListUpload:
    PLANT = "ZZTEST_UP_PLANT"
    SUB = "ZZTEST_UP_SUB"
    LINE = "ZZTEST_UP_L01"

    @pytest.fixture(autouse=True)
    def _seed(self, pg, client):
        self.client = client
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (self.SUB, self.SUB))
            cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING", (self.SUB, self.PLANT))
            cur.execute("INSERT INTO production_lines (subnetwork, plant, production_line) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                        (self.SUB, self.PLANT, self.LINE))
            conn.commit()
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM priority_list WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM production_lines WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM plants WHERE plant = %s", (self.PLANT,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (self.SUB,))
            conn.commit()

    def _xlsx(self, rows: list[dict]) -> bytes:
        import io as _io
        import pandas as pd
        buf = _io.BytesIO()
        pd.DataFrame(rows).to_excel(buf, index=False)
        return buf.getvalue()

    def test_legacy_color_columns_auto_detect_with_no_mapping(self):
        body = self._xlsx([{"COLOR": "RED", "ORDER_Y": 1}, {"COLOR": "BLUE", "ORDER_Y": 2}])
        r = self.client.post(f"/priority-list/{self.PLANT}/colorWheel",
                             files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        assert r.json()["line"] == ""

    def test_no_rank_column_uses_row_order(self):
        body = self._xlsx([{"PRT_01": "DOG"}, {"PRT_01": "CAT"}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "PRT_01"})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_ambiguous_columns_return_needs_mapping(self):
        body = self._xlsx([{"FOO": "DOG", "BAR": "CAT"}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "needs_mapping"
        assert set(r.json()["headers"]) == {"FOO", "BAR"}

    def test_explicit_mapping_with_line_scope_persists(self):
        body = self._xlsx([{"TOOL": "DOG", "RANK": 1}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK", "line": self.LINE})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
        assert r.json()["line"] == self.LINE

    def test_unknown_line_is_rejected(self):
        body = self._xlsx([{"TOOL": "DOG", "RANK": 1}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK", "line": "NOT-A-REAL-LINE"})
        assert r.status_code == 400

    def test_multiple_line_values_in_file_rejected_without_explicit_line(self):
        body = self._xlsx([
            {"TOOL": "DOG", "RANK": 1, "LINE": self.LINE},
            {"TOOL": "CAT", "RANK": 2, "LINE": "SOME-OTHER-LINE"},
        ])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK"})
        assert r.status_code == 400
        assert "multiple" in r.json()["detail"].lower()

    def test_duplicate_value_conflicting_rank_rejected(self):
        body = self._xlsx([{"TOOL": "DOG", "RANK": 1}, {"TOOL": "DOG", "RANK": 2}])
        r = self.client.post(f"/priority-list/{self.PLANT}/prt01",
                             files={"file": ("t.xlsx", body)},
                             data={"value_column": "TOOL", "rank_column": "RANK"})
        assert r.status_code == 400
        assert "DOG" in r.json()["detail"]

    def test_unknown_field_key_rejected(self):
        body = self._xlsx([{"TOOL": "DOG"}])
        r = self.client.post(f"/priority-list/{self.PLANT}/not-a-real-field",
                             files={"file": ("t.xlsx", body)})
        assert r.status_code == 400


@pytest.mark.pg
class TestLegacyColorWheelUploadConsolidation:
    """POST /color-wheel/{plant} now shares _resolve_priority_list_columns/
    _persist_priority_list with the generic endpoint (Decision 9b). No
    existing test exercised this route's POST before (confirmed by grep —
    only its GET and /color-wheels were tested), so these are new regression
    pins for the preserved contract, plus one test for the one deliberate,
    strictly-permissive behavior change (ORDER_Y is no longer required)."""
    PLANT = "ZZTEST_CWLEGACY_PLANT"

    @pytest.fixture(autouse=True)
    def _cleanup(self, pg, client):
        self.client = client
        yield
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM priority_list WHERE plant = %s", (self.PLANT,))
            conn.commit()

    def _xlsx(self, rows: list[dict]) -> bytes:
        import io as _io
        import pandas as pd
        buf = _io.BytesIO()
        pd.DataFrame(rows).to_excel(buf, index=False)
        return buf.getvalue()

    def test_color_and_order_y_still_uploads_with_legacy_action_names(self):
        body = self._xlsx([{"COLOR": "RED", "ORDER_Y": 1}, {"COLOR": "BLUE", "ORDER_Y": 2}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        assert r.json() == {"status": "ok", "row_count": 2, "action": "color_wheel_upload", "replaced": False}

    def test_order_column_still_auto_renames_to_rank(self):
        body = self._xlsx([{"COLOR": "RED", "ORDER": 1}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_missing_order_y_now_falls_back_to_row_order_instead_of_400ing(self):
        body = self._xlsx([{"COLOR": "RED"}, {"COLOR": "BLUE"}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["status"] == "ok"

    def test_missing_color_column_still_400s(self):
        body = self._xlsx([{"FOO": "RED", "ORDER_Y": 1}])
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        assert r.status_code == 400

    def test_replace_uses_legacy_replace_action_name(self):
        body = self._xlsx([{"COLOR": "RED", "ORDER_Y": 1}])
        self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w.xlsx", body)})
        r = self.client.post(f"/color-wheel/{self.PLANT}", files={"file": ("w2.xlsx", body)})
        assert r.status_code == 200
        assert r.json()["action"] == "color_wheel_replace"
        assert r.json()["replaced"] is True
```

- [ ] **Step 2: Run to verify they fail**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k "TestGenericPriorityListUpload or TestLegacyColorWheelUploadConsolidation" -v`
Expected: `TestGenericPriorityListUpload` FAILs with 404 (route doesn't exist yet). Of `TestLegacyColorWheelUploadConsolidation`, `test_missing_order_y_now_falls_back_to_row_order_instead_of_400ing` FAILs against **today's** `/color-wheel/{plant}` (it still 400s — that's the behavior this step changes); the other four cases already pass against today's code (they're regression pins for existing behavior, not new behavior) and must stay green throughout this task.

- [ ] **Step 3: Implement**

Add the two shared helpers to `brain.py`, right after `_cw_df_to_entries` (`brain.py:648-661`) — they supersede its role for anything going through either upload route (`_cw_df_to_entries` itself is left alone, since `_parse_color_wheel`'s disk→DB backfill helper still calls it directly and that path is out of scope here):

```python
def _resolve_priority_list_columns(
        df: pd.DataFrame, plant: str, spec: dict, *,
        explicit_line: str = "", explicit_value_col: str | None = None,
        explicit_rank_col: str | None = None,
) -> dict:
    """Shared column-resolution/validation for POST /priority-list/{plant}/{field_key}
    (Stage 2) and the legacy POST /color-wheel/{plant} (Decision 9b — the two
    were independent implementations before this consolidation). The legacy
    caller passes no explicit_* — auto-detect finds COLOR/ORDER_Y|ORDER exactly
    as it always did, since COLOR is spec['mp_column'] and is therefore always
    the sole candidate in a well-formed color-wheel file. The two routes differ
    only in how they react to a "needs_mapping" result: the generic endpoint
    returns it to the client for the mapping modal; the legacy endpoint (no
    mapping UI on the other end) turns it into a 400.

    Returns {"status": "needs_mapping", "headers": [...], "sample": [...]} or
    {"status": "resolved", "value_col": str, "rank_col": str | None,
     "line": str, "entries": {VALUE: RANK|None}}.
    Raises HTTPException(400) for plant-mismatch, unknown-line, multi-value
    LINE column, an explicitly-named column that doesn't exist in the file, or
    conflicting ranks for the same value.
    """
    headers = list(df.columns)

    if "PLANT" in headers:
        file_plants = set(df["PLANT"].astype(str).str.strip()) - {"", "nan"}
        if file_plants and file_plants != {plant}:
            raise HTTPException(status_code=400,
                detail=f"File's PLANT column ({sorted(file_plants)}) doesn't match target plant {plant!r}")

    resolved_line = explicit_line.strip()
    if "LINE" in headers and not resolved_line:
        file_lines = {v for v in df["LINE"].astype(str).str.strip() if v and v.lower() != "nan"}
        if len(file_lines) > 1:
            raise HTTPException(status_code=400,
                detail=f"File contains multiple LINE values {sorted(file_lines)} — upload once per line, or pass a single line explicitly")
        if len(file_lines) == 1:
            resolved_line = next(iter(file_lines))
    if resolved_line:
        known_lines = md.known_line_codes_for_plant(plant)
        if resolved_line not in known_lines:
            raise HTTPException(status_code=400,
                detail=f"{resolved_line!r} is not a known production line for plant {plant!r}")

    resolved_value_col = explicit_value_col
    if resolved_value_col and resolved_value_col not in headers:
        raise HTTPException(status_code=400, detail=f"Missing required column: {resolved_value_col!r}")
    if not resolved_value_col:
        candidates = [h for h in headers if h.upper() in {spec["mp_column"].upper(), "VALUE"}]
        if len(candidates) == 1:
            resolved_value_col = candidates[0]
        else:
            return {"status": "needs_mapping", "headers": headers,
                    "sample": df.head(5).to_dict(orient="records")}

    resolved_rank_col = explicit_rank_col
    if resolved_rank_col and resolved_rank_col not in headers:
        raise HTTPException(status_code=400, detail=f"Missing required column: {resolved_rank_col!r}")
    if not resolved_rank_col:
        candidates = [h for h in headers if h.upper() in {"ORDER_Y", "RANK", "ORDER"}]
        if len(candidates) == 1:
            resolved_rank_col = candidates[0]

    values = df[resolved_value_col].astype(str).str.upper().str.strip()
    if resolved_rank_col:
        ranks = pd.to_numeric(df[resolved_rank_col], errors="coerce")
    else:
        ranks = pd.Series(range(1, len(df) + 1), dtype=float)

    entries: dict[str, float | None] = {}
    conflicts: list[str] = []
    for v, r in zip(values, ranks, strict=True):
        if not v or v == "NAN":
            continue
        r_val = None if pd.isna(r) else float(r)
        if v in entries and entries[v] != r_val:
            conflicts.append(v)
        entries[v] = r_val
    if conflicts:
        raise HTTPException(status_code=400,
            detail=f"Conflicting ranks for the same value in this file: {sorted(set(conflicts))}")

    return {"status": "resolved", "value_col": resolved_value_col, "rank_col": resolved_rank_col,
            "line": resolved_line, "entries": entries}


def _persist_priority_list(plant: str, field_key: str, spec: dict, entries: dict, *,
                           line: str, value_col: str, rank_col: str | None,
                           filename: str, row_count: int, user: str,
                           legacy_action_names: bool = False) -> bool:
    """Shared upsert+audit+cache-reload step (Decision 9b) — this part was
    ALREADY byte-for-byte identical between the legacy and generic upload
    paths before consolidation; only the audit action-name family differs,
    controlled by legacy_action_names so /color-wheel/{plant}'s historical
    audit trail (color_wheel_upload/color_wheel_replace) doesn't fork into a
    second naming scheme for the same route. Returns is_replace."""
    res = db.upsert_priority_list(
        plant, field_key, entries, line=line,
        source_column=spec["orders_column"], value_column=value_col,
        rank_column=rank_col, filename=filename, row_count=row_count, uploaded_by=user,
    )
    is_replace = not res["inserted"]
    if legacy_action_names:
        action = "color_wheel_replace" if is_replace else "color_wheel_upload"
    else:
        action = "priority_list_replace" if is_replace else "priority_list_upload"
    _cw_append_audit({
        "ts": datetime.utcnow().isoformat() + "Z", "user": user, "action": action, "plant": plant,
        "details": {"field_key": field_key, "line": line, "filename": filename,
                    "row_count": row_count, "replaced": is_replace},
    })
    _reload_one_plant_lists(plant)
    return is_replace
```

Add the new generic endpoint, right after the `GET /priority-lists` endpoint from Task 4:

```python
@api.post("/priority-list/{plant}/{field_key}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_priority_list(
        plant: str, field_key: str, request: Request, file: UploadFile = File(...),
        line: str = Form(default=""), value_column: str | None = Form(default=None),
        rank_column: str | None = Form(default=None),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Generic priority-list upload (Stage 2) — one file per plant [+ optional
    line override]. See docs/superpowers/plans/2026-08-11-priority-lists-stage-2.md
    Decisions 5-6 for the Line-column and implicit-rank rules, and Decision 9b
    for why this shares _resolve_priority_list_columns/_persist_priority_list
    with the legacy POST /color-wheel/{plant}."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    spec = md.RANKABLE_FIELDS.get(field_key)
    if spec is None:
        raise HTTPException(status_code=400, detail=f"Unknown field_key {field_key!r}")

    raw = await file.read()
    try:
        df = await run_in_threadpool(lambda: db.clean(pd.read_excel(io.BytesIO(raw))))
    except Exception as e:
        raise HTTPException(status_code=400, detail="Could not parse the uploaded file as .xlsx") from e
    if df.empty:
        raise HTTPException(status_code=400, detail="Uploaded file has no rows")

    resolved = _resolve_priority_list_columns(
        df, plant, spec, explicit_line=line, explicit_value_col=value_column, explicit_rank_col=rank_column,
    )
    if resolved["status"] == "needs_mapping":
        return resolved

    row_count = len(df)
    user = request.headers.get("X-User", "system")
    fname = file.filename or "upload.xlsx"

    is_replace = await run_in_threadpool(
        _persist_priority_list, plant, field_key, spec, resolved["entries"],
        line=resolved["line"], value_col=resolved["value_col"], rank_col=resolved["rank_col"],
        filename=fname, row_count=row_count, user=user, legacy_action_names=False,
    )
    return {"status": "ok", "row_count": row_count, "line": resolved["line"],
            "action": "replace" if is_replace else "upload", "replaced": is_replace}
```

**Rewrite the existing `POST /color-wheel/{plant}` handler** (`brain.py:1673-1723`) to call the same two helpers instead of its own independent parsing:

```python
@api.post("/color-wheel/{plant}", dependencies=[Depends(require_api_key), Depends(require_admin)])
async def upload_color_wheel(plant: str, request: Request, file: UploadFile = File(...)):
    """Upload or replace a plant-specific color wheel (persisted to the
    priority_list table). Consolidated (Decision 9b) onto the same
    _resolve_priority_list_columns/_persist_priority_list helpers
    POST /priority-list/{plant}/colorWheel uses — this route is now a thin
    back-compat wrapper for external callers that predate the generic
    endpoint; NIMBUS's own frontend uploads color the same way as every
    other field after Task 12. Preserves the historical contract: only
    `file` is accepted, a file with no resolvable COLOR column 400s
    immediately (no needs_mapping round-trip — there's no mapping UI on the
    other end of this route), and audit entries keep the historical
    color_wheel_upload/color_wheel_replace action names. One deliberate
    loosening: ORDER_Y is no longer required (row order is used if omitted,
    same as every other field, Decision 6) — strictly more permissive, so no
    previously-valid file starts failing.
    """
    raw = await file.read()
    spec = md.RANKABLE_FIELDS["colorWheel"]
    try:
        df = await run_in_threadpool(lambda: db.clean(pd.read_excel(io.BytesIO(raw))))
    except Exception as e:
        _log_event("warn", "color_wheel", "Color-wheel xlsx parse failed",
                   exc=e, error_code="xlsx.parse", plant=plant, filename=file.filename)
        raise HTTPException(
            status_code=400,
            detail="Could not parse the uploaded color-wheel file — check it is a valid .xlsx with a COLOR column",
        ) from e
    if df.empty:
        raise HTTPException(status_code=400, detail="Uploaded file has no rows")

    resolved = _resolve_priority_list_columns(df, plant, spec)
    if resolved["status"] == "needs_mapping":
        raise HTTPException(status_code=400, detail="Missing required columns: ['COLOR']")

    row_count = len(df)
    user = request.headers.get("X-User", "system")
    fname = file.filename or "upload.xlsx"

    is_replace = await run_in_threadpool(
        _persist_priority_list, plant, "colorWheel", spec, resolved["entries"],
        line=resolved["line"], value_col=resolved["value_col"], rank_col=resolved["rank_col"],
        filename=fname, row_count=row_count, user=user, legacy_action_names=True,
    )
    action = "color_wheel_replace" if is_replace else "color_wheel_upload"
    return {"status": "ok", "row_count": row_count, "action": action, "replaced": is_replace}
```

Add the route template to `_ADMIN_WRITE_OPERATIONS` (`brain.py:547-577`) — `/color-wheel/{plant}` is already registered; only the new route needs adding:

```python
    "/priority-list/{plant}/{field_key}": "priority_list.write",
```

Check `Form` is imported from `fastapi` at the top of `brain.py` (it is not used by any existing endpoint per the research — `file: UploadFile = File(...)` is the only multipart param used today); add `Form` to the existing `from fastapi import ...` line if missing.

- [ ] **Step 4: Run to verify they pass**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k "TestGenericPriorityListUpload or TestLegacyColorWheelUploadConsolidation or color_wheel" -v`
Expected: all PASS, including the pre-existing `test_color_wheel_endpoints_are_backed_by_priority_list` (GET-only regression) — confirms the consolidation didn't disturb the read path.

- [ ] **Step 5: Commit**

```bash
git add brain.py tests/test_priority_lists.py
git commit -m "feat: add generic priority-list upload endpoint; consolidate legacy color-wheel upload onto shared column-resolution/persist helpers"
```

---

### Task 6: `brain.py` — generic `GET`/`DELETE /priority-list/{plant}/{field_key}`

**Files:**
- Modify: `brain.py`
- Test: `tests/test_priority_lists.py`

**Interfaces:**
- Consumes: `db.get_priority_list`, `db.delete_priority_list` (both already generic, `db.py:1967-1999`), `auth.get_allowed_plants_for_request`, `master_data._assert_plant_allowed` (Decision 8 — RBAC on **both** verbs, not just the write).
- Produces: `GET /priority-list/{plant}/{field_key}?line=` → `{"plant","field_key","line","entries":[{"value":str,"rank":number}],"meta":{"uploaded_at","uploaded_by","filename","row_count"}}` (404 if absent, 403 if the plant is outside the caller's `role_plants` scope); `DELETE` (admin-gated) → `{"status":"ok"}` or `{"status":"not_found"}`.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.pg
def test_generic_get_and_delete_priority_list(client, pg):
    plant = "ZZTEST_GD_PLANT"
    pg.upsert_priority_list(plant, "prt01", {"DOG": 1.0, "CAT": None}, line="",
                            source_column="prt_01", filename="t.xlsx", row_count=2, uploaded_by="t")
    r = client.get(f"/priority-list/{plant}/prt01")
    assert r.status_code == 200
    body = r.json()
    assert body["entries"] == [{"value": "DOG", "rank": 1.0}, {"value": "CAT", "rank": 999999}]

    r2 = client.delete(f"/priority-list/{plant}/prt01",
                       headers={"X-API-Key": os.environ.get("NIMBUS_API_KEY", "")})
    assert r2.status_code == 200
    assert r2.json()["status"] == "ok"

    r3 = client.get(f"/priority-list/{plant}/prt01")
    assert r3.status_code == 404
```

- [ ] **Step 2: Run to verify it fails**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k generic_get_and_delete -v`
Expected: FAIL with 404 (routes don't exist).

- [ ] **Step 3: Implement**

```python
@api.get("/priority-list/{plant}/{field_key}")
def get_priority_list_generic(
        plant: str, field_key: str, line: str = Query(default=""),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Generic value/rank listing for one (plant, field_key[, line]) — the
    Stage 2 field card's Preview data source for non-color fields (color
    keeps using GET /color-wheel/{plant} via ColorWheelViewer, unchanged)."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    if field_key not in md.RANKABLE_FIELDS:
        raise HTTPException(status_code=400, detail=f"Unknown field_key {field_key!r}")
    row = db.get_priority_list(plant, field_key, line=line)
    if row is None:
        raise HTTPException(status_code=404,
            detail=f"No {field_key!r} priority list uploaded for plant {plant!r}" + (f" line {line!r}" if line else ""))
    entries = [
        {"value": v, "rank": (999999 if r is None else r)}
        for v, r in row["entries"].items()
    ]
    entries.sort(key=lambda e: e["rank"])
    return {
        "plant": plant, "field_key": field_key, "line": line, "entries": entries,
        "meta": {
            "uploaded_at": row["uploaded_at"].isoformat() if row["uploaded_at"] else None,
            "uploaded_by": row["uploaded_by"], "filename": row["filename"], "row_count": row["row_count"],
        },
    }


@api.delete("/priority-list/{plant}/{field_key}", dependencies=[Depends(require_api_key), Depends(require_admin)])
def delete_priority_list_generic(
        plant: str, field_key: str, request: Request, line: str = Query(default=""),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    if field_key not in md.RANKABLE_FIELDS:
        raise HTTPException(status_code=400, detail=f"Unknown field_key {field_key!r}")
    res = db.delete_priority_list(plant, field_key, line=line)
    if res is None:
        return {"status": "not_found"}
    ts = datetime.utcnow().isoformat() + "Z"
    user = request.headers.get("X-User", "system")
    _cw_append_audit({
        "ts": ts, "user": user, "action": "priority_list_delete", "plant": plant,
        "details": {"field_key": field_key, "line": line, "filename": res.get("filename") or "unknown"},
    })
    _reload_one_plant_lists(plant)
    return {"status": "ok"}
```

No `_ADMIN_WRITE_OPERATIONS` change needed in this task: `_admin_route_details` keys off `request.scope["route"].path` alone, not `(method, path)` (confirmed at `brain.py:582-591`), and `POST`/`DELETE /priority-list/{plant}/{field_key}` share the exact same route-template string — Task 5's single entry already covers both.

- [ ] **Step 4: Run to verify it passes**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k generic_get_and_delete -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add brain.py tests/test_priority_lists.py
git commit -m "feat: add generic GET/DELETE priority-list endpoints"
```

---

### Task 7: `brain.py` — live missing-master-data endpoint

**Files:**
- Modify: `brain.py`
- Test: `tests/test_priority_lists.py`

**Interfaces:**
- Consumes: `db.missing_master_data_for_plant` (Task 2), `auth.get_allowed_plants_for_request`, `master_data._assert_plant_allowed` (Decision 8 — this is plant-specific data, so `require_admin` alone is not scope enforcement; every sibling endpoint in this stage also checks `role_plants`).
- Produces: `GET /master-data/{plant}/missing-master-data` (+`?format=csv`) — identical response/CSV shape to the existing batch-scoped endpoint (`brain.py:1614-1656`); 403 if the plant is outside the caller's scope.

- [ ] **Step 1: Write the failing test**

```python
@pytest.mark.pg
def test_live_missing_master_data_endpoint(client, pg):
    plant = "ZZTEST_LMD_PLANT"
    sub = "ZZTEST_LMD_SUB"
    with pg._pool.connection() as conn, conn.cursor() as cur:
        cur.execute("INSERT INTO subnetworks (code, name) VALUES (%s, %s) ON CONFLICT DO NOTHING", (sub, sub))
        cur.execute("INSERT INTO plants (subnetwork, plant) VALUES (%s,%s) ON CONFLICT DO NOTHING", (sub, plant))
        cur.execute(
            "INSERT INTO orders (id, production_order, material_number, plant, basic_start_date)"
            " VALUES ('zzlmd1','PO1','MAT-X',%s, NOW()) ON CONFLICT (id) DO NOTHING", (plant,))
        conn.commit()
    try:
        r = client.get(f"/master-data/{plant}/missing-master-data")
        assert r.status_code == 200
        body = r.json()
        assert body["unmatched_pairs"] == 1
        assert body["exceptions"][0]["material_number"] == "MAT-X"

        r_csv = client.get(f"/master-data/{plant}/missing-master-data?format=csv")
        assert r_csv.status_code == 200
        assert r_csv.headers["content-type"].startswith("text/csv")
        assert "MAT-X" in r_csv.text
    finally:
        with pg._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("DELETE FROM orders WHERE id = 'zzlmd1'")
            cur.execute("DELETE FROM plants WHERE plant = %s", (plant,))
            cur.execute("DELETE FROM subnetworks WHERE code = %s", (sub,))
            conn.commit()
```

- [ ] **Step 2: Run to verify it fails**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k live_missing_master_data -v`
Expected: FAIL with 404.

- [ ] **Step 3: Implement**

```python
@api.get("/master-data/{plant}/missing-master-data", dependencies=[Depends(require_admin)])
def get_live_missing_master_data(
        plant: str, format: str | None = Query(default=None),
        allowed_plants: list[str] | None = Depends(auth.get_allowed_plants_for_request)):
    """Live (not batch-scoped) missing-master-data report for one plant's
    Optimization tab (docs/superpowers/plans/2026-08-11-priority-lists-stage-2.md
    Decision 3). Same JSON/CSV shape as GET /upload/{batch_id}/missing-master-data
    so the frontend shares one renderer."""
    try:
        md._assert_plant_allowed(plant, allowed_plants)
    except md.PlantNotAllowed as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    result = db.missing_master_data_for_plant(plant)
    if format == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["plant", "material_number", "order_count", "reason"])
        writer.writeheader()
        for e in result["exceptions"]:
            writer.writerow({k: e.get(k) for k in ["plant", "material_number", "order_count", "reason"]})
        return Response(
            content=buf.getvalue(), media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="missing-master-data-{plant}.csv"'},
        )
    return {"plant": plant, **result}
```

- [ ] **Step 4: Run to verify it passes**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -k live_missing_master_data -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add brain.py tests/test_priority_lists.py
git commit -m "feat: add live per-plant missing-master-data endpoint"
```

---

### Task 8: Backend admin-audit regression test + full pytest pass

**Files:**
- Test: `tests/test_priority_lists.py`

**Interfaces:**
- Consumes: `brain._ADMIN_WRITE_OPERATIONS` (mirrors `test_resync_route_is_registered_for_admin_audit_logging`, `tests/test_priority_lists.py` pure-logic section).

- [ ] **Step 1: Write the test**

```python
def test_priority_list_write_route_is_registered_for_admin_audit_logging():
    assert brain._ADMIN_WRITE_OPERATIONS["/priority-list/{plant}/{field_key}"] == "priority_list.write"
```

- [ ] **Step 2: Run it**

Run: `python -m pytest tests/test_priority_lists.py -k write_route_is_registered -v`
Expected: PASS (Task 5 already added the entry) — this is a pure-logic regression pin, not new TDD.

- [ ] **Step 3: Run the full Stage 2 pytest suite**

Run: `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -v`
Expected: all tests (Stage 1's existing ones + this stage's new ones) PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/test_priority_lists.py
git commit -m "test: pin priority-list write route in the admin-audit registry"
```

---

### Task 9: `web/types.mts` — generic priority-list types

**Files:**
- Modify: `web/types.mts`

**Interfaces:**
- Produces: `PriorityFieldMeta`, `PriorityListRow`, `PriorityListsForPlant`, `PriorityListEntry`, `PriorityListResponse`, `MissingMasterDataException`, `MissingMasterDataReport` — consumed by Tasks 10-11.
- Modifies: `ConstraintKey` (widen from the single-literal union to all four field keys, since Stage 2's cards reference field keys even though the Settings panel doesn't consume them yet).

- [ ] **Step 1: Implement**

Add near `ConstraintConfig`/`ConstraintKey` (`web/types.mts:117-170`):

```ts
/** GET /priority-fields row. */
export interface PriorityFieldMeta {
  field_key: string;
  mp_column: string;
  orders_column: string;
  task_field: string;
  default_label: string;
}

/** One (plant, line, field_key) row's metadata, from list_priority_lists_meta. */
export interface PriorityListRow {
  plant: string;
  line: string;
  field_key: string;
  uploaded_at: string | null;
  uploaded_by: string | null;
  filename: string | null;
  row_count: number;
}

/** GET /priority-lists?plant= response, per field_key. */
export interface PriorityListFieldSummary {
  default_label: string;
  plant_wide: PriorityListRow | null;
  line_overrides: PriorityListRow[];
  coverage: Record<string, { distinct_values: number; ranked_values: number }>;
}
export interface PriorityListsForPlant {
  plant: string;
  fields: Record<string, PriorityListFieldSummary>;
}

/** GET /priority-list/{plant}/{field_key} response. */
export interface PriorityListEntry { value: string; rank: number; }
export interface PriorityListResponse {
  plant: string;
  field_key: string;
  line: string;
  entries: PriorityListEntry[];
  meta: { uploaded_at: string | null; uploaded_by: string | null; filename: string | null; row_count: number };
}

/** Shared shape of both missing-master-data endpoints (batch-scoped and live). */
export interface MissingMasterDataException {
  plant: string | null;
  material_number: string;
  order_count: number;
  reason: 'no_mp_row' | 'no_plant_derived';
}
export interface MissingMasterDataReport {
  unmatched_pairs: number;
  unmatched_orders: number;
  exceptions: MissingMasterDataException[];
}
```

Replace the single-literal `ConstraintKey` (`web/types.mts:170`):

```ts
/** Widened in Stage 2 — all four RANKABLE_FIELDS keys now exist as upload
 *  targets, even though only 'colorWheel' is wired into Engine._sortTerms
 *  until Stage 3. */
export type ConstraintKey = 'colorWheel' | 'prt01' | 'prt02' | 'productionVersion';
```

- [ ] **Step 2: Verify**

Run: `npm run typecheck`
Expected: passes (these are additive interfaces; `ConstraintKey`'s widening is safe since nothing currently narrows against the old single-literal type except by construction).

- [ ] **Step 3: Commit**

```bash
git add web/types.mts
git commit -m "feat: add generic priority-list TS types, widen ConstraintKey"
```

---

### Task 10: `web/index.html` — mapping modal + generic viewer modal markup

**Files:**
- Modify: `web/index.html` (add near the existing `#modal-cw-viewer`, `web/index.html:2573-2611`)

**Interfaces:**
- Produces: `#modal-priority-mapping` (column-mapping modal DOM), `#modal-priority-viewer` (generic list viewer DOM) — consumed by Tasks 11-12.

- [ ] **Step 1: Add the mapping modal**

Insert after the `#modal-cw-viewer` block:

```html
<div class="modal-backdrop" id="modal-priority-mapping" hidden
     onclick="if(event.target===this)NIMBUS.PriorityListMapping.close()">
  <div class="modal" style="max-width:520px">
    <div class="modal-head">
      <h3 data-i18n="ui.mapping_modal_title">Map columns</h3>
      <button class="modal-close" onclick="NIMBUS.PriorityListMapping.close()">&times;</button>
    </div>
    <div class="modal-body">
      <p style="margin:0 0 12px;font-size:12.5px;color:var(--fg-mute)" data-i18n="ui.mapping_modal_sub">
        We couldn't tell which column holds the value and which holds the rank. Pick them below.
      </p>
      <div class="form-row">
        <label data-i18n="ui.mapping_value_col">Value column</label>
        <select id="pl-mapping-value-col" class="input"></select>
      </div>
      <div class="form-row">
        <label data-i18n="ui.mapping_rank_col">Rank column (optional — row order used if left blank)</label>
        <select id="pl-mapping-rank-col" class="input">
          <option value="" data-i18n="ui.mapping_rank_none">— use row order —</option>
        </select>
      </div>
      <div id="pl-mapping-sample" class="pl-mapping-sample"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="NIMBUS.PriorityListMapping.close()" data-i18n="btn.cancel">Cancel</button>
      <button class="btn btn-primary" onclick="NIMBUS.PriorityListMapping.confirm()" data-i18n="btn.upload">Upload</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add the generic viewer modal**

Insert after the mapping modal, closely mirroring `#modal-cw-viewer`'s structure (`web/index.html:2573-2611`) minus the swatch/color-specific pieces:

```html
<div class="modal-backdrop cw-viewer-backdrop" id="modal-priority-viewer" hidden
     onclick="if(event.target===this)NIMBUS.PriorityListViewer.close()">
  <div class="cw-viewer-modal">
    <div class="opt-header">
      <div class="opt-header-icon">&#128203;</div>
      <div class="opt-header-text">
        <div class="opt-header-title"><span id="pl-viewer-field-label">&mdash;</span> &middot; <span id="pl-viewer-plant-name">&mdash;</span></div>
        <div class="opt-header-sub" id="pl-viewer-meta">&mdash;</div>
      </div>
      <button class="opt-close" onclick="NIMBUS.PriorityListViewer.close()">&times;</button>
    </div>
    <div class="cw-viewer-toolbar">
      <div class="cw-search-wrap">
        <span class="cw-search-icon">&#128269;</span>
        <input type="search" id="pl-viewer-search" class="cw-search-input" data-i18n-placeholder="ph.search_values"
               oninput="NIMBUS.PriorityListViewer.search(this.value)">
      </div>
      <span class="cw-count-badge" id="pl-viewer-count"></span>
    </div>
    <div class="cw-viewer-list" id="pl-viewer-list">
      <div class="cw-loading"><span class="cw-spin"></span><span data-i18n="ui.loading">Loading&hellip;</span></div>
    </div>
    <div class="cw-viewer-footer">
      <button class="btn btn-ghost" onclick="NIMBUS.PriorityListViewer.close()" data-i18n="btn.close">Close</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Verify**

Run: `npm run check:static-assets` (confirms no backend filenames leaked in, and — while this check doesn't validate HTML syntax — open `index.html` in a text editor and confirm the two new blocks are well-formed, matching the existing modal blocks' indentation).

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat: add priority-list mapping and generic viewer modal markup"
```

---

### Task 11: `web/schedule-workbench.mts` — `PriorityListViewer` module

**Files:**
- Modify: `web/schedule-workbench.mts` (add new module near `ColorWheelViewer`, `web/schedule-workbench.mts:7296-7456`)
- Modify: the module's export list (find the `return { ... }` / bridge object at the bottom of the file that currently includes `ColorWheelViewer`) and `app-entry.mjs`'s `window.__NIMBUS_WORKBENCH = {...}` assignment, and `app.js`'s destructure line that pulls names off `__NIMBUS_WORKBENCH` — grep for `ColorWheelViewer` in both `app-entry.mjs` and `app.js` and add `PriorityListViewer` alongside it in every place it appears.
- Test: `tests/modules/schedule-workbench.test.mjs` (or wherever this module's public-API smoke tests live — grep for an existing `ColorWheelViewer` test to find the right file, following the thin "public API shape" style seen in `tests/modules/plant-and-administration.test.mjs`)

**Interfaces:**
- Consumes: `ColorWheelViewer.open` (delegation target, `web/schedule-workbench.mts:7325`), `Config.API_BASE`, `Util.t`, `Util.norm`, `PriorityListEntry`/`PriorityListResponse` (Task 9's new types).
- Produces: `PriorityListViewer.open(plant: string, fieldKey: string): void`, `.close(): void`, `.search(val: string): void`.

This file also uses explicit named type imports (`import type { NimbusTask, NimbusBlock, NimbusPlantBlock, AlertType, AlertSev, UtilSevBucket, OptimizerMode, WorkHours } from './types.mjs';`, `web/schedule-workbench.mts:148`) — extend it with `PriorityListEntry, PriorityListResponse` or the `body.entries`/`body.meta` references below are unresolved names.

- [ ] **Step 1: Write the failing test**

```js
import { PriorityListViewer } from '../../web/schedule-workbench.mjs';

test('PriorityListViewer exposes open/close/search', () => {
  assert.equal(typeof PriorityListViewer.open, 'function');
  assert.equal(typeof PriorityListViewer.close, 'function');
  assert.equal(typeof PriorityListViewer.search, 'function');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test tests/modules/schedule-workbench.test.mjs`
Expected: FAIL — `PriorityListViewer` is not exported.

- [ ] **Step 3: Implement**

Add after `ColorWheelViewer`'s closing `})();` (`web/schedule-workbench.mts:7456`):

```ts
export const PriorityListViewer = (() => {
  let _plant: string | null = null;
  let _fieldKey: string | null = null;
  let _entries: PriorityListEntry[] = [];
  let _search = '';

  const _esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c: string) =>
    (({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]));

  function open(plant: string, fieldKey: string) {
    if (fieldKey === 'colorWheel') { ColorWheelViewer.open(plant); return; }
    _plant = plant; _fieldKey = fieldKey; _search = '';
    const el = document.getElementById('modal-priority-viewer');
    if (!el) return;
    el.hidden = false;
    const srch = document.getElementById('pl-viewer-search') as HTMLInputElement | null;
    if (srch) srch.value = '';
    requestAnimationFrame(() => el.querySelector('.cw-viewer-modal')?.classList.add('visible'));
    _load();
  }

  function close() {
    const el = document.getElementById('modal-priority-viewer');
    if (!el) return;
    el.querySelector('.cw-viewer-modal')?.classList.remove('visible');
    setTimeout(() => { el.hidden = true; }, 240);
  }

  function _load() {
    const labelEl = document.getElementById('pl-viewer-field-label');
    const nameEl  = document.getElementById('pl-viewer-plant-name');
    const listEl  = document.getElementById('pl-viewer-list');
    if (labelEl) labelEl.textContent = _fieldKey ? Util.t(`constraint.${_fieldKey}`) : '—'; // resolved label, not the raw camelCase key — same rule as Plant's toasts/modals
    if (nameEl)  nameEl.textContent  = _plant || '—';
    if (listEl)  listEl.innerHTML    = `<div class="cw-loading"><span class="cw-spin"></span>${Util.t('ui.loading')}</div>`;

    fetch(`${Config.API_BASE}/priority-list/${encodeURIComponent(_plant!)}/${encodeURIComponent(_fieldKey!)}`,
          { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() as Promise<PriorityListResponse> : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(body => {
        _entries = body.entries || [];
        const metaEl = document.getElementById('pl-viewer-meta');
        const m = body.meta || {};
        if (metaEl) metaEl.textContent = m.filename
          ? `${m.filename} · ${m.row_count ?? _entries.length} values`
          : `${_entries.length} values`;
        _render();
      })
      .catch((err: Error) => {
        _entries = [];
        if (listEl) listEl.innerHTML = `<div class="cw-viewer-empty">${Util.t('empty.pl_no_list_for_plant')}</div>`;
        const metaEl = document.getElementById('pl-viewer-meta');
        if (metaEl) metaEl.textContent = err.message.includes('404') ? Util.t('empty.pl_no_file') : err.message;
      });
  }

  function _render() {
    const listEl = document.getElementById('pl-viewer-list');
    const countEl = document.getElementById('pl-viewer-count');
    if (!listEl) return;
    const q = _search.toLowerCase();
    const data = _entries.filter(e => !q || e.value.toLowerCase().includes(q));
    if (countEl) countEl.textContent = `${data.length} / ${_entries.length}`;
    if (!data.length) {
      listEl.innerHTML = `<div class="cw-viewer-empty">${Util.t('empty.pl_no_matches')}</div>`;
      return;
    }
    listEl.innerHTML = data.map(e => {
      const pri = e.rank < 999999 ? e.rank : '—';
      return `
        <div class="cw-viewer-row">
          <div class="cw-viewer-rank">${_esc(pri)}</div>
          <div class="cw-viewer-name">${_esc(e.value)}</div>
        </div>`;
    }).join('');
  }

  function search(val: string) { _search = String(val || ''); _render(); }

  return { open, close, search };
})();
```

Then wire the bridge: locate the module's export object (grep `ColorWheelViewer,` in `web/schedule-workbench.mts`'s bottom-of-file export block) and add `PriorityListViewer,` beside it; do the same in `app-entry.mjs`'s `window.__NIMBUS_WORKBENCH = {...}` object and in `app.js`'s destructure of `__NIMBUS_WORKBENCH`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && node --test tests/modules/schedule-workbench.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/schedule-workbench.mts web/app-entry.mjs web/app.js tests/modules/schedule-workbench.test.mjs
git commit -m "feat: add PriorityListViewer, delegating to ColorWheelViewer for color"
```

---

### Task 12: `web/plant-and-administration.mts` — rewrite `_renderOptimization` into per-field cards

The largest frontend task. Split into sub-steps but kept as one task since the four field cards, the missing-master-data panel, and the resync button all read from the same `GET /priority-lists?plant=` fetch and are not independently meaningful without each other.

**Files:**
- Modify: `web/plant-and-administration.mts:717-857` (`_fetchAndRenderOptimization`, `_renderOptimization`, `_uploadWheel`, `_confirmDeleteWheel` — the whole color-wheel-only block)
- Test: `tests/modules/plant-and-administration.test.mjs`

**Interfaces:**
- Consumes: `GET /priority-fields` (Task 3), `GET /priority-lists?plant=` (Task 4), `POST/DELETE /priority-list/{plant}/{field_key}` (Tasks 5-6), `GET /master-data/{plant}/missing-master-data` (Task 7), `POST /master-data/resync-order-attributes` (Stage 1), `PriorityListViewer.open` (Task 11), `_mkCombobox` (`web/plant-and-administration.mts:2908-2963`, same-file top-level function — call directly).
- Produces: `Plant._renderOptimization(plantName)` (same public name and call sites, generalized body), `Plant._uploadPriorityList(plantName, fieldKey, file, line?)`, `Plant._confirmDeletePriorityList(plantName, fieldKey, line)`, `Plant._resyncOrderAttributes(plantName)`.

- [ ] **Step 1: Write the failing test**

```js
test('Plant exposes the generalized priority-list optimization API', () => {
  assert.equal(typeof Plant._renderOptimization, 'function');
  assert.equal(typeof Plant._uploadPriorityList, 'function');
  assert.equal(typeof Plant._confirmDeletePriorityList, 'function');
  assert.equal(typeof Plant._resyncOrderAttributes, 'function');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && node --test tests/modules/plant-and-administration.test.mjs`
Expected: FAIL — the new method names don't exist yet (only `_uploadWheel`/`_confirmDeleteWheel` do).

- [ ] **Step 3: Implement**

Replace `_fetchAndRenderOptimization` (`:717-734`) to fetch the new combined endpoint plus the field registry:

```ts
  _fetchAndRenderOptimization(plantName: string | null): void {
    const panel = document.getElementById('plant-opt-panel');
    if (!panel) return;
    const body = panel.querySelector('.panel-body');
    if (body) body.innerHTML = `<div class="cw-loading"><span class="cw-spin"></span>${Util.t('ui.loading')}</div>`;
    if (!plantName) return;

    Promise.all([
      fetch(`${Config.API_BASE}/priority-fields`, { signal: AbortSignal.timeout(6000) }).then(r => r.json()),
      fetch(`${Config.API_BASE}/priority-lists?plant=${encodeURIComponent(plantName)}`, { signal: AbortSignal.timeout(6000) }).then(r => r.json()),
      fetch(`${Config.API_BASE}/master-data/${encodeURIComponent(plantName)}/missing-master-data`, { signal: AbortSignal.timeout(6000) }).then(r => r.json()).catch(() => null),
    ])
      .then(([fieldsBody, listsBody, missingBody]) => {
        Plant._priorityFields = fieldsBody.fields || [];
        Plant._priorityLists = listsBody.fields || {};
        Plant._missingMasterData = missingBody;
        Plant._renderOptimization(plantName);
      })
      .catch(() => {
        Plant._priorityFields = [];
        Plant._priorityLists = {};
        Plant._missingMasterData = null;
        Plant._renderOptimization(plantName);
      });
  },
```

Replace `_renderOptimization` (`:736-805`) with a per-field-card renderer. This is the core new render function — keep every element ID scoped by `fieldKey` (`plant-pl-dropzone-${fieldKey}`, etc.) since there are now up to 4 dropzones on screen at once:

```ts
  _renderOptimization(plantName: string | null): void {
    const body = document.getElementById('plant-opt-body');
    if (!body) return;
    const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'} as Record<string, string>)[c]);
    const relTime = (ts: string | null | undefined): string => {
      if (!ts) return Util.t('ui.unknown_time');
      const diff = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
      if (diff < 120)   return Util.t('ui.just_now');
      if (diff < 3600)  return Util.t('ui.mins_ago', { n: Math.floor(diff / 60) });
      if (diff < 86400) return Util.t('ui.hours_ago', { n: Math.floor(diff / 3600) });
      return Util.t('ui.days_ago', { n: Math.floor(diff / 86400) });
    };

    const fields = Plant._priorityFields || [];
    const lists  = Plant._priorityLists  || {};

    const fieldCardHtml = (f: { field_key: string; default_label: string }): string => {
      const summary = lists[f.field_key] || { plant_wide: null, line_overrides: [], coverage: {} };
      // Util.t(key, vars?) — no fallback-string param (confirmed at
      // web/application-foundation.mts:556-562): it already falls back
      // en -> raw key on a missing translation, which is why Task 14 must
      // land the constraint.* keys in en.js at minimum. f.default_label is
      // the backend's own default (surfaced via GET /priority-fields) and is
      // NOT threaded through Util.t — it exists for API consumers that don't
      // have the locale bundle at all, not as an in-app i18n fallback.
      const label = Util.t(`constraint.${f.field_key}`);
      const inertBadge = f.field_key === 'colorWheel' ? '' :
        `<span class="pl-inert-badge">${Util.t('ui.not_yet_used_in_sequencing')}</span>`;
      const cov = summary.coverage[''] || null;
      const covHtml = cov
        ? `<div class="pl-coverage"><span class="pl-coverage-num">${cov.ranked_values}/${cov.distinct_values}</span> ${Util.t('ui.values_ranked')}</div>`
        : '';

      let activeOrDrop: string;
      if (summary.plant_wide) {
        const w = summary.plant_wide;
        activeOrDrop = `
          <div class="cw-active-card">
            <div class="cw-active-icon">${f.field_key === 'colorWheel' ? '🎨' : '🔧'}</div>
            <div class="cw-active-info">
              <div class="cw-active-name">${esc(w.filename || '—')}</div>
              <div class="cw-active-meta">${w.row_count ?? '?'} ${Util.t('ui.values')} &middot; ${relTime(w.uploaded_at)} &middot; ${esc(w.uploaded_by || 'system')}</div>
              ${covHtml}
            </div>
            <div class="cw-active-actions">
              <button class="btn btn-ghost sm" data-action="preview" data-field="${f.field_key}">👁 ${Util.t('btn.preview')}</button>
              <button class="btn btn-ghost sm cw-delete-btn" data-action="delete" data-field="${f.field_key}" data-line="">⌫ ${Util.t('btn.remove')}</button>
            </div>
          </div>
          <div class="cw-dropzone cw-replace-zone" id="plant-pl-dropzone-${f.field_key}" data-field="${f.field_key}" title="${Util.t('ui.drop_to_replace')}">
            <div class="cw-drop-inner">
              <span class="cw-drop-icon">↻</span>
              <span class="cw-drop-text">${Util.t('ui.drop_replace_text')}</span>
              <input type="file" id="plant-pl-file-${f.field_key}" accept=".xlsx,.xls" style="display:none">
            </div>
          </div>`;
      } else {
        activeOrDrop = `
          <div class="cw-dropzone" id="plant-pl-dropzone-${f.field_key}" data-field="${f.field_key}">
            <div class="cw-drop-inner">
              <span class="cw-drop-icon">📂</span>
              <span class="cw-drop-text">${Util.t('ui.drop_list_text', { field: label })}</span>
              <div class="cw-drop-hint">${Util.t('ui.drop_list_hint')}</div>
              <input type="file" id="plant-pl-file-${f.field_key}" accept=".xlsx,.xls" style="display:none">
            </div>
          </div>`;
      }

      const overridesHtml = summary.line_overrides.map(o => {
        // priority_list_coverage (db.py:2056) computes coverage PER LINE, not
        // just plant-wide — an override row that only ever showed row_count/
        // upload time would silently drop the one number `covHtml` above proves
        // is available and useful (the whole point of N3's per-line breakdown).
        const lineCov = summary.coverage[o.line] || null;
        const lineCovHtml = lineCov
          ? `<span class="pl-coverage pl-override-coverage">${lineCov.ranked_values}/${lineCov.distinct_values} ${Util.t('ui.values_ranked')}</span>`
          : '';
        return `
        <div class="pl-override-row">
          <span class="pl-override-line">${esc(o.line)}</span>
          <span class="pl-override-meta">${o.row_count} ${Util.t('ui.values')} &middot; ${relTime(o.uploaded_at)}</span>
          ${lineCovHtml}
          <button class="btn btn-ghost sm" data-action="preview" data-field="${f.field_key}">👁</button>
          <button class="btn btn-ghost sm cw-delete-btn" data-action="delete" data-field="${f.field_key}" data-line="${esc(o.line)}">⌫</button>
        </div>`;
      }).join('');

      return `
        <div class="pl-field-card" data-field="${f.field_key}">
          <div class="pl-field-card-head">
            <h4>${esc(label)}</h4>
            ${inertBadge}
          </div>
          ${activeOrDrop}
          <div class="pl-overrides">${overridesHtml}</div>
          <div class="pl-add-override" id="pl-add-override-${f.field_key}"></div>
          <div id="plant-pl-status-${f.field_key}" class="admin-status" style="margin-top:8px;"></div>
        </div>`;
    };

    const missingHtml = Plant._missingMasterData && Plant._missingMasterData.unmatched_pairs > 0 ? `
      <div class="pl-mmd-panel">
        <div class="pl-mmd-head">
          <h4>${Util.t('ui.missing_master_data_title')}</h4>
          <button class="btn btn-ghost sm" id="pl-mmd-export">${Util.t('btn.export_csv')}</button>
          <button class="btn btn-primary sm" id="pl-mmd-resync">${Util.t('btn.resync_now')}</button>
        </div>
        <p class="pl-mmd-sub">${Util.t('ui.missing_master_data_sub', { pairs: Plant._missingMasterData.unmatched_pairs, orders: Plant._missingMasterData.unmatched_orders })}</p>
        <div class="pl-mmd-list">
          ${Plant._missingMasterData.exceptions.slice(0, 20).map((e: { material_number: string; order_count: number; reason: string }) => `
            <div class="pl-mmd-row">
              <span class="pl-mmd-material">${esc(e.material_number)}</span>
              <span class="pl-mmd-count">${e.order_count} ${Util.t('ui.orders')}</span>
              <span class="pl-mmd-reason">${Util.t(`ui.mmd_reason_${e.reason}`)}</span>
            </div>`).join('')}
          ${Plant._missingMasterData.exceptions.length > 20 ? `
            <div class="pl-mmd-more">${Util.t('ui.mmd_more_rows', { n: Plant._missingMasterData.exceptions.length - 20 })}</div>` : ''}
        </div>
      </div>` : '';

    body.innerHTML = fields.map(fieldCardHtml).join('') + missingHtml;

    // Wire dropzones (one per field) — see Task pattern at the old single-wheel wiring.
    fields.forEach(f => {
      const zone = document.getElementById(`plant-pl-dropzone-${f.field_key}`);
      const fileInput = document.getElementById(`plant-pl-file-${f.field_key}`) as HTMLInputElement | null;
      if (!zone || !fileInput) return;
      zone.onclick = e => { if (e.target !== fileInput) fileInput.click(); };
      fileInput.onchange = () => { if (fileInput.files![0]) Plant._uploadPriorityList(plantName, f.field_key, fileInput.files![0]); };
      zone.ondragover  = e => { e.preventDefault(); zone.classList.add('drag-over'); };
      zone.ondragleave = () => zone.classList.remove('drag-over');
      zone.ondrop = e => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (e.dataTransfer!.files.length > 1) {
          Toast.show(Util.t('toast.one_file_at_a_time'), 'warn');
          return;
        }
        const f0 = e.dataTransfer!.files[0];
        if (f0) Plant._uploadPriorityList(plantName, f.field_key, f0);
      };
    });

    // Wire preview/delete buttons.
    body.querySelectorAll<HTMLElement>('[data-action="preview"]').forEach(btn => {
      btn.addEventListener('click', () => PriorityListViewer.open(plantName!, btn.dataset.field!));
    });
    body.querySelectorAll<HTMLElement>('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', () => Plant._confirmDeletePriorityList(plantName!, btn.dataset.field!, btn.dataset.line || ''));
    });

    // Wire "+ add line override" combobox per field (Store.masterData lines for this plant).
    fields.forEach(f => {
      const host = document.getElementById(`pl-add-override-${f.field_key}`);
      if (!host) return;
      host.innerHTML = `<button class="btn btn-ghost sm" data-add-override="${f.field_key}">+ ${Util.t('ui.add_line_override')}</button>`;
      host.querySelector('button')!.addEventListener('click', () => {
        // Store.linesForSelectedPlant() — the established O(1)-indexed read
        // used throughout this file (e.g. :256, :596) and schedule-workbench.mts;
        // correct here since the Optimization tab is already scoped to
        // Store.selectedPlant, which equals plantName in this render pass.
        const lineNames = Store.linesForSelectedPlant();
        host.innerHTML = `<div class="pl-override-combo"></div><input type="file" id="pl-override-file-${f.field_key}" accept=".xlsx,.xls" style="display:none">`;
        const comboHost = host.querySelector('.pl-override-combo') as HTMLElement;
        _mkCombobox(comboHost, lineNames, {
          placeholder: Util.t('ph.pick_a_line'),
          onSelect: (line: string) => {
            (document.getElementById(`pl-override-file-${f.field_key}`) as HTMLInputElement).onchange = (e) => {
              const file = (e.target as HTMLInputElement).files![0];
              if (file) Plant._uploadPriorityList(plantName, f.field_key, file, line);
            };
            (document.getElementById(`pl-override-file-${f.field_key}`) as HTMLInputElement).click();
          },
        });
      });
    });

    // Wire missing-master-data panel actions.
    document.getElementById('pl-mmd-export')?.addEventListener('click', () => {
      window.open(`${Config.API_BASE}/master-data/${encodeURIComponent(plantName!)}/missing-master-data?format=csv`, '_blank');
    });
    document.getElementById('pl-mmd-resync')?.addEventListener('click', () => Plant._resyncOrderAttributes(plantName!));
  },
```

Replace `_uploadWheel` with `_uploadPriorityList` (generalizing `:807-838`, handling the `needs_mapping` response by opening the Task 10 mapping modal instead of failing):

```ts
  _uploadPriorityList(plantName: string | null, fieldKey: string, file: File, line?: string): void {
    const status = document.getElementById(`plant-pl-status-${fieldKey}`);
    if (status) { status.textContent = Util.t('toast.uploading_file', { name: file.name }); status.className = 'admin-status info'; }

    const post = (extra: Record<string, string> = {}) => {
      const fd = new FormData();
      fd.append('file', file);
      if (line) fd.append('line', line);
      Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
      return fetch(`${Config.API_BASE}/priority-list/${encodeURIComponent(plantName!)}/${encodeURIComponent(fieldKey)}`, {
        method: 'POST', body: fd, headers: { 'X-User': Session.actor() },
      }).then(r => r.json());
    };

    post().then(body => {
      if (body.status === 'needs_mapping') {
        PriorityListMapping.open(body.headers, body.sample, (valueCol: string, rankCol: string) => {
          post({ value_column: valueCol, rank_column: rankCol }).then(body2 => Plant._handleUploadResult(plantName, fieldKey, status, body2));
        });
        return;
      }
      Plant._handleUploadResult(plantName, fieldKey, status, body);
    }).catch(e => {
      if (status) { status.textContent = Util.t('toast.upload_failed', { msg: e.message }); status.className = 'admin-status error'; }
    });
  },

  _handleUploadResult(plantName: string | null, fieldKey: string, status: HTMLElement | null, body: { status: string; message?: string; row_count?: number; replaced?: boolean }): void {
    // Every field card header resolves its label via Util.t('constraint.' + fieldKey)
    // (see fieldCardHtml above) — toasts/modals must do the same, or a raw
    // camelCase key ("prt01 list uploaded for 5512") leaks through next to
    // polished card copy ("Prod. Resource Tool (01)").
    const label = Util.t(`constraint.${fieldKey}`);
    if (body.status !== 'ok') {
      if (status) { status.textContent = Util.t('toast.upload_failed', { msg: body.message || 'unknown' }); status.className = 'admin-status error'; }
      ErrorLog.error('plant', `Priority list upload failed for ${plantName}/${fieldKey}: ${body.message}`, body);
      return;
    }
    const verb = body.replaced ? 'replaced' : 'uploaded';
    Toast.show(Util.t('toast.priority_list_verb', { verb, field: label, plant: plantName! }), 'success');
    ErrorLog.info('plant', `Priority list ${verb} for ${plantName}/${fieldKey}: ${body.row_count} values`);
    Plant._fetchAndRenderOptimization(plantName);
  },
```

Replace `_confirmDeleteWheel` with `_confirmDeletePriorityList` (generalizing `:840-857`):

```ts
  async _confirmDeletePriorityList(plantName: string, fieldKey: string, line: string): Promise<void> {
    const label = Util.t(`constraint.${fieldKey}`); // same-resolution rule as _handleUploadResult above
    const ok = await Modal.confirm({ title: Util.t('modal.remove_priority_list', { plant: plantName, field: label }), confirmLabel: Util.t('btn.yes_delete') });
    if (!ok) return;
    const qs = line ? `?line=${encodeURIComponent(line)}` : '';
    fetch(`${Config.API_BASE}/priority-list/${encodeURIComponent(plantName)}/${encodeURIComponent(fieldKey)}${qs}`, {
      method: 'DELETE', headers: { 'X-User': Session.actor() },
    })
      .then(r => r.json())
      .then(body => {
        if (body.status !== 'ok' && body.status !== 'not_found') {
          Toast.show(Util.t('toast.delete_failed'), 'error'); return;
        }
        Toast.show(Util.t('toast.priority_list_deleted', { plant: plantName, field: label }), 'success');
        Plant._fetchAndRenderOptimization(plantName);
      })
      .catch(e => Toast.show(Util.t('toast.delete_failed_msg', { msg: e.message }), 'error'));
  },
```

Add `_resyncOrderAttributes`:

```ts
  async _resyncOrderAttributes(plantName: string): Promise<void> {
    // Modal.confirm's real opts are {title, message, detail, confirmLabel, tone}
    // (web/application-foundation.mts:1289-1291) — its own header comment is
    // stale (documents an old callback-style signature); 'body' is not a field.
    const ok = await Modal.confirm({
      title: Util.t('modal.resync_title', { plant: plantName }),
      message: Util.t('modal.resync_warning'),
      confirmLabel: Util.t('btn.resync_now'),
      tone: 'warn',
    });
    if (!ok) return;
    fetch(`${Config.API_BASE}/master-data/resync-order-attributes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-email': Session.actor() },
      body: JSON.stringify({ plant: plantName }),
    })
      .then(r => r.json())
      .then(body => {
        Toast.show(Util.t('toast.resync_done', { pairs: body.unmatched_pairs, orders: body.unmatched_orders }), 'success');
        Plant._fetchAndRenderOptimization(plantName);
      })
      .catch(e => Toast.show(Util.t('toast.resync_failed', { msg: e.message }), 'error'));
  },
```

Also add a small `PriorityListMapping` module (new, minimal — reads/writes the Task 10 modal DOM):

```ts
export const PriorityListMapping = (() => {
  let _onConfirm: ((valueCol: string, rankCol: string) => void) | null = null;

  function open(headers: string[], sample: Record<string, unknown>[], onConfirm: (v: string, r: string) => void): void {
    _onConfirm = onConfirm;
    const valSel = document.getElementById('pl-mapping-value-col') as HTMLSelectElement;
    const rankSel = document.getElementById('pl-mapping-rank-col') as HTMLSelectElement;
    valSel.innerHTML = headers.map(h => `<option value="${h}">${h}</option>`).join('');
    rankSel.innerHTML = `<option value="">${Util.t('ui.mapping_rank_none')}</option>` +
      headers.map(h => `<option value="${h}">${h}</option>`).join('');
    const sampleEl = document.getElementById('pl-mapping-sample');
    if (sampleEl) {
      sampleEl.innerHTML = `<table class="pl-sample-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
        sample.slice(0, 5).map(row => `<tr>${headers.map(h => `<td>${String(row[h] ?? '')}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
    }
    const el = document.getElementById('modal-priority-mapping');
    if (el) el.hidden = false;
  }

  function close(): void {
    const el = document.getElementById('modal-priority-mapping');
    if (el) el.hidden = true;
    _onConfirm = null;
  }

  function confirm(): void {
    const valSel = document.getElementById('pl-mapping-value-col') as HTMLSelectElement;
    const rankSel = document.getElementById('pl-mapping-rank-col') as HTMLSelectElement;
    const cb = _onConfirm;
    close();
    if (cb) cb(valSel.value, rankSel.value);
  }

  return { open, close, confirm };
})();
```

Add `_priorityFields`, `_priorityLists`, `_missingMasterData` as declared instance fields on `Plant` alongside the existing `_cwMeta` field declaration. **`Plant` is a plain object literal** (`export const Plant = { ... }`, `web/plant-and-administration.mts:294`), not a class or interface — a bare type annotation with no initializer (as in a class-field or interface declaration) is invalid syntax here and will fail to compile. Give each field the same initialize-with-an-`as`-cast shape `_cwMeta` already uses:

```ts
_priorityFields: [] as PriorityFieldMeta[],
_priorityLists: {} as Record<string, PriorityListFieldSummary>,
_missingMasterData: null as MissingMasterDataReport | null,
```

Also extend the existing `import type { NimbusBlock, NimbusPlantBlock, NimbusMasterPlant, NimbusMasterLine, NimbusLineSetting, ConstraintConfig, BufferUnit, TopLevelTab } from './types.mjs';` line (`web/plant-and-administration.mts:46`) to add `PriorityFieldMeta, PriorityListFieldSummary, MissingMasterDataReport` — this file uses explicit named type imports (no wildcard), so Task 9's new interfaces are otherwise unresolved names here.

Wire the new `PriorityListMapping` and `PriorityListViewer` exports the same way as Task 11 (bridge object + `app-entry.mjs` + `app.js` destructure).

- [ ] **Step 4: Run to verify it passes**

Run: `npm run build && node --test tests/modules/plant-and-administration.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/plant-and-administration.mts web/app-entry.mjs web/app.js tests/modules/plant-and-administration.test.mjs
git commit -m "feat: rewrite Optimization tab into per-field priority-list cards"
```

---

### Task 13: `web/styles.css` — field cards, coverage, inert badge, mapping modal

**Files:**
- Modify: `web/styles.css` (extend the existing `PLANT OPT` section, `web/styles.css:3565-3661`)

**Interfaces:**
- Produces: `.pl-field-card`, `.pl-field-card-head`, `.pl-inert-badge`, `.pl-coverage`, `.pl-coverage-num`, `.pl-overrides`, `.pl-override-row`, `.pl-override-line`, `.pl-override-meta`, `.pl-override-coverage`, `.pl-add-override`, `.pl-override-combo`, `.pl-mmd-panel`, `.pl-mmd-head`, `.pl-mmd-sub`, `.pl-mmd-list`, `.pl-mmd-row`, `.pl-mmd-material`, `.pl-mmd-count`, `.pl-mmd-reason`, `.pl-mmd-more`, `.pl-mapping-sample`, `.pl-sample-table`.

- [ ] **Step 1: Implement**

Add after `.cw-drop-hint` (`web/styles.css:3635`):

```css
/* ── Per-field priority-list cards (Stage 2 of docs/scheduling_priority.md) ── */
.pl-field-card {
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: 14px 16px;
  margin-bottom: 16px;
}
.pl-field-card-head {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 10px;
}
.pl-field-card-head h4 {
  margin: 0; font-size: 13px; font-weight: 600; color: var(--fg);
}
/* Soft-tint badge, not a colored side-stripe (DESIGN.md §6 Don'ts) — same
   -soft/text-color pairing as Toasts/Badges (§5), using Signal Info. */
.pl-inert-badge {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.02em;
  padding: 2px 8px; border-radius: var(--r-sm);
  background: var(--info-soft); color: var(--info);
}
/* Mono-Means-Machine Rule (DESIGN.md §3) — coverage is a measured ratio. */
.pl-coverage {
  font-family: var(--font-mono); font-size: 11px; color: var(--fg-mute);
  margin-top: 4px;
}
.pl-coverage-num { font-weight: 600; color: var(--fg); }

.pl-overrides { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.pl-override-row {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 10px; border: 1px solid var(--line); border-radius: var(--r-md);
  background: var(--bg-subtle);
}
.pl-override-line { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--fg); flex-shrink: 0; }
.pl-override-meta { font-family: var(--font-mono); font-size: 11px; color: var(--fg-mute); flex: 1; }
/* .pl-coverage's margin-top:4px assumes a block layout under a card title;
   inside this flex row (align-items:center) that margin would nudge it out
   of vertical center, so zero it and stop it from stretching with .pl-override-meta. */
.pl-override-row .pl-override-coverage { margin-top: 0; flex: 0 0 auto; }
.pl-add-override { margin-top: 8px; }
.pl-override-combo { max-width: 260px; }

/* ── Missing-master-data report panel ── */
.pl-mmd-panel {
  border: 1px solid var(--warn); border-radius: var(--r-lg);
  background: var(--warn-soft); padding: 14px 16px; margin-top: 8px;
}
.pl-mmd-head { display: flex; align-items: center; gap: 10px; }
.pl-mmd-head h4 { margin: 0; flex: 1; font-size: 13px; font-weight: 600; color: var(--fg); }
.pl-mmd-sub { font-size: 12px; color: var(--fg-mute); margin: 6px 0 10px; }
.pl-mmd-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow-y: auto; }
.pl-mmd-row {
  display: flex; align-items: center; gap: 10px; font-size: 12px;
  padding: 4px 8px; border-radius: var(--r-sm); background: var(--bg-elev);
}
.pl-mmd-material { font-family: var(--font-mono); font-weight: 600; color: var(--fg); }
.pl-mmd-count { font-family: var(--font-mono); color: var(--fg-mute); }
.pl-mmd-reason { color: var(--warn); margin-left: auto; font-size: 11px; }
/* N3/scale mandate (CLAUDE.md): the list caps at 20 rows so it never renders
   thousands of rows at 50+ plants — this makes the cap visible instead of
   silently truncating (the sub-text's pairs/orders counts are already the
   FULL total, not the sliced 20, but that alone doesn't say "there's more"). */
.pl-mmd-more { font-family: var(--font-mono); font-size: 11px; color: var(--fg-mute); text-align: center; padding: 6px 0 2px; }

/* ── Column-mapping modal sample table ── */
.pl-mapping-sample { margin-top: 10px; max-height: 160px; overflow: auto; border: 1px solid var(--line); border-radius: var(--r-md); }
.pl-sample-table { width: 100%; border-collapse: collapse; font-family: var(--font-mono); font-size: 11px; }
.pl-sample-table th, .pl-sample-table td { padding: 4px 8px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
.pl-sample-table th { background: var(--bg-strong); color: var(--fg-mute); font-weight: 600; }
```

No `body.dark` overrides needed — every value used is a token that already flips in `body.dark` (confirmed for `--info`/`--info-soft`/`--warn`/`--warn-soft`/`--bg-subtle`/`--bg-elev`/`--bg-strong`/`--line`/`--font-mono`, matching the pattern the existing `.cw-*`/`.cons-*` rules already rely on with zero dark-mode overrides).

- [ ] **Step 2: Verify visually**

Start the app (`uvicorn brain:api --port 8000 --reload`), open Plant → Optimization for a plant with no lists at all, one with a plant-wide color wheel, and toggle dark mode — confirm: 4 cards render, non-color cards show the inert badge, coverage text renders in mono, no layout break in dark mode, and the missing-master-data panel only appears when `unmatched_pairs > 0`.

- [ ] **Step 3: Commit**

```bash
git add web/styles.css
git commit -m "style: add priority-list field card, coverage, and missing-master-data panel styles"
```

---

### Task 14: i18n — new locale keys across all 5 locales

**Files:**
- Modify: `web/locales/en.js`, `web/locales/de.js`, `web/locales/es.js`, `web/locales/fr.js`, `web/locales/pt.js`

**Interfaces:**
- Produces: every key referenced by Tasks 10-12's `Util.t(...)` calls, in all 5 files.

- [ ] **Step 1: Add English keys** (near the existing `ui.constraint_*` block, `web/locales/en.js:500-508`)

```js
  // Stage 2 of docs/scheduling_priority.md — priority-list field labels
  // (shared namespace with Stage 3's Scheduling Constraints tree, Decision 4).
  'constraint.colorWheel':             'Color Wheel',
  'constraint.prt01':                  'Prod. Resource Tool (01)',
  'constraint.prt02':                  'Prod. Resource Tool (02)',
  'constraint.productionVersion':      'Production Version',
  'ui.not_yet_used_in_sequencing':     'Not yet used in sequencing',
  'ui.values_ranked':                  'values ranked',
  'ui.values':                         'values',
  'ui.orders':                         'orders',
  'ui.add_line_override':              'Add line override',
  'ui.drop_to_replace':                'Drop to replace or click to browse',
  'ui.drop_replace_text':              'Drop new file to replace, or click to browse',
  'ui.drop_list_text':                 'Drag a {{field}} list here, or click to browse',
  'ui.drop_list_hint':                 '.xlsx · value column required, rank column optional',
  'ui.missing_master_data_title':      'Missing Master Data',
  'ui.missing_master_data_sub':        '{{pairs}} materials ({{orders}} orders) have no matching Material Plant row — their color/tooling values are blank until this is fixed.',
  'ui.mmd_reason_no_mp_row':           'No Material Plant row',
  'ui.mmd_reason_no_plant_derived':    'Plant could not be derived',
  'ui.mmd_more_rows':                  '+ {{n}} more — export CSV to see all',
  'ui.mapping_modal_title':            'Map columns',
  'ui.mapping_modal_sub':              "We couldn't tell which column holds the value and which holds the rank. Pick them below.",
  'ui.mapping_value_col':              'Value column',
  'ui.mapping_rank_col':               'Rank column (optional — row order used if left blank)',
  'ui.mapping_rank_none':              '— use row order —',
  'ui.unknown_time':                   'unknown',
  'ui.just_now':                       'just now',
  'ui.mins_ago':                       '{{n}}m ago',
  'ui.hours_ago':                      '{{n}}h ago',
  'ui.days_ago':                       '{{n}}d ago',
  'ph.search_values':                  'Search values…',
  'ph.pick_a_line':                    'Pick a line…',
  'btn.preview':                       'Preview',
  'btn.remove':                        'Remove',
  'btn.export_csv':                    'Export CSV',
  'btn.resync_now':                    'Resync Now',
  'btn.cancel':                        'Cancel',
  'btn.upload':                        'Upload',
  'btn.close':                         'Close',
  'btn.yes_delete':                    'Yes, Delete',
  'toast.one_file_at_a_time':          'Drop one file at a time',
  'toast.priority_list_verb':          '{{field}} list {{verb}} for {{plant}}',
  'toast.priority_list_deleted':       '{{field}} list deleted for {{plant}}',
  'toast.resync_done':                 'Resync complete — {{pairs}} materials ({{orders}} orders) still missing master data',
  'toast.resync_failed':               'Resync failed: {{msg}}',
  'modal.remove_priority_list':        'Remove the {{field}} list for {{plant}}?',
  'modal.resync_title':                'Resync order attributes for {{plant}}?',
  'modal.resync_warning':              'This re-stamps color/tooling values from Material Plant data on every matching order — any unsaved edit to an affected order will be discarded on next save. Do this at a quiet moment, not mid-shift.',
  'empty.pl_no_list_for_plant':        'No list uploaded for this plant yet.',
  'empty.pl_no_file':                  'No file on record.',
  'empty.pl_no_matches':               'No values match your search.',
  'ui.select_plant_for_priority_lists': 'Select a plant to manage its priority lists.',
  'toast.export_failed':               'Export failed: {{msg}}',
```

(The two keys above were added during Task 12's fix round — its empty-plant-selected state and CSV-export-failure toast — and are not in the original code snippets earlier in this document. Include them here so this step covers every key Tasks 10-12 actually reference.)

Check each key against existing entries in `en.js` first (`btn.cancel`/`btn.close`/`btn.yes_delete` etc. may already exist elsewhere in the file — grep before adding to avoid duplicate-key lint warnings; only add what's genuinely missing).

- [ ] **Step 2: Translate into de/es/fr/pt**

Add the same key set to `de.js`, `es.js`, `fr.js`, `pt.js`, translating each value (not the keys). Use the existing neighboring entries in each file as the terminology reference (e.g. `de.js`'s existing `ui.constraint_no_wheel` translation for tone/register).

- [ ] **Step 3: Verify**

Run: `npm run lint` (catches syntax errors and duplicate keys across the 5 files).

- [ ] **Step 4: Commit**

```bash
git add web/locales/en.js web/locales/de.js web/locales/es.js web/locales/fr.js web/locales/pt.js
git commit -m "feat: add i18n keys for priority-list field cards, mapping modal, and missing-master-data panel"
```

---

### Task 15: New locale-completeness test (N22)

No precedent exists in the repo for this (confirmed by research — locale files are classic scripts setting a global, not ES modules, so they can't be `import`ed by a Node test; text-based key extraction is the way in).

**Files:**
- Create: `tests/modules/locale-completeness.test.mjs`

**Interfaces:**
- Consumes: `web/locales/{en,de,es,fr,pt}.js` as plain text.

- [ ] **Step 1: Write the test**

```js
// New in Stage 2 of docs/scheduling_priority.md (N22) — no prior locale-
// completeness test existed. Locale files are classic scripts (not ES
// modules), so keys are extracted via regex on the raw source text rather
// than importing them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', '..', 'web', 'locales');
const LOCALES = ['en', 'de', 'es', 'fr', 'pt'];
const KEY_RE = /^\s*'([\w.]+)'\s*:/gm;

function keysOf(locale) {
  const text = readFileSync(join(LOCALES_DIR, `${locale}.js`), 'utf8');
  const keys = new Set();
  let m;
  while ((m = KEY_RE.exec(text))) keys.add(m[1]);
  return keys;
}

test('every constraint.<field> key exists in all 5 locales', () => {
  const REQUIRED = ['constraint.colorWheel', 'constraint.prt01', 'constraint.prt02', 'constraint.productionVersion'];
  const perLocale = Object.fromEntries(LOCALES.map(l => [l, keysOf(l)]));
  for (const key of REQUIRED) {
    for (const locale of LOCALES) {
      assert.ok(perLocale[locale].has(key), `${locale}.js is missing key "${key}"`);
    }
  }
});

test('en.js is the superset — no locale has a key en.js lacks', () => {
  const en = keysOf('en');
  for (const locale of LOCALES.filter(l => l !== 'en')) {
    const extra = [...keysOf(locale)].filter(k => !en.has(k));
    assert.deepEqual(extra, [], `${locale}.js has keys not present in en.js: ${extra.join(', ')}`);
  }
});
```

- [ ] **Step 2: Run to verify it fails before Task 14, passes after**

Run: `node --test tests/modules/locale-completeness.test.mjs`
Expected (before Task 14 lands): FAIL on the `constraint.*` keys. (If Task 14 already landed in this session, this will PASS immediately — in that case, temporarily comment out one key in one locale file, confirm the test catches it, then restore, to prove the test actually works before trusting it green.)

- [ ] **Step 3: Add to the test suite runner**

Confirm `npm run test:modules` (`"node --test \"tests/modules/*.test.mjs\""`) picks this file up automatically via the glob — no config change needed.

- [ ] **Step 4: Commit**

```bash
git add tests/modules/locale-completeness.test.mjs
git commit -m "test: add locale-completeness check for constraint.* keys across all 5 locales"
```

---

### Task 16: Docs — update the stage table, CLAUDE.md/AGENTS.md, MIGRATION.md

**Files:**
- Modify: `docs/scheduling_priority.md` (stage table `:14-20`, status paragraph `:25-31`)
- Modify: `CLAUDE.md` (Data Sources → Priority lists bullet; endpoint count/list)
- Modify: `AGENTS.md` (the same specific bullets that were kept in parallel with `CLAUDE.md` during Stage 1 — do not attempt to fix AGENTS.md's larger pre-existing drift, per the Stage 1 precedent)
- Modify: `docs/MIGRATION.md` (if Task 12's `PriorityListMapping`/`PriorityListViewer` bridge wiring, or the two missing-master-data endpoints sharing a JSON shape, introduce any new debt worth tracking — review R13/R17 for whether this stage widens them)

- [ ] **Step 1: Update `docs/scheduling_priority.md`**

Change the Stage 2 status cell (`:19`) from `Not started` to a real status once Tasks 1-15 land, and add a "Stage 2 status (date)" paragraph mirroring the existing Stage 1 one (`:25-31`) — what's code-complete, what's untested against a live DB, what pre-ship checks (if any) are outstanding (e.g., "verify the mapping modal against a real ambiguous-column file, not just the pytest fixture").

- [ ] **Step 2: Update `CLAUDE.md` and `AGENTS.md`**

In the "Priority lists" bullet under Data Sources, add a sentence noting Stage 2 shipped the generic upload/mapping/coverage/missing-master-data UI, and that `GET /priority-fields` is now the field registry consumed by the frontend (rather than a hardcoded list). Bump the endpoint count and add the 6 new routes (`GET /priority-fields`, `GET /priority-lists`, `POST/GET/DELETE /priority-list/{plant}/{field_key}`, `GET /master-data/{plant}/missing-master-data`) to the endpoints list.

- [ ] **Step 3: Review `docs/MIGRATION.md`**

Re-read the existing "Priority lists generalize color wheels" subsection (added in Stage 1) and add any Stage-2-specific follow-up it doesn't already cover — in particular, note that `PriorityListMapping`/`PriorityListViewer` are new bridge-wired modules (another entry in the CQ-1 compatibility inventory's export lists to keep in sync if a future module reshuffle happens), that the "not yet used in sequencing" badge is scaffolding that must be removed in Stage 3 once the fields actually affect sequencing (a literal find of `pl-inert-badge`/`not_yet_used_in_sequencing` is enough to locate every place it needs to come out), and that **`POST /color-wheel/{plant}` was rewritten (Task 5, Decision 9b) onto the shared `_resolve_priority_list_columns`/`_persist_priority_list` helpers** — record the one behavior change (a color-wheel file with no `ORDER_Y` now succeeds via row-order fallback instead of 400ing) in case any external caller relied on that rejection, and that its audit-log action names (`color_wheel_upload`/`color_wheel_replace`) are now the ONLY route still emitting that naming family — `priority_list_upload`/`priority_list_replace` is standard everywhere else, including color uploaded through the new UI.

- [ ] **Step 4: Commit**

```bash
git add docs/scheduling_priority.md CLAUDE.md AGENTS.md docs/MIGRATION.md
git commit -m "docs: record Stage 2 status and new priority-list endpoints"
```

---

## Cross-cutting verification (run once all tasks land)

- [ ] `npm run build && npm run typecheck` — clean.
- [ ] `npm run lint:errors` — clean.
- [ ] `npm test` (legacy + modules) — clean, including the new `locale-completeness` and `schedule-workbench`/`plant-and-administration` additions.
- [ ] `PG_HOST=localhost NIMBUS_TEST_DB=1 python -m pytest tests/test_priority_lists.py -v` — all Stage 1 + Stage 2 tests pass against local Postgres.
- [ ] Manual smoke test (per `CLAUDE.md`'s standing UI rule — type-checking isn't feature-checking): boot the app, open Plant → Optimization for a plant with zero lists, upload a legacy-shaped color wheel (no mapping step should appear), upload a PRT list with ambiguous headers (mapping modal should appear and complete the upload), add a line override via the combobox, preview a non-color list (generic viewer opens, not `ColorWheelViewer`), preview color (still opens the untouched `ColorWheelViewer`), delete a line override, trigger the missing-master-data panel (upload orders for materials absent from `material_plants`) and confirm CSV export + Resync Now both work, and toggle dark mode across all of the above.
- [ ] Confirm the Scheduling Constraints panel (Plant → System Settings) is byte-for-byte unchanged — still shows exactly one row (`colorWheel`) regardless of how many other fields now have lists uploaded. This is the explicit test of Decision 1.
- [ ] Since Task 5 rewrites `POST /color-wheel/{plant}` (Decision 9b) and nothing in NIMBUS's own frontend calls it anymore post-Task-12, directly `curl`/Postman-test it once against a real `.xlsx` (with and without an `ORDER_Y` column) to confirm the back-compat contract holds for whatever external caller — script, integration, or manual admin habit — might still use it outside the UI.
