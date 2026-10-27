// Tests for frontend/setup/setup-admin.mjs (SetupAdmin).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SetupAdmin } from '../../../frontend/setup/setup-admin.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';

test('SetupAdmin keeps read, copy, and export available to non-writers', () => {
  // Regression target: hiding the entire matrix UI from a scheduler/preview
  // user would remove the inspection and export access Stage 0 requires.
  assert.deepEqual(SetupAdmin.permissionsFor({ isAdmin: false, setupScheduler: false, plantAllowed: false }), {
    read: true, copy: true, export: true, definitionWrite: false, matrixWrite: false, stateWrite: false,
  });
  assert.deepEqual(SetupAdmin.permissionsFor({ isAdmin: false, setupScheduler: true, plantAllowed: true }), {
    read: true, copy: true, export: true, definitionWrite: false, matrixWrite: false, stateWrite: true,
  });
});

test('SetupAdmin does not offer retired Production Version as a setup-signature field', () => {
  // Regression target: a retired optimization dimension could still be added
  // to a new signature when a stale registry response reached this editor.
  assert.deepEqual(SetupAdmin.registeredFields([
    { field_key: 'colorWheel' }, { field_key: 'prt01' },
    { field_key: 'prt02' }, { field_key: 'productionVersion' },
  ]), ['colorWheel', 'prt01', 'prt02']);
});

test('SetupAdmin removes a signature field from the draft but never empties the signature', () => {
  // Regression target: the editor could only grow or reorder a signature,
  // forcing an administrator to create a new definition to remove one field.
  assert.deepEqual(SetupAdmin.removeSignatureField(['colorWheel', 'prt01', 'prt02'], 1), ['colorWheel', 'prt02']);
  assert.deepEqual(SetupAdmin.removeSignatureField(['colorWheel'], 0), ['colorWheel']);
});

test('setup signature editor exposes accessible removal and a version suffix stays out of the visible label', () => {
  // Regression target: a visible version suffix obscures the action label.
  // (The "settings has one fixed strip plus a scrollable body" half of this
  // regression target lives in Plant's Settings pane, now in
  // tests/modules/master-data/admin-ui.test.mjs, since Plant and SetupAdmin
  // split into different files in Phase P2 of
  // docs/architecture/domain-refactor-plan.md.)
  const source = readFileSync(new URL('../../../frontend/setup/setup-admin.mts', import.meta.url), 'utf8');
  assert.match(source, /data-setup-field-remove=.*aria-label=/);
  assert.match(source, /data-setup-field-remove=.*definitionFields\.length === 1 \? 'disabled' : ''/);
  assert.doesNotMatch(source, /data-setup-signature-edit[^>]*>[^<]*v\$\{version/);
});

test('SetupAdmin bounds missing-setup review data and reserves the editor for writers', () => {
  // Regression target: exposing a matrix editor to readers, or handing an
  // unbounded candidate table across the preview/admin boundary.
  const pairs = Array.from({ length: 14 }, (_, index) => ({
    line: 'L-1', predecessorOrderId: `before-${index}`, successorOrderId: `after-${index}`,
    fromState: 'colorWheel=RED', toState: 'colorWheel=BLUE', reason: 'matrix-missing',
    remedy: 'Add a setup matrix row for this transition',
  }));
  const csv = SetupAdmin.missingPairsCsv('5512', pairs);
  assert.match(csv, /Plant,Line,Predecessor order,Successor order,From setup state,To setup state,Reason,Remedy/);
  assert.equal(csv.trim().split('\n').length, 13, 'the review export caps rows at the preview boundary');
  assert.equal(SetupAdmin.reviewAction({ matrixWrite: true }), 'editor');
  assert.equal(SetupAdmin.reviewAction({ matrixWrite: false }), 'copy-export');
});

test('SetupAdmin plans a cross-plant missing-setup handoff even when its pane is hidden', () => {
  // Regression target: review used to render only an already-visible pane,
  // leaving a preview from another plant with nowhere usable to go.
  assert.deepEqual(SetupAdmin.reviewNavigation('5512', '1006', false), {
    selectPlant: true,
    openMasterData: true,
    masterSub: 'plant',
    plantTab: 'settings',
    renderAfterNavigation: true,
  });
});

test('SetupAdmin only grants state writes to an explicitly scoped setup scheduler', () => {
  // Regression target: treating any authenticated non-admin as a scheduler
  // would show a write control that the server must reject.
  assert.equal(SetupAdmin.permissionsFor({ isAdmin: false, setupScheduler: true, plantAllowed: true }).stateWrite, true);
  assert.equal(SetupAdmin.permissionsFor({ isAdmin: false, setupScheduler: false, plantAllowed: true }).stateWrite, false);
  assert.equal(SetupAdmin.permissionsFor({ isAdmin: false, setupScheduler: true, plantAllowed: false }).stateWrite, false);
});

test('SetupAdmin resolves sparse line rows over inherited plant rows and deletes only the override', () => {
  // Regression target: treating an override deletion as a plant-row deletion
  // would erase the shared standard instead of revealing it again.
  const from = [{ fieldKey: 'COLOR', value: 'RED' }];
  const to = [{ fieldKey: 'COLOR', value: 'BLUE' }];
  const plant = { machine: '', signature_version: 4, from_key: from, to_key: to, setup_min: 20, source: 'manual' };
  const line = { machine: 'L-10', signature_version: 4, from_key: from, to_key: to, setup_min: 7, source: 'manual' };
  assert.deepEqual(SetupAdmin.effectiveRows({ plantRows: [plant], machineRows: [line], machine: 'L-10', version: 4 }), [{
    ...line, inherited: false, inheritedFromPlant: false,
  }]);
  assert.deepEqual(SetupAdmin.deleteRequest(line), {
    machine: 'L-10', signature_version: 4, rows: [line],
  });
  assert.equal(SetupAdmin.effectiveRows({ plantRows: [plant], machineRows: [], machine: 'L-10', version: 4 })[0].setup_min, 20);
  assert.equal(SetupAdmin.effectiveRows({ plantRows: [plant], machineRows: [], machine: 'L-10', version: 4 })[0].inherited, true);
});

test('SetupAdmin.deleteAllConfirmationMatches requires the exact (trimmed) plant code before enabling the destructive action', () => {
  // Regression target for the D3 "delete all rows" typed confirmation
  // (OD-D3a) — a partial, case-varied, or blank match must never enable it.
  assert.equal(SetupAdmin.deleteAllConfirmationMatches('5512', '5512'), true);
  assert.equal(SetupAdmin.deleteAllConfirmationMatches('  5512  ', '5512'), true, 'surrounding whitespace in the typed value is trimmed');
  assert.equal(SetupAdmin.deleteAllConfirmationMatches('', '5512'), false, 'an empty typed value never matches');
  assert.equal(SetupAdmin.deleteAllConfirmationMatches('551', '5512'), false, 'a partial match never matches');
  assert.equal(SetupAdmin.deleteAllConfirmationMatches('5512X', '5512'), false, 'an over-typed match never matches');
  assert.equal(SetupAdmin.deleteAllConfirmationMatches('5512', ''), false, 'a blank plant can never be satisfied, even by an empty typed value');
});

test('SetupAdmin blocks stale writes and reports why activation is unavailable after a definition change', () => {
  // Regression target: submitting an old signature version after the fields
  // changed could write rows that can never resolve against the new definition.
  assert.equal(SetupAdmin.canWriteVersion(3, 4), false);
  assert.match(SetupAdmin.activationStatus({ active: false, signature_version: 4, fields: ['COLOR'] }, { matrixVersion: 3, coveragePass: true }).reason,
    /version-matched matrix/i);
  assert.match(SetupAdmin.activationStatus({ active: false, signature_version: 4, fields: ['COLOR'] }, { matrixVersion: 4, coveragePass: false }).reason,
    /coverage pass/i);
});

test('SetupAdmin.activationStatus reads plant_active (the D2-relocated gate), not the vestigial definition.active', () => {
  // Regression target: the status chip must key off plants.setup_active
  // (passed in as the third argument) once definition readiness clears —
  // definition.active is deliberately ignored here even when true, and the
  // omitted third argument (every pre-D2 caller/test) must keep defaulting
  // to false rather than throwing or silently reporting active.
  const readyDefinition = { active: true, signature_version: 4, fields: ['COLOR'] };
  const readyChecks = { matrixVersion: 4, coveragePass: true };
  assert.equal(SetupAdmin.activationStatus(readyDefinition, readyChecks, true).active, true);
  assert.equal(SetupAdmin.activationStatus(readyDefinition, readyChecks, false).active, false);
  assert.equal(SetupAdmin.activationStatus(readyDefinition, readyChecks).active, false,
    'omitting plantActive must default to inactive, not throw or read definition.active');
  // definition.active === false must not force inactive when plant_active is true —
  // proof the two gates are read from genuinely independent sources.
  assert.equal(SetupAdmin.activationStatus({ ...readyDefinition, active: false }, readyChecks, true).active, true);
});

test('SetupAdmin exports canonical long-form columns with plant, line, and version metadata', () => {
  // Regression target: changing labels or omitting scope/version makes an
  // exported file impossible to import deterministically into this editor.
  assert.deepEqual(SetupAdmin.csvColumns(), [
    'Plant', 'Line', 'Signature version', 'From setup state', 'To setup state', 'Setup minutes',
  ]);
});

test('SetupAdmin uses registered setup keys and reversibly parses canonical long-form CSV', () => {
  // Regression target: task DTO names (COLOR) would be rejected by the
  // backend, while delimiter-joined values could not be imported safely.
  assert.deepEqual(SetupAdmin.registeredFields([{ field_key: 'colorWheel' }, { field_key: 'prt01' }]), ['colorWheel', 'prt01']);
  const csv = [
    'Plant,Line,Signature version,From setup state,To setup state,Setup minutes',
    '5512,LINE-1,4,"[{""fieldKey"":""colorWheel"",""value"":""A|B""}]","[{""fieldKey"":""colorWheel"",""value"":""C,D""}]",12',
  ].join('\r\n');
  assert.deepEqual(SetupAdmin.parseLongFormCsv(csv), {
    plant: '5512', machine: 'LINE-1', signature_version: 4,
    rows: [{ from: [{ fieldKey: 'colorWheel', value: 'A|B' }], to: [{ fieldKey: 'colorWheel', value: 'C,D' }], setup_min: 12 }],
  });
});

test('SetupAdmin reports pre-coverage activation truthfully until coverage is available', () => {
  // Regression target: a hardcoded false coverage result falsely claims a
  // coverage failure before Task 7 exposes the coverage API.
  const status = SetupAdmin.activationStatus({ active: false, signature_version: 4, fields: ['colorWheel'] }, { matrixVersion: 4 });
  assert.match(status.reason, /coverage has not been measured/i);
});

test('SetupAdmin loads every plant-line page without requesting an unbounded list', async () => {
  // Regression target: the first 100 lines silently omitted every later line
  // at scale, despite the server providing a paged total.
  const calls = [];
  const lines = await SetupAdmin.collectPagedLines(async (offset, limit) => {
    calls.push({ offset, limit });
    return offset === 0
      ? { rows: [{ machine: 'L-100' }, { machine: 'L-001' }], meta: { total: 3 } }
      : { rows: [{ machine: 'L-250' }], meta: { total: 3 } };
  }, 2);
  assert.deepEqual(lines, ['L-001', 'L-100', 'L-250']);
  assert.deepEqual(calls, [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }]);
});

