# NIMBUS: Next Code and Operational Graduations

Assessment date: September 14, 2026  
Status: Recommendations for prioritization; implementation has not started.

## Executive overview

NIMBUS has progressed beyond the point where its next major improvement is simply a new programming language or a better folder structure. The next step is to make the application dependable enough for planners to use every day, while keeping it manageable as scheduling rules, users, and plant sizes grow.

The central question is: **Can we change NIMBUS confidently, explain the schedules it produces, and trust what it saves under real operating conditions?**

The application already has useful foundations: TypeScript checking, automated tests, a shared scheduling state, background optimization, and protections against some conflicting edits. The recommendations below build on those investments.

Three outcomes have equal importance:

- **Correctness:** Planners can trust the calculations, warnings, and saved results.
- **Maintainability:** New capabilities can be added without unexpected effects elsewhere.
- **Performance:** The application remains responsive with 70+ machines per plant and has a path to 50+ plants.

The intended milestone is a daily-use pilot whose planner-approved schedules guide production. Planners must retain the ability to save schedules with conflicts. That flexibility makes accurate warnings and a clear history of changes especially important. It does not imply permission to silently overwrite someone else's work.

## 1. Make changes safer by separating responsibilities

### Executive summary

A change to one scheduling feature can currently affect several other parts of the application. This makes development slower and increases the chance that fixing one problem creates another. The next improvement is to give each part of NIMBUS a clear responsibility, so scheduling calculations can be changed and checked without disturbing the screens, saved data, or alerts.

### Current situation

The frontend/backend and domain folders are already useful. However, some modules still depend on each other in both directions. Calendar calculations call the scheduling engine, while the engine calls calendar calculations. Similar relationships exist between the engine and alerts, and between shared application state and selection/sandbox behavior.

The scheduling engine also uses a module-level variable to switch between live application data and a captured candidate snapshot. This works within the current conventions but requires contributors to understand implicit context.

Several files remain large. `setup-scheduler.mts` exceeds 6,000 nonblank lines, while the shared backend data layer still combines multiple domains in `db.py` and `master_data.py`. File size is a signal to inspect responsibilities, not a reason to split code arbitrarily.

### Recommended graduation

- Define a scheduling core with explicit inputs and outputs: scheduling facts and rules go in; proposed changes, scores, and explanations come out.
- Keep screen updates, application-state changes, and saving outside the calculation core.
- Replace implicit live-versus-snapshot context with explicit inputs as affected calculations are extracted.
- Divide large modules by responsibility, such as placement, scoring, validation, and proposal orchestration.
- Gradually separate backend domain services and data access while preserving shared transaction boundaries.
- Add automated dependency checks to prevent new circular relationships or prohibited imports.

### Evidence of completion

A scheduling calculation can run in isolation without loading the screen or changing application state. A change to scoring does not require understanding calendar UI or persistence internals. Automated checks enforce the agreed boundaries.

Source anchors: [engine.mts](frontend/optimization/engine.mts), [setup-scheduler.mts](frontend/optimization/setup-scheduler.mts), [store.mts](frontend/platform/store.mts), [db.py](db.py), [master_data.py](master_data.py).

## 2. Protect the whole schedule when several people work at once

### Executive summary

Two planners can make individually reasonable changes that conflict when combined. One person might also approve a proposal after another person changes the calendar or setup requirements behind it. NIMBUS needs to recognize these situations and explain them accurately. Planners should remain free to accept scheduling conflicts, while the application protects them from unknowingly saving outdated work.

### Current situation

Existing row-version checks detect when another writer changed the same order. Optimizer saves can also be atomic, meaning a rejected order prevents the proposal's entire batch from being saved.

Those protections do not by themselves cover different orders competing for the same machine. The save path locks edited orders, then reads neighboring orders for overlap diagnostics. That creates a concurrency scenario requiring a dedicated test: two transactions editing different orders may each miss the other's uncommitted placement.

The overlap query also selects neighboring orders by their start dates within a padded window. An order that started before that window but continues into it can be omitted. This limitation is visible in the query; its practical impact should be established with a regression case.

Browser-side proposal validation exists, but a local state revision is not a server-recognized revision of all scheduling inputs across users.

