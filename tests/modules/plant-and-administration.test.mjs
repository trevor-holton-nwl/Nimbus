// Tests for web/plant-and-administration.mjs — CQ-1 Phase 4 Tasks 1-3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CalendarUI, Plant, ProdLines, MasterData, LaborPlanning, Interface, Security, AdminCockpit, SetupAdmin } from '../../web/plant-and-administration.mjs';

test('CalendarUI/Plant/ProdLines expose their documented public API', () => {
  assert.equal(typeof CalendarUI.render, 'function');
  assert.equal(typeof Plant.init, 'function');
  assert.equal(typeof Plant.gotoTab, 'function');
  assert.equal(typeof Plant._renderSettingsPane, 'function', 'App._renderSettingsPane was relocated bodily onto Plant in Task 1 — must land here');
  assert.equal(typeof ProdLines.render, 'function');
});

test('MasterData/LaborPlanning expose their documented public API', () => {
  assert.equal(typeof MasterData.render, 'function');
  assert.equal(typeof MasterData.syncLineSettings, 'function');
  assert.equal(typeof LaborPlanning.init, 'function');
  assert.equal(typeof LaborPlanning.render, 'function');
  assert.equal(typeof LaborPlanning.onGroupToggle, 'function');
  assert.equal(typeof LaborPlanning.clearGroupFilter, 'function');
  assert.equal(typeof LaborPlanning.prevHorizon, 'function');
  assert.equal(typeof LaborPlanning.nextHorizon, 'function');
  assert.equal(typeof LaborPlanning.setSpan, 'function');
});

test('Interface/Security/AdminCockpit expose their documented public API', () => {
  assert.equal(typeof Interface.render, 'function');
  assert.equal(typeof Security.render, 'function');
  assert.equal(typeof AdminCockpit.init, 'function');
  assert.equal(typeof AdminCockpit.render, 'function');
  assert.equal(typeof AdminCockpit._startHealthPolling, 'function');
  assert.equal(typeof AdminCockpit._stopHealthPolling, 'function');
  assert.equal(typeof AdminCockpit.gotoOvTab, 'function');
  assert.equal(typeof AdminCockpit._setSub, 'function');
});

test('Plant Settings pane exposes tree-rendering internals', () => {
  // Smoke-level, matching this file's existing thin public-API-shape style.
  // The Stage 3 priority tree's actual behavior is covered by
  // Engine.flattenConstraints' own tests in tests/modules/schedule-services.test.mjs
  // — _renderSettingsPane is a thin consumer of it (it deliberately does not
  // reimplement the flatten), and its render path needs a live DOM, which this
  // node:test suite has no jsdom for.
  assert.equal(typeof Plant._renderSettingsPane, 'function');
});

test('Plant exposes the generalized priority-list optimization API', () => {
  assert.equal(typeof Plant._renderOptimization, 'function');
  assert.equal(typeof Plant._uploadPriorityList, 'function');
  assert.equal(typeof Plant._confirmDeletePriorityList, 'function');
  assert.equal(typeof Plant._resyncOrderAttributes, 'function');
});

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