test('SetupAdmin.collectAllScopeRows scopes the "delete all" fetch by machine, not the stale "line" param', async () => {
  // Regression target: GET /setup/{plant}/matrix-rows reads `machine`, not
  // `line` (renamed by an earlier workstream) — FastAPI silently ignores an
  // unrecognized query param, so a `line=` request always returns the
  // plant-default rows regardless of which machine is selected, making
  // "delete all rows in this scope" delete the wrong rows for any
  // machine-scoped view.
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    seen.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [], meta: { total: 0 } }) });
  };
  try {
    await SetupAdmin.collectAllScopeRows('5512', 'L-10');
    assert.equal(seen.length, 1);
    const query = new URL(seen[0], 'http://localhost').searchParams;
    assert.equal(query.get('machine'), 'L-10', 'must send machine=, not line=');
    assert.equal(query.get('line'), null, 'must not send a line= param at all');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SetupAdmin.fetchListRows scopes the List view page fetch by machine, not the stale "line" param', async () => {
  // Same regression family as collectAllScopeRows above: this call site
  // still built its params as { line: _lineScope, ... } until fixed, so a
  // machine selected in the List view combobox never actually reached the
  // backend and the view always rendered plant-default rows.
  const seen = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    seen.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [], meta: { total: 0, offset: 0, limit: 50 } }) });
  };
  try {
    const definition = { active: true, signature_version: 4, fields: ['colorWheel'] };
    await SetupAdmin.fetchListRows('5512', definition, null, 'L-10');
    assert.equal(seen.length, 1);
    const query = new URL(seen[0], 'http://localhost').searchParams;
    assert.equal(query.get('machine'), 'L-10', 'must send machine=, not line=');
    assert.equal(query.get('line'), null, 'must not send a line= param at all');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('SetupAdmin.invalidatePlant drops the per-plant line and coverage caches so the next render re-fetches them', async () => {
  // Regression target: loadScopeLines/loadCoverage early-return on a cached
  // plant and never expire, so a Master Data Refresh could not reach this pane.
  const plant = 'P-INVAL';
  const priorFetch = Util.fetchTraced;
  const priorPlant = Store.selectedPlant;
  const priorSnapshot = Store.setupSnapshot;
  const urls = [];
  Util.fetchTraced = (url) => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [{ machine: 'M1' }], meta: { total: 1 } }) });
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const count = (needle) => urls.filter(u => u.includes(needle)).length;
  try {
    // A different selected plant makes render's post-load repaint a no-op, so no DOM is needed.
    Store.setSelectedPlant(null, 'test');
    Store.replaceSetupSnapshot({ plant }, 'test');
    const target = { innerHTML: '' };

    SetupAdmin.render(target, plant);
    await settle();
    assert.equal(count(`/master-data/machine?plant=${plant}`), 1);
    assert.equal(count(`/setup/${plant}/coverage`), 1);

    SetupAdmin.render(target, plant);
    await settle();
    assert.equal(count(`/master-data/machine?plant=${plant}`), 1, 'cached: no second line fetch');
    assert.equal(count(`/setup/${plant}/coverage`), 1, 'cached: no second coverage fetch');

    SetupAdmin.invalidatePlant(plant);
    SetupAdmin.render(target, plant);
    await settle();
    assert.equal(count(`/master-data/machine?plant=${plant}`), 2, 'invalidated: lines re-fetched');
    assert.equal(count(`/setup/${plant}/coverage`), 2, 'invalidated: coverage re-fetched');
  } finally {
    Util.fetchTraced = priorFetch;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.replaceSetupSnapshot(priorSnapshot, 'test-restore');
  }
});

// Setup Matrix grid redesign (docs/archive/setup_matrix_ui_redesign.md) — the
// from-state x to-state grid replacing the old flat edge-list table.

test('cartesianStates builds one state per combination, in field order', () => {
  const states = SetupAdmin.cartesianStates(['colorWheel', 'prt01'], { colorWheel: ['BLUE', 'RED'], prt01: ['A12'] });
  assert.equal(states.length, 2);
  assert.deepEqual(states.map(s => s.parts), [['BLUE', 'A12'], ['RED', 'A12']]);
  assert.deepEqual(states[0].key, [{ fieldKey: 'colorWheel', value: 'BLUE' }, { fieldKey: 'prt01', value: 'A12' }]);
});

test('stateSig matches regardless of key part order — a real row must resolve against a synthesized candidate state', () => {
  const candidate = SetupAdmin.cartesianStates(['colorWheel', 'prt01'], { colorWheel: ['RED'], prt01: ['A12'] })[0];
  const storedRow = { machine: '', signature_version: 1, from_key: [{ fieldKey: 'prt01', value: 'A12' }, { fieldKey: 'colorWheel', value: 'RED' }], to_key: [], setup_min: 5 };
  assert.equal(SetupAdmin.stateSig(candidate.key), SetupAdmin.stateSig(storedRow.from_key));
});

