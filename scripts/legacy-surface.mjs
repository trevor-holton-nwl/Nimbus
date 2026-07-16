// CQ-1 legacy-surface scanner.
//
// Produces a deterministic inventory of the inline-handler and cross-module
// NIMBUS.* references that must be migrated away during Phase 4. Use the
// output as a shrinking allowlist: the count only decreases as callers migrate.
//
// Usage:
//   import { scanLegacySurface } from './scripts/legacy-surface.mjs';
//   node scripts/legacy-surface.mjs          # diff vs contract; exit 1 on drift
//   node scripts/legacy-surface.mjs --write  # write / overwrite contract

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..');
const CONTRACT_PATH = resolve(ROOT, 'tests/contracts/cq1-legacy-surface.json');

// ---------------------------------------------------------------------------
// Core scanner — pure function, no I/O.
// ---------------------------------------------------------------------------

/**
 * Scan legacy source texts for the CQ-1 compatibility surface.
 *
 * @param {{ htmlSource: string, intelligenceSource: string, appSource: string }} sources
 * @returns {{ version: number, inlineHandlers: object[], htmlCommands: string[],
 *             intelligenceCommands: string[], privateConsumers: string[] }}
 */
export function scanLegacySurface({ htmlSource, intelligenceSource, appSource }) {
  // -- 1. Inline handlers --------------------------------------------------
  // Scan on[a-z]+="..." in index.html and JS template literals in app.js.
  const handlerRe = /\bon([a-z]+)="([^"]+)"/g;
  const handlerMap = new Map();

  function collectHandlers(src, file) {
    for (const [, attr, expr] of src.matchAll(handlerRe)) {
      const key = `${file}|on${attr}|${expr}`;
      if (!handlerMap.has(key)) {
        handlerMap.set(key, { file, attribute: `on${attr}`, expression: expr });
      }
    }
  }

  collectHandlers(htmlSource, 'index.html');
  collectHandlers(appSource, 'app.js');

  const inlineHandlers = [...handlerMap.values()].sort((a, b) => {
    const ka = `${a.file}|${a.attribute}|${a.expression}`;
    const kb = `${b.file}|${b.attribute}|${b.expression}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  // -- 2. HTML commands (NIMBUS.Module.member from index.html) ---------------
  const nimbusRef = /NIMBUS\.([A-Za-z][A-Za-z0-9]*)\.([A-Za-z_][A-Za-z0-9_]*)/g;
  const htmlCommandSet = new Set();

  for (const [, mod, mem] of htmlSource.matchAll(nimbusRef)) {
    htmlCommandSet.add(`${mod}.${mem}`);
  }
  const htmlCommands = [...htmlCommandSet].sort();

  // -- 3. Intelligence commands (NIMBUS.Module.member + destructured refs) ---
  // nimbus-intelligence.js starts with `const { A, B, … } = NIMBUS;` — capture
  // those module names so bare `Store.foo` counts as `NIMBUS.Store.foo`.
  const destructureMatch = intelligenceSource.match(
    /const\s*\{([^}]+)\}\s*=\s*NIMBUS\b/
  );
  const destructuredModules = new Set(
    destructureMatch
      ? destructureMatch[1].split(',').map(s => s.trim()).filter(s => /^[A-Za-z]/.test(s))
      : []
  );

  const intelligenceCommandSet = new Set();

  // Explicit NIMBUS.Module.member
  for (const [, mod, mem] of intelligenceSource.matchAll(nimbusRef)) {
    intelligenceCommandSet.add(`${mod}.${mem}`);
  }

  // Destructured module references: e.g. Store.tasksArr, UndoStack._entries
  for (const modName of destructuredModules) {
    // word boundary to avoid matching inside identifiers like "DataStore.foo"
    const modRe = new RegExp(`(?<![A-Za-z0-9_])${modName}\\.([A-Za-z_][A-Za-z0-9_]*)`, 'g');
    for (const [, mem] of intelligenceSource.matchAll(modRe)) {
      intelligenceCommandSet.add(`${modName}.${mem}`);
    }
  }

  const intelligenceCommands = [...intelligenceCommandSet].sort();

  // -- 4. Private consumers (Module._member from HTML + intelligence) --------
  // Any member starting with _ accessed from outside its defining module.
  const privateRe = /(?:NIMBUS\.)?([A-Z][A-Za-z0-9]*)\._([A-Za-z0-9_]+)/g;
  const privateSet = new Set();

  for (const [, mod, mem] of htmlSource.matchAll(privateRe)) {
    privateSet.add(`${mod}._${mem}`);
  }
  for (const [, mod, mem] of intelligenceSource.matchAll(privateRe)) {
    privateSet.add(`${mod}._${mem}`);
  }

  const privateConsumers = [...privateSet].sort();

  return { version: 1, inlineHandlers, htmlCommands, intelligenceCommands, privateConsumers };
}

// ---------------------------------------------------------------------------
// CLI — diff vs contract or write contract.
// ---------------------------------------------------------------------------

function readContract() {
  try {
    return JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diff(label, current, saved) {
  const added = current.filter(x => !saved.includes(x));
  const removed = saved.filter(x => !current.includes(x));
  if (added.length || removed.length) {
    console.log(`\n  ${label}:`);
    added.forEach(x => console.log(`    + ${x}`));
    removed.forEach(x => console.log(`    - ${x}`));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const htmlSource = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
  const intelligenceSource = readFileSync(resolve(ROOT, 'nimbus-intelligence.js'), 'utf8');
  const appSource = readFileSync(resolve(ROOT, 'app.js'), 'utf8');

  const surface = scanLegacySurface({ htmlSource, intelligenceSource, appSource });

  if (process.argv.includes('--write')) {
    writeFileSync(CONTRACT_PATH, JSON.stringify(surface, null, 2) + '\n', 'utf8');
    console.log(`Contract written to ${CONTRACT_PATH}`);
    console.log(`  ${surface.inlineHandlers.length} inline handlers`);
    console.log(`  ${surface.htmlCommands.length} html commands`);
    console.log(`  ${surface.intelligenceCommands.length} intelligence commands`);
    console.log(`  ${surface.privateConsumers.length} private consumers`);
    process.exit(0);
  }

  const saved = readContract();
  if (!saved) {
    console.error('No contract found. Generate it with: node scripts/legacy-surface.mjs --write');
    process.exit(1);
  }

  if (deepEqual(surface, saved)) {
    console.log('Legacy surface matches contract. No drift detected.');
    process.exit(0);
  }

  console.error('Legacy surface has DRIFTED from contract:');
  diff('inlineHandlers (file|attr|expr)', surface.inlineHandlers.map(h => `${h.file}|${h.attribute}|${h.expression}`), saved.inlineHandlers.map(h => `${h.file}|${h.attribute}|${h.expression}`));
  diff('htmlCommands', surface.htmlCommands, saved.htmlCommands);
  diff('intelligenceCommands', surface.intelligenceCommands, saved.intelligenceCommands);
  diff('privateConsumers', surface.privateConsumers, saved.privateConsumers);
  console.error('\nUpdate with: node scripts/legacy-surface.mjs --write');
  process.exit(1);
}
