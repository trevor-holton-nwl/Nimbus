# Alert Profiles — plant-shared alert profiles and acknowledgements

Backend half of the Alert Monitor (spec: `docs/superpowers/specs/2026-10-20-alert-monitor-design.md`). Frontend half: `frontend/alert-monitor/`.

## What lives here

- `data.py` — persistence + validation (no FastAPI imports): `list/get/create/update/delete_alert_profile`, `list_alert_acks`, `upsert_alert_ack`, `upsert_alert_acks` (bulk, one transaction), `delete_alert_ack`, `validate_rules`, `validate_ranking`, `ensure_alert_profile_tables()` (called from the `brain.py` lifespan). `DuplicateName` subclasses `ValueError` — catch it first.
- `routes.py` — HTTP only: plant scope, auth, creator/admin checks, status-code mapping. No SQL.

## Tables (both per-plant; mirrored in `migrations/2026-10-20-2-alert-profiles.sql` and `schema.sql`)

- `alert_profile(id, plant, name, description, rules JSONB array, ranking, created_by, updated_by, created_at, updated_at)`, `UNIQUE (plant, name)`. `ranking` is one of `impact|time|severity|orders`; the Alert Monitor editor no longer shows it (it sends `impact` for new profiles and passes an existing value through unchanged), so the column and the API field are kept and the page reads `time` as its default Date sort.
- `alert_ack(plant, alert_id, acknowledged_by, reason, until, created_at)`, PK `(plant, alert_id)`.
- Writes append `admin_audit` rows (`alert_profile` create/update/delete, `alert_ack` ack/unack) in the same transaction; a bulk acknowledge (`upsert_alert_acks`, `POST /alert-acks/bulk`) writes one `ack` row for the whole batch (the de-duplicated count and the first 50 ids).

## Routes and auth

Every route does the plant check (`md._assert_plant_allowed`; `PlantNotAllowed` -> 403, missing plant -> 400). Writes also need `auth.require_authenticated`; the signed-in email it returns is the actor.

| Route | Result |
|---|---|
| `GET /alert-profiles?plant=` | `{plant, profiles}` |
| `POST /alert-profiles` `{plant, name, description?, rules, ranking?}` | 201 profile; 400 validation; 409 `name_taken` |
| `PUT /alert-profiles/{id}` `{name?, description?, rules?, ranking?, expected_updated_at?}` | profile; 404; 403; 409 `stale` / `name_taken`; 400 if the body has none of the four updatable fields |
| `DELETE /alert-profiles/{id}?plant=` | `{deleted: true, id}`; 404; 403 |
| `GET /alert-acks?plant=` | `{plant, acks}` (active only) |
| `POST /alert-acks` `{plant, alert_id, reason, until?}` | the ack (upsert, so re-acking replaces the previous one) |
| `POST /alert-acks/bulk` `{plant, alert_ids (1-500 strings), reason, until?}` | `{acks, count}` (active acks written; one transaction, one audit row; ids de-duplicated and written sorted; the client chunks groups above 500); 400 empty / >500 / non-string ids / bad reason / bad `until` |
| `DELETE /alert-acks/{plant}/{alert_id}` | `{deleted: bool}`; 403 |

PUT/DELETE check the plant of the **stored** row (the `plant` query param on DELETE is not trusted). Optimistic concurrency: send `expected_updated_at` from the last read; a mismatch is 409 `stale`.

## Permission model

Profiles are shared across a plant; any authenticated user with plant access can read, create and use them. Edit/delete is limited to the creator (`created_by`, case-insensitive) or an admin (`auth.get_user_role(actor) == 'admin'`). Acks follow the same rule against `acknowledged_by`. `until` expiry is enforced by `list_alert_acks` (expired rows are hidden and purged on the next upsert).

## Categories (2026-10-30, Alert Profiles revamp W3)

