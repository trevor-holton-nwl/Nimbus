// Contract test for the CQ-1 legacy-surface scanner.
//
// Asserts specific known references exist, then deep-compares the full scan
// result to tests/contracts/cq1-legacy-surface.json. A mismatch means a
// caller was migrated or removed — update the contract only intentionally:
//   node scripts/legacy-surface.mjs --write
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanLegacySurface, discoverModuleSources } from '../../scripts/legacy-surface.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const htmlSource = readFileSync(resolve(ROOT, 'web/index.html'), 'utf8');
const intelligenceSource = readFileSync(resolve(ROOT, 'web/nimbus-intelligence.js'), 'utf8');
const appSource = readFileSync(resolve(ROOT, 'web/app.js'), 'utf8');
const moduleSources = discoverModuleSources(ROOT);

const surface = scanLegacySurface({ htmlSource, intelligenceSource, appSource, moduleSources });

test('discoverModuleSources picks up the CQ-1 extracted .mjs files (blind-spot regression guard)', () => {
  const files = moduleSources.map(m => m.file);
  assert.ok(files.includes('application-foundation.mjs'), files.join(', '));
  assert.ok(files.includes('schedule-state.mjs'), files.join(', '));
  assert.ok(files.includes('app-entry.mjs'), files.join(', '));
});

test('inlineHandlers picks up an onchange-shaped string from an .mjs module, not just index.html/app.js', () => {
  // Regression guard for the exact drift the review flagged: a doc-comment
  // containing an onchange="..."-shaped string moved from app.js into
  // application-foundation.mjs during the migration and silently disappeared
  // from the contract because the scanner only read 3 hardcoded files.
  assert.ok(
    surface.inlineHandlers.some(h => h.file === 'application-foundation.mjs'),
    'expected at least one inlineHandlers entry sourced from application-foundation.mjs'
  );
});

test('surface has version 1', () => {
  assert.equal(surface.version, 1);
});

test('htmlCommands includes Persistence.saveAll', () => {
  assert.ok(surface.htmlCommands.includes('Persistence.saveAll'), surface.htmlCommands.join(', '));
});

test('htmlCommands includes OptimizeDialog.run', () => {
  assert.ok(surface.htmlCommands.includes('OptimizeDialog.run'), surface.htmlCommands.join(', '));
});

test('intelligenceCommands includes Store.tasksArr', () => {
  assert.ok(surface.intelligenceCommands.includes('Store.tasksArr'), surface.intelligenceCommands.join(', '));
});

test('intelligenceCommands includes Compute.utilization', () => {
  assert.ok(surface.intelligenceCommands.includes('Compute.utilization'), surface.intelligenceCommands.join(', '));
});

test('privateConsumers includes GanttFilter._selectedLines', () => {
  assert.ok(surface.privateConsumers.includes('GanttFilter._selectedLines'), surface.privateConsumers.join(', '));
});

test('inlineHandlers contains onclick attributes', () => {
  assert.ok(surface.inlineHandlers.some(x => x.attribute === 'onclick'));
});

test('contract snapshot matches scan result', () => {
  const contractPath = resolve(ROOT, 'tests/contracts/cq1-legacy-surface.json');
  let contract;
  try {
    contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  } catch {
    assert.fail(
      'Contract file missing — generate it with: node scripts/legacy-surface.mjs --write'
    );
  }
  assert.deepStrictEqual(
    surface,
    contract,
    'Scan result drifted from contract. Regenerate with: node scripts/legacy-surface.mjs --write'
  );
});
