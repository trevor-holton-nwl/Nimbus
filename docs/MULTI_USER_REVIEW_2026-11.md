# Multi-user readiness review, November 2026

Review date: 2026-11-05. Document date: 2026-11-06. Target: 30-40 planners using NIMBUS at the same time.

Status: Review only. No changes have been made. Nothing in this document is implemented, merged, pushed or deployed. The owner has read the findings. The waves in section 7 are a proposal, not a commitment.

Method: three Explore audits at high effort (backend concurrency and correctness; frontend multi-user interaction; performance and infrastructure), then three independent verifiers that re-read live code for every High finding. Static reading only. No browser checks, no live Azure queries, no code run.

Finding IDs: `F-` frontend, `B-` backend, `P-` performance. Severity grades are the audit agents' grades, adjusted where a verifier narrowed or confirmed them.

## 1. Executive summary

Steady-state load from 40 users is fine. Saves are one transaction, polling is light (about 30-100 requests a minute in total), indexes exist and there is no N+1 query. What is not ready is multi-user correctness and load waves.

Each item below gives the impact first, then the recommendation.

1. **Nobody is told when someone else changes the plant.**
   - Impact: there is no change feed, poll or presence signal. A planner can work on a stale board for as long as the tab stays open. The only protection is the per-row stale check, and it only covers rows the user edited themselves. A job that auto-applies an optimizer run gives open sessions no notice either.
   - Recommendation: build the change feed (Wave 2). It surfaces other users' changes once they are saved. See section 3 for why unsaved edits are never shown.
   - IDs: F-C1, B-7.1, F-D.

2. **Four client paths can silently overwrite a colleague's work.**
   - Impact: these paths send a current row version next to stale data, so the server accepts the save as if nothing was wrong. They are undo after a conflict refresh, note save, Time Machine restore, and Optimize Apply onto rows another user placed.
   - Recommendation: make the server catch them like a normal stale save (refuse and refresh the row). Because stricter checks make the existing per-row blocking more visible, add field-level merging in the same wave so edits to different fields of one order no longer collide.
   - IDs: F-A1, F-A2, F-A3, F-A4, B-1.2.

3. **Deleted blackouts can come back, and a stale calendar can be pushed.**
   - Impact: any open planner tab can re-create the last deleted plant blackout, and promoting a What-If flushes the whole local calendar over the server's.
   - Recommendation: replace the "empty list means not migrated" guess with a server flag, and flush only what the What-If touched.
   - IDs: F-B1, F-B2.

4. **Server-side bulk writers race planner saves.**
   - Impact: the routing resolver, the tool stamp, the master-data grid save and the HTTP upload, purge and recompute routes can overwrite or undo a planner's save that lands mid-run.
   - Recommendation: lock or guard the rows the resolver writes, take the jobs' per-plant lock on the HTTP bulk routes, and send only changed cells from the master-data grid.
   - IDs: B-1.3, B-1.4, B-2.1, B-3.2.

5. **A shift-start wave of board loads is the first thing that falls over, and the container size is unconfirmed.**
   - Impact: the board load has no cache and no 304, the client gives up at 8 seconds and then retries about every 9 seconds in lockstep, and the full setup matrix is fetched on every load. CPU and memory are not set in the deploy command, so the container is probably at the Azure default.
   - Recommendation: do not upgrade the container now. Cap the optimizer child at 1 GB (free), confirm the real size, read the slow-load log events, and size up the week the 30-40 user rollout starts. Pull the board cache and retry ceiling forward if sizing stays small. See section 5.
   - IDs: P-H1, P-H2, P-H3.

6. **Identity is a spoofable header, and some reads need no identity at all.**
   - Impact: anyone can act as anyone, so every audit actor is advisory. This is known and documented as interim. Three read routes and the plant calendar are reachable with no identity, and the client config route hands out the API key.
   - Recommendation: patch the unauthenticated reads now. Entra remains the real fix.
   - IDs: B-5.1, B-5.2, B-6.1.

7. **A latent version limit will eventually reject every save.**
   - Impact: the save model caps the row version at 2^31, but the underlying transaction counter is unsigned 32-bit. Once the shared Azure server passes 2^31 transactions, every save fails validation.
   - Recommendation: one-line fix now (Wave 0). It is also removed for good by the per-order version counter in section 4.
   - ID: B-1.6.

Capacity verdict from the performance audit: what breaks first is a board-load wave (shift start, post-deploy refresh) on an unsized single container, then an optimizer job at 8 am in the same container, then a mid-shift Excel upload and burstable Postgres credits.

## 2. Reading guide

Section 3 records the owner's decisions. Section 4 is the field-level merging design. Section 5 covers container sizing and cost. Section 6 holds every finding with file:line evidence and verifier verdicts. Section 7 is the proposed fix order. Section 8 is the verification plan. Section 9 is the context and learnings appendix.

## 3. Owner decisions and clarifications (2026-11-05 and 2026-11-06)