test('reviewStateSigFromText matches stateSig regardless of the optimizer preview text\'s part order', () => {
  const candidate = SetupAdmin.cartesianStates(['colorWheel', 'prt01'], { colorWheel: ['RED'], prt01: ['A12'] })[0];
  // schedule-workbench.mts's describeMissingPairs formats states as
  // "fieldKey=value | fieldKey=value" (see stateForOrder/text there) — same
  // shape keyText() produces in this file, unordered.
  assert.equal(SetupAdmin.reviewStateSigFromText('prt01=A12 | colorWheel=RED'), SetupAdmin.stateSig(candidate.key));
  assert.equal(SetupAdmin.reviewStateSigFromText('colorWheel=RED | prt01=A12'), SetupAdmin.stateSig(candidate.key));
});

test('reviewStateSigFromText returns null for missing/placeholder text', () => {
  assert.equal(SetupAdmin.reviewStateSigFromText(null), null);
  assert.equal(SetupAdmin.reviewStateSigFromText(undefined), null);
  assert.equal(SetupAdmin.reviewStateSigFromText(''), null);
});

test('fieldValueSet unions plant-default and line-override ranked values', () => {
  const rankMaps = { '': { colorWheel: { RED: 1, BLUE: 2 } }, L1: { colorWheel: { BLUE: 1, GREEN: 2 } } };
  assert.deepEqual(SetupAdmin.fieldValueSet(rankMaps, 'colorWheel', ''), ['BLUE', 'RED']);
  assert.deepEqual(SetupAdmin.fieldValueSet(rankMaps, 'colorWheel', 'L1'), ['BLUE', 'GREEN', 'RED']);
});

test('buildGridModel resolves an existing row regardless of from/to array order', () => {
  const rows = [{ machine: '', signature_version: 1, from_key: [{ fieldKey: 'colorWheel', value: 'RED' }], to_key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], setup_min: 12, inherited: false, inheritedFromPlant: false }];
  const model = SetupAdmin.buildGridModel(['colorWheel'], { colorWheel: ['RED', 'BLUE'] }, rows);
  const red = model.rowStates.find(s => s.parts[0] === 'RED');
  const blue = model.colStates.find(s => s.parts[0] === 'BLUE');
  const found = model.cellLookup.get(red.sig)?.get(blue.sig);
  assert.equal(found?.setup_min, 12);
});

test('gridCellValue: identical states default to 0, any other missing pair is unknown (null), never a fabricated zero', () => {
  // Mirrors docs/changeover_matrix.md's resolution rule: "For A != B, missing
  // means unknown, never zero... the only missing-row case that may resolve
  // to zero" is the diagonal.
  const red = { key: [], sig: 'colorWheel=RED', parts: ['RED'] };
  const blue = { key: [], sig: 'colorWheel=BLUE', parts: ['BLUE'] };
  assert.equal(SetupAdmin.gridCellValue(red, red, undefined, undefined), 0);
  assert.equal(SetupAdmin.gridCellValue(red, blue, undefined, undefined), null);
  assert.equal(SetupAdmin.gridCellValue(red, blue, { setup_min: 7 }, undefined), 7);
  assert.equal(SetupAdmin.gridCellValue(red, blue, undefined, { setup_min: 3 }), 3);
  assert.equal(SetupAdmin.gridCellValue(red, blue, undefined, { setup_min: null }), null);
});

test('gridCellState distinguishes the six cell states (docs/Setup_matrix_redesign.md §7)', () => {
  const red = { key: [], sig: 'colorWheel=RED', parts: ['RED'] };
  const blue = { key: [], sig: 'colorWheel=BLUE', parts: ['BLUE'] };
  // dirty always wins, even over an existing row
  assert.equal(SetupAdmin.gridCellState(red, blue, { setup_min: 7, inherited: false }, { setup_min: 3 }, ''), 'dirty');
  // no row, off-diagonal: uncovered — never a fabricated value
  assert.equal(SetupAdmin.gridCellState(red, blue, undefined, undefined, ''), 'uncovered');
  // no row, diagonal: implicit zero — structurally free, not recorded
  assert.equal(SetupAdmin.gridCellState(red, red, undefined, undefined, ''), 'implicit-zero');
  // a row exists on the diagonal: an engineer recorded this explicitly
  assert.equal(SetupAdmin.gridCellState(red, red, { setup_min: 10, inherited: false }, undefined, ''), 'diagonal-explicit');
  // line scoped, row not inherited from the plant default: an explicit line override
  assert.equal(SetupAdmin.gridCellState(red, blue, { setup_min: 5, inherited: false }, undefined, 'L1'), 'line-override');
  // line scoped, row inherited from the plant default: not an override
  assert.equal(SetupAdmin.gridCellState(red, blue, { setup_min: 5, inherited: true }, undefined, 'L1'), 'plant-default');
  // no line scope at all: always plant-default, never "override"
  assert.equal(SetupAdmin.gridCellState(red, blue, { setup_min: 5, inherited: false }, undefined, ''), 'plant-default');
});

test('capAxis bounds the rendered universe and reports what was hidden (docs/Setup_matrix_redesign.md §6)', () => {
  const states = SetupAdmin.cartesianStates(['colorWheel'], { colorWheel: ['A', 'B', 'C', 'D', 'E'] });
  const uncapped = SetupAdmin.capAxis(states, 60);
  assert.equal(uncapped.states.length, 5);
  assert.equal(uncapped.truncated, false);
  const capped = SetupAdmin.capAxis(states, 3);
  assert.equal(capped.states.length, 3);
  assert.equal(capped.total, 5);
  assert.equal(capped.truncated, true);
});

test('fieldLabel translates the shared constraint.<key> vocabulary, falling back to the raw key', () => {
  assert.equal(typeof SetupAdmin.fieldLabel('colorWheel'), 'string');
  assert.equal(SetupAdmin.fieldLabel('colorWheel').length > 0, true);
  assert.equal(SetupAdmin.fieldLabel('not_a_real_field'), 'not_a_real_field');
});

test('filterStates matches any field part, case-insensitively, and preserves order', () => {
  const states = SetupAdmin.cartesianStates(['colorWheel'], { colorWheel: ['RED', 'BLUE', 'GREEN'] });
  assert.deepEqual(SetupAdmin.filterStates(states, 'blu').map(s => s.parts[0]), ['BLUE']);
  assert.deepEqual(SetupAdmin.filterStates(states, '').map(s => s.parts[0]), ['RED', 'BLUE', 'GREEN']);
});

test('tierRuns groups by prefix per tier, not merging non-adjacent groups that share a later value', () => {
  const states = SetupAdmin.cartesianStates(['colorWheel', 'prt01'], { colorWheel: ['BLUE', 'RED'], prt01: ['A', 'B'] });
  // BLUE/A, BLUE/B, RED/A, RED/B
  assert.deepEqual(SetupAdmin.tierRuns(states, 0), [{ value: 'BLUE', start: 0, span: 2 }, { value: 'RED', start: 2, span: 2 }]);
  // tier 1 must NOT merge BLUE/A's "A" with RED/A's "A" into one run — they share a value but not the tier-0 prefix.
  assert.deepEqual(SetupAdmin.tierRuns(states, 1), [{ value: 'A', start: 0, span: 1 }, { value: 'B', start: 1, span: 1 }, { value: 'A', start: 2, span: 1 }, { value: 'B', start: 3, span: 1 }]);
});

test('parseGridMinutes accepts 0-10080 whole minutes, clears on blank, rejects out-of-range/non-numeric', () => {
  assert.equal(SetupAdmin.parseGridMinutes('45'), 45);
  assert.equal(SetupAdmin.parseGridMinutes(' 45 '), 45);
  assert.equal(SetupAdmin.parseGridMinutes(''), null);
  assert.equal(SetupAdmin.parseGridMinutes('  '), null);
  assert.equal(SetupAdmin.parseGridMinutes('-1'), 'invalid');
  assert.equal(SetupAdmin.parseGridMinutes('10081'), 'invalid');
  assert.equal(SetupAdmin.parseGridMinutes('abc'), 'invalid');
});

