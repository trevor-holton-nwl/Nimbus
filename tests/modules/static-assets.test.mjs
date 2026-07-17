// Static-asset boundary tests (CQ-1 Phase 0 Task 4). Pins two things: the
// legacy frontend entry files exist under the dedicated web/ directory, and
// the import-closure checker used by `npm run check:static-assets` correctly
// walks local relative imports while rejecting escapes/missing targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WEB_DIR,
  collectStaticImportClosure,
  findForbiddenFiles,
} from '../../scripts/check-static-assets.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(__dirname, 'fixtures/static-assets');

const REQUIRED_ASSETS = [
  'index.html', 'styles.css', 'app.js', 'nimbus-intelligence.js',
  'nimbus-worker.js', 'nimbus-compute-core.js',
  'locales/en.js', 'locales/de.js', 'locales/es.js', 'locales/fr.js', 'locales/pt.js',
  'Images/user.png',
];

test('expected legacy entry assets exist under web/', () => {
  for (const rel of REQUIRED_ASSETS) {
    assert.ok(existsSync(resolve(WEB_DIR, rel)), `missing web/${rel}`);
  }
});

test('no backend source or config file appears under web/', () => {
  assert.deepEqual(findForbiddenFiles(WEB_DIR), []);
});

test('collectStaticImportClosure walks local relative imports', () => {
  const closure = collectStaticImportClosure(
    resolve(FIXTURE_ROOT, 'entry.mjs'), { root: FIXTURE_ROOT },
  );
  assert.deepEqual(closure, [
    resolve(FIXTURE_ROOT, 'entry.mjs'),
    resolve(FIXTURE_ROOT, 'helper.mjs'),
  ].sort());
});

test('collectStaticImportClosure throws when an import escapes the static root', () => {
  assert.throws(
    () => collectStaticImportClosure(resolve(FIXTURE_ROOT, 'escape-entry.mjs'), { root: FIXTURE_ROOT }),
    /escapes/,
  );
});

test('collectStaticImportClosure throws when an import target does not exist', () => {
  assert.throws(
    () => collectStaticImportClosure(resolve(FIXTURE_ROOT, 'missing-entry.mjs'), { root: FIXTURE_ROOT }),
    /does not resolve/,
  );
});