| Topic | Decision or clarification |
|---|---|
| Change feed (item 1, F-C1, B-7.1) | The owner wants other users' changes surfaced only once they are SAVED. Confirmed this is inherent: the schedule event log records committed writes only, and unsaved edits never leave a browser. No plan change. |
| Closing the four silent-overwrite gaps (F-A1 to F-A4) | "Close" means the server catches them like a normal stale save: refuse and refresh the row. The notification is a separate piece and comes with the feed. |
| Per-row versioning side effect | The owner raised that per-row versioning means a tiny change (for example a note) blocks a colleague's unrelated save. Agreed this already happens today (B-1.2) and that the four fixes make it stricter. Resolution: add FIELD-LEVEL MERGING to Wave 1, so edits to different fields merge and only same-field collisions are refused. Design in section 4. |
| Items 3, 4, 6, 7 | Calendar resurrection, server bulk writers, the auth interim (patch the unauthenticated reads now; Entra stays the real fix) and the 2^31 version limit are agreed as written. |
| Container sizing (P-H2) | The owner asked about cost and value and is leaning 1 CPU / 2 GB. Recommendation recorded: NO upgrade now. Details in section 5. |
| Burstable tier | Applies to the Postgres server, not the container. Explained in section 5. |
| Status of the work | Review only. No changes are being made for now. |

## 4. Field-level merging design

Purpose: let two planners edit different fields of the same order without either save being refused, and refuse only when both touched the same field.

Analogy the owner drew: SAP change pointers. Agreed, it is the same idea used inward for conflict resolution instead of outward for replication. The existing `schedule_event.changes` JSONB column, shaped `{"field":[before,after]}` (`schema.sql:2265-2285`), is already the change-pointer record.

Steps:

1. **Per-order version counter.** Replace the xmin token with a monotonic `version` column on each order. Record the version on every schedule event row. This also removes the 2^31 limit (B-1.6) for good. Effort: about 2 days. It touches every reader of `row_version` (`db.py:759`, `db.py:1034`, `db.py:1592`), the models and the frontend.
2. **Client tracks dirty fields.** Today the client tracks only dirty row ids (`persistence.mts:257-258`, `_dirtyIds` and `_forceIds`). It must track dirty fields per row and send them. Placement (start, finish, machine, segments) is one logical field. Notes, firm, tool (PRT) and production version are separate fields. Effort: about 1 day.
3. **Server merge rule.** On a stale save, take the union of fields changed in schedule event rows since the client's version.
   - If the sets are disjoint: apply only the client's fields onto the current row, bump the version, and return the merged row.
   - If they overlap: refuse, and return both field sets with actor names.
   Effort: about 2 days, with interleaving tests.
4. **Fail closed.** Schedule event writes are fail-open. If the history does not account for every version step between the client's version and the current one, refuse the merge and fall back to today's behaviour.
5. **UI.** Merged: replace the row and clear its dirty flags. Refused: show a theirs-versus-mine dialog with "re-apply mine". The change feed needs the same dialog (F-C2), so it is built once.

Total: about 1 to 1.5 weeks and one additive migration.

## 5. Sizing and cost

### What is known

- No `--cpu` or `--memory` appears anywhere in the repo (create command, promote-azure skill, no bicep or yaml). The live size is likely the Azure default of 0.5 vCPU and 1 GiB, but this is UNCONFIRMED.
- One uvicorn process serves everything and shares CPU with the optimizer's Node child, which has a default heap of 1536 MB and a hard kill at 68 s or 240 s.
- Replicas are fixed at one, with no autoscale.

### Cost (approximate list prices, from memory, unverified)

The Container Apps consumption plan bills a flat per-second allocation with one pinned replica and no autoscale, so spend cannot run away.

| Size | Approximate monthly cost |
|---|---|
| Default 0.5 CPU / 1 GB | about $40 |
| 1 CPU / 2 GB | about $80 |
| 2 CPU / 4 GB | about $155 |

### Recommendation: no upgrade now

At today's user count there is little value in upgrading. Instead:

1. Cap the optimizer Node child at 1 GB using the existing `NIMBUS_OPTIMIZER_NODE_MB` setting. It is free and removes the only present-day crash risk.
2. Confirm the actual current size: `az containerapp show -g rg-nimbus-dev -n ca-nimbus-dev --query properties.template.containers[0].resources`.
3. Pull the `tasks.timing` slow-load log events from the live app to replace the benchmark figure with real numbers.
4. Bump to 1 CPU / 2 GB the week the 30-40 user rollout starts. Go to 2 CPU only if mornings are still rough.
5. If sizing stays at 1 CPU, pull the board cache and the reconnect retry ceiling forward into Wave 1.

### Risks of NOT upgrading (assuming the default size, unconfirmed)

Today:

- An optimizer child out-of-memory on a big plant kills the whole container. Effects: a restart, the job marked failed, any in-flight save lost. Unsaved edits survive in the browser cache.

At 30-40 users:

- Shift-start pile-up. Board loads queue, clients give up at 8 seconds and retry about every 9 seconds, and boards stay empty for minutes after every morning start or deploy.
- A memory kill at roughly 8-10 concurrent big-plant board loads (an estimate).
- An optimizer run during the shift causes the same memory kill, on a schedule.
- A large Excel upload stalls everyone and can tip memory.
- 40 logins at about 0.5 CPU-seconds of password hashing each is about half a minute of wait for the last person.
- Large responses are gzipped on the main thread and stall saves.

None of these corrupt data, because saves are transactional. Software fixes (cache, 304, retry ceiling, pre-encoding) remove most of the pile-up and retry risk but not the memory ceiling.

### Burstable applies to the database, not the container