test('buildSaveRequests: line-scoped edits are a sparse upsert of only the edited rows', () => {
  const red = { key: [{ fieldKey: 'colorWheel', value: 'RED' }], sig: 'colorWheel=RED', parts: ['RED'] };
  const blue = { key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], sig: 'colorWheel=BLUE', parts: ['BLUE'] };
  const { upsert, deletes } = SetupAdmin.buildSaveRequests([{ row: red, col: blue, setup_min: 20, machine: 'L1' }], 4, []);
  assert.deepEqual(upsert, [{ machine: 'L1', signature_version: 4, rows: [{ from: red.key, to: blue.key, setup_min: 20 }] }]);
  assert.deepEqual(deletes, []);
});

test('buildSaveRequests: plant-default edits merge into the FULL existing row set (replace_plant_matrix is delete-then-insert)', () => {
  const red = { key: [{ fieldKey: 'colorWheel', value: 'RED' }], sig: 'colorWheel=RED', parts: ['RED'] };
  const blue = { key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], sig: 'colorWheel=BLUE', parts: ['BLUE'] };
  const green = { key: [{ fieldKey: 'colorWheel', value: 'GREEN' }], sig: 'colorWheel=GREEN', parts: ['GREEN'] };
  const existingUntouchedRow = { machine: '', signature_version: 4, from_key: green.key, to_key: blue.key, setup_min: 99 };
  const { upsert } = SetupAdmin.buildSaveRequests([{ row: red, col: blue, setup_min: 20, machine: '' }], 4, [existingUntouchedRow]);
  assert.equal(upsert.length, 1);
  assert.equal(upsert[0].machine, '');
  // The edited pair AND the untouched existing row must both be present —
  // sending only the edited cell here would silently wipe the untouched row.
  assert.equal(upsert[0].rows.length, 2);
  assert.ok(upsert[0].rows.some(r => r.setup_min === 20 && r.from[0].value === 'RED'));
  assert.ok(upsert[0].rows.some(r => r.setup_min === 99 && r.from[0].value === 'GREEN'));
});

test('buildSaveRequests: a plant-default clear removes that pair from the resent set', () => {
  const red = { key: [{ fieldKey: 'colorWheel', value: 'RED' }], sig: 'colorWheel=RED', parts: ['RED'] };
  const blue = { key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], sig: 'colorWheel=BLUE', parts: ['BLUE'] };
  const existingRow = { machine: '', signature_version: 4, from_key: red.key, to_key: blue.key, setup_min: 20 };
  const { upsert, deletes } = SetupAdmin.buildSaveRequests([{ row: red, col: blue, setup_min: null, machine: '' }], 4, [existingRow]);
  assert.equal(upsert[0].rows.length, 0);
  assert.deepEqual(deletes, []); // plant-default clears are folded into the resend, not a separate DELETE call
});

test('buildSaveRequests: plant-default replace carries stored provenance and the plant matrix token', () => {
  const red = { key: [{ fieldKey: 'colorWheel', value: 'RED' }], sig: 'colorWheel=RED', parts: ['RED'] };
  const blue = { key: [{ fieldKey: 'colorWheel', value: 'BLUE' }], sig: 'colorWheel=BLUE', parts: ['BLUE'] };
  const green = { key: [{ fieldKey: 'colorWheel', value: 'GREEN' }], sig: 'colorWheel=GREEN', parts: ['GREEN'] };
  const existing = { machine: '', signature_version: 4, from_key: green.key, to_key: blue.key, setup_min: 99,
    source: 'imported', source_metadata: { file: 'a.csv' }, source_reference: 'ref-1' };
  const { upsert } = SetupAdmin.buildSaveRequests([{ row: red, col: blue, setup_min: 20, machine: '' }], 4, [existing], 'tok-1');
  assert.equal(upsert[0].plant_matrix_token, 'tok-1');
  const kept = upsert[0].rows.find(r => r.setup_min === 99);
  assert.equal(kept.source, 'imported');
  assert.deepEqual(kept.source_metadata, { file: 'a.csv' });
  assert.equal(kept.source_reference, 'ref-1');
  // line-scoped upserts never carry the plant token
  const line = SetupAdmin.buildSaveRequests([{ row: red, col: blue, setup_min: 20, machine: 'L1' }], 4, [], 'tok-1');
  assert.equal(line.upsert[0].plant_matrix_token, undefined);
});

test('state editor / compatibility mount on the inline state container that actually exists (#47)', () => {
  const source = readFileSync(new URL('../../../frontend/setup/setup-admin.mts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.setup-state \.panel-body/, 'the old Line Status panel no longer exists; selecting it made Update state a no-op');
  assert.match(source, /querySelector<HTMLElement>\('\[data-setup-state-inline\]'\)/);
});

test('grid listeners read the current render context, not the first render closure (#47)', () => {
  const source = readFileSync(new URL('../../../frontend/setup/setup-admin.mts', import.meta.url), 'utf8');
  assert.match(source, /_setupGridCtx = \{ snapshot: snapshot0/);
  assert.match(source, /const \{ snapshot, definition, rows, permissions \} = ctx\(\)/);
});


test('compatibility can be restored, retries preserve the draft, and each save uses the mounted line', async t => {
  const { Toast } = await import('../../../frontend/platform/foundation.mjs');
  const { Persistence } = await import('../../../frontend/scheduling/persistence.mjs');
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Persistence, 'noteSetupWrite', () => {});
  globalThis.window ||= {};
  const nodes = Object.fromEntries(['compatible', 'compatibility-reason', 'save-compatibility'].map(key => [key, {
    checked: false, disabled: false, value: 'Blocked', listeners: {}, focus() {}, addEventListener(type, fn) { this.listeners[type] = fn; },
  }]));
  const compat = { className: '', innerHTML: '', querySelector: selector => nodes[selector.replace('[data-setup-', '').replace(']', '')] };
  const previous = globalThis.document;
  globalThis.document = { createElement: () => compat };
  t.after(() => { globalThis.document = previous; });
  await SetupAdmin._wireCompatibilityForTest({ querySelector: () => ({ appendChild() {} }) }, { plant: 'A' }, 'LINE1', false);
  const cb = nodes.compatible; const save = nodes['save-compatibility'];
  cb.checked = true; cb.listeners.change();
  assert.equal(save.disabled, false, 'checking compatibility must enable Save');
  const requests = [];
  t.mock.method(Util, 'fetchTraced', async (url, opts) => {
    requests.push({ url, data: JSON.parse(opts.body) });
    return { ok: requests.length > 1, status: 500 };
  });
  await save.listeners.click();
  assert.equal(cb.checked, true, 'failed write retains the requested compatible state');
  assert.equal(save.disabled, false, 'failure remains retryable');
  const saveFirstLine = save.listeners.click;
  await SetupAdmin._wireCompatibilityForTest({ querySelector: () => ({ appendChild() {} }) }, { plant: 'A' }, 'LINE2', false);
  await saveFirstLine();
  assert.match(requests[1].url, /A\/lines\/LINE1\/compatibility$/);
  assert.deepEqual(requests[1].data, { setup_compatible: true, reason: '' });
  assert.equal(save.disabled, true, 'saved baseline is clean');
});

test('master-data-changed clears the selected plant\'s SetupAdmin scope caches so a new machine appears without a reload', async () => {
  const plant = 'P-MDC';
  const priorFetch = Util.fetchTraced, priorPlant = Store.selectedPlant;
  const priorSnapshot = Store.setupSnapshot, priorMasterData = Store.masterData;
  const urls = [];
  Util.fetchTraced = (url) => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ rows: [{ machine: 'M1' }], meta: { total: 1 } }) });
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  const lineFetches = () => urls.filter(u => u.includes(`/master-data/machine?plant=${plant}`)).length;
  try {
    // Selected plant != render plant keeps the post-load repaint a no-op (no DOM needed).
    Store.setSelectedPlant(null, 'test');
    Store.replaceSetupSnapshot({ plant }, 'test');
    const target = { innerHTML: '' };
    SetupAdmin.render(target, plant);
    await settle();
    assert.equal(lineFetches(), 1);

    Store.setMasterData({ plants: [], lines: [] }, 'master-data-save', 'machine');
    SetupAdmin.render(target, plant);
    await settle();
    assert.equal(lineFetches(), 1, 'no selected plant: caches untouched');

    Store.setSelectedPlant(plant, 'test');
    Store.setMasterData({ plants: [], lines: [] }, 'master-data-save', 'machine');
    Store.setSelectedPlant(null, 'test');
    SetupAdmin.render(target, plant);
    await settle();
    assert.equal(lineFetches(), 2, 'master-data-changed for the selected plant dropped its cached lines');
  } finally {
    Util.fetchTraced = priorFetch;
    Store.setSelectedPlant(priorPlant, 'test-restore');
    Store.replaceSetupSnapshot(priorSnapshot, 'test-restore');
    Store.setMasterData(priorMasterData, 'test-restore');
  }
});

