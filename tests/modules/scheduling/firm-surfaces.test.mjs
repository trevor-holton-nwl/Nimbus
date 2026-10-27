// Universal firm (2026-10-27, Workstream C): the lock-aware firm surfaces in orders.mts and gantt.mts.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Table, Inspector, ContextMenu } from '../../../frontend/scheduling/orders.mjs';
import { Interaction } from '../../../frontend/scheduling/gantt.mjs';
import { Selection } from '../../../frontend/scheduling/selection.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { Util, Toast, Modal } from '../../../frontend/platform/foundation.mjs';
import { Alerts } from '../../../frontend/insights/services.mjs';
import { Engine } from '../../../frontend/optimization/engine.mjs';

const require = createRequire(import.meta.url);
globalThis.NimbusComputeCore = globalThis.NimbusComputeCore || require('../../../frontend/nimbus-compute-core.js');

globalThis.window = globalThis.window || {};
if (typeof globalThis.document === 'undefined') globalThis.document = { getElementById: () => null, querySelector: () => null };
const originalDocument = globalThis.document;
const originalWindow = globalThis.window;
const originalRaf = globalThis.requestAnimationFrame;
afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  globalThis.requestAnimationFrame = originalRaf;
});

const NOW = new Date('2026-10-27T08:00:00');
const FROZEN_END = new Date('2026-10-30T08:00:00');
const placed = (id, start, end, extra = {}) => ({ id, PLANT: 'FS', MACHINE: 'FS-L1', RUN_TIME: 1, user_scheduled: true, start_date: start, end_date: end, ...extra });

/** Pins the plant clock to NOW and the frozen window to [NOW, FROZEN_END) for the plant "FS". */
function liveClockFixture(t) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const priorTasks = Store.tasksArr.map(x => ({ ...x }));
  const priorFirmed = new Set(Store.firmedIds);
  const priorEnd = Store.frozenHorizonEnd;
  const priorOffset = Store.serverOffsetMs;
  Store.setMasterData({ plants: [{ plant: 'FS', timezone: tz }], lines: [] }, 'test');
  Store._blockedPlants.clear();
  Store.serverOffsetMs = NOW.getTime() - Date.now();
  Store.setFrozenHorizonEnd(FROZEN_END, 'test');
  Store.setTasks([
    placed('open', new Date('2026-11-05T08:00:00'), new Date('2026-11-05T10:00:00')),
    placed('sap', new Date('2026-11-05T11:00:00'), new Date('2026-11-05T12:00:00'), { ecc_firmed: true }),
    placed('manual', new Date('2026-11-06T08:00:00'), new Date('2026-11-06T10:00:00')),
    placed('frozen', new Date('2026-10-28T08:00:00'), new Date('2026-10-28T10:00:00'), { ecc_firmed: true }),
    placed('running', new Date('2026-10-27T06:00:00'), new Date('2026-10-27T10:00:00')),
  ], 'test');
  Store.firmedIds.clear();
  Store.setFirmed(['manual'], true, 'test');
  t.after(() => {
    Store.setFrozenHorizonEnd(priorEnd, 'test');
    Store.serverOffsetMs = priorOffset;
    Store._blockedPlants.clear();
    Store.setTasks(priorTasks, 'test');
    Store.firmedIds.clear();
    for (const id of priorFirmed) Store.firmedIds.add(id);
  });
}

test('Inspector lock block: Firmed card only while NIMBUS locks, neutral SAP tag outside the card, button per D4', t => {
  liveClockFixture(t);
  const t_ = id => Store.tasks[id];
  assert.equal(Inspector._lockBlockHtml(t_('open')), '', 'nothing to show for an unlocked, non-SAP order');
  assert.equal(Inspector._firmButtonHtml(t_('open')).includes('data-act="firm"'), true);
  assert.match(Inspector._firmButtonHtml(t_('open')), /btn-primary/, 'Firm is the primary button');

  const sapOnly = Inspector._lockBlockHtml(t_('sap'));
  assert.match(sapOnly, /sap-pill neutral insp-sap-tag/);
  assert.doesNotMatch(sapOnly, /insp-status/, 'SAP firm locks nothing, so no Firmed card');
  assert.match(Inspector._firmButtonHtml(t_('sap')), /data-act="firm"/, 'a SAP-firmed order can still be firmed');

  const manual = Inspector._lockBlockHtml(t_('manual'));
  assert.match(manual, /insp-status-head/);
  assert.doesNotMatch(manual, /insp-sap-tag/);
  assert.match(Inspector._firmButtonHtml(t_('manual')), /data-act="unfirm"/);
  assert.doesNotMatch(Inspector._firmButtonHtml(t_('manual')), /btn-primary/, 'Unfirm is the plain button');

  const frozen = Inspector._lockBlockHtml(t_('frozen'));
  assert.match(frozen, /insp-status/);
  assert.match(frozen, /insp-sap-tag/, 'card and SAP tag together');
  assert.ok(frozen.indexOf('insp-status') < frozen.indexOf('insp-sap-tag'));
  assert.equal(Inspector._firmButtonHtml(t_('frozen')), '', 'no firm/unfirm button when frozen');
  assert.equal(Inspector._firmButtonHtml(t_('running')), '', 'no firm/unfirm button when running');
  assert.match(Inspector._lockBlockHtml(t_('running')), /insp-status-reasons/);
});

