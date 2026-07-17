// ESLint flat config for NIMBUS.
//
// NIMBUS has NO build step: app.js / nimbus-intelligence.js / locales/*.js are plain
// <script> files (sourceType: 'script', not modules) that attach to a single global
// `window.NIMBUS`; all third-party libs come from CDN as globals. nimbus-worker.js is a
// standalone Web Worker (worker globals, no DOM, no NIMBUS).
//
// Purpose: a static-analysis gate for the bug classes hand-review can't reliably find in
// a 15k-line file — undeclared/accidentally-global variables (no-undef), shadowing
// (no-shadow), unused code (no-unused-vars), redeclarations, const reassignment.
//
// Run:  npm run lint           (full report)
//       npm run lint:undef     (just the undeclared-var / shadow gate)

const globals = require('globals');

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
    ],
  },
  {
    // Frontend scripts + locale string maps (live under web/ — the dedicated static
    // asset directory served by brain.py's StaticFiles mount, see CQ-1 Phase 0 Task 4).
    files: ['web/app.js', 'web/nimbus-intelligence.js', 'web/locales/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...CDN_GLOBALS, ...APP_GLOBALS },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: SHARED_RULES,
  },
  {
    // Standalone Web Worker: worker globals only (self/postMessage/onmessage), no DOM, no NIMBUS.
    files: ['web/nimbus-worker.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.worker },
    },
    rules: SHARED_RULES,
  },
  {
    // Shared compute core (UMD): loaded in the worker (self/importScripts), the browser
    // (window), and Node tests (module.exports) — so it needs worker + `module` globals.
    files: ['web/nimbus-compute-core.js'],
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
    // Browser ESM modules under web/ — browser environment. Also covers the Phase 0
    // fixture web/_static-delivery-check.mjs; Phase 1+ will add real module entries here.
    files: ['web/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...CDN_GLOBALS },
    },
    rules: SHARED_RULES,
  },
];