// ── Mass-upload validation: resolveFromKey cache, counted reads, debounce (workload relief step 4) ──────────────

/** The pre-cache implementation, kept verbatim as the parity oracle: rebuild the cartesian states and `find` the first match. */
function legacyResolveFromKey(fields, filterText, rankMaps, lineScope) {
  const q = filterText.trim();
  if (!q) return null;
  const valuesByField = {};
  fields.forEach(field => { valuesByField[field] = SetupAdmin.fieldValueSet(rankMaps, field, lineScope); });
  const candidates = SetupAdmin.cartesianStates(fields, valuesByField);
  const match = candidates.find(state => state.parts.join(' · ').toLowerCase() === q.toLowerCase() || state.sig === q);
  return match ? match.key : null;
}

function withRankMaps(maps, fn) {
  const prior = Store.priorityRankMaps;
  Store.setPriorityRankMaps(maps, 'unit-test');
  try { return fn(); } finally { Store.setPriorityRankMaps(prior, 'unit-test'); }
}

const rankMapsFor = (colors, tools, lineColors = []) => ({
  '': { colorWheel: Object.fromEntries(colors.map((c, i) => [c, i + 1])), prt01: Object.fromEntries(tools.map((t, i) => [t, i + 1])) },
  ...(lineColors.length ? { 'L-9': { colorWheel: Object.fromEntries(lineColors.map((c, i) => [c, i + 1])) } } : {}),
});

test('resolveFromKey matches the old linear find: display text (case-insensitive), signature, misses and blanks', () => {
  const fields = ['colorWheel', 'prt01'];
  const maps = rankMapsFor(['Blue', 'Red', 'green'], ['T1', 'T2']);
  withRankMaps(maps, () => {
    const probes = ['Blue · T1', 'blue · t1', 'RED · T2', 'green · T2', 'colorWheel=Red|prt01=T1', 'prt01=T1|colorWheel=Red',
      'Red', 'Blue · T9', '', '   ', 'Blue · T1 '];
    for (const probe of probes) {
      assert.deepEqual(SetupAdmin.resolveFromKey(fields, probe, ''), legacyResolveFromKey(fields, probe, maps, ''), `probe "${probe}"`);
    }
  });
});

test('resolveFromKey keeps the FIRST state when two values collide case-insensitively', () => {
  const fields = ['colorWheel'];
  const maps = rankMapsFor(['Blue', 'BLUE', 'blue'], []);
  maps[''].prt01 = {};
  withRankMaps(maps, () => {
    for (const probe of ['blue', 'BLUE', 'Blue']) {
      assert.deepEqual(SetupAdmin.resolveFromKey(fields, probe, ''), legacyResolveFromKey(fields, probe, maps, ''), probe);
    }
    // A display-text hit at a later index must lose to a signature hit at an earlier one (smaller index wins).
    const sigProbe = 'colorWheel=BLUE';
    assert.deepEqual(SetupAdmin.resolveFromKey(fields, sigProbe, ''), legacyResolveFromKey(fields, sigProbe, maps, ''));
  });
});

test('resolveFromKey cache invalidates on new rank maps, a different line scope and different fields', () => {
  const fields = ['colorWheel'];
  const first = rankMapsFor(['Blue'], []);
  withRankMaps(first, () => {
    assert.ok(SetupAdmin.resolveFromKey(fields, 'Blue', ''));
    assert.equal(SetupAdmin.resolveFromKey(fields, 'Violet', ''), null);
    // New rank-maps object: a value that only exists in the new maps must resolve.
    const second = rankMapsFor(['Blue', 'Violet'], []);
    Store.setPriorityRankMaps(second, 'unit-test');
    assert.ok(SetupAdmin.resolveFromKey(fields, 'Violet', ''));
    // Line scope: 'Teal' exists only in line L-9's override map.
    const third = rankMapsFor(['Blue'], [], ['Teal']);
    Store.setPriorityRankMaps(third, 'unit-test');
    assert.equal(SetupAdmin.resolveFromKey(fields, 'Teal', ''), null, 'plant scope does not see the line-only value');
    assert.ok(SetupAdmin.resolveFromKey(fields, 'Teal', 'L-9'), 'line scope does');
    assert.equal(SetupAdmin.resolveFromKey(fields, 'Teal', ''), null, 'and switching back is not served from the line-scope entry');
    // Fields: a two-field signature changes the state shape.
    const key = SetupAdmin.resolveFromKey(['colorWheel', 'prt01'], 'Blue · T1', '');
    assert.equal(key, null, 'no prt01 values in these maps');
    const fourth = rankMapsFor(['Blue'], ['T1']);
    Store.setPriorityRankMaps(fourth, 'unit-test');
    assert.equal(SetupAdmin.resolveFromKey(['colorWheel', 'prt01'], 'Blue · T1', '').length, 2);
    assert.equal(SetupAdmin.resolveFromKey(['colorWheel'], 'Blue · T1', ''), null);
  });
});

test('counted: validating 2,000 pasted rows reads the rank maps the same number of times as validating 20', () => {
  const fields = ['colorWheel', 'prt01'];
  const colors = Array.from({ length: 30 }, (_, i) => `COLOR${i}`);
  const tools = Array.from({ length: 10 }, (_, i) => `TOOL${i}`);
  const plain = rankMapsFor(colors, tools);
  const definition = { plant: 'P', fields, signature_version: 1, strict_blanks: true, active: true };
  const lines = n => Array.from({ length: n }, (_, i) =>
    `${colors[i % 30]}|${tools[i % 10]}\t${colors[(i + 1) % 30]}|${tools[(i + 3) % 10]}\t${10 + (i % 50)}`).join('\n');
  const count = n => {
    let reads = 0;
    // Count every read of the maps, including the nested per-field maps.
    const deep = new Proxy({}, { get(_t, key) { reads++; const v = plain[key]; return v && new Proxy(v, { get(t2, k2, r2) { reads++; return Reflect.get(t2, k2, r2); } }); },
      ownKeys: () => Reflect.ownKeys(plain), getOwnPropertyDescriptor: (_t, key) => ({ ...Reflect.getOwnPropertyDescriptor(plain, key), configurable: true }), has: (_t, key) => key in plain });
    return withRankMaps(deep, () => {
      const outcome = SetupAdmin.parseMassUploadText(lines(n), definition, [], false, undefined, '');
      assert.equal(outcome.ready.length, n);
      return reads;
    });
  };
  const small = count(20);
  const large = count(2000);
  assert.ok(small > 0, 'the rank maps were consulted');
  assert.equal(large, small, 'rank-map reads must not grow with the row count');
});

test('createDebouncedValidator: trailing run after the delay, flush runs a pending pass once, cancel drops it', () => {
  const timers = [];
  let now = 0;
  const fake = {
    set: (fn, ms) => { const t = { fn, at: now + ms, live: true }; timers.push(t); return t; },
    clear: t => { t.live = false; },
  };
  const advance = ms => { now += ms; timers.filter(t => t.live && t.at <= now).forEach(t => { t.live = false; t.fn(); }); };
  let runs = 0;
  const v = SetupAdmin.createDebouncedValidator(() => { runs++; }, 150, fake);
  v.schedule(); advance(100); v.schedule(); advance(100);
  assert.equal(runs, 0, 'each keystroke restarts the 150 ms window');
  advance(60);
  assert.equal(runs, 1, 'runs once, trailing');
  v.schedule(); v.flush();
  assert.equal(runs, 2, 'flush runs the pending pass immediately');
  advance(500);
  assert.equal(runs, 2, 'and the flushed timer does not fire again');
  v.flush();
  assert.equal(runs, 2, 'flush with nothing pending is a no-op');
  v.schedule(); v.cancel(); advance(500);
  assert.equal(runs, 2, 'cancel drops a pending pass (modal closed)');
});