The burstable tier applies to the Postgres server (planned as B1ms; the live tier is unconfirmed). When burst credits drain, the server is THROTTLED to its baseline and never billed extra. If this proves real at 40 users, the fix is the General Purpose tier, a flat step up that roughly doubles the database cost line. Both upgrades (container and database) are flat tier changes, and neither can run away.

### Two Azure checks to run

1. Container size: the `az containerapp show` command above.
2. Live Postgres SKU, and the container's health probe path (nothing in the repo configures a probe, see P-M2).

## 6. Full findings

### 6.1 Frontend multi-user interaction

Verifier verdicts:

- A1 CONFIRMED. The snapshot clones `row_version` but `restoreTasks` discards it. `UndoStack.invalidate` has one caller, in the distribution pane only.
- A2 CONFIRMED. The note response has no dates. Adopting the new version is the unsafe step.
- A3 CONFIRMED. No confirm. Only firm, frozen, running, parented and exception rows are skipped.
- A4 PARTIAL. The atomic apply does require a current `base_version` on every patched row. The real hole is an unpatched row that another user placed on the same machine, which A's Store never pulled in.
- B1 CONFIRMED but narrower. It fires only when the deleted block was the plant's LAST plant blackout. The server `INSERT ON CONFLICT DO UPDATE` recreates it under the same id.
- B2 CONFIRMED. `flushPlant` is unconditional, and calendar refresh is suppressed for the whole What-If.
- C1 CONFIRMED by grep.

Silent overwrites (version check passes, data was stale):

- **F-A1 High.** Undo after a conflict refresh overwrites the other user's change. `frontend/platform/store.mts:1405-1419` `restoreTasks` keeps the live `row_version`. A refresh-sourced `bulkUpdate` clears redo only (`store.mts:1436-1466`). Fix direction: invalidate undo entries for refreshed ids.
- **F-A2 High.** Note save adopts the server's new version without a `base_version` check. `frontend/scheduling/orders.mts:2133-2139, 3111-3140`. `backend/scheduling/routes.py:791-806` takes no `base_version` but bumps xmin. A stale row then carries a current version, and the next date edit clobbers the other user's move.
- **F-A3 High.** Time Machine restore rolls the whole plant back over others' work. `frontend/nimbus-intelligence.js:1630-1641, 1858-1895`. Snapshots carry no `row_version`, so patched rows keep the live version and the save passes.
- **F-A4 High.** Browser Optimize Apply has no cross-row guard. `frontend/optimization/optimize-ui.mts:2781-2829` validates against the local Store only. `persistence.mts:2048` sends no `strict_conflicts` (the headless job path does, `headless-writer.mts:70-74`). Double-booked lines are reported only by an after-the-fact toast.

Calendar and blackout overwrites by stale clients:

- **F-B1 High.** Deleted blackouts come back from any open planner tab. `frontend/calendar/calendar-sync.mts:260-265, 367-377` treats an empty server list as "not migrated" and re-posts local blocks on every re-hydration.
- **F-B2 High/Med.** What-If promote flushes the whole stale calendar. `optimize-ui.mts:3601-3624` always calls `CalendarSync.flushPlant`. `calendar-sync.mts:591-643` upserts hours, blackouts and periods from the local Store.

Stale board and conflict UX:

- **F-C1 High.** No refresh signal at all; staleness is unbounded. Only `/tasks/horizons` on Gantt entry or tab visibility (`persistence.mts:995-1063`, `application-shell.mts:2477-2492, 2849-2855`). Fix direction: poll `GET /schedule-events/{plant}/recent?since=` and `POST /tasks/refresh` for non-dirty ids.
- **F-C2 Med.** On conflict the user's edit is discarded, and the toast names no orders or person (`persistence.mts:2232-2241, 2336-2394`, `en.js:173`). A row edited mid-flight stays conflicted and is excluded from all later saves (`persistence.mts:2008-2016`).
- **F-C3 Med/High.** The only "get latest" control (palette Reload Data, `nimbus-intelligence.js:1223`) discards unsaved work with no confirm.
- **F-C4 Med.** One stale row blocks the whole optimizer atomic batch forever; there is no resolve UI (`persistence.mts:2150-2159`).
- **F-C5 Med.** Multi-drag can be partly saved when one companion is stale (`gantt.mts:6123, 6303, 6659`, non-atomic group).

Jobs auto-apply versus planner:

- **F-D Med.** The job write is guarded, but the planner gets no notice. An unsaved edit on a job-moved row is discarded, the rest of the board stays stale, and drags into job-filled slots are accepted with an advisory only.

Admin and master-data edits during live sessions:

- **F-E Med.** The setup snapshot, plant rows and Order Rules, and machine master refresh on plant load only. Calendar and tool refresh only on the horizons probe. The server save path does not check blackouts, calendar, frozen horizon or setup, so a stale engine's placement is accepted. `_restoreNonTaskState` (`persistence.mts:1802-1838`) overlays cached calendars, line settings and plants over server data.

Cache, tabs, shared PCs:

- **F-F Low/Med.** The cache is keyed per user and plant and version-gated (fine). With two tabs on the same plant there is one record and the last writer wins. Tab B never learns of tab A's saves. "Duplicate tab" copies sessionStorage so two tabs share a `client_id` (`persistence.mts:278-293`). The session is cached in localStorage for 12 hours (`session.mts:172-178`), so the next person at a shared browser acts as the previous user.

