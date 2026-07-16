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

import { scanLegacySurface } from '../../scripts/legacy-surface.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const htmlSource = readFileSync(resolve(ROOT, 'web/index.html'), 'utf8');
const intelligenceSource = readFileSync(resolve(ROOT, 'web/nimbus-intelligence.js'), 'utf8');
const appSource = readFileSync(resolve(ROOT, 'web/app.js'), 'utf8');

const surface = scanLegacySurface({ htmlSource, intelligenceSource, appSource });

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