test('Inspector.refreshLock patches only the lock block and the firm button, and re-wires the button', t => {
  liveClockFixture(t);
  const clicks = [];
  const mkSlot = () => ({
    innerHTML: '',
    querySelector(sel) {
      const act = /data-act="(\w+)"/.exec(sel)?.[1];
      return act && this.innerHTML.includes(`data-act="${act}"`)
        ? { addEventListener: (ev, fn) => clicks.push({ act, ev, fn }) } : null;
    },
  });
  const lock = mkSlot();
  const firmSlot = mkSlot();
  let notesTouched = false;
  const body = {
    get innerHTML() { return ''; },
    set innerHTML(_v) { notesTouched = true; },
    querySelector: sel => (sel === '[data-insp-lock]' ? lock : sel === '[data-insp-firm]' ? firmSlot : null),
  };
  globalThis.document = { getElementById: id => (id === 'inspector-body' ? body : null) };
  const priorId = Inspector._currentId;
  t.after(() => { Inspector._currentId = priorId; });
  Inspector._currentId = 'open';
  Inspector.refreshLock('open');
  assert.match(firmSlot.innerHTML, /data-act="firm"/);
  assert.equal(clicks.length, 1, 'the new button gets its listener');
  assert.equal(notesTouched, false, 'never a full _render');

  Inspector.refreshLock('someone-else');   // not the open order: no-op
  assert.equal(clicks.length, 1);

  // The window rolls: the open order becomes frozen without any Store event; the next scan patches it.
  Store.updateTask('open', { start_date: new Date('2026-10-28T08:00:00'), end_date: new Date('2026-10-28T09:00:00') }, 'test');
  Inspector.refreshLock('open');
  assert.equal(firmSlot.innerHTML, '', 'the Firm button disappears');
  assert.match(lock.innerHTML, /insp-status/, 'and the lock card appears');
});

test('Inspector.toggleFirm re-checks at click time and refuses a now-locked order with a toast', t => {
  liveClockFixture(t);
  const toasts = [];
  t.mock.method(Toast, 'show', (m) => toasts.push(m));
  t.mock.method(Alerts, 'scheduleRecompute', () => {});
  globalThis.document = { getElementById: () => null };
  const priorId = Inspector._currentId;
  t.after(() => { Inspector._currentId = priorId; });
  Inspector._currentId = 'frozen';
  Inspector.toggleFirm(true);
  assert.equal(Store.isFirmed('frozen'), false);
  assert.equal(toasts.length, 1);
  Inspector._currentId = 'open';
  Inspector.toggleFirm(true);
  assert.equal(Store.isFirmed('open'), true);
});

function ctxFixture() {
  const mk = (extra = {}) => ({ style: {}, disabled: false, hidden: false, focus() {}, setAttribute() {}, ...extra });
  const firm = mk({ dataset: { action: 'firm' } });
  const unfirm = mk({ dataset: { action: 'unfirm' } });
  const note = mk({ textContent: '', hidden: true });
  const sep = mk();
  const menu = {
    hidden: true, style: {},
    querySelectorAll: () => [firm, unfirm],
    querySelector: sel => ({ '[data-action="firm"]': firm, '[data-action="unfirm"]': unfirm, '.ctx-note': note, '#ctx-sep-firm': sep })[sel] ?? null,
    getBoundingClientRect: () => ({ width: 200, height: 200 }),
  };
  globalThis.document = { activeElement: null, getElementById: id => (id === 'ctx-menu' ? menu : null) };
  globalThis.window = { innerWidth: 1000, innerHeight: 800 };
  globalThis.requestAnimationFrame = cb => cb();
  return { firm, unfirm, note, sep };
}

test('context menu: three states (Firm / Unfirm / lock note) and the separator hides with the note', t => {
  liveClockFixture(t);
  const { firm, unfirm, note, sep } = ctxFixture();
  t.after(() => { ContextMenu._targetId = null; ContextMenu._returnFocus = null; });

  ContextMenu.open(10, 10, 'open');
  assert.equal(firm.style.display, '');
  assert.equal(unfirm.style.display, 'none');
  assert.equal(note.hidden, true);
  assert.equal(sep.style.display, '');

  ContextMenu.open(10, 10, 'manual');
  assert.equal(firm.style.display, 'none');
  assert.equal(unfirm.style.display, '');
  assert.equal(note.hidden, true);

  ContextMenu.open(10, 10, 'frozen');
  assert.equal(firm.style.display, 'none');
  assert.equal(unfirm.style.display, 'none');
  assert.equal(note.hidden, false, 'the lock reason shows in the note');
  assert.ok(note.textContent.length > 0);
  assert.equal(sep.style.display, 'none');

  // Back to an actionable order: the note clears again.
  ContextMenu.open(10, 10, 'open');
  assert.equal(note.hidden, true);
  assert.equal(note.textContent, '');
});

