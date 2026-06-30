# NIMBUS backend tests

Minimal pytest harness bootstrapped during the master code review to guard the
high-severity data-integrity findings before the DB code is changed.

## Run

```bash
# from the project root, using the app venv
./.venv/Scripts/python.exe -m pytest -q
```

- **No Postgres needed for the pure tests** (`test_make_id.py`) — they always run.
- **DB-integration tests** (`test_data_integrity.py`) are marked `@pytest.mark.pg`
  and **auto-skip** when Postgres is unreachable. To run them, start Postgres and
  ensure `.env` points at a DB with `schema.sql` applied (the `WTG/1006` and
  `HMF/5512` plant seeds are required by the #202 test).

## What's covered

| Finding | File | Current guard | Target (xfail until fixed) |
|---------|------|---------------|----------------------------|
| #202 cross-plant attribution | `test_data_integrity.py::TestCrossPlantAttribution_202` | reattribute picks lexically-lowest plant | ambiguous shared line code stays NULL + warn |
| #211 cascade preview | `…::TestCascadePreviewMaterials_211` | `materials` preview omits `material_plants` | preview reports `material_plants` count |
| #203 bulk-update contract | `…::TestBulkUpdateContract_203` | happy-path + inverted-range rejection | lost-rows-as-failed (needs concurrency harness) |
| #202 root cause | `test_make_id.py` | `make_id` is plant-blind (collision) | (flip when `make_id` gains a plant arg) |

When a fix lands: remove the matching `test_current_*` guard and drop the `xfail`
marker on the `test_desired_*` test so it becomes a hard assertion.
