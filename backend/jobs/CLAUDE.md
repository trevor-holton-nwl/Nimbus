# Jobs — scheduled job definitions, schedules, runs and run logs

Plan: `C:\Users\PJ29587\.claude\plans\what-needs-to-be-squishy-sketch.md` (owner decisions 2026-10-28: auto-apply is an admin opt-in per job, admins create/edit, default 8am Exhaustive). Named `jobs` so it is not confused with the Gantt `backend/scheduling/`. The Admin > Jobs tab lives in `frontend/admin-ops/`; the headless engine in `frontend/optimization/headless-*.mts`.

## What lives here

- `triggers.py` — **pure** (stdlib + APScheduler). `validate_schedule(row)` normalises a payload (presets compile to cron, times become naive plant-local); `build_trigger(row)` is the ONE place a row becomes a trigger; `next_fire_times` / `preview` use that same trigger, so the UI preview cannot disagree with what fires. `PlantCronTrigger` fixes stock APScheduler DST behaviour on zoneinfo (gap time 02:30 -> 03:30 EDT, ambiguous 01:30 fires once). Numeric cron day-of-week is translated from standard cron (0/7 = Sunday) to names because APScheduler numbers Monday as 0.
- `context.py` — **pure** `JobContext`: `ctx.log(level, msg, step=, **data)`, `with ctx.step(name)`, `ctx.cancelled/check_cancel()/sleep()`. Caps: msg 2 KB, data 8 KB (replaced by a `_truncated` preview), 2000 lines per run (line 2000 is a warn marker, `truncated` flag -> `job_run.log_truncated`). Rows flush to an injected sink (DB in production) every 0.5 s; warn/error also go to `_BACKEND_LOG` via the mirror.
- `registry.py` — `JobType(key, label, params_model, run, plant_scoped, default_timeout_s, timeout_fn, lock_key, stub)`, `JobOutcome(status, summary, error)`. Stub types are hidden from `GET /jobs/types` and refused by `POST /jobs` unless `NIMBUS_JOBS_STUBS=1`.
- `types/noop.py` (stub, logs steps, cancellable) and `types/optimizer.py` (`optimizer.plant`, params `mode` due_date|min_changeover|spt, `search` normal|exhaustive default exhaustive, `respect_firmed`, `apply_mode` propose|apply). **The runner plugs into the seam `optimizer.set_runner(fn)`**, `fn(ctx, plant, params) -> dict` (optional keys late, changeovers, moved, applied, dropped, action_id, warnings, steps, proposal, status='failed'); `scheduler.install` wires `optimizer_runner.run_optimizer`. Unwired (tests, tools), a run fails with a clear message. `apply_mode` defaults to `apply` (owner ruling 2026-10-28 W1, reversing the earlier Propose default); `propose` is a dry run. The optimizer type sets `needs_plant_timezone` (a schedule for a plant with no timezone is a 400, a job without a schedule is fine) and `defer_clock`.
- `data.py` — `JOB_DDL`, `ensure_job_tables()` (lifespan boot hook), queries, `boot_sweep()`, `sweep_job_runs()`, session advisory-lock helpers.
- `runner.py` — `run_job`, `start_manual_run`, `fire_schedule`, `record_skipped`, `cancel_run`, `cancel_all`.
- `scheduler.py` — `install(scheduler)` (called in the `brain.py` lifespan before `scheduler.start()`), `reconcile`, the 60 s tick.
- `routes.py` — the HTTP surface (below).

## Tables (`migrations/2026-10-29-1-job-scheduler.sql`, `schema.sql` mirror, `JOB_DDL`, pinned verbatim by `tests/test_jobs.py`)

