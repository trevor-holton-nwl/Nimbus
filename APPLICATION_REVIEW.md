# Executive Summary

NIMBUS is a capable, unusually mature prototype moving toward a production scheduling platform. Its strongest qualities are its plant-scoped data model, stateless order reads from PostgreSQL, optimistic row-version checks, shared main-thread/worker scheduling computations, searchable plant and line selection, detailed operational diagnostics, and a clear product/design direction. The code shows consistent attention to practical manufacturing workflows rather than generic dashboard patterns.

The largest risks are at system boundaries. The application has a login screen but does not have server-verifiable user sessions; authorization trusts a caller-supplied username header. Order identity is not plant-aware. The optimizer can deliberately create an infeasible schedule after its search limit, and optimizer saves bypass concurrency checks. Browser cache recovery can overlay stale local dates on newer server data. Finally, runtime schema mutation and a test harness that connects to any reachable configured PostgreSQL database create avoidable production-data and schema-drift risk.

Overall health: **strong prototype / moderate production readiness**. The scheduling UI and operational tooling are ahead of the security, migration, multi-user, and fail-safe correctness foundations needed for broader rollout.

The top five recommendations, in priority order, are:

1. [HI-1: Replace spoofable identity with server-verified authentication and fail-closed plant authorization](#hi-1-replace-spoofable-identity-with-server-verified-authentication-and-fail-closed-plant-authorization).
2. [HI-2: Introduce a plant-aware, immutable order identity](#hi-2-introduce-a-plant-aware-immutable-order-identity).
3. [HI-3: Make optimization fail safely and preserve concurrency guarantees](#hi-3-make-optimization-fail-safely-and-preserve-concurrency-guarantees).
4. [HI-4: Make server state authoritative and model local work as explicit drafts](#hi-4-make-server-state-authoritative-and-model-local-work-as-explicit-drafts).
5. [HI-5: Make schema changes and database tests safe by construction](#hi-5-make-schema-changes-and-database-tests-safe-by-construction).

Review validation performed on 2026-07-15:

- The JavaScript compute/timezone suite passed all 15 tests when run without Node's process-isolation spawning, which is restricted in this environment.
- The Python suite reached 72 passed, 1 skipped, 8 failed, and 2 errors, but it also exposed a critical harness issue: `tests/conftest.py` connected to the reachable database from `.env`, which was the configured Azure database. Several tests write fixture data. The suite should not be run again against that environment until HI-5 is addressed.
- `npm run lint:errors` reported 47 duplicate locale keys. The blocking CI lint intentionally excludes locale files.
- `ruff check` reported five errors. These are small individually, but confirm that the Python lint gate is not currently clean or enforced by CI.

# High Impact Improvements

## HI-1: Replace spoofable identity with server-verified authentication and fail-closed plant authorization

**Issue:** `auth.py:478-494` derives identity from `x-user-email`/`X-User`, while `app.js:344` supplies that value from client state. A caller can therefore claim any username, including an administrator. `get_allowed_plants()` also treats an unknown user or a non-admin role with no plant assignments as unrestricted. Several task, note, refresh, baseline, and labor-plan routes in `brain.py:1058-1187` and `brain.py:1950-1980` have no authenticated-user or plant-ownership gate. CORS defaults to `*`, and the optional shared API key is a no-op unless configured.

**Why it matters:** The current login verifies a password once but does not establish a trusted session. On an internet-accessible pilot, a direct API caller can bypass the UI, impersonate an administrator, read plants outside an intended role, or edit arbitrary order IDs. Audit actors are not trustworthy for the same reason.

**Recommended solution:** Integrate Entra ID/OIDC and validate issuer, audience, signature, expiry, and tenant on every request. As an interim step, issue a signed, HttpOnly, SameSite session cookie after password authentication. Centralize `require_user`, `require_admin`, and `require_plant_access` dependencies; resolve plant scope in SQL for every read and write, including ID-based writes. Make no assignment mean no access, with a separate explicit unrestricted role flag. Remove the first-run open grace after a one-time bootstrap mechanism. Pin production CORS to the application origin, fail startup on wildcard production CORS, rate-limit login, and derive all audit actors from verified claims.

**Expected impact:** Closes the most serious production security gap, makes RBAC meaningful, and creates a trustworthy base for auditing and multi-user rollout.

**Estimated effort:** High

## HI-2: Introduce a plant-aware, immutable order identity

**Issue:** `db.py:93` hashes only `production_order|material_number`. `db.py:1257-1317` resolves duplicates by appending a cumulative suffix based on row order within the current ingest batch. The same order/material in two plants collides, and reordered duplicate rows can receive different suffixes on the next upload.

**Why it matters:** A collision can overwrite another plant's order or associate persisted schedule dates, notes, row versions, and frontend state with the wrong physical order. This risk grows directly with the documented target of 50+ plants and reused line/order namespaces.

**Recommended solution:** Define the authoritative SAP business key with operations stakeholders—typically plant, production order, operation/item/sequence, and material where needed. Store those fields separately, add a database unique constraint, and derive an opaque stable ID from that complete key or use a surrogate UUID with the business key constrained. Build a migration that maps existing IDs and related records. Quarantine ambiguous records during ingest instead of assigning order-dependent suffixes. Add cross-plant, duplicate-operation, reordered-upload, and re-ingest tests.

**Expected impact:** Prevents silent cross-plant data corruption and makes imports, notes, scheduling edits, dependencies, and future SAP synchronization reliably idempotent.

**Estimated effort:** High

## HI-3: Make optimization fail safely and preserve concurrency guarantees

**Issue:** `Engine._dispatchDayIntegrity` in `app.js:4990-5125` force-places an order after 90 zero-admission days, explicitly bypassing `fitsAt`. That can place work through closed shifts, blackouts, or fixed orders. The SPT path also continues after a placement guard warning. Optimizer-dirtied IDs are sent with `force: true` in `Persistence.saveAll()` (`app.js:13920-13945`), bypassing PostgreSQL `xmin` conflict protection. Finish-to-start links are displayed but are not optimizer constraints.

**Why it matters:** The most authoritative-looking action in the UI can produce an infeasible plan or overwrite a concurrent planner's work. A warning in the client log is too weak for a production schedule that may drive labor and line execution.

**Recommended solution:** Return a structured optimization result such as `{patches, infeasible, warnings, assumptions}`. Never include constraint-violating patches in the normal apply set. Validate the final candidate schedule through the same calendar/blackout/fixed-order rules before preview. Show infeasible orders in the preview and require a separately permissioned exception workflow if planners must place them manually. Preserve row-version checks for optimizer writes and submit the plan against a plant-level schedule revision; on conflict, refresh and re-run or ask the user to reconcile. Either enforce actual precedence links or label the current links as visual sequence links.

**Expected impact:** Converts optimization from best-effort mutation into a safe planning recommendation, protects concurrent work, and increases planner trust.

**Estimated effort:** High

## HI-4: Make server state authoritative and model local work as explicit drafts

**Issue:** On a successful backend load, `_overlayUserMoves()` (`app.js:13439`) reapplies cached task dates whenever cached start differs from cached original start, without comparing `row_version`. The cache key is global rather than user-and-plant scoped and includes tasks, notes, calendars, fixed IDs, and settings. If the backend and cache are unavailable, `_loadDemo()` silently generates random orders (`app.js:13851`) inside the production application.

**Why it matters:** A stale browser can visually hide another planner's newer server schedule. A shared workstation can expose another user's cached data. Random demo orders can be mistaken for live production work during an outage. Dirty edit intent is also implicit, making recovery and conflict handling difficult to explain.

**Recommended solution:** Treat a successful server response as authoritative. Store unsaved edits in a separate, explicit draft queue containing user, plant, task ID, base version, changes, and timestamp. Namespace caches by verified user and plant, encrypt or minimize sensitive cached fields, and show a draft-recovery/reconciliation screen when versions differ. Disable demo generation in production; use a prominent read-only offline state with last-sync time and provenance. Add an unsaved-change guard and a visible connection/sync state.

**Expected impact:** Prevents stale or synthetic data from masquerading as the live schedule and makes offline recovery understandable and auditable.

**Estimated effort:** Medium

## HI-5: Make schema changes and database tests safe by construction

**Issue:** `brain.py:174-195` runs numerous `ensure_*` DDL functions at startup, while `schema.sql`, dated migration files, and the live Master Data DDL wizard all mutate schema through separate paths. The test harness in `tests/conftest.py` enables PostgreSQL tests against any reachable database resolved from `.env`; during this review it connected to the configured Azure database and ran write-capable fixtures. The observed live schema also differed from test expectations.

**Why it matters:** Startup mutation hides drift, manual DDL has no guaranteed source-control record, and a local test command can alter pilot data. These are deployment and recovery risks, not just developer inconvenience.

**Recommended solution:** Adopt one ordered migration runner, using Alembic or the existing `schema_migrations` ledger consistently. Startup should verify a required schema version and refuse or enter read-only mode, not alter schema. Have the DDL wizard generate a reviewed migration record or restrict it to controlled development environments. Require an explicit `NIMBUS_TEST_DB=1` opt-in, reject known production/Azure hosts, and create a disposable database per test run using Testcontainers or a CI service database. Isolate tests with transactions or schema recreation and unique test data.

**Expected impact:** Eliminates the possibility of accidental production test writes, makes deployments reproducible, and turns schema drift into an early, actionable failure.

**Estimated effort:** High

## HI-6: Define plant-local time semantics before expanding across regions

**Issue:** Schedule and blackout columns use PostgreSQL `TIMESTAMP` without a timezone (`schema.sql:41-45`, `schema.sql:474-500`). The frontend parses and emits naive local values, calculations use the browser's local `Date`, and the user timezone setting is explicitly display-only (`app.js:600-621`). There is no plant IANA timezone in the scheduling model.

**Why it matters:** A central planner in another timezone, daylight-saving transitions, or plants in multiple regions can shift work or assign it to the wrong production day. Calendar capacity and “due today” logic depend on plant-local days, so display-only conversion is insufficient.

**Recommended solution:** Document whether SAP values represent plant wall-clock time or absolute instants. Add an IANA timezone to each plant. Convert at API boundaries and perform day/window calculations in the plant timezone using a timezone-capable library or the Temporal API/polyfill. Store absolute instants as `TIMESTAMPTZ` where appropriate, while explicitly modeling plant-local date/shift fields where wall-clock semantics are required. Add DST gap/fold, cross-timezone planner, and plant-local day-boundary tests before migrating data.

**Expected impact:** Prevents subtle schedule shifts and makes multi-region deployment safe.

**Estimated effort:** High

## HI-7: Close untrusted-input gaps in the browser and upload pipeline

**Issue:** The frontend has 175 `.innerHTML` sinks with inconsistent escaping. Concrete examples include line names in `app.js:8789`, plant values in `_renderPlantList()` around `app.js:5395`, and BOM options in `_mkCombobox()` around `app.js:18058`. Inline `onclick` handlers compound attribute/JavaScript escaping risk. There is no content-security-policy middleware. Separately, the three XLSX endpoints call `await file.read()` without a byte limit (`brain.py:1226-1323`) before sending the payload to pandas/openpyxl.

**Why it matters:** Master-data and uploaded values can become stored cross-site scripting vectors. A malformed or very large Office ZIP can exhaust application memory or worker capacity. The wildcard CORS default increases exposure until HI-1 is complete.

**Recommended solution:** Replace data-bearing HTML strings with `createElement`, `textContent`, DOM properties, and delegated event listeners. Centralize the few places that intentionally accept sanitized markup. Remove inline event handlers, then add a restrictive CSP plus `nosniff`, frame-ancestor, referrer, and HSTS headers. Add proxy and application request limits, spool uploads with a hard byte ceiling, validate filename/signature/ZIP contents, reject macros, cap sheets/rows/columns, and bound parse time. Add XSS payload and oversized/ZIP-bomb regression tests.

**Expected impact:** Reduces browser compromise and denial-of-service risk without requiring a frontend rewrite.

**Estimated effort:** Medium

# Code Quality & Architecture

## CQ-1: Split the frontend into explicit modules behind stable interfaces

**Issue:** `app.js` is roughly 20,000 sequential lines of IIFEs, `nimbus-intelligence.js` monkey-patches existing modules, and `index.html` contains extensive UI markup and inline handlers. Load order and private-field access are implicit dependencies. `Util` mixes date helpers, network tracing, localization, Flatpickr setup, and schedule KPI calculations.

**Why it matters:** Small changes require broad context, circular behavior is easy to introduce, and unit testing a module without booting large parts of the application is difficult. Monkey patches make runtime behavior depend on script order.

**Recommended solution:** Incrementally extract files by existing boundary—store, calendar, alerts, optimizer, persistence, timeline, table, admin, and intelligence—while preserving the current vanilla JavaScript runtime. Use native ES modules or an explicit ordered manifest, expose narrow public APIs, and stop accessing other modules' private state. Move intelligence hooks to documented events rather than wrapping methods. Separate inline styles and handlers as components are touched.

**Expected impact:** Smaller review surfaces, clearer ownership, easier unit testing, and lower regression risk while retaining the no-framework architecture.

**Estimated effort:** High

## CQ-2: Consolidate authorization and transaction boundaries in service functions

**Issue:** Route handlers mix request identity, plant checks, logging, dataframe conversion, and database calls. Some writes are admin-gated, some only API-key-gated, and task/labor writes are ungated. Actor headers are passed manually into many functions. Similar validation and error mapping is repeated across `brain.py`, `db.py`, `master_data.py`, and `auth.py`.

**Why it matters:** Security and transactional correctness depend on every new endpoint remembering multiple conventions. This becomes harder as SAP, labor, calendar, and scheduling APIs grow.

**Recommended solution:** Add small application-service functions with a trusted request context `{user_id, roles, allowed_plants, request_id}`. Each service should authorize, validate, perform one transaction, and emit an audit record. Keep FastAPI routes as adapters and repositories as database-only code. Introduce this first for task writes and master-data writes, then migrate other routes opportunistically.

**Expected impact:** Makes authorization reviewable, reduces endpoint inconsistency, and simplifies future API work.

**Estimated effort:** Medium

## CQ-3: Use one consistent API error and partial-result contract

**Issue:** Some failures correctly raise HTTP errors, while other database failures return HTTP 200 with `{status: "error"}`. Optimistic conflicts also return 200 by design, and several diagnostics helpers return raw `str(e)`. Clients must inspect both HTTP status and multiple body shapes.

**Why it matters:** Monitoring can record failed operations as successful, frontend code can miss a failure branch, and external integrations must reverse-engineer endpoint-specific behavior.

**Recommended solution:** Define a versioned envelope with `error_code`, safe message, request ID, and structured details. Use 4xx/5xx for failed requests; reserve 200/207-style bodies for explicitly documented per-row results. Keep optimistic conflicts structured and distinguish them from rollback or infrastructure failure. Generate schemas from Pydantic models and test every endpoint's failure contract.

**Expected impact:** More reliable clients and monitoring, clearer support diagnostics, and less defensive frontend branching.

**Estimated effort:** Medium

## CQ-4: Separate visual sequence links from real production dependencies

**Issue:** `GET /tasks` creates finish-to-start links by sorting each line and connecting adjacent rows (`brain.py:916-963`). These are presented through the dependency overlay and stored as dependencies, but they are not authoritative SAP precedence relationships and the optimizer does not enforce them.

**Why it matters:** Users can infer that a displayed dependency is a protected business constraint when it is only the current visual order. Future code may accidentally treat it as authoritative.

**Recommended solution:** Rename the current construct to `sequence_links` and keep it presentation-only. Add a separate dependency model with source, target, relationship type, lag, origin, and version when SAP or master data can supply real precedence. Only show dependency semantics that the optimizer or validation layer actually enforces.

**Expected impact:** Removes a misleading domain abstraction and prepares the application for true routing/precedence constraints.

**Estimated effort:** Low

## CQ-5: Move database pool lifecycle under FastAPI lifespan and dependency injection

**Issue:** `db.py:60-65` opens a PostgreSQL pool at module import. Importing application modules or collecting tests can therefore contact the configured database before the application lifespan or test fixtures control it.

**Why it matters:** Imports have surprising external side effects, shutdown can leave pool threads warning, tests are harder to isolate, and configuration errors occur at module-load time.

**Recommended solution:** Construct and open pools in the FastAPI lifespan, close them on shutdown, and pass a repository/pool dependency to services. For command-line and test use, provide an explicit context manager or factory. Keep a temporary compatibility accessor while modules migrate.

**Expected impact:** Predictable startup/shutdown, safer tests, and cleaner dependency boundaries.

**Estimated effort:** Medium

# Performance

## P-1: Make master-data and BOM operations set-based and always paged at scale

**Issue:** `master_data.list_rows()` supports pagination, but most frontend tables request the full catalog and render a custom DOM table. `bulk_apply()` executes one statement per row. BOM ingest loads every material/plant pair into a Python set, loops with pandas `iterrows()`, and then sends row-by-row upserts. The BOM filter prevents the worst read, but other large tables remain unbounded.

**Why it matters:** Materials, material-plants, and BOMs will reach tens or hundreds of thousands of rows. Full-table transfer, DOM rendering, Python object expansion, and round-trip-per-row writes will become slow well before the target plant scale.

**Recommended solution:** Require limit/cursor pagination for scalable tables and add server-side search, sort, and plant/material filters. Reuse AG Grid's virtual/infinite row model for the management UI. For writes, stage chunks with PostgreSQL `COPY`, temporary tables, or multi-row `VALUES`; validate foreign keys in SQL joins and merge with one `INSERT ... ON CONFLICT`. Return bounded error samples plus total rejection counts.

**Expected impact:** Keeps master-data workflows responsive and makes large SAP/BOM loads practical.

**Estimated effort:** High

## P-2: Remove pandas from the `/tasks` request hot path

**Issue:** Every task read converts PostgreSQL rows to a DataFrame (`db.py:232-275`), then performs `dropna`, color merge, `astype`, grouping, sorting, and `iterrows()` in `brain.py:858-980`. Paged requests may issue a separate count query.

**Why it matters:** DataFrame construction and row iteration add CPU and memory churn for every planner load. This work scales with order count and competes with uploads and scheduling requests in the same container.

**Recommended solution:** Return typed rows from psycopg and build the response in one streaming Python pass. Apply the cached color rank through dictionary lookup or a plant-keyed database join. Order rows in SQL by plant/line/effective start and construct sequence links while iterating. Add an expression/compound index such as plant, line, and effective start only after confirming with `EXPLAIN (ANALYZE, BUFFERS)`. Benchmark representative 1k/10k/50k plant datasets before and after.

**Expected impact:** Lower response latency and memory use, with more predictable performance as plants grow.

**Estimated effort:** Medium

## P-3: Coalesce worker work and recover from stalled jobs

**Issue:** The compute wrapper sends plant-scoped snapshots, which is good, but rapid Store mutations can queue multiple obsolete alert/utilization jobs. Stale results are ignored only after computation, pending requests have no timeout, and one worker error permanently switches the session to synchronous main-thread computation.

**Why it matters:** Dragging, bulk edits, or large schedule updates can waste worker time and create a long stale-work tail. A transient worker issue can degrade the entire session and cause visible main-thread pauses.

**Recommended solution:** Keep only the latest queued job per computation type and attach generation numbers. Add timeouts, telemetry for queue/compute/clone time, and one bounded worker restart before falling back. Longer term, send compact normalized arrays or versioned deltas instead of repeatedly cloning full snapshots.

**Expected impact:** Smoother interaction during rapid edits and more resilient off-main-thread calculation.

**Estimated effort:** Medium

## P-4: Reduce startup dependency and payload risk

**Issue:** The browser loads large unbundled application files plus critical libraries and fonts from Google, unpkg, and jsDelivr. Versions are pinned, but scripts/styles do not use subresource integrity and core scheduling UI depends on third-party availability. `nimbus-intelligence.js` and administration code load for every user regardless of role or tab.

**Why it matters:** Corporate proxy/CDN outages can block the application, third-party compromise affects production scheduling, and parse/execute cost grows as the monolith grows even though gzip reduces transfer size.

**Recommended solution:** Vendor or self-host pinned runtime dependencies and fonts in the container; if a CDN remains, add SRI and a tested fallback. Lazy-load intelligence and administration modules after authentication or first tab activation. Track compressed transfer, parse time, and time-to-interactive in a simple performance budget. Keep the existing active-locale-only loading optimization.

**Expected impact:** Faster and more dependable startup with a smaller supply-chain and outage surface.

**Estimated effort:** Medium

# UI / UX Opportunities

## UX-1: Restore browser zoom and make dialogs/comboboxes keyboard-accessible

**Issue:** `index.html:6-17` deliberately blocks Ctrl/Cmd zoom and Ctrl-wheel zoom. The shared `Modal.open/close` helper only toggles `hidden` (`app.js:7130-7132`), without dialog semantics, focus trapping, Escape handling, initial focus, or focus restoration. Many close buttons lack accessible names. Custom comboboxes do not consistently expose `aria-controls`, `aria-activedescendant`, or selected-option state.

**Why it matters:** Blocking 200% zoom is a major accessibility failure for low-vision users. Keyboard and screen-reader users can lose context or interact with content behind a modal, which is especially costly in dense operational workflows.

**Recommended solution:** Remove page-zoom interception and reserve unmodified wheel gestures for Gantt zoom. Build one accessible dialog utility using native `<dialog>` where supported, including labels, focus trap, Escape, backdrop behavior, and focus return. Standardize a tested WAI-ARIA combobox/listbox pattern and roving keyboard behavior for tabs. Add automated axe checks and a short keyboard-only UAT script.

**Expected impact:** Materially improves accessibility and reduces interaction errors for all keyboard-heavy users.

**Estimated effort:** Medium

## UX-2: Make save, connection, draft, and conflict state continuously visible

**Issue:** “Autosave” writes only localStorage, while backend persistence requires an explicit Save/Cmd+S action. Network failure toasts say the work was saved locally, but there is no persistent indicator of unsaved task count, draft age, offline mode, retry status, or unresolved conflicts.

**Why it matters:** Planners can leave believing a schedule is shared when it only exists in one browser. Transient toasts are insufficient for a high-consequence workflow.

**Recommended solution:** Add a compact top-bar state machine: `Saved to server`, `N unsaved`, `Saving`, `Offline—draft stored locally`, and `Conflict—review required`, with last successful sync time. Keep the Save button, add before-unload protection, expose retry/review actions, and distinguish local draft storage from server persistence in all copy. Tie this to the explicit draft model in HI-4.

**Expected impact:** Reduces lost work and false confidence, especially during network instability or multi-user editing.

**Estimated effort:** Medium

## UX-3: Explain optimizer assumptions and exceptions in the preview

**Issue:** The UI uses “Optimize” and “Smart” language for dispatch heuristics that do not model setup-time matrices, release floors, true precedence, or automatic firm/frozen fences. Infeasible force-placement currently appears only in logs.

**Why it matters:** The interface can overstate mathematical rigor and hide assumptions that experienced planners need to judge a recommendation.

**Recommended solution:** Label modes as scheduling strategies, list active/enforced constraints in the preview, and show moved, late, capacity-risk, and infeasible orders before apply. Add a per-order explanation such as “kept on due day,” “carried because capacity was full,” or “not scheduled: duration exceeds every shift.” Make warnings block apply when they represent invalidity, not merely reduced optimality.

**Expected impact:** Increases trust, shortens schedule review, and helps users detect bad master data.

**Estimated effort:** Medium

## UX-4: Put due-date risk directly into the primary scheduling surfaces

**Issue:** Due-date performance is central to the product strategy and appears in dashboard KPIs, but risk recognition is less direct while working in the Gantt and order table. Planners must mentally connect the current bar position, SAP due date, and lateness.

**Why it matters:** The main scheduling decision is which order needs attention now. Forcing users to switch to a dashboard adds cognitive and navigation cost.

**Recommended solution:** Add a due-date marker/variance indicator to Gantt orders, a sortable risk column in AG Grid, and a filter for late/due-soon/at-risk orders. Use text/icon/shape in addition to color. Let the dashboard drill directly to the relevant plant, line, date, and selected order.

**Expected impact:** Faster exception handling and better alignment between the product's “due dates are north star” principle and daily work.

**Estimated effort:** Medium

## UX-5: Finish localization as a system rather than a dictionary layer

**Issue:** Locale files contain 47 duplicate keys, many strings and `en-US` date formats remain hard-coded, and `<html lang="en">` is not updated when the locale changes. Duplicate object keys silently discard earlier translations.

**Why it matters:** Users receive mixed-language screens, screen readers use the wrong language, and translation regressions are easy to miss.
    
**Recommended solution:** Remove duplicate keys and make locale lint blocking. Extract remaining user-facing strings, use locale-aware date/number formatting, update `document.documentElement.lang`, and add a missing/extra-key parity test against English. Include screenshot smoke tests for one long-text locale and one non-English decimal/date format.

**Expected impact:** Consistent international UX and much safer translation maintenance.

**Estimated effort:** Medium

# Feature Opportunities

## FO-1: Add a frozen horizon, release constraints, and firm-order protection

**Issue:** Manual pinning is the only reliable protection from optimizer movement. SAP firming indicators are displayed but not enforced, and there is no plant/line frozen horizon or material release floor.

**Why it matters:** Near-term production is commonly constrained by labor, staged material, tooling, and communicated commitments. Moving those orders can make an otherwise feasible-looking plan operationally unusable.

**Recommended solution:** Add per-plant defaults and per-line overrides for frozen horizon. Treat in-progress and SAP-firmed orders as protected by default, with permissioned exceptions. Add release/not-before dates when the source becomes available. Surface every protected reason in the inspector and optimization preview.

**Expected impact:** Makes generated schedules more executable and reduces manual repinning after each run.

**Estimated effort:** Medium

## FO-2: Model sequence-dependent setup time before calling changeover modes optimized

**Issue:** Color/form ordering reduces changeovers heuristically, but there is no sequence-dependent setup duration or cost matrix. Capacity therefore excludes time actually consumed by changeovers.

**Why it matters:** A sequence with fewer transitions may still be worse if certain transitions take much longer, and daily capacity can be overstated.

**Recommended solution:** Add plant/line-family setup matrices with effective dates and a default fallback. Include setup blocks or duration in placement and utilization, show setup time separately in preview KPIs, and retain the current heuristic when no matrix exists. Begin with one constrained product family to validate data quality.

**Expected impact:** More realistic capacity and more meaningful changeover strategy results.

**Estimated effort:** High

## FO-3: Add lightweight schedule collaboration and change provenance

**Issue:** Optimistic row conflicts exist, but users cannot see who is editing a plant, what changed since they loaded it, or the provenance of a schedule move. Logs are operational rather than a planner-facing change history.

**Why it matters:** As usage expands, last-writer-loses refresh is surprising and planners will coordinate outside the application.

**Recommended solution:** Add a plant schedule revision and append-only change events containing actor, source, before/after, reason, and correlation ID. Start with polling and a “changed since you opened” drawer; later add Server-Sent Events for live revision/conflict notification. Allow comment/reason capture for overrides and optimizer publication.

**Expected impact:** Safer collaboration, easier shift handoff, and auditable planning decisions without building full real-time co-editing initially.

**Estimated effort:** Medium

## FO-4: Productionize SAP synchronization through staged validation

**Issue:** The SAP interface is intentionally a transport skeleton. Configuration, mappings, and run history exist, but live connector behavior, distributed scheduler locking, dry-run reconciliation, and operational recovery are not complete.

**Why it matters:** SAP sync is the natural next data path, but direct writes from an immature connector could amplify the identity, validation, and schema issues identified above.

**Recommended solution:** Implement a staged pipeline: fetch to immutable raw payload, map to a typed staging table, validate identity/plant/material/date rules, show a diff and rejection summary, then publish through the shared upsert. Add idempotency keys, retry/backoff, watermarks, advisory locking for multiple replicas, secrets in Key Vault, and replay tooling. Pilot one read-only object before enabling scheduled order writes.

**Expected impact:** Turns the existing skeleton into an operable integration while containing source-data and retry risk.

**Estimated effort:** High

# Technical Debt

## TD-1: Restore a fully green, blocking quality gate

**Issue:** CI exists in `.github/workflows/ci.yml`, but locale lint is deliberately non-blocking and Ruff is not run. Current local checks found 47 duplicate locale keys and five Ruff errors. The Python suite was not green in the configured environment, including auth/log expectations and live-schema drift.

**Why it matters:** Known failures become background noise, and new regressions are harder to distinguish from accepted debt.

**Recommended solution:** Fix duplicate locale keys and make full ESLint blocking. Add `ruff check`, dependency/security scanning, and a fresh-schema plus migration-reapply test to CI. Update auth/log fixtures to create a verified admin context. Keep the CI PostgreSQL service, but combine it with HI-5's explicit test-database guard. Publish concise test/lint artifacts on failure.

**Expected impact:** Makes every pull request trustworthy and prevents debt from accumulating silently.

**Estimated effort:** Low

## TD-2: Harden health, logs, and audit storage

**Issue:** Public `/health` returns pool details, order counts, the absolute `COLOR_FILE` path, and missed colors. Some database helpers expose raw exception strings. Frontend/backend log ingestion and audit actors are not consistently authenticated, while several logs are in-memory or local-file only and disappear on restart or diverge across replicas.

**Why it matters:** Operational details leak publicly, log endpoints can be polluted, and records are not sufficient for incident investigation or compliance as the application scales.

**Recommended solution:** Keep `/livez` minimal and add a minimal readiness endpoint. Put detailed health behind admin authorization and sanitize errors. Authenticate and rate-limit client-log ingestion. Persist audit events append-only in PostgreSQL or a central Azure log sink with retention, actor claims, request IDs, and plant scope. Keep in-memory buffers only as a convenience view.

**Expected impact:** Better incident response, lower information exposure, and reliable multi-replica observability.

**Estimated effort:** Medium

## TD-3: Automate build identity, static asset inclusion, and deployment checks

**Issue:** `APP_VERSION` in `app.js` and `NIMBUS_BUILD_ID` in `index.html` must be manually synchronized. The deployment and Docker asset lists are maintained manually. A missed bump can serve stale code even when the backend is updated.

**Why it matters:** Manual cache-busting and copy lists are easy to forget and produce difficult “fix did nothing” incidents.

**Recommended solution:** Generate one build ID from the commit/image during container build and expose it to both HTML and JavaScript. Use a static asset manifest or copy the frontend directory by convention, then smoke-test that every referenced asset returns 200 and reports the same build ID. Add the deployment commands to a controlled CI/CD workflow with health and migration gates.

**Expected impact:** More repeatable deployments and fewer cache/version mismatches.

**Estimated effort:** Low

## TD-4: Reconcile documentation with implemented behavior

**Issue:** `AGENTS.md`, `DEPLOYMENT.md`, `MIGRATION.md`, and source comments contain valuable operational knowledge, but some historical warnings and architecture descriptions no longer match current behavior. Generated or approximate file/module counts also drift quickly.

**Why it matters:** Stale runbooks can cause incorrect recovery or deployment actions, and future engineers may preserve obsolete workarounds.

**Recommended solution:** Treat deployment, migration, security posture, and data identity as a small set of canonical docs. Move historical facts to dated decision records, link source comments to those records, and add lightweight checks for version strings, endpoint inventory, and migration order. Update docs in the same pull request as behavior changes.

**Expected impact:** Faster onboarding and safer operations with less contradictory guidance.

**Estimated effort:** Low

## TD-5: Expand tests around system invariants, not just individual helpers

**Issue:** Existing tests cover important compute and database behavior, but the highest-risk cross-layer invariants are underrepresented: plant authorization on ID-based writes, cross-plant identity collisions, optimizer feasibility, stale-cache reconciliation, save conflicts after optimization, DST behavior, upload size limits, XSS rendering, accessibility, and multi-replica scheduler safety.

**Why it matters:** Most serious risks in NIMBUS arise where individually reasonable modules interact. Unit tests in isolation will not catch them.

**Recommended solution:** Add contract/integration tests for the invariants above, plus property-based optimizer tests asserting no overlap with protected intervals and no invalid ranges. Add browser smoke tests for login/RBAC, plant switching, drag-save-refresh, offline state, modal keyboard behavior, and optimizer preview. Use representative generated datasets to enforce latency and memory budgets.

**Expected impact:** Detects high-consequence regressions before deployment and makes future architectural cleanup safer.

**Estimated effort:** Medium