### Recommended graduation

- Fix overlap detection to include all relevant intersecting intervals, including long-running and split orders.
- Test simultaneous saves involving both the same order and different orders on the same machine.
- Coordinate schedule writes at the appropriate plant/machine scope so conflict diagnostics reflect a consistent committed result.
- Track server-recognized freshness for relevant orders, calendars, setup data, and scheduling rules.
- Distinguish a scheduling warning, an outdated proposal, and a persistence failure in the save result.
- Preserve warning-based manual saves. Keep stale-write protection separate from the planner's choice to accept a scheduling conflict.
- Make retry behavior explicit when a save commits but the browser never receives its response.

### Evidence of completion

Concurrent saves do not silently lose edits. A long-running order cannot disappear from conflict detection because it started earlier. An outdated proposal receives a clear freshness result. A planner who intentionally saves a conflicting schedule sees accurate warnings afterward.

Source anchors: [save and overlap logic](db.py), [scheduling routes](backend/scheduling/routes.py), [save client](frontend/scheduling/persistence.mts), [concurrency tests](tests/test_task_concurrency.py).

## 3. Prove complete planner workflows, not just individual calculations

### Executive summary

An application can pass many tests and still fail when a planner completes a real sequence of actions. Problems often occur between steps: a preview is correct but saves incorrectly, a reload changes the result, or two open sessions disagree. The next testing investment should prove that everyday planning activities work from beginning to end.

### Current situation

NIMBUS has substantial Node and Python coverage, including scheduling, workers, persistence, and database behavior. CI runs frontend checks and Python tests against PostgreSQL. However, the inspected CI workflow does not contain a real-browser end-to-end test gate. Browser stubs and module tests cannot fully establish actual boot behavior, interaction, worker loading, and rendering.

### Recommended graduation

- Add real-browser tests using Playwright or an equivalent browser test runner, with a safe local test database.
- Cover Optimize → Preview → Apply → Save → Reload and verify the committed result.
- Exercise two independent planner sessions, plant switching during pending requests, and calendar/setup changes during preview.
- Cover interrupted requests, retries, partial manual saves, and stale optimizer saves.
- Test overnight work, DST transitions, split orders, and browser/plant timezone differences.
- Build representative, planner-reviewed scheduling examples with expected outcomes.
- Add generated scenarios that verify scheduling invariants, such as preserved productive runtime, legal optimizer placements, and correct capacity accounting.
- For small scheduling problems, compare heuristic output with exhaustive results to measure solution quality separately from validity.

### Evidence of completion

CI exercises a working browser against the application and database. Critical workflows verify saved business results, not only that a button was clicked. Generated cases expose combinations that hand-written examples miss, and small reference problems provide an independent check on optimizer quality.

Source anchors: [CI workflow](.github/workflows/ci.yml), [frontend test suite](tests/modules), [Python test suite](tests), [worker tests](tests/modules/optimization/optimizer-worker.test.mjs).

## 4. Give scheduling information one clear meaning everywhere

### Executive summary

The same order can be represented differently as it moves from an upload to the database, the screen, and the optimizer. Small differences in names, dates, or units can become large scheduling errors. NIMBUS should translate incoming information into one agreed form so every part of the application interprets it consistently.

### Current situation

Strict TypeScript checking is enabled, and generated API types are already consumed by scheduling persistence. However, some domain types still permit ambiguity. For example, `NimbusTask` contains both `PLANT` and `plant`, and `RUN_TIME` accepts either a number or a string. Generated API-type consumption is not yet broadly established across domains.

Type checking helps only when the declared types express the actual business rules. A field that accepts several interpretations still passes the compiler.

### Recommended graduation

- Normalize uploaded and API data at defined boundaries into a canonical scheduling model.
- Make plant/machine identity, duration units, timestamp meaning, and scheduled-versus-unscheduled state explicit.
- Keep raw source-system fields separate from the normalized values calculations consume.
- Expand validated request/response models and generated frontend API types across critical domains.
- Add a CI check that detects drift between generated types and the backend API contract.
- Introduce Python type checking incrementally around scheduling services and domain interfaces.
- Preserve the existing date contract during this work; any change to time representation needs a separately tested compatibility migration.