`job_definition` (plant, job_type, name, params JSONB, enabled, archived, retry_max 0-5, timeout_s), `job_schedule` (kind once|hourly|daily|weekdays|weekly|monthly|cron, cron_expr compiled, time_of_day, days_of_week 0=Mon..6=Sun, day_of_month, run_at, timezone, valid_from/until, paused, retired, misfire_grace_s, skip_if_running), `job_run` (status, trigger schedule|manual|retry, attempt, scheduled_for/started_at/ended_at, triggered_by, summary JSONB, error, log_truncated, cancel_requested), `job_run_log` (PK run_id+seq, level, step, msg, duration_ms, data).
- **No `ON DELETE CASCADE` and no destructive keyword anywhere in the migration text, comments included** (the deploy runner's regex, see `backend/schedule_events/CLAUDE.md`). Say "sweep", "remove", "archive", "modified_at".
- Removing a job = `PATCH {archived: true}`; removing a schedule = `PATCH {retired: true}` (history keeps pointing at them). Nothing is ever deleted except by the retention sweep.
- `plant`/`job_type` on `job_run` are copied at run time so history survives edits. No FK to `plants`.
- `timezone` on a schedule is copied from `plants.timezone` (UTC when empty) at every timing save; a later plant timezone change does not re-arm existing schedules until they are saved again.

## Lifecycle and invariants

- `scheduled -> running -> succeeded | warning | failed | cancelled`, plus `skipped` (overlap, misfire). `finish_run` only moves a row still `scheduled|running`.
- **Scheduling**: DB is the source of truth, no `SQLAlchemyJobStore`. One APScheduler job per active schedule `job:<schedule_id>` (`max_instances=1`, `coalesce=True`, `misfire_grace_time=misfire_grace_s`). `reconcile` adds/replaces (by a row signature)/removes every 60 s; an exhausted trigger is never added (it would be added paused). A missed fire (EVENT_JOB_MISSED) records a `skipped` run.
- A `once` schedule is retired when it fires or misfires; reconcile never re-arms one that has a run.
- **Overlap**: per (job type, plant) SESSION advisory lock (`jobs:<type>:<plant>`, pattern from `sap_staging.poll_once`) held on a pooled connection for the whole run. Taken by someone else -> a recorded `skipped` run ("previous run still running"); `skip_if_running=false` queues behind it instead.
- **Concurrency** 2 (`runner.MAX_CONCURRENCY`, a semaphore). **Hard timeout**: job `timeout_s` or the type's (`optimizer`: Normal 120 s, Exhaustive 600 s = search budget + 60 s, remeasure at W6); the body runs in an inner thread, on expiry the cancel event is set, a body that ignores it for 10 s is abandoned and the run is `failed: timed out after Ns`.
- **Cancel**: `POST /jobs/runs/{id}/cancel` sets the in-process event and `cancel_requested`; the supervisor also polls the DB flag every 2 s. A `scheduled` run cancelled before start becomes `cancelled`.
- **Boot sweep** marks leftover `scheduled|running` rows `failed: interrupted by restart` (single-replica assumption). Fires that happen while the process is down are NOT recorded (APScheduler memory store); only misfires inside a live process are.
- **Retry**: fixed policy only: after a `failed` attempt with `attempt <= retry_max`, wait 30 s and run again as a new `retry` row. Backoff is deferred.
- **Retention**: `system_settings.job_run_retention_days` (`md.get_job_run_retention_days`, clamped 1-60, default 14; `POST /system-settings` rejects anything else with 400). `sweep_job_runs` removes log lines by `run_id` then the run rows, in chunks of 500 runs under an advisory xact lock, never touching `scheduled|running`; daily job `nimbus:job-run-sweep` plus a +90 s boot one-shot. Result in `DIAGNOSTICS["job_run_last_sweep"]`.

## Route contract

Writes: `require_api_key` + `require_admin` + plant scope (`get_allowed_plants_for_request`, 403 outside). Reads: `require_authenticated` + plant scope; all read responses are `Cache-Control: no-store`. Write routes are in `brain._ADMIN_WRITE_OPERATIONS` (`jobs.create|update|schedule_create|schedule_update|run_now|run_cancel`) and audited for non-GET only.

| Route | Request | Response |
|---|---|---|
| `GET /jobs/types` | | `{types:[{key,label,plant_scoped,default_timeout_s,stub,params_schema,defaults}]}` |
| `GET /jobs?plant&job_type&status&q&include_archived&limit(1-200)&before_id` | | `{jobs:[Job], next_before_id}`; `status` filters on the LAST run's status |
| `POST /jobs` | `{plant, job_type, name, params?, enabled?, retry_max?, timeout_s?, schedules?:[ScheduleIn]}` | `Job` |
| `PATCH /jobs/{id}` | any of `{name, params, enabled, archived, retry_max, timeout_s}` | `Job` |
| `POST /jobs/{id}/schedules` | `ScheduleIn` | `Schedule` |
| `PATCH /jobs/schedules/{id}` | any ScheduleIn timing field plus `paused, retired, misfire_grace_s, skip_if_running`; a changed `kind` starts clean | `Schedule` |
| `POST /jobs/schedules/preview` | `ScheduleIn + {plant, n(1-20)}` | `{timezone, cron_expr, entries:[{at_utc, at_local, dst_shifted}]}` |
| `GET /jobs/{id}/upcoming?n` | | `{job_id, entries:[{at_utc, at_local, dst_shifted, job_id, job_name, plant, schedule_id, timezone}]}` |
| `GET /jobs/upcoming?plant&n` (extra, not in the plan) | | `{entries:[same]}` soonest first across visible jobs |
| `POST /jobs/{id}/run` | | `{run: Run}` (status `scheduled`, runs on a background thread) |
| `POST /jobs/runs/{id}/cancel` | | `{run: Run}`; 409 when already finished |
| `GET /jobs/runs?plant&job_id&job_type&status&periodicity&scheduled_by&since_hours(1-168)&limit&before_id` | `status` also accepts the synthetic `missed` (skipped runs recorded for a misfire); `periodicity` = schedule kind or `manual`; `scheduled_by` = `triggered_by` | `{runs:[Run], next_before_id}` |
| `GET /jobs/runs/{id}` (extra) | | `{run: Run}` |
| `GET /jobs/summary?plant` (W1) | | `{running, queued, failed_24h, failed_config_24h, failed_system_24h, failed_transient_24h, missed_24h, warning_24h, next_fire:{at_utc,at_local,job_id,job_name,plant}\|null, scheduler:{ok,last_tick_at}, longer_than_usual:[run ids]}` |
| `GET /jobs/runs/{id}/proposal` (W1) | dry-run runs only (400 otherwise) | `{run_id, plant, total, shown, rows:[{id,machine,finish_before,finish_after,delta_hours,status,changed_since}], findings, board_matches\|null, truncated, pending}` (`pending: true` while the dry run is scheduled/running) |
| `POST /jobs/runs/{id}/restart` (W1) | admin | `{run: Run}` (a new manual run of the same job); 409 archived or a run is active |
| `GET /jobs/runs/{id}/log?after_seq&level(min: debug\|info\|warn\|error)&limit(1-2000)` | | `{run_id, status, log_truncated, done, lines:[{seq,at,level,step,msg,duration_ms,data}], last_seq}` |

`ScheduleIn`: `{kind, time_of_day "HH:MM", days_of_week [0=Mon..6=Sun], day_of_month, cron_expr, run_at (naive plant-local ISO), valid_from, valid_until, paused, misfire_grace_s (1-86400, 300), skip_if_running (true)}`. The timezone is never accepted; it comes from the plant. `once` in the past is a 400.
`Job`: `{id, plant, job_type, name, params, enabled, archived, retry_max, timeout_s, created_by/at, modified_by/at, schedules:[Schedule], next_run_at (UTC ISO|null), next_run_local, last_run: Run|null}`.
`Run`: `{id, job_id, job_name, plant, job_type, schedule_id, status, trigger, attempt, scheduled_for, started_at, ended_at, duration_ms, triggered_by, summary, error, log_truncated, cancel_requested}`.
Poll the log with `after_seq=last_seq` until `done`.

## W1 run status (2026-10-28)

- **SAP-style semantics (owner 2026-10-28)**: no approval inbox; jobs are admin-only; **`apply_mode` now defaults to `apply`** (API and dialog). `propose` is kept as a **dry run**: its proposal is viewable (`GET /jobs/runs/{id}/proposal`) and there is no approve or discard route. The stored proposal now carries `snapshot_version` so the route can say whether the board still matches.
- **Failure classification**: a failed run's `summary` carries `error_kind` (`config` = fix the job or its inputs: bad params, plant without a timezone, blocked or refused apply, inputs changed; `system` = timeout, interrupted by restart, crash, DB) and `failed_step` and `steps`. `optimizer_runner._fail(kind=, step=)` sets them for the optimizer; `runner._describe_failure` fills the rest (default `system`; `failed_step` from `ctx.failed_step` / `ctx.last_error_step`; `steps` from `ctx.step_timings`); the boot sweep writes `system`.
- **Heartbeat**: `scheduler.record_tick()` runs after the install reconcile and each 60 s tick; `scheduler.heartbeat()` is `ok` while the last tick is under 180 s old (in-process, cleared by a restart). **Missed** = a `skipped` run whose error starts `missed:`; a fire expected but never recorded (process down) is still not detectable. **Longer than usual** = a running run past max(2x median of the job's last 10 succeeded/warning runs, 5 min), only with >= 3 such runs (`data.longer_than_usual`).
- The proposal rows join `db.get_task_versions` (machine, live finish, status, `row_version` vs the patch's `base_version` -> `changed_since`); "finish before" is the LIVE finish now, rows sorted by |delta| and capped at 200 with the full `total`. Restart is audited as `jobs.run_restart`.

## Fix-wave behaviour (2026-10-29)

- `scheduler.install` and `boot_sweep` never raise into `brain.py`'s scheduler `try` (a failure is a logged event; the SAP and sweep jobs still start). Scheduled fires run on their own bounded pool (`scheduler._FIRE_POOL`, 6 workers), not the shared anyio threadpool the UI API uses; surplus fires queue there. A fire for a plant that no longer exists records a `skipped` run and disables the job.
- **Timeout clock**: a job type with `defer_clock` (the optimizer) starts the hard-timeout clock at `ctx.begin_work()`, called once the optimizer slot is held, so queueing behind another plant never eats the run's time (cancel still works while waiting). Other types start it at once.
- A retry re-reads the job: archived, disabled or removed stops the chain; edited params are used. `POST /jobs/{id}/run` is a 409 while a `scheduled|running` run of that job exists. `cancel_all` (shutdown) also kills live child processes (`optimizer_runner.kill_children`).
- **Child limits**: stdout over 64 MB and a stderr line over 64 KB are cut (the child is killed on the first); child log keys that collide with `ctx.log` parameters are dropped; the stored proposal is measured as a whole object against 256 KB.
- **Apply phase clock**: the live board is read at the LIVE bundle's `server_now` (`params.liveServerNow`), the run snapshot at the run's. A started-since order is dropped as `running`. `tz_mismatch` (the child's resolved zone is not the plant's) fails the run and the apply; apply also answers `plant_no_timezone` and `inputs_changed:<part>`.
- **What guards what at apply**: `calendar_version` (from `db.plant_calendar_version`) covers ONLY the calendar tables (plant hours, periods, machine calendars, plant and machine blackouts) plus the plant's default week and timezone. The apply phase additionally compares, between the run's and the live snapshot, this plant's `plants` row, machine / work-center / tool-inventory master rows, own-hours line calendars and both blackout lists (`plantInputsDiff`, refusal `inputs_changed:master_data|plant_calendar|line_calendars|blackouts|plant_blackouts`); priority lists, setup truth and tool inventory are in `snapshot_version`. Per-order changes are the `row_version` drop; a distribution family is every order sharing PARENT_ORDER + MATERIAL_NUMBER in either bundle, and one changed, missing or running member drops every patched member.
- The snapshot token is read before the wire is built and again after (one retry); the token read before the final build is kept.
- Tests: `tests/test_jobs_runner_unit.py` (no DB), `tests/test_jobs_optimizer_runner.py`, `tests/test_jobs_contract.py`; JS `tests/modules/optimization/headless-guards.test.mjs` (live clock, tz_mismatch, a child process in America/Chicago across the 2035-11-04 fall-back, input drift, families, helper drift check).

## W1 fix wave (2026-10-29, branch `w1-fixes`)

- **Summary**: `GET /jobs/summary` no longer loads run summaries or the newest 200 jobs. `data.run_health` is one aggregate query (cached 5 s per plant scope, cleared by every in-process run write; partial indexes `idx_job_run_ended` / `idx_job_run_active` from `JOB_INDEX_DDL`, run by `ensure_job_tables` and mirrored at the end of `schema.sql`, kept OUT of `JOB_DDL` and the migration file which tests pin verbatim) and `data.next_fire_schedules` (armed schedules in the visible plants, minimum next fire over all of them). `GET /jobs/upcoming` uses the same query. New fields: `failed_config_24h`, `failed_system_24h`, `failed_transient_24h`.
- **Slot wait**: an optimizer run (`defer_clock`) is marked `summary.waiting_for = 'slot'` by `mark_running`; it counts as **Queued** (not Running) in the summary and is left out of `longer_than_usual`. `ctx.begin_work()` (slot held) fires `data.mark_work_started`, which clears the marker and resets `started_at`, so elapsed, `duration_ms` and the duration medians measure from work start.
- **Failure kinds**: `error_kind` is `config | system | transient`. `transient` ("Board changed, run again") = snapshot or inputs changed since the run / while applying, a calendar or tool-inventory refusal, a refused write. Every failure also logs an error line (`optimizer_runner._fail` logs at error level with `step=`; `runner` writes one for a pre-validation failure and, as a fallback, whenever a failed run logged none), so Errors-only, First error and Copy errors always have a line.
- **PATCH /jobs/{id}** merges incoming `params` over the stored params before validating (a partial body keeps `apply_mode: propose`).
- **Proposal**: stored patches carry `delta_hours` (proposed minus the run snapshot's finish); the route sorts by it, reads live rows only for the first 200, puts changed-since rows last and caches `board_matches` 60 s per run. A scheduled/running dry run answers `200 {pending: true, rows: [], total: 0}`; every proposal body now has `pending`. 400 stays for runs that are not dry runs.
- **Restart / run now**: `start_manual_run` inserts under a per-job advisory xact lock with `INSERT ... WHERE NOT EXISTS` and returns `None` (route: 409) when a run is active. The UI confirm names the job's CURRENT mode: a restart runs the job with its current params, not the old run's.
- `GET /jobs/runs` also filters by `job_type`. The `missed:` SQL is built from `data.MISSED_PREFIX`.

## Known limitations (accepted for the pilot)

- **Periodicity filter** uses the schedule's CURRENT kind (a schedule edited from daily to weekly moves its old runs to Weekly).
- **Missed** counts recorded misfires only; fires lost to downtime need W3's persisted `last_fire_at` / catch-up.
- **Heartbeat** reflects the reconcile tick, not each job's own firing.
- **Pre/post KPIs** (late count before and after) are deferred.

- **Boot sweep ownership during a rolling revision**: `boot_sweep` marks every `scheduled|running` row `failed: interrupted by restart`. While the old and new revision overlap, the new one can fail the old one's live runs (the old body keeps running and its `finish_run` is then a no-op). Safe only because the pilot is single-replica; a lease/heartbeat column is the fix.
- **Hourly preset on the fall-back day**: the DST-aware trigger fires an `hourly` job once per wall-clock hour, so the repeated 01:xx hour fires once and that day has one slot fewer than 24. Daily and weekly presets are unaffected.
- A body that ignores cancel past the 10 s grace is abandoned: the run is `failed`, the advisory lock and run slot are released, and the abandoned thread may still finish (the optimizer's write phase checks `ctx.cancelled` right before the write, so a timed-out run cannot write after the timeout; a write already started is not interrupted).

## Deferred (v1 cut)

Templates catalogue, chains, notifications/SLA alerts, backoff beyond the fixed retry, holiday/closed-day skips, cancel mid-run for non-cooperative job types, log streaming, concurrency above 2, migrating the existing lifespan jobs (SAP, staging poll, event sweep) onto this registry, machine-level scope, Plan B/C alternates, recording fires missed while the process was down, multi-replica coordination (boot sweep and the in-process cancel registry assume one replica).

## Imports in / Imported by

**Imports in:** `db`, `master_data as md`, `backend.admin_ops.{diagnostics_state,logbuffer}`, `backend.security.auth`, APScheduler, pydantic. `triggers`, `context`, `registry` import no project code.
**Imported by:** `brain.py` (`ensure_job_tables`, `jobs_scheduler.install`, `jobs_runner.cancel_all` on shutdown, `include_router`).

## Tests

`python -m pytest tests/test_jobs.py tests/test_schema_idempotent.py -q` — pure tests (DDL pins, presets, DST, log caps, registry, outcome mapping) run anywhere; `@pytest.mark.pg` tests (routes, lifecycle, overlap, timeout, boot sweep, misfire, reconcile, retention sweep, RBAC) need local Postgres with `NIMBUS_TEST_DB=1`.

## Optimizer runner (`types/optimizer_runner.py`)

- **Bundle**: `gather_bundle(plant)` builds the `HeadlessWire` in-process (`build_tasks_payload` validated through `_TASKS_ADAPTER` as the wire `/tasks`, `md.load_plant_calendar` + `calendar_version`, `setup_data.get_setup_snapshot` + `plant_active`, `plcache.PLANT_LISTS`, `md.list_rows` plants / machine / sap_workcenter / tool_inventory, `db.plant_horizons` version tokens) plus `server_now` and `sched.optimizer_snapshot_version(plant)` (also served as `GET /optimizer/snapshot-version?plant=`: sha1 over priority lists, setup, calendar and tool inventory versions).
- **Child**: `node [--max-old-space-size=NIMBUS_OPTIMIZER_NODE_MB, 1536] headless-cli.mjs --phase run|apply --input -`, env `TZ=<plant timezone>` plus PATH/SYSTEMROOT/TEMP only (never the DB credentials), JSON on stdin/stdout, stderr JSON lines mirrored into `ctx.log` (a line with `ms` also feeds `summary.steps`). Hard timeout = search budget (Normal 8 s, Exhaustive 180 s) + 60 s; killed on timeout and on `ctx.cancelled`. Env knobs: `NIMBUS_NODE_BIN`, `NIMBUS_HEADLESS_CLI`, `NIMBUS_OPTIMIZER_CONCURRENCY` (1-2, default 1, a process semaphore on top of `runner.MAX_CONCURRENCY`).
- **Propose**: patches, `base_versions` and up to 50 findings go on `summary.proposal` (over 256 KB: counts only, `proposal_truncated`); blockers make it a `warning`.
- **Apply**: blockers or error findings fail the run; fresh bundle; a changed snapshot token fails it; `--phase apply` drops changed-`row_version` families (`warning` and a `dropped` list in the log), refuses on calendar / tool inventory change; the token is checked again right before the write; the write is `sched._apply_task_date_updates(..., atomic_optimizer, strict_conflicts, actor 'job:<id>', client_id 'job:<id>', ev=EventCtx(source 'optimizer'))`, never forced, so a stale or conflicting row rolls the whole batch back and the run fails. `summary.action_id` links to the Inspector history.
- Summary keys: late, moved (patches proposed), applied, dropped, setup_minutes, search_complete, termination, tool_blocked, steps, warnings, action_id (`changeovers` is not reported). Tests: `tests/test_jobs_optimizer_runner.py` (fake node script; one real-node smoke).