Identity and presence:

- **F-G Low/Med.** No presence, soft lock or claim. Inspector History (`orders.mts:2220-2246`) is the only place another user's change is visible. The unsaved dialog's "Changed by" shows the current user.

Client performance:

- **F-H Low.** Saves refetch only stale ids (fine). `/tasks` returns the whole plant (about 3.7M characters for plant 1008). Any change feed must use events plus `/tasks/refresh`, never full reloads.

Checked and fine (frontend): every save row carries `base_version`. Dirty flags are cleared only when the live row matches what was sent. Cache restore is version-gated and user-scoped. Headless Jobs apply is fully guarded. Alert profiles and setup have stale guards. The reconnect watcher and version banner never discard edits.

### 6.2 Backend concurrency

Verifier verdicts:

- 1.3 resolver lost update CONFIRMED, scoped to routing-enabled plants. It even clobbers a planner's manual run time (writing `run_time_source='routing'`), and the schedule event before-image comes from the stale in-memory row. The next resolve pass repairs the damage.
- 1.6 `base_version` limit CONFIRMED. There is no `RequestValidationError` handler, so one out-of-range row returns 422 for the whole batch. The client sends `row_version` raw.
- 5.1 header identity CONFIRMED and documented as interim (`auth.py:552-554, 814-816`, `docs/DEPLOYMENT.md:10`, `docs/MIGRATION.md:277, 317`; the Entra plan is MIGRATION.md Workstream 3). Extra: `GET /security/client-config` hands `NIMBUS_API_KEY` to any caller (`backend/security/routes.py:48-57`).
- 5.2 CONFIRMED. `/tasks`, `/tasks/horizons` and `/priority-rank-maps` have only the plant-scope dependency, with no router-level auth and no app-wide auth middleware.
- 1.4 tool stamp CONFIRMED. It also overwrites `color`. Production version is only filled when blank, so that field is safe. It is documented as "master data wins" (R5, `db.py:3342-3347`) but there is no planner warning.
- 4 `PLANT_LISTS` race CONFIRMED but narrow: only a pop or a new-plant insert during iteration raises.
- 7.2 and 7.3 jobs CONFIRMED. Queue-behind needs `skip_if_running=false` to be configured (the default is true). The abandoned `routing.recompute` body checks cancel only before the write.
- 3.2 CONFIRMED. The lock key appears only under `backend/jobs/`. The `order_steps.py:5` docstring claiming every order writer shares it is wrong.

Optimistic concurrency on `/tasks`:

- **B-1.1 Med.** The conflict reply lists ids only (`db.py:1704-1706`, `backend/scheduling/routes.py:725-754`). It carries no server version, actor, source or changed fields, though `schedule_event` has them. Fix: join the latest event into the stale reply.
- **B-1.2 Med.** The version is per row, so unrelated writes all bump xmin and invalidate another planner's pending drag: note (`db.py:2119`), firm, ingest description and quantity, master-data stamp (`db.py:3450`), resolver (`resolver.py:815`). Fix: field-level conflict detection or a schedule-only token.
- **B-1.3 Med/High.** The routing resolver reads orders unlocked (`backend/routing/resolver.py:641-671`). `_write_outcomes_chunk` (`:815-832`) then writes run time and production version with no re-check of machine or production version. `_write_holds_chunk` (`:884-913`) re-checks only that the hold changes something. A planner save landing between read and write is overwritten or pushed into Needs Planning. It runs on every upload, machine or routing master-data edit (`backend/master_data/routes.py:557-565`), distribution write, recompute and job step. Fix: lock the loaded rows, or guard the WHERE on the read values.
- **B-1.4 Med.** `_stamp_run` (`db.py:3448-3464`) overwrites planner-edited PRT_01 and PRT_02 from `material_plants` on each upload and plant-wide resync (`db.py:3563, 3589`), with no version check.
- **B-1.5 Low/Med.** `base_version` is optional on the non-atomic path (`db.py:1524-1528, 1704`), which writes unconditionally. `force=true` is honored by `/tasks/update` and `/task/update` (`routes.py:774`). Fix: require `base_version` and drop force.
- **B-1.6 Med (latent).** The `base_version` model has `le=2**31-1` (`backend/scheduling/models.py:299`) but xmin is unsigned 32-bit. Once the shared Azure server's xid passes 2^31, every save returns 422. Fix: `le=2**32-1`.
- **B-1.7 Low.** Note save has no version check (`db.py:2109-2134`); last writer wins.

Transactions and locking:

