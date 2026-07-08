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
const CDN_GLOBALS = {
  vis: 'readonly',        // vis-timeline (the Gantt)
  agGrid: 'readonly',     // ag-grid-community (orders table)
  Chart: 'readonly',      // chart.js (dashboard)
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
    // Frontend scripts + locale string maps.
    files: ['app.js', 'nimbus-intelligence.js', 'locales/*.js'],
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
    files: ['nimbus-worker.js'],
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
    files: ['nimbus-compute-core.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.worker, module: 'readonly' },
    },
    rules: SHARED_RULES,
  },
];