test('mass-upload Stage and Download-rejected re-check the outcome after flushing a pending validation', () => {
  // The modal is not exported and there is no DOM harness, so pin the handler shape: after `debounced.flush()` an empty
  // outcome (text cleared inside the 150 ms window) must return before staging / saving a header-only CSV.
  const source = readFileSync(new URL('../../../frontend/setup/setup-admin.mts', import.meta.url), 'utf8');
  assert.match(source, /data-setup-mass-upload-download\]'\)!\.addEventListener\('click', \(\) => \{\s*debounced\.flush\(\);\s*if \(!lastOutcome\.rejected\.length\) return;/);
  assert.match(source, /data-setup-mass-upload-stage\]'\)!\.addEventListener\('click', \(\) => \{\s*debounced\.flush\(\);\s*if \(!lastOutcome\.ready\.length\) return;/);
});

// ── Default changeover by value (Wave C): grid/list states, activation, tiles, card helpers ─────────────────────
import { Persistence } from '../../../frontend/scheduling/persistence.mjs';
import { Toast } from '../../../frontend/platform/foundation.mjs';

const VD_DEF = { signature_version: 4, fields: ['prt01', 'colorWheel'], strict_blanks: true, active: false };
const vdState = (prt, color) => [{ fieldKey: 'prt01', value: prt }, { fieldKey: 'colorWheel', value: color }];
const vdGridState = (prt, color) => { const key = vdState(prt, color); return { key, sig: SetupAdmin.stateSig(key), parts: [prt, color] }; };
const VD_DEFAULTS = [
  { field_key: 'prt01', value: 'A', setup_min: 10, signature_version: 4 },
  { field_key: 'prt01', value: 'B', setup_min: 30, signature_version: 4 },
  { field_key: 'prt01', value: 'C', setup_min: 60, signature_version: 4 },
  { field_key: 'colorWheel', value: 'RED', setup_min: 15, signature_version: 4 },
  { field_key: 'prt01', value: 'Z', setup_min: 999, signature_version: 3 }, // old version: ignored
];

test('gridCellState: a default-covered pair is "value-default" only below every exact row and the diagonal', () => {
  const a = vdGridState('A', 'RED'), b = vdGridState('B', 'RED');
  assert.equal(SetupAdmin.gridCellState(a, b, undefined, undefined, '', 30), 'value-default');
  assert.equal(SetupAdmin.gridCellState(a, b, undefined, undefined, '', null), 'uncovered');
  assert.equal(SetupAdmin.gridCellState(a, b, undefined, undefined, ''), 'uncovered', 'the sixth parameter is optional');
  assert.equal(SetupAdmin.gridCellState(a, a, undefined, undefined, '', 30), 'implicit-zero', 'identical states stay implicit zero');
  assert.equal(SetupAdmin.gridCellState(a, b, undefined, { setup_min: 5 }, '', 30), 'dirty', 'a pending edit wins');
  assert.equal(SetupAdmin.gridCellState(a, b, { setup_min: 5, inherited: false }, undefined, '', 30), 'plant-default', 'a plant row beats the default');
  // line scope: a line override stays line-override, a plant row seen at line scope stays plant-default
  assert.equal(SetupAdmin.gridCellState(a, b, { setup_min: 5, inherited: false }, undefined, 'L1', 30), 'line-override');
  assert.equal(SetupAdmin.gridCellState(a, b, { setup_min: 5, inherited: true }, undefined, 'L1', 30), 'plant-default');
  // line scope with no row at all: the plant-wide default still covers the pair
  assert.equal(SetupAdmin.gridCellState(a, b, undefined, undefined, 'L1', 30), 'value-default');
});

test('valueDefaultFor resolves the worked check through the real resolver (only the default tier can answer)', () => {
  const idx = SetupAdmin.defaultIndexFor(VD_DEF, VD_DEFAULTS);
  const f = (from, to) => SetupAdmin.valueDefaultFor(VD_DEF, vdState(...from), vdState(...to), VD_DEFAULTS, idx);
  assert.equal(f(['A', 'RED'], ['B', 'RED']).min, 30);
  assert.equal(f(['B', 'RED'], ['A', 'BLUE']).min, 10, 'partial sum: BLUE has no default');
  assert.match(f(['B', 'RED'], ['A', 'BLUE']).reason, /no default: colorWheel=BLUE/);
  assert.equal(f(['C', 'BLUE'], ['C', 'RED']).min, 15);
  assert.equal(f(['A', 'RED'], ['B', 'RED']).min, SetupAdmin.valueDefaultFor(VD_DEF, vdState('A', 'RED'), vdState('B', 'RED'), VD_DEFAULTS).min, 'indexed and index-less agree');
  assert.equal(f(['A', 'RED'], ['A', 'RED']), null, 'identical states are implicit zero, not a default');
  assert.equal(f(['A', 'RED'], ['X', 'BLUE']), null, 'no default on any changed field: uncovered');
  assert.equal(SetupAdmin.valueDefaultFor(VD_DEF, vdState('A', 'RED'), vdState('B', 'RED'), [], undefined), null);
  assert.equal(SetupAdmin.valueDefaultFor(VD_DEF, vdState('A', 'RED'), vdState('B', 'RED'), undefined, undefined), null, 'absent value_defaults is []');
});

test('listRowView: a default-covered pair is its own state, never a Gap; a line override outranks it', () => {
  const row = { from_key: vdState('A', 'RED'), to_key: vdState('B', 'RED'), setup_min: null, source: 'plant', inherited: false, plant_value: null };
  const gap = SetupAdmin.listRowView(row, '');
  assert.equal(gap.isGap, true);
  const covered = SetupAdmin.listRowView(row, '', { min: 30, reason: 'Default by value: prt01=B (30)' });
  assert.equal(covered.isGap, false);
  assert.equal(covered.isValueDefault, true);
  assert.equal(covered.defaultMin, 30);
  assert.equal(covered.sourceLabel, Util.t('ui.setup_source_value_default'));
  assert.match(covered.detail, /prt01=B/);
  const lineRow = { ...row, setup_min: 5, inherited: false };
  const override = SetupAdmin.listRowView(lineRow, 'L1', { min: 30, reason: 'x' });
  assert.equal(override.isOverride, true);
  assert.equal(override.isValueDefault, false, 'line override beats the default');
  const planted = SetupAdmin.listRowView({ ...row, setup_min: 7, plant_value: 7, inherited: true }, 'L1', { min: 30, reason: 'x' });
  assert.equal(planted.isValueDefault, false, 'a plant row (inherited at line scope) beats the default');
});

test('matrixVersionFor counts value defaults for the CURRENT version so a defaults-only plant can pass the version check', () => {
  assert.equal(SetupAdmin.matrixVersionFor({ rowCount: 0, valueDefaults: [], version: 4 }), null, 'no rows, no defaults');
  assert.equal(SetupAdmin.matrixVersionFor({ rowCount: 0, valueDefaults: undefined, version: 4 }), null);
  assert.equal(SetupAdmin.matrixVersionFor({ rowCount: 0, valueDefaults: VD_DEFAULTS, version: 4 }), 4, 'defaults-only plant');
  assert.equal(SetupAdmin.matrixVersionFor({ rowCount: 0, valueDefaults: [VD_DEFAULTS[4]], version: 4 }), null, 'a default for an old version does not count');
  assert.equal(SetupAdmin.matrixVersionFor({ rowCount: 3, valueDefaults: [], version: 4 }), 4, 'rows still count');
  assert.equal(SetupAdmin.matrixVersionFor({ rowCount: 3, valueDefaults: [], version: null }), null);
  const matrixVersion = SetupAdmin.matrixVersionFor({ rowCount: 0, valueDefaults: VD_DEFAULTS, version: 4 });
  assert.equal(SetupAdmin.activationStatus(VD_DEF, { matrixVersion, coveragePass: true }, true).active, true, 'a defaults-only plant with passing coverage activates');
  // Util.t falls back to the key when another test has already defined `window`, so accept either rendering.
  assert.match(SetupAdmin.activationStatus(VD_DEF, { matrixVersion: null, coveragePass: true }).reason, /version-matched matrix or default by value|ui.setup_status_version_mismatch/i, 'the reason names defaults');
});

