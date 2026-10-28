// alertOrderIds: the ONE reader of an alert's order fields. A count-aware tool conflict carries many peers
// (`peerIds`), so every consumer that used to assume a pair (`taskId` + `peerId`) goes through it. The source
// gate fails the build when a new `.peerId` read bypasses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertOrderIds, groupAlerts } from '../../../frontend/insights/alert-profiles.mjs';
import { summaryLine, groupCounts } from '../../../frontend/alert-monitor/alert-monitor-model.mjs';

const FRONTEND = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'frontend');

test('alertOrderIds: anchor first, then peerIds, else the single peerId, de-duplicated, blanks dropped', () => {
  assert.deepEqual(alertOrderIds({ taskId: 'a' }), ['a']);
  assert.deepEqual(alertOrderIds({ taskId: 'a', peerId: 'b' }), ['a', 'b']);
  assert.deepEqual(alertOrderIds({ taskId: 'a', peerId: 'b', peerIds: ['b', 'c', 'd'] }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(alertOrderIds({ taskId: 'a', peerIds: ['a', 'b', 'b', '', undefined] }), ['a', 'b'], 'dedupes and drops blanks');
  assert.deepEqual(alertOrderIds({ peerId: 'b' }), ['b']);
  assert.deepEqual(alertOrderIds({}), []);
  assert.deepEqual(alertOrderIds({ taskId: 7, peerIds: [8] }), ['7', '8'], 'ids are strings');
});

test('groupAlerts counts every order a multi-holder tool conflict touches', () => {
  const alert = { id: 'toolc-d|T1', sev: 'err', type: 'tool-conflict', taskId: 'd', peerId: 'a', peerIds: ['a', 'b', 'c'], line: 'L4', time: new Date('2031-01-07T10:00:00Z') };
  const groups = groupAlerts([alert], 'none', { horizonStart: new Date('2031-01-06T00:00:00Z'), horizonMinutes: 60 * 24 * 7, tasksById: {} });
  assert.deepEqual([...groups[0].orderIds].sort(), ['a', 'b', 'c', 'd']);
});

test('Alert Monitor model: summaryLine / groupCounts count every holder as an affected order', () => {
  const alerts = [{ id: 't', sev: 'err', type: 'tool-conflict', taskId: 'd', peerId: 'a', peerIds: ['a', 'b', 'c'], line: 'L4' }];
  assert.equal(groupCounts(alerts, () => false).orders, 4);
  const seen = [];
  summaryLine({ hasPlant: true, alerts, focus: null, confidence: null }, (key, vars) => { seen.push([key, vars]); return key; });
  assert.ok(seen.some(([, vars]) => vars && Object.values(vars).includes(4)), 'the summary reports 4 orders: ' + JSON.stringify(seen));
});

// ---- source gate ----
// Files allowed to touch `peerId` directly, and why. Everything else must call alertOrderIds().
const ALLOWED = new Map([
  // The helper itself and its documentation of the single-peer fallback.
  ['insights/alert-profiles.mts', 'defines alertOrderIds'],
  // The Gantt anchor object (NOT an alert): gotoLineDay keeps a single peer = the earliest holder.
  ['scheduling/gantt.mts', 'gotoLineDay anchor.peerId is an anchor object; the single earliest holder'],
  // Builds that anchor object ({ taskId, peerId }) from alertOrderIds(); the alert itself is never read.
  ['insights/insights-ui.mts', 'builds the gotoLineDay anchor object from alertOrderIds'],
]);

// One regex per way of reading the field: member access, destructuring / one-line object braces, bracket access.
const PEERID_READS = [
  ['member access', /\.peerId\b/],
  ['destructuring / braces', /\{[^{}]*\bpeerId\b[^{}]*\}/],
  ['bracket access', /\[\s*(?:'peerId'|"peerId"|\x60peerId\x60)\s*\]/],
];
function peerIdReads(line) {
  // Type-position declarations (`peerId?: string`) are not reads.
  const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').replace(/\bpeerId\??:\s*(?:string|number|unknown)\b/g, 'PEERID_TYPE');
  return PEERID_READS.filter(([, re]) => re.test(code)).map(([name]) => name);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'node_modules') walk(p, out); continue; }
    if (p.endsWith('.mts') || p.endsWith('.js')) out.push(p);
    // A .mjs with an .mts twin is compiled output; a hand-written .mjs is scanned.
    else if (p.endsWith('.mjs') && !existsSync(p.slice(0, -4) + '.mts')) out.push(p);
  }
  return out;
}

test('source gate patterns catch member access, destructuring and bracket access (synthetic)', () => {
  assert.deepEqual(peerIdReads('const x = a.peerId;'), ['member access']);
  assert.deepEqual(peerIdReads('const { peerId } = alert;'), ['destructuring / braces']);
  assert.deepEqual(peerIdReads('const { taskId, peerId: other } = alert;'), ['destructuring / braces']);
  assert.deepEqual(peerIdReads('function f({ peerId }) {}'), ['destructuring / braces']);
  assert.deepEqual(peerIdReads("const x = a['peerId'];"), ['bracket access']);
  assert.deepEqual(peerIdReads('const x = a["peerId"];'), ['bracket access']);
  assert.deepEqual(peerIdReads('const x = a[`peerId`];'), ['bracket access']);
  assert.deepEqual(peerIdReads('// a.peerId in a comment'), []);
  assert.deepEqual(peerIdReads('alertOrderIds(a).slice(1)'), []);
  assert.deepEqual(peerIdReads('anchor?: { taskId?: string; peerId?: string }): void'), [], 'a type declaration is not a read');
  assert.deepEqual(peerIdReads('  peerIds: holderIds,'), [], 'peerIds and multi-line writes are not reads');
});

test('source gate: no `peerId` read bypasses alertOrderIds outside the documented exceptions', () => {
  const offenders = [];
  for (const file of walk(FRONTEND)) {
    const rel = relative(FRONTEND, file).split(sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      const kinds = peerIdReads(line);
      if (kinds.length) offenders.push(`${rel}:${i + 1} [${kinds.join(', ')}]: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], 'read an alert\'s orders through alertOrderIds(a) (frontend/insights/alert-profiles.mts); a tool conflict has many peers:\n' + offenders.join('\n'));
});

test('source gate: the exception list is not stale (every allowed file still mentions peerId)', () => {
  for (const rel of ALLOWED.keys()) {
    assert.match(readFileSync(join(FRONTEND, rel), 'utf8'), /peerId/, `${rel} no longer mentions peerId: drop it from ALLOWED`);
  }
});
