import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Util, Toast } from '../../../frontend/platform/foundation.mjs';
import { Store } from '../../../frontend/platform/store.mjs';
import { ORDER_FIELD_CATALOG } from '../../../frontend/scheduling/order-field-catalog.mjs';

let instance = 0;
async function fixture(t) {
  let html = ''; let inputs = []; const controls = new Map();
  const node = (props = {}) => ({ ...props, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, fire(type, e) { return this.listeners[type]?.(e ?? { target: this }); } });
  const host = {
    get innerHTML() { return html; },
    set innerHTML(value) {
      html = value;
      inputs = [...value.matchAll(/<input[^>]+data-sc-field="([^"]+)"[^>]+data-sc-surface="([^"]+)"[^>]*>/g)].map(m => node({ dataset: { scField: m[1], scSurface: m[2] }, checked: /\schecked(?:\s|>)/.test(m[0]) }));
      controls.set('#sc-save-btn', node({ disabled: /id="sc-save-btn"[^>]*disabled/.test(value) }));
      controls.set('#sc-save-state', node({ textContent: '' }));
      const ret = /id="sc-retention-days"[^>]*value="(\d+)"/.exec(value);
      const attrs = {};
      controls.set('#sc-retention-days', node({ value: ret ? ret[1] : '', attrs, setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; } }));
      controls.set('#sc-retention-invalid', node({ hidden: /id="sc-retention-invalid"[^>]*\shidden/.test(value) }));
    },
    querySelectorAll: () => inputs,
    querySelector(selector) {
      if (controls.has(selector)) return controls.get(selector);
      const match = selector.match(/data-sc-field="([^"]+)".*data-sc-surface="([^"]+)"/);
      return match ? inputs.find(input => input.dataset.scField === match[1] && input.dataset.scSurface === match[2]) : null;
    },
  };
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = { getElementById: id => id === 'system-config-host' ? host : null };
  globalThis.window = {};
  t.after(() => Object.assign(globalThis, previous));
  const requests = []; const published = [];
  t.mock.method(Toast, 'show', () => {});
  t.mock.method(Store, 'setOrderFieldVisibility', fields => published.push(structuredClone(fields)));
  t.mock.method(Util, 'fetchTraced', (url, opts) => new Promise(resolve => requests.push({ url, opts, resolve })));
  const { SystemConfig: config } = await import(`../../../frontend/admin-ops/admin-ui.mjs?system-config=${++instance}`);
  const respond = (request, fields, status = 200) => request.resolve({ ok: status < 400, status, json: async () => ({ orderFields: fields }) });
  async function load(fields = {}) { const promise = config.render(); respond(requests.at(-1), fields); await promise; }
  const key = ORDER_FIELD_CATALOG[0].key;
  const input = () => host.querySelector(`input[data-sc-field="${key}"][data-sc-surface="grid"]`);
  function edit(value) { input().checked = value; input().fire('change'); }
  return { config, requests, published, respond, load, input, edit, key, save: () => controls.get('#sc-save-btn'), retention: () => controls.get('#sc-retention-days'), retentionHint: () => controls.get('#sc-retention-invalid'), status: () => controls.get('#sc-save-state') };
}

test('System Config suppresses duplicate saves and acknowledges only the submitted snapshot', async t => {
  const f = await fixture(t); await f.load();
  const original = f.input().checked;
  assert.equal(f.save().disabled, true, 'normalized defaults are initially clean');
  f.edit(!original); assert.equal(f.save().disabled, false);
  assert.equal(f.status().textContent, 'ui.system_config_unsaved');
  const saving = f.save().fire('click'); const pending = f.requests.at(-1);
  f.save().fire('click'); assert.equal(f.requests.filter(r => r.opts?.method === 'POST').length, 1);
  assert.equal(f.save().disabled, true);
  assert.equal(f.status().textContent, 'ui.system_config_saving');
  f.edit(original);
  const submitted = JSON.parse(pending.opts.body).orderFields;
  assert.equal(submitted[f.key].grid, !original);
  f.respond(pending, submitted); await saving;
  assert.equal(f.published.at(-1)[f.key].grid, !original);
  assert.equal(f.input().checked, original, 'newer reversal remains visible');
  assert.equal(f.save().disabled, false, 'newer reversal still needs a save');
  const retry = f.save().fire('click'); const next = f.requests.at(-1);
  assert.equal(JSON.parse(next.opts.body).orderFields[f.key].grid, original);
  f.respond(next, JSON.parse(next.opts.body).orderFields); await retry;
  assert.equal(f.save().disabled, true);
});