### Evidence of completion

A calculation receives a duration in a known unit and a clearly identified plant. Scheduled and unscheduled orders have unambiguous representations. Backend contract changes fail a check when frontend consumers have not been updated.

Source anchors: [domain types](frontend/platform/types.mts), [generated API types](frontend/types/api-generated.d.mts), [scheduling persistence](frontend/scheduling/persistence.mts), [TypeScript configuration](tsconfig.json).

## 5. Establish measurable performance at large-plant scale

### Executive summary

A scheduling application must remain usable while planners are making decisions. Slow loading, frozen interactions, or unpredictable optimization times reduce confidence and encourage workarounds. NIMBUS needs repeatable evidence that a busy plant with 70+ machines can use the application comfortably, including when several people are working at once.

### Current situation

NIMBUS already uses background workers and records useful performance timings. The next gap is a repeatable workload and acceptance standard for the complete application.

Some frontend master-data requests still fetch the machine catalog without a plant filter. Task loading requests a full plant-scoped result. The effect depends on order volume, planning horizon, setup complexity, and concurrency—not just machine count.

### Recommended graduation

- Create repeatable synthetic workloads with 70+ machines and increasing order counts, setup combinations, blackouts, and split orders.
- Include simultaneous planners and background imports in the workload model.
- Measure time to usable schedule, plant switching, drag response, optimization time and quality, memory, save latency, and database contention.
- Establish explicit performance targets after the baseline is measured; this assessment does not invent unvalidated response-time promises.
- Scope machine and other master-data requests to the active planning context.
- Separate display loading from optimization input loading. A partially loaded screen must not cause the optimizer to assume omitted orders do not exist.
- Use measurements to choose query/index changes, caching, incremental updates, or rendering changes.
- Add a repeatable performance regression check on a controlled runner.

### Evidence of completion

The team can show measured results for agreed large-plant workloads and identify regressions between releases. Planners can continue interacting during optimization. Every optimization run knows whether its required input scope is complete.

Source anchors: [data loading](frontend/scheduling/persistence.mts), [performance monitor](frontend/platform/foundation.mts), [optimizer worker client](frontend/optimization/optimizer-worker-client.mts), [task query interface](backend/scheduling/routes.py).

## 6. Make saved changes explainable and recoverable

### Executive summary

When a production sequence changes unexpectedly, the business needs to know what changed, why it changed, and how to recover. A record that optimization was run is not enough to establish what was actually saved. NIMBUS needs a durable history tied to committed changes and a practiced recovery process.

### Current situation

NIMBUS has database-backed audit records for some operations, an in-memory diagnostic buffer, and a file-based priority-list/optimization audit trail. Optimizer audit requests occur separately from the eventual schedule save, so they do not prove that a particular proposal became the committed schedule.

Local undo helps within a planning session but is not a durable cross-session history or disaster-recovery mechanism.

### Recommended graduation

- Write schedule history on the server in the same database transaction as the schedule change.
- Record affected orders, before/after values, the acting user, change source, relevant input revisions, and warnings returned by validation.
- Distinguish calculation, local Apply, and committed Save events.
- Move operationally important file-based history into durable storage with a defined retention policy.
- Support investigation of a plant or machine's schedule changes over time.
- Treat restoring an earlier business state as a new validated change against current data, rather than silently replaying obsolete values.
- Define acceptable data loss and recovery time, then perform a restore drill in an isolated environment.
- Include application/schema compatibility in recovery instructions, especially for Needs Planning state.

### Evidence of completion

A planner can explain which saved change altered a production sequence. History cannot claim a save succeeded when its transaction rolled back. A recovery exercise demonstrates that the application and schedule data can be restored together.

Source anchors: [optimizer Apply/audit behavior](frontend/optimization/optimize-ui.mts), [file-based audit trail](backend/priority_lists/audit_log.py), [database schema](schema.sql), [deployment compatibility notes](docs/DEPLOYMENT.md).

## 7. Make releases predictable and repeatable

### Executive summary

