# Independent integration and evidence review

Reviewed the working changes against `960abf6` on 2026-10-16. Scope: cross-package contracts and remaining root artifacts, rather than repeating the four independent domain reviews. No production code, database contents, credentials, or compatibility contract were changed by this reviewer. No browser or live-service access was used.

**Disposition:** no additional implementation blocker established in the reviewed scope. Final full gates, domain correction closure, and the deliberate compatibility inventory update remain the coordinating agent's responsibility. Browser acceptance remains blocked; this report does not establish visual, native keyboard, screen-reader, zoom, or browser performance acceptance.

## Reviewed integration boundaries

- Generated API types reflect the archive route's `offset`/`search` parameters and new `/labor-plan/batch` endpoint. No unrelated generated endpoint change appears in the diff. Batch body and response remain broadly typed because the Python route uses a dictionary rather than a response model; generated types alone do not prove payload compatibility. The frontend request names and validated `lines.rows`/`applied`/`skipped` response collections match the current backend contract. Domain integration tests and the root safe-local run own runtime acceptance.
- Archive requests retain admin and plant-access dependencies. Search values remain SQL parameters; `strpos` implements literal matching, and `deleted_at DESC, id DESC` provides deterministic tie order. Offset paging is bounded per request. It is not snapshot isolation against concurrent archive insertion; no such guarantee should be claimed.
- Snapshot restore uses selected-plant task identity and the existing protection authority, clears stale split segments before normalization, and delegates finish-based reconciliation and Undo to existing domain APIs. It does not introduce schedule persistence. Source dates are absent from the restore patch. The independent shared reviewer owns the detailed real-Engine correction evidence.
- Calendar race coverage crosses the real SandboxAdapter/Store/CalendarSync boundary. It covers deferred GET and POST ordering, failed-write retention/retry, promotion, unrelated-line hydration and other-plant scope. The console spy now observes the actual `[Store] listener error:` channel, closing the nonblocking note in review-planning.md.
- Four added intelligence dependencies are existing public reads: `Store.tasksForSelectedPlant`, `Engine.firmingStatus`, `Store.masterData`, and `Store.lineSettings`. They centralize authoritative scope/protection and conservative legacy ownership inference. Accept a narrowly reviewed inventory exception recording these four additions and expected removals; do not disguise references or weaken the scanner. The coordinating agent owns that update and gate.

## Remaining root artifacts

`scripts/seed_frontend_audit.py` checks loopback host, the dedicated audit database-name prefix, and `NIMBUS_TEST_DB=1` before connecting. It additionally rejects unexpected plant ownership before inserts. Credentials are read without printing; writes are parameterized, additive, transaction-scoped and use conflict handling. Its catalog counts match 50 added plants and 188 machines; the two schema seed plants are disclosed separately. Fixtures are relative to the run date and do not cover specialized setup/distribution/SAP states. Existing fixtures are not reset by a rerun, so switching back from 10,000 to 1,000 requested orders does not shrink the database. The documented fresh-database workflow is appropriate.

The single `test_scale_catalog_paging.py` correction compares `sorted(seen)` with the Python-sorted expected set. It removes an assumption that PostgreSQL collation equals Python code-point ordering while retaining exact full traversal, duplicate detection, page bounds, plant checks and constant-query assertions. Production SQL is unchanged. This reviewer did not run database tests while the coordinating agent's full run was active.

## Fresh verification

- `node --test --test-isolation=none tests/modules/calendar/calendar-hydration-races.test.mjs tests/modules/locale-completeness.test.mjs`: **38 passed, zero failures/skips/TODOs** (10 calendar, 28 locale).
- Independent VM evaluation of all five locale files: **53 audit keys**, each present exactly once, nonempty, with identical interpolation placeholder names to English. Passed for English, German, Spanish, French and Portuguese.
- The existing locale suite's general key parser recognizes single-quoted keys, whereas these audit additions use double quotes. Its 28 passing tests alone do not establish audit-key completeness. The direct VM check establishes the current contents; a lasting targeted test is recommended and was sent to the coordinator. Translation meaning and text expansion remain manual acceptance items.
- Initial attempt to obtain baseline locale text through a Node child process was blocked by sandbox `EPERM`; the successful check read the marked audit additions directly and did not need a child process or permissions change.

## Evidence and final-document boundaries

README, COVERAGE and OPPORTUNITIES explicitly separate source inspection, automated behavior, HTTP observations and blocked browser acceptance. The coverage table assigns every listed surface an owner; this is disposition coverage, not proof that every nested interaction passed an end-to-end run. HTTP fixture evidence supports scoped counts and response sizes/timings, not browser responsiveness. The 10,000-order observation is 9,500 AUD01 rows and 500 AUD02 rows, consistent with the seed distribution.

At review time README and VERIFICATION still contain interim correction/pending-gate statuses. Replace these with the final observed results once the coordinating runs finish; retain baseline Ruff findings, expected failures and warnings explicitly. Preserve original review reproductions, but append correction closure so stale initial findings do not read as current blockers. Link this report from the final audit index. Do not describe the entire requested frontend acceptance matrix as complete while actual browser work remains unavailable.

## Coordinator closure

Final README/VERIFICATION/PROGRESS now record observed gate results and closed production findings, and the index links this review. The four-public-read inventory was refreshed only after an exact-additions assertion; the compatibility gate passes without scanner changes. A permanent regression lists all 53 audit keys and checks discovery, exactly-once definitions, nonempty values and interpolation parity in all five locales. It failed against the old single-quote parser; the quote-aware fix passes all 29 locale tests and the final isolated full Node suite. The browser limitation, unchanged Ruff debt, Python skip/expected failures and legacy concurrency boundaries remain explicit.