test('coverageSummary: Recorded / By default / Gaps come from the server counts, not total - gaps', () => {
  assert.deepEqual(SetupAdmin.coverageSummary({ total_pairs: 100, covered_pairs: 20, default_covered_pairs: 70, missing_pairs: 10 }),
    { total: 100, recorded: 20, byDefault: 70, gaps: 10, covered: 90 });
  // an older response with no covered_pairs / default key degrades to a derived number
  assert.deepEqual(SetupAdmin.coverageSummary({ total_pairs: 10, missing_pairs: 4 }), { total: 10, recorded: 6, byDefault: 0, gaps: 4, covered: 6 });
  assert.deepEqual(SetupAdmin.coverageSummary(undefined), { total: 0, recorded: 0, byDefault: 0, gaps: 0, covered: 0 });
  // the observed bucket has the same shape
  assert.equal(SetupAdmin.coverageSummary({ total_pairs: 8, covered_pairs: 3, default_covered_pairs: 4, missing_pairs: 1 }).covered, 7);
});

test('setupWriteKind maps the value-defaults route to its own kind (stales an open optimizer preview)', () => {
  assert.equal(SetupAdmin.setupWriteKind('/setup/P1/value-defaults'), 'value-default');
  assert.equal(SetupAdmin.setupWriteKind('http://x/setup/P1/value-defaults?x=1'), 'value-default');
  assert.equal(SetupAdmin.setupWriteKind('/setup/P1/matrix/import'), 'matrix');
  assert.equal(SetupAdmin.setupWriteKind('/setup/P1/definition'), 'definition');
});

test('value-default rows dedupe on the canonical value, badge listed > observed > stored, natural sort', () => {
  const stored = new Map([['T10', 5], ['ORPHAN', 7]]);
  const rows = SetupAdmin.buildValueDefaultRows({
    listed: ['Red', 'RED ', 't2', 'T10'], observed: ['red', 'BLUE', 'TRUE', 'true'], stored,
  });
  assert.deepEqual(rows.map(r => r.value), ['BLUE', 'ORPHAN', 'RED', 'T2', 'T10', 'true']);
  const byValue = Object.fromEntries(rows.map(r => [r.value, r]));
  assert.equal(rows.filter(r => r.value === 'RED').length, 1, 'Red / "RED " / red collapse to one row');
  assert.equal(byValue.RED.badge, 'listed');
  assert.equal(byValue.BLUE.badge, 'observed');
  assert.equal(byValue.ORPHAN.badge, 'stored');
  assert.equal(byValue.T10.stored, 5);
  assert.ok(byValue.true, 'booleans keep the client canonical lowercase form, and the server TRUE is the same row');
  assert.deepEqual(SetupAdmin.filterValueDefaultRows(rows, ' re ').map(r => r.value), ['RED']);
  assert.equal(SetupAdmin.filterValueDefaultRows(rows, '').length, rows.length);
});

test('stage / mass-fill / entries: only dirty values, blank removes, equal-to-stored is no change', () => {
  const stored = new Map([['A', 10], ['B', 30]]);
  const dirty = new Map();
  SetupAdmin.stageValueDefault(dirty, stored, 'a', 10);
  assert.equal(dirty.size, 0, 'same as stored: not dirty');
  SetupAdmin.stageValueDefault(dirty, stored, 'A', 12);
  SetupAdmin.stageValueDefault(dirty, stored, 'B', null);
  SetupAdmin.stageValueDefault(dirty, stored, 'NEW', 5);
  SetupAdmin.stageValueDefault(dirty, stored, 'NOPE', null);
  assert.deepEqual(SetupAdmin.valueDefaultEntries(dirty), [{ value: 'A', setup_min: 12 }, { value: 'B', setup_min: null }, { value: 'NEW', setup_min: 5 }]);
  SetupAdmin.stageValueDefault(dirty, stored, 'A', 10);
  assert.equal(dirty.has('A'), false, 'typing the stored value back clears the dirty entry');
  const chunks = SetupAdmin.chunkValueDefaultEntries(Array.from({ length: 4500 }, (_, i) => ({ value: `V${i}`, setup_min: 1 })));
  assert.deepEqual(chunks.map(c => c.length), [2000, 2000, 500], 'the 2,000-entry route cap is honoured');
  assert.equal(SetupAdmin.valueDefaultWorstCase(VD_DEFAULTS, 4, ['prt01', 'colorWheel'], 'prt01', new Map()), 75, '60 + 15; the old-version 999 is ignored');
  assert.equal(SetupAdmin.valueDefaultWorstCase(VD_DEFAULTS, 4, ['prt01', 'colorWheel'], 'prt01', new Map([['C', 10000]])), 10015);
  assert.equal(SetupAdmin.valueDefaultWorstCase(VD_DEFAULTS, 4, ['prt01', 'colorWheel'], 'prt01', new Map([['C', null]])), 45, 'a pending removal drops C');
});

/** A target that records innerHTML per mount and answers querySelector for the card's mounts. */
function vdFakeTarget() {
  const mk = () => ({ innerHTML: '', textContent: '', toggled: {}, querySelector: () => null, toggleAttribute(name, on) { this.toggled[name] = on; } });
  const nodes = {
    '[data-setup-vd-mount]': mk(), '[data-setup-vd-rows]': mk(), '[data-setup-vd-massfill]': mk(), '[data-setup-vd-notes]': mk(),
    '[data-setup-vd-dirty-count]': mk(), '[data-setup-vd-discard]': mk(), '[data-setup-vd-save]': mk(),
  };
  return { nodes, querySelector: sel => nodes[sel] ?? null };
}
const vdPermissions = { read: true, copy: true, export: true, definitionWrite: true, matrixWrite: true, stateWrite: true };

test('the card renders at most 200 rows with an "N more" text node; mass-fill applies to EVERY matching value', () => {
  const t = SetupAdmin._valueDefaultsForTest;
  t.reset();
  const target = vdFakeTarget();
  const snapshot = { plant: 'P-VD', definition: VD_DEF, plant_rows: [], machine_rows: [], machine_states: [], overrides: [], value_defaults: [], plant_active: true };
  t.attach(target, snapshot, vdPermissions);
  t.setValues('P-VD', 4, 'prt01', { listed: [], observed: Array.from({ length: 450 }, (_, i) => `V${String(i).padStart(3, '0')}`) });
  SetupAdmin.paintValueDefaultRows();
  const html = target.nodes['[data-setup-vd-rows]'].innerHTML;
  assert.equal((html.match(/data-setup-vd-row=/g) || []).length, t.rowCap);
  assert.equal(t.rowCap, 200);
  assert.ok(html.includes(Util.escapeHtml(Util.t('ui.setup_vd_more', { count: 250 }))), 'the 250 hidden rows are announced in a text node');
  assert.match(html, /role="status"/);
  assert.ok(target.nodes['[data-setup-vd-massfill]'].innerHTML.includes('data-setup-vd-massfill-input'), 'writers get the mass-fill strip');
  assert.ok(target.nodes['[data-setup-vd-massfill]'].innerHTML.includes(Util.escapeHtml(Util.t('ui.setup_vd_massfill_label', { count: 450 }))), 'the label counts every match, not the rendered rows');
  // filter then mass-fill: applies to all matching, rendered or not
  t.setFilter('V4');
  SetupAdmin.paintValueDefaultRows();
  assert.equal(t.massFillMatching(20), 50, 'V400..V449 match: all 50 staged');
  assert.equal(t.state().dirty.size, 50);
  t.setFilter('');
  assert.equal(t.massFillMatching(20), 450, 'unfiltered: every one of the 450');
  assert.equal(t.state().dirty.size, 450);
  SetupAdmin.paintValueDefaultRows();
  assert.equal((target.nodes['[data-setup-vd-rows]'].innerHTML.match(/class="setup-vd-dirty"/g) || []).length, 200, 'rendered dirty rows are marked');
  t.reset();
});