test('SAP Firmed grid column reads ecc_firmed: X or blank; the Inspector More row special-cases the key', t => {
  liveClockFixture(t);
  const col = Table._catalogOnlyColumns().find(c => c.field === 'FIRMING_INDICATOR');
  assert.ok(col, 'the column is still keyed FIRMING_INDICATOR (saved layouts key on it)');
  assert.equal(col.headerName, 'col.sap_firmed');
  assert.equal(col.hide, true, 'hidden by default');
  assert.equal(col.valueGetter({ data: Store.tasks.sap }), 'X');
  assert.equal(col.valueGetter({ data: Store.tasks.open }), '');
  assert.equal(col.valueGetter({ data: undefined }), '');
});

test('Override dialog: the Also firm row is hidden while locked, kept (and applyFirm refuses) otherwise', t => {
  liveClockFixture(t);
  const rows = [];
  const firmRow = { hidden: false };
  const els = {
    'ovr-order': { textContent: '' }, 'ovr-line': { innerHTML: '' },
    'ovr-firm': { checked: false, closest: sel => (sel === '.chk-row' ? firmRow : null) },
  };
  globalThis.document = { getElementById: id => els[id] || null };
  t.mock.method(Util, 'fpDatetime', () => ({ setDate() {} }));
  t.mock.method(Modal, 'open', (id) => rows.push(id));
  Table._fpOvrFinish = null;
  t.mock.method(Table, '_getPairOptions', () => []);
  for (const id of ['open', 'frozen', 'manual']) {
    firmRow.hidden = false;
    Table._openOverrideModalForId(id);
    assert.equal(firmRow.hidden, id === 'frozen', id);
  }
  assert.equal(els['ovr-firm'].checked, true, 'manual firm still sets .checked before the row is shown');
});

test('F key: firms what can be firmed, skips locked orders with a toast, and does nothing on an all-locked selection', t => {
  liveClockFixture(t);
  const toasts = [];
  t.mock.method(Toast, 'show', (m) => toasts.push(m));
  t.mock.method(Alerts, 'scheduleRecompute', () => {});
  const key = () => ({ key: 'f', ctrlKey: false, metaKey: false, target: { tagName: 'DIV', closest: () => null, isContentEditable: false }, preventDefault() {} });
  const press = () => Interaction._onKeyDown?.(key());
  assert.equal(typeof Interaction._onKeyDown, 'function');
  const prior = Selection.ids();
  t.after(() => Selection.set(prior));

  Selection.set(['open', 'frozen']);
  press();
  assert.equal(Store.isFirmed('open'), true);
  assert.equal(Store.isFirmed('frozen'), false, 'a frozen order never gets a planner firm');
  assert.equal(toasts.length, 1, 'the skipped count is toasted');

  toasts.length = 0;
  Selection.set(['frozen', 'running']);
  press();
  assert.equal(toasts.length, 1, 'all-locked selection: one info toast, no write');
  assert.equal(Store.isFirmed('running'), false);

  // Nothing left to firm in the first pair, so the F key now unfirms the planner-only firm.
  Selection.set(['open']);
  press();
  assert.equal(Store.isFirmed('open'), false);
});

test('multi-inspector shows Firm all / Unfirm all only when their list is non-empty', t => {
  liveClockFixture(t);
  const panel = { innerHTML: '', querySelector: () => null };
  globalThis.document = { getElementById: id => (id === 'inspector-body' ? panel : null), querySelector: () => panel };
  const prior = Selection.ids();
  t.after(() => Selection.set(prior));

  Selection.set(['open']);
  Interaction._showMultiInspector();
  assert.match(panel.innerHTML, /data-action="firm"/);
  assert.doesNotMatch(panel.innerHTML, /data-action="unfirm"/);

  Selection.set(['manual']);
  Interaction._showMultiInspector();
  assert.doesNotMatch(panel.innerHTML, /data-action="firm"/);
  assert.match(panel.innerHTML, /data-action="unfirm"/);

  Selection.set(['frozen', 'running']);
  Interaction._showMultiInspector();
  assert.doesNotMatch(panel.innerHTML, /data-action="firm"/);
  assert.doesNotMatch(panel.innerHTML, /data-action="unfirm"/);
  assert.match(panel.innerHTML, /ui\.multi_firmed_count/, 'the firmed count is the union, i18n-routed');
});
