// ESLint flat config for NIMBUS.
//
// app.js / nimbus-intelligence.js / locales/*.js are plain <script> files
// (sourceType: 'script', not modules) that attach to a single global `window.NIMBUS`;
// all third-party libs come from CDN as globals. A per-file, non-bundling TypeScript
// build now covers some modules (docs/archive/typescript_migration.md) — nimbus-worker.ts is
// the Phase 0 pilot (a TS "global script", same worker-only shape as its predecessor
// nimbus-worker.js); .mts blocks below are ready for Phase 1+ browser modules.
//
// Purpose: a static-analysis gate for the bug classes hand-review can't reliably find in
// a 15k-line file — undeclared/accidentally-global variables (no-undef), shadowing
// (no-shadow), unused code (no-unused-vars), redeclarations, const reassignment. For
// TypeScript sources, no-undef/no-unused-vars are disabled in favor of tsc's own
// `npm run typecheck` (which has full ambient-type awareness) and the TS-aware
// @typescript-eslint/no-unused-vars rule.
//
// Run:  npm run lint           (full report)
//       npm run lint:undef     (just the undeclared-var / shadow gate)

const globals = require('globals');
const tseslint = require('typescript-eslint');

// Third-party globals injected by the CDN <script> tags in index.html.
// (chart.js's `Chart` global was removed here in CQ-1 Phase 3 Task 4, alongside
// the CDN <script> tag itself and the dead Dashboard code that referenced it —
// Dashboard's heatmap is hand-rolled DOM/CSS and never called Chart.js.)
const CDN_GLOBALS = {
  vis: 'readonly',        // vis-timeline (the Gantt)
  agGrid: 'readonly',     // ag-grid-community (orders table)
  flatpickr: 'readonly',  // flatpickr (all date/time inputs)
};

// Cross-file app globals. app.js defines `NIMBUS` and the i18n resolver `t`/`window.t`;
// nimbus-intelligence.js and locales reference them. Declared as writable so the
// defining file isn't flagged (no-redeclare is set with builtinGlobals:false below).
const APP_GLOBALS = {
  NIMBUS: 'writable',
  t: 'writable',
  NimbusComputeCore: 'readonly',  // shared compute core (nimbus-compute-core.js), loaded before app.js
};

const SHARED_RULES = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', vars: 'all', ignoreRestSiblings: true }],
  'no-shadow': 'warn',
  'no-redeclare': ['error', { builtinGlobals: false }],
  'no-const-assign': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-func-assign': 'error',
  'no-unreachable': 'warn',
  'no-self-assign': 'warn',
  'no-self-compare': 'warn',
  'no-unsafe-negation': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

module.exports = [
  {
    // Global ignores. The lint scripts target the app surface explicitly, but this
    // also keeps a bare `npx eslint .` from picking up non-app/vendored root JS
    // (e.g. nimbus-full-audit.js, emscripten_fetch_worker.js) or this config itself.
    ignores: [
      'node_modules/**',
      '.claude/**',          // agent/workflow scripts, not app code
      '**/nimbus-full-audit.js',
      '**/emscripten_fetch_worker.js',
      'eslint.config.js',
      // Compiled .mts twins are gitignored build output (every warning was counted twice).
      // Only the hand-written, git-tracked frontend .mjs files are linted; keep this
      // negation list in sync with `git ls-files "frontend/**/*.mjs"`.
      'frontend/**/*.mjs',
      '!frontend/master-data/_static-delivery-check.mjs',
      '!frontend/scheduling/order-field-catalog.mjs',
      '!frontend/setup/_static-delivery-check.mjs',
    ],
  },
  {
    // Frontend scripts + locale string maps (live under frontend/ — the dedicated static
    // asset directory served by brain.py's StaticFiles mount, see CQ-1 Phase 0 Task 4).
    files: ['frontend/app.js', 'frontend/nimbus-intelligence.js', 'frontend/locales/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...CDN_GLOBALS, ...APP_GLOBALS },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: SHARED_RULES,
  },
  {
    // Standalone Web Worker, now TypeScript (see docs/archive/typescript_migration.md Phase 0):
    // worker globals only (self/postMessage/onmessage), no DOM, no NIMBUS. Deliberately
    // sourceType: 'script' — nimbus-worker.ts has no top-level import/export so tsc emits
    // it unwrapped; ESLint needs to agree it isn't a module either.
    //
    // no-undef/no-unused-vars are swapped for TS-aware equivalents: base no-undef doesn't
    // know about `declare global` ambient types (e.g. NimbusComputeCore from
    // nimbus-compute-core.d.ts) and would false-positive on them — tsc's own `typecheck`
    // script already covers undefined-variable detection with full ambient-type awareness.
    files: ['frontend/nimbus-worker.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.worker },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...SHARED_RULES,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
    },
  },
  {
    // TypeScript ambient declaration files (.d.ts) — pure type information, never emitted
    // as JS. sourceType 'module' since they use `export {}` to allow `declare global`.
    files: ['frontend/**/*.d.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...SHARED_RULES,
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    // Shared compute core (UMD): loaded in the worker (self/importScripts), the browser
    // (window), and Node tests (module.exports) — so it needs worker + `module` globals.
    files: ['frontend/nimbus-compute-core.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.worker, module: 'readonly' },
    },
    rules: SHARED_RULES,
  },
  {
    // ESM scripts (scanner, checkers) — Node environment.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: SHARED_RULES,
  },
  {
    // ESM test modules — Node environment.
    files: ['tests/modules/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: SHARED_RULES,
  },
  {
    // Browser ESM modules under frontend/ — browser environment. Also covers the Phase 0
    // fixture frontend/_static-delivery-check.mjs; Phase 1+ will add real module entries here.
    files: ['frontend/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...CDN_GLOBALS },
    },
    rules: SHARED_RULES,
  },
  {
    // Browser TypeScript modules under frontend/ (docs/archive/typescript_migration.md Phase 1+ —
    // no real files yet as of Phase 0; this block is ready for schedule-state.mts etc.
    // as each phase converts a module). Same reasoning as the nimbus-worker.ts block
    // above for the no-undef/no-unused-vars swap.
    files: ['frontend/**/*.mts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...CDN_GLOBALS },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      ...SHARED_RULES,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { args: 'none', ignoreRestSiblings: true }],
    },
  },
  {
    // R1: no ${} interpolation inside an inline on*="..." handler attribute (injection
    // class from the H4 audit). Use data-* attributes + a delegated listener instead.
    // Must stay `error`: lint:ci runs --quiet and would hide a warning.
    files: ['frontend/**/*.mts', 'frontend/app.js', 'frontend/nimbus-intelligence.js'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'TemplateElement[value.raw=/\\son[a-z]+="[^"]*$/]',
        message: 'No ${} inside on*=; use data-* + addEventListener',
      }],
    },
  },
  {
    // Domain API calls must carry the shared identity/API-key headers. The
    // bootstrap fetch and login handshake are the deliberate exceptions.
    files: ['frontend/**/*.mts'],
    ignores: ['frontend/platform/foundation.mts', 'frontend/security/session.mts'],
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Use Util.fetchTraced for API calls.' }],
    },
  },
];