test('the card is disabled and explained for read-only users, never hidden', () => {
  const t = SetupAdmin._valueDefaultsForTest;
  t.reset();
  const target = vdFakeTarget();
  const snapshot = { plant: 'P-RO', definition: VD_DEF, plant_rows: [], machine_rows: [], machine_states: [], overrides: [], value_defaults: [{ field_key: 'prt01', value: 'A', setup_min: 10, signature_version: 4 }], plant_active: false };
  t.attach(target, snapshot, { ...vdPermissions, matrixWrite: false });
  t.setValues('P-RO', 4, 'prt01', { listed: [], observed: ['B'] });
  SetupAdmin.paintValueDefaultRows();
  const rows = target.nodes['[data-setup-vd-rows]'].innerHTML;
  assert.ok(rows.includes('data-setup-vd-row="A"') && rows.includes('data-setup-vd-row="B"'));
  assert.equal((rows.match(/ disabled>/g) || []).length, 2, 'every minutes input is disabled');
  assert.equal(target.nodes['[data-setup-vd-massfill]'].innerHTML, '', 'no mass-fill for a reader');
  const notes = target.nodes['[data-setup-vd-notes]'].innerHTML;
  assert.ok(notes.includes(Util.escapeHtml(Util.t('ui.setup_vd_admin_only'))), 'the reason is shown');
  assert.ok(notes.includes(Util.escapeHtml(Util.t('ui.setup_vd_inert_note'))), 'setup-off plants are told defaults are inert');
  assert.equal(target.nodes['[data-setup-vd-save]'].toggled.disabled, true);
  t.reset();
});

test('saveValueDefaults PUTs only dirty entries, then reloads the snapshot, drops the coverage cache and stales the preview', async () => {
  const t = SetupAdmin._valueDefaultsForTest;
  t.reset();
  const plant = 'P-VD-SAVE';
  const priors = { fetch: Util.fetchTraced, plant: Store.selectedPlant, snapshot: Store.setupSnapshot, load: Persistence.loadSetupSnapshot, inval: Persistence._invalidateSetupSnapshot, toast: Toast.show };
  const calls = []; const kinds = []; const order = [];
  Util.fetchTraced = (url, init) => { calls.push({ url: String(url), init }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ rows: [], meta: { total: 0 } }) }); };
  Persistence.loadSetupSnapshot = async () => { order.push('load'); return null; };
  Persistence._invalidateSetupSnapshot = () => { order.push('invalidate'); };
  Persistence.setSetupWriteListener((p, k) => kinds.push([p, k]));
  Toast.show = () => {};
  try {
    Store.setSelectedPlant(null, 'test');
    const snapshot = { plant, definition: VD_DEF, plant_rows: [], machine_rows: [], machine_states: [], overrides: [], value_defaults: [{ field_key: 'prt01', value: 'A', setup_min: 10, signature_version: 4 }, { field_key: 'prt01', value: 'B', setup_min: 30, signature_version: 4 }] };
    Store.replaceSetupSnapshot(snapshot, 'test');
    const target = { innerHTML: '', querySelector: () => null };
    t.attach(target, snapshot, vdPermissions);
    t.setValues(plant, 4, 'prt01', { listed: [], observed: ['C'] });
    t.stage('A', 10);          // equals stored: not dirty
    t.stage('B', null);        // remove
    t.stage('C', 60);          // new
    await SetupAdmin.saveValueDefaults();
    const put = calls.find(c => c.init?.method === 'PUT');
    assert.ok(put, 'a PUT was sent');
    assert.ok(put.url.endsWith(`/setup/${plant}/value-defaults`));
    assert.deepEqual(JSON.parse(put.init.body), { signature_version: 4, field_key: 'prt01', entries: [{ value: 'B', setup_min: null }, { value: 'C', setup_min: 60 }] });
    assert.deepEqual(kinds, [[plant, 'value-default']], 'an open optimizer preview is staled with the value-default kind');
    assert.deepEqual(order.slice(0, 2), ['invalidate', 'load'], 'snapshot invalidated then reloaded');
    assert.equal(t.state().dirty.size, 0, 'draft cleared after a successful save');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(calls.some(c => c.url.includes(`/setup/${plant}/coverage`)), 'coverage was invalidated and re-fetched (tiles refresh)');
    // nothing dirty: no request at all
    const before = calls.length;
    await SetupAdmin.saveValueDefaults();
    assert.equal(calls.length, before);
  } finally {
    Util.fetchTraced = priors.fetch; Persistence.loadSetupSnapshot = priors.load; Persistence._invalidateSetupSnapshot = priors.inval; Toast.show = priors.toast;
    Persistence.setSetupWriteListener(null);
    Store.setSelectedPlant(priors.plant, 'test-restore'); Store.replaceSetupSnapshot(priors.snapshot, 'test-restore');
    t.reset();
  }
});

test('saveValueDefaults refuses without a definition, without matrixWrite, and keeps dirty entries on a 409', async () => {
  const t = SetupAdmin._valueDefaultsForTest;
  t.reset();
  const priors = { fetch: Util.fetchTraced, load: Persistence.loadSetupSnapshot, inval: Persistence._invalidateSetupSnapshot, toast: Toast.show, plant: Store.selectedPlant, snapshot: Store.setupSnapshot };
  const calls = [];
  let status = 200;
  Util.fetchTraced = (url, init) => { calls.push({ url: String(url), init }); return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(status === 409 ? { detail: 'signature_version is stale' } : { rows: [], meta: { total: 0 } }) }); };
  Persistence.loadSetupSnapshot = async () => null; Persistence._invalidateSetupSnapshot = () => {}; Toast.show = () => {};
  try {
    Store.setSelectedPlant(null, 'test');
    const target = { innerHTML: '', querySelector: () => null };
    const empty = { plant: 'P-NODEF', definition: null, plant_rows: [], machine_rows: [], machine_states: [], overrides: [], value_defaults: [] };
    t.attach(target, empty, vdPermissions);
    await SetupAdmin.saveValueDefaults();
    assert.equal(calls.length, 0, 'no definition: no PUT attempted');
    t.reset();
    const snap = { ...empty, plant: 'P-RO2', definition: VD_DEF };
    t.attach(target, snap, { ...vdPermissions, matrixWrite: false });
    t.stage('C', 60);
    await SetupAdmin.saveValueDefaults();
    assert.equal(calls.length, 0, 'read-only: no PUT attempted');
    t.reset();
    Store.replaceSetupSnapshot({ ...snap, plant: 'P-409' }, 'test');
    t.attach(target, { ...snap, plant: 'P-409' }, vdPermissions);
    t.stage('C', 60);
    status = 409;
    await SetupAdmin.saveValueDefaults();
    assert.ok(calls.some(c => c.init?.method === 'PUT'));
    assert.equal(t.state().dirty.size, 1, '409 keeps the unsaved entries');
  } finally {
    Util.fetchTraced = priors.fetch; Persistence.loadSetupSnapshot = priors.load; Persistence._invalidateSetupSnapshot = priors.inval; Toast.show = priors.toast;
    Store.setSelectedPlant(priors.plant, 'test-restore'); Store.replaceSetupSnapshot(priors.snapshot, 'test-restore');
    t.reset();
  }
});

test('the card repaints after every render() and on master-data-changed, and typing never calls renderSnapshot (source contract)', () => {
  // renderSnapshot rebuilds target.innerHTML, so the card mount is re-created every time. There is no HTML-parsing DOM
  // in this suite, so pin the wiring: paint follows wire() inside renderSnapshot, the subscriber repaints it, and the
  // card's own handlers never call renderSnapshot/render (focus loss).
  const source = readFileSync(new URL('../../../frontend/setup/setup-admin.mts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.match(source, /wire\(target, snapshot, permissions, rows, definition\);\n\s*\/\/[^\n]*\n\s*_vdCtx = \{ target, snapshot, definition, permissions \};\n\s*paintValueDefaults\(\);/);
  assert.match(source, /if \(evt\.type !== 'master-data-changed'\) return;[\s\S]*?paintValueDefaults\(\);\n  \}, 'SetupAdmin\.cacheReset'\);/);
  const start = source.indexOf('function wireValueDefaults(');
  const end = source.indexOf('async function saveValueDefaults(');
  const handlers = source.slice(start, end);
  assert.doesNotMatch(handlers, /renderSnapshot\(|[^a-zA-Z]render\(/, 'typing / filtering / mass-fill never rebuild the whole panel');
  assert.doesNotMatch(source.slice(source.indexOf('// ── "Default changeover by value" card'), end), /\bon(click|change|input|keydown)=/, 'no inline on*= attributes');
});