test('SetupAdmin bounds missing-setup review data and reserves the editor for writers', () => {
  // Regression target: exposing a matrix editor to readers, or handing an
  // unbounded candidate table across the preview/admin boundary.
  const pairs = Array.from({ length: 14 }, (_, index) => ({
    line: 'L-1', predecessorOrderId: `before-${index}`, successorOrderId: `after-${index}`,
    fromState: 'colorWheel=RED', toState: 'colorWheel=BLUE', reason: 'matrix-missing',
  }));
  const csv = SetupAdmin.missingPairsCsv('5512', pairs);
  assert.match(csv, /Plant,Line,Predecessor order,Successor order,From setup state,To setup state,Reason/);
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
  const plant = { line: '', signature_version: 4, from_key: from, to_key: to, setup_min: 20, source: 'manual' };
  const line = { line: 'L-10', signature_version: 4, from_key: from, to_key: to, setup_min: 7, source: 'manual' };
  assert.deepEqual(SetupAdmin.effectiveRows({ plantRows: [plant], lineRows: [line], line: 'L-10', version: 4 }), [{
    ...line, inherited: false, inheritedFromPlant: false,
  }]);
  assert.deepEqual(SetupAdmin.deleteRequest(line), {
    line: 'L-10', signature_version: 4, rows: [line],
  });
  assert.equal(SetupAdmin.effectiveRows({ plantRows: [plant], lineRows: [], line: 'L-10', version: 4 })[0].setup_min, 20);
  assert.equal(SetupAdmin.effectiveRows({ plantRows: [plant], lineRows: [], line: 'L-10', version: 4 })[0].inherited, true);
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

test('SetupAdmin keeps Stage 2 policy activation blocked without recorded release evidence', () => {
  const status = SetupAdmin.policyActivationStatus({ minChangeoverEnabled: true }, {
    stage1Validated: false, localDbVerified: false, performanceVerified: false,
  });
  assert.equal(status.active, false);
  assert.match(status.reason, /Stage 1 validation/);
});

test('SetupAdmin validates editable policy thresholds and makes safe-disable payloads', () => {
  // Regression target: an admin must be able to maintain guardrails without
  // accidentally activating a detached optimization policy.
  assert.deepEqual(SetupAdmin.normalizePolicyThresholds('60', '1440'), {
    throughputMinSavingsMin: 60, throughputMaxSlipMin: 1440,
  });
  assert.throws(() => SetupAdmin.normalizePolicyThresholds('59.5', '1440'), /whole number/i);
  assert.throws(() => SetupAdmin.normalizePolicyThresholds('60', '-1'), /zero or greater/i);
  assert.deepEqual(SetupAdmin.safeDisablePolicy({
    plant: '5512', dueDateFirstEnabled: true, minChangeoverEnabled: true, throughputEnabled: true,
    throughputMinSavingsMin: 60, throughputMaxSlipMin: 1440, version: 3,
  }), {
    plant: '5512', dueDateFirstEnabled: false, minChangeoverEnabled: false, throughputEnabled: false,
    throughputMinSavingsMin: 60, throughputMaxSlipMin: 1440, expected_version: 3,
  });
});

test('SetupAdmin derives release readiness and preserves versioned evidence payloads', () => {
  const incomplete = {
    plant: '5512', stage1Validated: true, localDbVerified: true,
    performanceVerified: true, browserUatVerified: true,
    representativeReplayVerified: true, nullPredecessorVerified: true,
    ownerApproved: true, ownerEmail: 'owner@example.com', approvedAt: '2026-08-14T12:00:00Z',
    notes: '', version: 4, ready: false,
  };
  assert.equal(SetupAdmin.releaseEvidenceReady(incomplete), false);
  const complete = { ...incomplete, notes: 'All checks recorded.', ready: true };
  assert.equal(SetupAdmin.releaseEvidenceReady(complete), true);
  assert.deepEqual(SetupAdmin.releaseEvidencePayload(complete, { notes: 'Updated record.' }), {
    stage1Validated: true, localDbVerified: true, performanceVerified: true,
    browserUatVerified: true, representativeReplayVerified: true,
    nullPredecessorVerified: true, ownerApproved: true,
    ownerEmail: 'owner@example.com', approvedAt: '2026-08-14T12:00:00Z',
    notes: 'Updated record.', expected_version: 4,
  });
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
    plant: '5512', line: 'LINE-1', signature_version: 4,
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
      ? { rows: [{ production_line: 'L-100' }, { production_line: 'L-001' }], meta: { total: 3 } }
      : { rows: [{ production_line: 'L-250' }], meta: { total: 3 } };
  }, 2);
  assert.deepEqual(lines, ['L-001', 'L-100', 'L-250']);
  assert.deepEqual(calls, [{ offset: 0, limit: 2 }, { offset: 2, limit: 2 }]);
});