- **B-2.1 Med.** The Master Data grid saves the full row (`master_data.py:1343-1347, 1377-1385`, ON CONFLICT DO UPDATE on every column, no version). Two admins editing different cells of one `plants` or `machine` row clobber each other.
- **B-2.2 Med/Low.** Plant-level config has no versioning: plant hours (`master_data.py:3213-3220`), line hours (`:3235-3257`), constraint tree (`:1951-1952`), blackouts and periods (last writer per id; plant blackouts are planner-writable, `backend/calendars/routes.py:112-136`), tool inventory `/bulk`, labor cells, and the `system_settings` top-level key replace (`:2471-2476`).
- **B-2.3 Med/Low.** Writers that lock in scan order can deadlock a multi-row planner save: purge by date (`db.py:2307`), plant-wide stamp (`db.py:3450`), `_write_outcomes_chunk` relying on VALUES order (`resolver.py:802-804`), `reattribute_null_plant_orders` and `backfill_machine_keys` whole-table UPDATEs on every machine grid save (`db.py:923-934, 973-984`; `master_data/routes.py:525-537`), and distribution `_resolve_wc_codes` (`distribution/data.py:4099-4107`).
- **B-2.4 Low/Med.** Distribution resolve does an unlocked read then write, with no `schedule_event` row (`distribution/data.py:4104-4107, 4205-4208`).
- **B-2.5 Low.** The strict-save lock reads machines unlocked before taking advisory locks (`db.py:1213-1223`). Manual saves never take them (accepted).
- **B-2.6 Med.** No `lock_timeout` or `idle_in_transaction_session_timeout` (`db.py:61-72`). The pool is 20 against about 40 threads. Each job pins a connection for its run (`backend/jobs/runner.py:770`), and the SAP poll pins one (`sap_staging.py:1942, 1965`).
- Multi-row planner saves are atomic and id-ordered (fine).

Bulk and ingest versus live edits:

- **B-3.1 Med.** Ingest commits every 500 rows plus separate backfill, stamp, distribution, resolver and audit commits (`db.py:3681, 4433-4539, 4552, 4646, 4711, 4781`). Planners loading mid-upload see a mixed state. There is no "ingest in progress" flag in `/tasks`.
- **B-3.2 Med.** HTTP bulk routes (`/upload`, `/purge`, `/routing/{plant}/recompute`, `/master-data/resync-order-attributes`, SAP poll auto-apply, distribution resolve) do not take the jobs' per-plant lock `jobs:optimizer.plant:<plant>` (`backend/jobs/types/order_steps.py:43-45`). Manual and job bulk work can overlap on one plant.
- **B-3.3 Med.** A SAP or Excel reset or vanish gives an editing planner no live signal (banner deferred, `backend/integration/CLAUDE.md:140`, D35).

Shared in-process state:

- **B-4 Low.** The `PLANT_LISTS` reload may mutate while `_stamp_order_y` iterates (`backend/priority_lists/cache.py:47, 73-92`; `routes.py:187-191, 898`). `_login_failures` is an unlocked read-modify-write and is never evicted (`auth.py:706-736`). `DIAGNOSTICS` leaks other plants' ingest warnings into every `/tasks` meta. `_BACKEND_LOG` is clearable by any admin for all. Everything in this item also breaks on a second replica (see 6.3).

Auth and sessions:

- **B-5.1 High (known, frozen pending Entra).** Identity is the `x-user-email` or `X-User` header (`auth.py:584-603`). There is no server session or token. Anyone can act as anyone, so RBAC and every audit actor are advisory.
- **B-5.2 Med.** Unknown or missing identity gets unrestricted plants (`auth.py:569-571`). `GET /tasks` (`routes.py:344-351`), `GET /tasks/horizons` (`:518-520`) and `GET /priority-rank-maps` (`priority_lists/routes.py:235-260`) lack `require_authenticated`. `GET /plant-calendar` is not plant-scoped (`calendars/routes.py:36-37`).
- **B-5.3 Low/Med.** The login throttle is keyed on `request.client.host` (`security/routes.py:38`). With one proxy IP for everyone, any username can be locked out by a targeted attack.
- Per-user settings merge is atomic (fine).

Audit and attribution:

- **B-6.1 High (same root as 5.1).** Every audit actor is the spoofable header.
- **B-6.2 Low/Med.** No per-order history for distribution resolve machine rewrites, reattribute and backfill, or `restore_vanished_order`. History writes are fail-open.
- **B-6.3 Low.** Job writes are recorded as `job:<id>`, not as the admin who enabled auto-apply.
- **B-6.4 Low.** Calendar and master-data writes read only `x-user-email`; others fall back to `X-User`.

Jobs scheduler:

- **B-7.1 High.** Optimizer auto-apply protects committed rows only (`optimizer_runner.py:381-415`). There is no server signal to open sessions (no apply marker in `/tasks/horizons`; the feed was removed 2026-10-22). Planners' unsaved edits on moved rows are discarded, and edits on unmoved rows commit over the new plan non-strict, producing overlaps. Same issue as F-D and F-C1. Fix: a plant "board epoch" or apply marker in horizons so the client warns or rebases.
- **B-7.2 Med.** `_execute_gated` (`runner.py:766-783`) takes a global `_SEM` slot and a pool connection before waiting up to the full timeout for the per-plant lock. One long optimizer run blocks jobs for all plants.
- **B-7.3 Med.** After timeout plus grace (`runner.py:838-849`) the body thread is abandoned, but plant locks release in `finally` (`:790-792`). An abandoned purge, apply or recompute keeps writing while another job takes the plant.

Checked and fine (backend): the planner save is one transaction with `FOR UPDATE ORDER BY id`, the stale check runs under the lock, strict advisory locks are sorted, the conflict scan runs under a SAVEPOINT, and history is written in the same transaction. Ingest locks per chunk by id and protects running orders. Distribution writes require a header `base_version`. SAP staging is advisory-locked. Setup uses `signature_version` and `expected_token`. Alert profiles use `expected_updated_at`. The last-admin guard is locked. The optimizer job never forces.

### 6.3 Performance and infrastructure

Verifier verdicts:

