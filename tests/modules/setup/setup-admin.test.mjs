// Tests for frontend/setup/setup-admin.mjs (SetupAdmin).
// Split from tests/modules/plant-and-administration.test.mjs in Phase P2 of
// docs/architecture/domain-refactor-plan.md (plant-and-administration.mts
// was split into 9 domain files; this mirrors that split).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SetupAdmin } from '../../../frontend/setup/setup-admin.mjs';

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