test('System Config failure retains the draft and baseline for retry', async t => {
  const f = await fixture(t); await f.load();
  f.edit(!f.input().checked);
  const value = f.input().checked;
  const save = f.save().fire('click'); f.respond(f.requests.at(-1), {}, 500); await save;
  assert.equal(f.input().checked, value); assert.equal(f.save().disabled, false);
  assert.equal(f.status().textContent, 'ui.system_config_unsaved');
  assert.equal(f.published.length, 0);
  const retry = f.save().fire('click'); const pending = f.requests.at(-1);
  f.respond(pending, JSON.parse(pending.opts.body).orderFields); await retry;
  assert.equal(f.save().disabled, true);
});

test('System Config out-of-order loads and loads preceding edits cannot replace current drafts', async t => {
  const f = await fixture(t);
  const older = f.config.render(); const first = f.requests.at(-1);
  const newer = f.config.render(); const second = f.requests.at(-1);
  f.respond(second, { [f.key]: { grid: true } }); await newer;
  f.respond(first, { [f.key]: { grid: false } }); await older;
  assert.equal(f.input().checked, true);
  const refresh = f.config.render(); const pending = f.requests.at(-1);
  f.edit(false);
  f.respond(pending, { [f.key]: { grid: true } }); await refresh;
  assert.equal(f.input().checked, false);
  assert.equal(f.save().disabled, false);
  const count = f.requests.length;
  await f.config.render();
  assert.equal(f.requests.length, count, 'returning to a dirty editor preserves its draft');
  assert.equal(f.input().checked, false);
});

test('System Config a failed obsolete load does not remove a newer editor', async t => {
  const f = await fixture(t);
  const older = f.config.render(); const first = f.requests.at(-1);
  const newer = f.config.render(); f.respond(f.requests.at(-1), { [f.key]: { grid: true } }); await newer;
  f.respond(first, {}, 500); await older;
  assert.equal(f.input()?.checked, true);
});


test('System Config keeps an unrelated in-flight edit across a busy re-render', async t => {
  const f = await fixture(t); await f.load();
  f.edit(!f.input().checked);
  const saving = f.save().fire('click'); const pending = f.requests.at(-1);
  const submitted = JSON.parse(pending.opts.body).orderFields;
  const secondKey = ORDER_FIELD_CATALOG[1].key;
  // The first field remains the submitted value; edit a different checkbox.
  const host = globalThis.document.getElementById('system-config-host');
  const second = host.querySelector(`input[data-sc-field="${secondKey}"][data-sc-surface="inspector"]`);
  second.checked = !second.checked; second.fire('change');
  const intended = second.checked;
  const count = f.requests.length;
  await f.config.render();
  assert.equal(f.requests.length, count, 'busy re-render never starts an obsolete GET');
  f.respond(pending, submitted); await saving;
  assert.equal(f.published.at(-1)[secondKey].inspector, submitted[secondKey].inspector);
  assert.equal(host.querySelector(`input[data-sc-field="${secondKey}"][data-sc-surface="inspector"]`).checked, intended);
  assert.equal(f.save().disabled, false);
});

test('System Config retention: an invalid value disables Save and flags the input; a valid one marks dirty; blur clamps', async t => {
  const f = await fixture(t); await f.load();
  const ret = f.retention();
  assert.equal(f.save().disabled, true, 'clean at load');
  assert.equal(f.retentionHint().hidden, true);
  // valid change -> dirty
  ret.value = '30'; ret.fire('input');
  assert.equal(f.save().disabled, false);
  assert.equal(ret.attrs['aria-invalid'], undefined);
  // out of range while typing -> invalid, not clamped under the cursor
  ret.value = '75'; ret.fire('input');
  assert.equal(f.save().disabled, true, 'Save disabled while invalid');
  assert.equal(ret.attrs['aria-invalid'], 'true');
  assert.equal(f.retentionHint().hidden, false);
  assert.equal(ret.value, '75', 'no write-back on input');
  // not an integer / empty -> invalid too
  for (const bad of ['', '1.5', '0', '-3', 'abc']) {
    ret.value = bad; ret.fire('input');
    assert.equal(f.save().disabled, true, `"${bad}" disables Save`);
  }
  // blur clamps and re-enables
  ret.value = '75'; ret.fire('input');
  ret.fire('change');
  assert.equal(ret.value, '60', 'clamped on change');
  assert.equal(f.save().disabled, false);
  assert.equal(ret.attrs['aria-invalid'], undefined);
  assert.equal(f.retentionHint().hidden, true);
  // back to the baseline value -> clean again
  ret.value = '14'; ret.fire('input');
  assert.equal(f.save().disabled, true);
  // empty then blur restores the last valid draft
  ret.value = ''; ret.fire('input'); ret.fire('change');
  assert.equal(ret.value, '14');
});