- H1 PARTIAL. The mechanism is confirmed (8 s abort, no ETag, 304 or cache, no server-side cancellation of abandoned threadpool work). But the "830 ms" figure is the post-fix synthetic benchmark from the 2026-10-22 spec, not a production number. Real timings are in the `tasks.timing` log events. It is worse than claimed: the backoff only covers failed `/health` probes. If `/health` is fine but `/tasks` exceeds 8 s, the watcher resets attempts to 0 and retries about 1 s later, so every stuck client issues a full `/tasks` about every 9 s in lockstep with no escalation.
- H2 CONFIRMED. No `--cpu` or `--memory` anywhere in the repo (create command, promote-azure skill, no bicep or yaml). The Node child heap defaults to 1536 MB with a hard kill at 68 s or 240 s. A single uvicorn process shares CPU with the child.
- H3 PARTIAL. The GZip middleware on the event loop is confirmed (`brain.py:457-464`; a comment there admits it). `/setup/{plant}` is fetched on every board load and reconnect reload (`persistence.mts:920-925, 2519-2540`) and returns the full uncached matrix, contradicting `frontend/setup/CLAUDE.md:23`. Whether FastAPI's final JSON encode runs on the loop could not be verified (Python was not on the verifier's PATH).
- M2 CONFIRMED. An exact `COUNT(*)` over all orders, deliberately unauthenticated. Which path the live ACA probe uses is unknown; nothing in the repo configures one.
- M3 CONFIRMED. 101 `.mjs` files, 4.41 MB raw. Only `app-entry.mjs` carries `?v=`. The rest are bare relative imports revalidated on every load.
- Replica assumption CONFIRMED and documented in `backend/jobs/CLAUDE.md:35, 243, 250`. The `boot_sweep` overlap also bites on every promote, when old and new revisions overlap.

Setup as found:

- One uvicorn worker (`Dockerfile:73`), synchronous psycopg3 in plain `def` handlers (40-slot threadpool).
- Pool min 2, max 20, 10 s wait, 30 s statement timeout, no health check (`db.py:61-82`). Pool exhaustion returns a generic 500 (`db.py:141-152`).
- Replicas min=max=1.
- Container CPU and memory NOT set in the deploy command (`docs/DEPLOYMENT.md:370`). Likely the Azure default of 0.5 vCPU / 1 GiB, unconfirmed.
- Postgres planned as Burstable B1ms (`docs/MIGRATION.md:585`). Live SKU unconfirmed.
- Optimizer child Node heap up to 1536 MB, 180 s (`backend/jobs/types/optimizer_runner.py:29-46`).

Findings:

- **P-H1 High.** Board load (`GET /tasks`) at a load wave costs about 830 ms CPU and 12.6 MB of JSON per 9.5k-row plant (`backend/scheduling/routes.py:344-418`). The 830 ms figure is a benchmark, not a production number (see verdict H1). The client times out at 8 s (`persistence.mts:640`), then the reconnect loop polls `/health` and re-requests `/tasks` (`persistence.mts:1277-1306`), so abandoned work piles up. Fix direction: a per-plant cached gzipped payload keyed on a version token plus 304; jitter and a ceiling on reconnect; more CPU.
- **P-H2 High.** The container is likely undersized: about 100-150 MB peak per board load (estimate) plus an optimizer child up to 1.5 GB on a 1 GiB default means an OOM kill and a full outage. Fix direction as originally proposed: set 2+ vCPU / 4 GiB explicitly, or move the optimizer to a Container Apps Job. The owner's decision for now differs; see sections 3 and 5.
- **P-H3 High.** Large non-`/tasks` responses are JSON-encoded and gzipped on the event loop (`brain.py:464` GZip middleware). The worst is `GET /setup/{plant}` returning the full matrix on every board load (`backend/setup/routes.py:92-106`, `backend/setup/data.py:877-890`; about 50k rows on big plants). It blocks every other request meanwhile. Fix direction: pre-encode in the handler like `/tasks`; trim the setup snapshot.
- **P-M1 Med.** 2-4 extra DB round trips per request for identity and plant checks, each on its own pool connection (`backend/security/auth.py:520-643`). Fix: a per-request or short-TTL cache.
- **P-M2 Med.** `/health` counts all `orders` rows on every call, unauthenticated (`db.py:2494-2507`). It is called every 30 s per admin Overview and by every planner's reconnect loop. Fix: `SELECT 1` plus pool stats; point probes at `/livez`.
- **P-M3 Med.** Static assets are about 6 MB raw (1.2 MB gzipped), gzipped on every request on the event loop. `.mjs` is served `no-cache` without URL versioning (`brain.py:600-605`), giving about 100 conditional requests per reload through six middleware layers. Fix: a build id in module URLs plus immutable caching, and pre-compression.
- **P-M4 Med.** Excel upload reads the whole file before the 50 MB check and before the admin check (`backend/integration/routes.py:43-87`). The pure-Python parse holds the GIL for tens of seconds. Fix: a size cap before the body read, one ingest at a time, run as a job.
- **P-M5 Med.** Optimizer jobs run inside the API process. The bundle gather does a full board build plus 2-4 setup snapshot version checks (`optimizer_runner.py:92-144`, `backend/scheduling/routes.py:541-552`). Each job pins a pool connection for the whole run, including queue wait. Fix: a separate runner and a cheap version token.
- **P-M6 Med.** Burstable Postgres credits drain under board-load waves, diagnostics full scans (`db.py:2549-2573`) and VACUUM (`db.py:2921-2936`). Fix: confirm the SKU and move to GP D2ds or B2s.
- **P-M7 Med.** Admin ADD and DROP COLUMN (`master_data.py:1657, 1708`) and boot DDL (`brain.py:302-338`) take exclusive locks with no `lock_timeout`. Board loads reading `plants` queue behind them. Fix: `SET LOCAL lock_timeout`.
- **P-L1 Low.** Six stacked `@api.middleware("http")` layers on every request, including static (`brain.py:486-670`).
- **P-L2 Low.** Async handlers call blocking `md.plant_exists` on the event loop (`backend/master_data/routes.py:819-828, 906-933`).
- **P-L3 Low.** PBKDF2 with 600k iterations costs about 0.3-0.6 CPU-s per login (`auth.py:33`). A shift-start burst is about 20 CPU-s.
- **P-L4 Low.** Table-browser CSV export holds a pool connection per download, row-per-chunk (`backend/master_data/browser.py:349-390`).
- **P-L5 Low.** No pool connection health check; the first request after an Azure idle drop fails.
- **P-L6 Low.** Client error shipping multiplies traffic during an incident (`foundation.mts:1883-1922`).

