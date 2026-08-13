# Task 6 — Setup Administration UI Report

Implemented the plant-scoped, observation-only Setup Matrix editor in Plant →
System Settings. It hydrates the active plant snapshot with `Util.fetchTraced`,
uses a searchable line combobox (not chips), renders ordered registered fields,
version/activation prerequisites, canonical long-form matrix rows, sparse line
inheritance, scoped override deletion, current state/source/timestamp, and
occurrence-override audit details.

The editor keeps read/copy/CSV export available to non-writers. Definition and
matrix writes are admin-gated in the UI and API; state changes remain scheduler
actions. CSV columns are `Plant`, `Line`, `Signature version`, `From setup
state`, `To setup state`, and `Setup minutes`. Compatibility is a setup-only
line control requiring a reason before marking incompatible; its copy explicitly
distinguishes it from the existing global optimizer exclusion. It persists via
the existing production-lines bulk API because Task 3 defines no compatibility
endpoint.

Stage 0 activation remains status-only and observation-only: after a definition
change the UI reports that a version-matched matrix and reachable coverage pass
are required before activation review; it does not start or alter optimization.

Verification:

- `npm run build` — passed.
- `node --test tests/modules/plant-and-administration.test.mjs` — 9 passed.
- `node --test tests/modules/locale-completeness.test.mjs` — 4 passed.

`npm run lint` remains red on pre-existing repository errors (duplicate legacy
locale keys and undefined `localStorage` in `tests/modules/schedule-data.test.mjs`).
The focused lint invocation likewise reports only duplicate legacy keys in the
locale files and existing unused declarations in `plant-and-administration.mts`;
the Task 6 surface introduced no lint errors. A temporary unused type import
was removed before final verification.

Node's Windows test runner intermittently returned `spawn EPERM` directly
after a chained build/lint command. Re-running each focused test in its own
fresh command succeeded as recorded above.

Running the two Node test files in one `node --test` command returned Windows
`spawn EPERM`; each focused file succeeds independently. `NIMBUS_BUILD_ID` was
not changed.
