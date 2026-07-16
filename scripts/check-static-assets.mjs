// CQ-1 static asset boundary checker.
//
// Guards two invariants for the dedicated web/ frontend source directory:
//   1. Every local relative import reachable from any .mjs file under web/
//      resolves to an existing file that itself stays inside web/ (no escape
//      to the repo root where brain.py/db.py/schema.sql live).
//   2. No backend source/config filename appears anywhere under web/.
//
// Usage:
//   import { collectStaticImportClosure, findForbiddenFiles } from './scripts/check-static-assets.mjs';
//   node scripts/check-static-assets.mjs   # CLI: checks the real web/ tree, exit 1 on any violation

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
export const WEB_DIR = resolve(ROOT, 'web');

// Local relative specifiers only — `from './x'` / `from '../x'`, side-effect
// `import '...'`, and dynamic `import('...')`. Bare specifiers (npm packages)
// and absolute URLs (CDN scripts) are out of scope; those are governed by the
// compatibility inventory, not this checker.
const STATIC_IMPORT_RE = /\bimport\s+(?:[\s\S]*?\bfrom\s+)?['"](\.\.?\/[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

function localSpecifiers(source) {
  const specs = new Set();
  for (const re of [STATIC_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) specs.add(m[1]);
  }
  return [...specs];
}

/**
 * Walk the local-import graph starting at entryPath, requiring every reachable
 * file to exist and stay inside `root` (defaults to the real web/ directory).
 *
 * @param {string} entryPath
 * @param {{ root?: string }} [opts]
 * @returns {string[]} sorted absolute paths of every file in the closure
 */
export function collectStaticImportClosure(entryPath, { root = WEB_DIR } = {}) {
  const visited = new Set();
  const stack = [resolve(entryPath)];

  while (stack.length) {
    const file = stack.pop();
    if (visited.has(file)) continue;

    const rel = relative(root, file);
    if (rel.startsWith('..') || rel.startsWith(`.${sep}..`)) {
      throw new Error(`Static import escapes ${relative(ROOT, root)}/: ${file}`);
    }
    if (!existsSync(file)) {
      throw new Error(`Static import does not resolve to an existing file: ${file}`);
    }
    visited.add(file);

    const source = readFileSync(file, 'utf8');
    for (const spec of localSpecifiers(source)) {
      stack.push(resolve(dirname(file), spec));
    }
  }

  return [...visited].sort();
}

// Backend source/config that must never be reachable through the public
// static mount, wherever it appears in the tree.
const FORBIDDEN_BASENAMES = new Set([
  'brain.py', 'db.py', 'master_data.py', 'auth.py', 'sap_sync.py',
  'schema.sql', '.env', 'requirements.txt', 'Dockerfile', '.dockerignore',
]);

/** Recursively find any forbidden backend filename under `dir`. */
export function findForbiddenFiles(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findForbiddenFiles(full));
    } else if (FORBIDDEN_BASENAMES.has(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Recursively list every .mjs file under `dir`. */
function findMjsFiles(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findMjsFiles(full));
    } else if (entry.name.endsWith('.mjs')) {
      found.push(full);
    }
  }
  return found;
}

const REQUIRED_ASSETS = [
  'index.html', 'styles.css', 'app.js', 'nimbus-intelligence.js',
  'nimbus-worker.js', 'nimbus-compute-core.js',
  'locales/en.js', 'locales/de.js', 'locales/es.js', 'locales/fr.js', 'locales/pt.js',
  'Images/user.png',
];

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let ok = true;

  for (const rel of REQUIRED_ASSETS) {
    if (!existsSync(resolve(WEB_DIR, rel))) {
      console.error(`Missing expected static asset: web/${rel}`);
      ok = false;
    }
  }

  const forbidden = findForbiddenFiles(WEB_DIR);
  if (forbidden.length) {
    console.error('Backend files found inside the public static tree:');
    forbidden.forEach(f => console.error(`  ${relative(ROOT, f)}`));
    ok = false;
  }

  for (const entry of findMjsFiles(WEB_DIR)) {
    try {
      collectStaticImportClosure(entry);
    } catch (e) {
      console.error(`${relative(ROOT, entry)}: ${e.message}`);
      ok = false;
    }
  }

  if (!ok) process.exit(1);
  console.log('Static asset boundary OK.');
}