Polling at 40 users: steady state is about 30-100 requests a minute in total. No poll hits `/tasks`. Only `/health` (P-M2) is a heavy polled endpoint. A board load is about 15-20 requests, the heavy ones being `/tasks` and `/setup/{plant}`.

Write path is fine: `db.update_task_dates_bulk` (`db.py:1477-2096`) is one transaction, about 10-14 round trips regardless of N, with batched UPDATEs and one `schedule_event` insert.

Cannot scale to 2 replicas today. The blockers are the in-process log ring, priority-list cache, login throttle, CSP limiter, diagnostics counters, optimizer slot lock, job cancel registry, the jobs scheduler arming on every replica, the jobs boot sweep failing the other replica's runs, and the SAP cron having no advisory lock.

Checked and fine (performance): the board query is one statement with no N+1. Indexes are present on orders, segments, `schedule_event` and `job_run`. No connection leaks. Jobs have their own 6-thread pool. Sweeps are chunked with advisory locks. VACUUM is never FULL. `/version` is cached. `/livez` is DB-free.

## 7. Proposed waves

This run is review-only. Nothing is implemented. The waves below are the plan file's proposal, amended with the owner's decisions (field-level merging moved into Wave 1; no container upgrade now).

### Wave 0: trivial and safe (hours)

- B-1.6: `le=2**32-1` in `backend/scheduling/models.py:299`.
- B-5.2: add `require_authenticated` to `GET /tasks`, `/tasks/horizons` and `/priority-rank-maps`; plant-scope `/plant-calendar`; unknown identity gets an empty scope, not none.
- P-H2 (amended): do not resize now. Cap the optimizer Node child at 1 GB with `NIMBUS_OPTIMIZER_NODE_MB`. Confirm the live container size, Postgres SKU and ACA probe path. Pull `tasks.timing` events. See section 5.
- P-M2: `/health` becomes `SELECT 1` plus pool stats; probes move to `/livez`.
- F-A1: `UndoStack.invalidate(ids)` on refresh-sourced `bulkUpdate` in `persistence.mts` `_refreshTasks`.
- F-A2: send `base_version` on `/task/note`; adopt only when the server confirms the match, else refresh the row.
- F-C3: confirm before palette "Reload Data" when `hasPendingWork()`.

### Wave 1: silent-overwrite closures and field-level merging (days to about 1.5 weeks)

- Field-level merging (section 4): per-order `version` counter, client dirty-field tracking, server merge rule, fail-closed fallback, theirs/mine dialog. One additive migration. This resolves B-1.2 and absorbs B-1.6.
- F-A3: store `row_version` in Time Machine snapshots; restore only unchanged rows; confirm dialog.
- F-A4: browser atomic optimizer saves send `strict_conflicts: true`; re-fetch patched lines' rows (`/tasks/refresh`) before Apply.
- F-B1: replace the "empty list means not migrated" heuristic with a server-side migrated flag; never re-post on empty.
- F-B2: `flushPlant` on promote only for slices the What-If touched.
- B-1.3: resolver takes `SELECT ... ORDER BY id FOR UPDATE` on loaded rows, or guards the UPDATE WHERE on the read machine, production version and run time source.
- B-3.2: HTTP upload, purge, recompute and resync take `jobs:optimizer.plant:<plant>`; fix the `order_steps.py:5` docstring.
- B-2.1: master-data grid sends changed cells only, with an `updated_at` or xmin precondition.
- B-1.4: tool stamp skips rows with a planner override flag (or warn in the grid that PRT edits are temporary).
- Conditional pull-forward: if sizing stays at 1 CPU, bring the board cache and reconnect retry ceiling (from Wave 3, P-H1) into this wave.

### Wave 2: the change feed (1-2 weeks)