A reliable application also needs reliable updates. Each release should deliver the intended application and database changes together, and there should be a known way to recover if something goes wrong. As usage grows, deployment should become a routine operation with clear evidence that the released application works.

### Current situation

The container build compiles frontend modules, and migrations have an application ledger. These are useful foundations. However, application startup still runs many schema-creation or alteration helpers. The browser also loads important libraries from external CDNs, and the inspected CI pipeline does not include a full container/browser smoke test.

The deployment deliberately uses a single application worker. Some caches and scheduled-job assumptions remain tied to one running instance, which matters before increasing replicas.

### Recommended graduation

- Make deployment-managed migrations the authoritative path for application-owned schema changes.
- Replace startup schema changes with compatibility checks once the migration path covers existing installations.
- Address the admin schema-editing feature explicitly; preserve its intended capability while separating it from ordinary startup migrations.
- Package and version frontend runtime libraries with the release so browser startup is less dependent on external services.
- Build one identifiable artifact and verify that same artifact through container/browser smoke tests before promotion.
- Test both fresh database setup and upgrades from supported prior versions.
- Document rollback constraints; an older image is not automatically compatible with newer data states.
- Connect operational monitoring to failed saves, unavailable database access, failed imports, and performance degradation.
- Before adding replicas, establish cache freshness across instances and single-owner execution for scheduled jobs.

### Evidence of completion

A release can be reproduced and traced to its source revision. Startup checks compatibility without improvising schema upgrades. A failed release has a tested recovery path. Increasing replicas does not duplicate scheduled imports or leave planners seeing inconsistent cached data.

Source anchors: [application startup](brain.py), [container build](Dockerfile), [frontend library loading](frontend/index.html), [CI workflow](.github/workflows/ci.yml), [deployment runbook](docs/DEPLOYMENT.md).

## Recommended sequence

### Executive summary

These improvements should support ongoing product development rather than become one large rewrite. Start by building evidence about correctness and performance, address the gaps that could undermine daily planning, and strengthen internal structure in manageable pieces. Some work can advance together, but each improvement should have a clear business result.

| Stage | Main work | Expected outcome |
|---|---|---|
| Start now | Real-browser workflow tests, targeted concurrency regressions, and 70+ machine benchmarks | Establish a trustworthy baseline and expose the most consequential gaps. |
| Before reliance on daily production schedules | Accurate conflict warnings, stale-save handling, durable committed history, and a recovery drill | Planners can trust saved results, understand exceptions, and recover from mistakes. |
| Alongside feature development | Scheduling-core boundaries, canonical domain types, API contracts, and backend data-layer separation | Changes become easier to reason about and less likely to cause unrelated regressions. |
| Before broader rollout | Controlled releases, migration upgrade tests, operational monitoring, and replica-safe state/jobs | More plants can adopt NIMBUS without multiplying operational surprises. |
| When live integration is introduced | Production SAP connectors, retry/idempotency behavior, reconciliation, and visible import outcomes | Upstream changes arrive predictably without overwriting planner-owned scheduling decisions. |

FastAPI, PostgreSQL, and TypeScript remain a suitable foundation for this direction. This assessment does not establish a need for a framework rewrite, microservices, or replacement of the optimizer. Those choices should follow measured limitations or clearly defined business requirements.

## Assessment evidence and limits

### Executive summary

The recommendations are based on inspected code and successful frontend checks. They identify where the next investments should go; they do not certify enterprise capacity or production readiness. The remaining proof requires realistic workloads, concurrent-use tests, and recovery exercises.

- Reviewed current architecture, scheduling persistence, optimizer/worker boundaries, type contracts, CI, deployment configuration, and selected tests.
- `npm run typecheck` passed.
- `npm test` passed, including 659 module tests and the legacy suite.
- Database tests were not run during this assessment.
- Live Azure configuration, production workload performance, and recovery behavior were not verified.
- The simultaneous-save concern is an inference from transaction structure and requires reproduction. The overlap-window limitation is directly visible in the query.
- Recommendations should be rechecked against current code when scheduled; historical planning documents and comments can lag implementation.

Technical references: [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html), [Playwright browser isolation](https://playwright.dev/docs/browser-contexts), [Azure PostgreSQL backup and restore](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore).