`alert_profile.categories JSONB NULL` (`CHECK jsonb_typeof = 'object'`; `migrations/2026-10-30-2-alert-profile-categories.sql`, mirrored in `schema.sql` and the `ensure_alert_profile_tables` bootstrap). NULL = a legacy profile: the frontend derives each group from its rules. When present it is a complete map of the seven groups, each `{on: bool, color: <PALETTE name>}`, at least one on (`validate_categories`; `CATEGORIES` / `PALETTE` frozensets mirror `ALERT_CATEGORY_ORDER` / `PALETTE` in `frontend/insights/alert-profiles.mts`, pinned by `tests/test_alert_profile_categories.py`). With `categories`, `rules` may be `[]` (`validate_rules(allow_empty=True)`); without, one rule is still required. Matching rule (frontend): group switch on AND (no rule applies to the group OR some applicable rule matches); rules only narrow.

`alert_profile.gantt_colors BOOLEAN NOT NULL DEFAULT TRUE` ("Colour the Gantt": the profile fills its matched bars on the Gantt and minimap; `migrations/2026-11-01-1-alert-profile-gantt-colors.sql`, mirrored in `schema.sql` and the bootstrap; `validate_gantt_colors` accepts a real bool only; `POST` defaults it to true, `PUT` keeps the stored value when the field is absent; `_PROFILE_COLS` index 11). Rollback: the previous image ignores the column. Deploy: `promote-azure -Only 2026-11-01-1 -AllowDestructive` after a dry run.

`PUT` semantics: `categories` omitted keeps the stored map; an explicit `null` reverts to derived (the merged row must then have at least one rule, checked after `FOR UPDATE`; `_UNSET` sentinel in `update_alert_profile`); a map replaces it. `POST`/`PUT` bodies and responses carry `categories`. Rollback hazard: rows saved with `rules: []` match nothing on the previous image. Deploy: `promote-azure -Only 2026-10-30-2 -AllowDestructive` after a dry run.

## Rule schema

`rules` is a non-empty list (max 20; may be empty when `categories` is present) of `{types: string[]|null, dayFrom: int|null, dayTo: int|null, minSev: null|'warn'|'err', minLateHours: number|null}`. `types` are alert-type names from `ALERT_TYPES` in `data.py` (mirrors the `AlertType` union minus never-firing types); day offsets are within +/-365 and `dayFrom <= dayTo`. Alerts matching any rule are in the profile. Name: 1-60 chars after trim.

## Conventions and hazards

- **Naive local time.** `alert_ack.until` and all `*_at` columns are `TIMESTAMP` (no zone). `until` crosses the API as a naive ISO string (or null = no expiry) interpreted as the **plant's own local wall clock**: `list_alert_acks` and the purge in `upsert_alert_ack` compare it with `NOW() AT TIME ZONE <plants.timezone>` (blank or unset zone falls back to UTC), not the DB session zone. Never send an offset or `Z`.
- Ack `reason` is required, trimmed, at most 200 characters (enforced in the route).
- Never fetch profiles/acks for more than one plant per request.

## Tests

`tests/test_alert_profiles.py` (routes, no DB: standalone app + `dependency_overrides` + monkeypatched data functions) and `tests/test_alert_profiles_data.py` (data layer; `pg` tests need `NIMBUS_TEST_DB=1` and a local Postgres).

**`queued_now_fits` (2026-10-23).** `ALERT_TYPES` gained `queued_now_fits` (a frontend-produced alert, in the `planning` category since 2026-10-26 and in `exceptions` before that, see `frontend/insights/CLAUDE.md`); keep it in step with the `AlertType` union and `ALERT_CATEGORIES`.

**`needs_planning` (2026-10-26).** `ALERT_TYPES` gained `needs_planning` (one frontend-produced alert per queued order, category `planning`, see `frontend/insights/CLAUDE.md`; the Alert Monitor's "Slot…" action in `frontend/alert-monitor/CLAUDE.md`). No migration and no new route: the whitelist is all this domain needed, so an explicit-type rule that ticks it now validates. The tests are `tests/test_alert_profiles_data.py::test_alert_types_exclude_never_firing`, which asserts both queued types are present.