- F-C1 and B-7.1: the client polls `GET /schedule-events/{plant}/recent?since=` (exists, `backend/schedule_events/routes.py:35-57`) every 15-30 s on the visible tab, ignores its own `client_id`, then calls `POST /tasks/refresh` for non-dirty ids. A banner covers dirty ids ("3 of your unsaved orders were changed by X"). Add a plant `board_epoch` or apply-in-progress marker to `/tasks/horizons` so a job apply or ingest shows as a banner. Ensure every order writer records an event (distribution resolve, reattribute and backfill currently do not, B-6.2). Per the owner, only saved changes are surfaced.
- F-C2: conflict dialog with a mine/theirs list and actor name from the stale reply (B-1.1: join the latest `schedule_event` into the stale response) and "re-apply mine". Shared with the Wave 1 merge dialog.
- F-C4: a resolve path for a stuck atomic batch.

### Wave 3: load-wave hardening (parallel with Wave 2)

- P-H1: per-plant cached gzipped `/tasks` keyed on a data-version token plus ETag and 304; jitter and a ceiling on the reconnect reload; cancel abandoned work via `request.is_disconnected()` checks between stages.
- P-H3: pre-encode `/setup/{plant}` in the handler; trim the board-load snapshot to what the evaluator needs (or lazy-load the matrix).
- P-M3: build id in module URLs (import map or rewrite at build) plus `immutable`; pre-compress at build.
- P-M1: per-request identity cache. B-2.6: `lock_timeout` of about 5 s. P-M7: `SET LOCAL lock_timeout` on admin and boot DDL. P-L5: pool `check_connection`.
- P-M5, B-7.2, B-7.3: move optimizer jobs to a Container Apps Job or a second container; wait for the plant lock before taking `_SEM`; lease the lock to the body thread.
- Container size: bump to 1 CPU / 2 GB the week the rollout starts; 2 CPU only if mornings are still rough.

### Deferred and owner decisions

- B-5.1: header identity stays until Entra (MIGRATION.md WS3). Until then 30-40 users means 30-40 people who can impersonate each other. Flag the `client-config` API-key exposure for the same workstream.
- Presence and soft locks (F-G): not needed if Wave 2 lands. Revisit after pilot feedback.
- Two replicas: not possible until the jobs scheduler has leader election or moves out. Keep min=max=1.
- Field-level concurrency (B-1.2): no longer deferred. The owner moved it into Wave 1 (sections 3 and 4).
- Postgres tier: if burst credits prove to drain at 40 users, move to General Purpose (flat step up). Decide after confirming the live SKU.

## 8. Verification plan

- Each wave: `npm run test`, `python -m pytest tests/ -q` (local Postgres with `NIMBUS_TEST_DB=1`), `npm run check:static-assets`, `npm run check:legacy-surface`.
- Multi-user scenarios to script as JS module tests plus pytest, with two clients A and B against one plant:
  - undo after conflict
  - note then move
  - restore over newer
  - optimize onto an occupied line
  - delete the last blackout then re-hydrate
  - resolver versus save interleave (pytest with two connections)
  - upload during a job
- Add for field-level merging: disjoint fields merge, same-field collision refuses with both field sets and actors, a gap in event history refuses the merge (fail closed), and interleaved saves from three clients.
- Load wave: a small script firing 40 concurrent `GET /tasks?plant=1008` plus `GET /setup/1008` against a local container sized 2 vCPU / 4 GiB. Record p50 and p95 and the `tasks.timing` log events before and after Wave 3.
- Deploy via `promote-azure`; cache-bust the verify request. Owner browser checks are owed per the no-Chrome rule.

## 9. Appendix: context and learnings

### Why this review happened

NIMBUS runs as a single container on Azure Container Apps against Azure Postgres. So far one or a few planners have used it at a time. The owner wants confidence that it can support 30-40 people at once, in both how users interact (several planners on one plant, admins changing master data mid-session, scheduled optimizer jobs auto-applying) and raw system performance (process model, DB pool, hot endpoints, polling load, container sizing). The deliverable was a validated line-per-finding list grouped by area and ranked by severity, plus a recommended fix order.

### What was out of scope

- No code changes.
- No browser checks (owner rule: tests are the gate).
- No live Azure queries.
- UNVERIFIED and still open: the live container CPU and memory, the live Postgres SKU, the path the ACA health probe uses, and the live transaction id (xid) position relevant to B-1.6.
- One verifier could not run Python, so whether FastAPI's final JSON encode runs on the event loop (part of H3) is unverified.

### Learnings

- The "830 ms" board-load figure is a stale post-fix synthetic benchmark from the 2026-10-22 spec, not a production number. Real timings are in the `tasks.timing` log events. Treat any figure in a spec as unmeasured until compared to those events.
- The `backend/jobs/types/order_steps.py:5` docstring is wrong: it says every order writer shares the per-plant jobs lock, but the key is used only under `backend/jobs/`.
- `frontend/setup/CLAUDE.md:23` guidance (do not fetch the full setup snapshot per load) is contradicted by the board load, which fetches the full uncached matrix on every load and reconnect (`persistence.mts:920-925, 2519-2540`).
- The reconnect backoff covers only failed `/health` probes. A healthy `/health` with a slow `/tasks` resets the attempt counter, which creates a lockstep retry loop. A ceiling needs to cover the `/tasks` path too.
- The unsaved-only nature of the change feed is a property of the architecture, not a gap: the event log records committed writes, and unsaved edits never leave a browser.
- A narrower verifier verdict (F-A4, F-B1) changes the fix: the Optimize Apply hole is an unpatched row on the same machine, and the blackout resurrection fires only for the last plant blackout.
