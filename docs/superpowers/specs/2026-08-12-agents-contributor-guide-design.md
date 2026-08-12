# AGENTS.md Contributor Guide Design

## Goal

Add a concise contributor entry point to `AGENTS.md` without discarding its detailed NIMBUS operational guidance. The opening section must satisfy the requested “Repository Guidelines” format and remain useful to a contributor who has not yet read the longer reference.

## Document Structure

The file will begin with `# Repository Guidelines` and a roughly 300–400-word guide. A second top-level heading, `# Detailed NIMBUS Reference`, will introduce the existing content. Apart from replacing the old title and inserting the new guide and reference heading, the existing operational material will remain unchanged.

The concise guide will cover:

- Repository layout: root Python services, `web/`, `tests/`, `migrations/`, `docs/`, and `sample-data/`.
- Local workflows: dependency installation, `uvicorn brain:api --port 8000`, Python and JavaScript test commands, linting, type-checking, and TypeScript compilation.
- Style: Ruff’s Python 3.10 and 120-column settings, ESLint/TypeScript checks, four-space Python indentation, and existing naming conventions.
- Testing: `test_*.py` and `*.test.mjs`/`*.test.js` patterns, plus the explicit local-Postgres opt-in and live-database collection guard.
- Contributions: conventional commit prefixes observed in history and focused pull requests with verification details, UI screenshots when relevant, migration notes, and `NIMBUS_BUILD_ID` updates for deployments.
- Security: `.env` remains uncommitted, database targets must be checked before tests or DDL, and API/auth secrets must not enter source control.

## Verification

Confirm the added guide is 200–400 words, all referenced paths and commands exist in repository configuration, Markdown headings render coherently, and the original detailed content remains present. Review the final diff to ensure unrelated dirty-worktree changes are untouched.
