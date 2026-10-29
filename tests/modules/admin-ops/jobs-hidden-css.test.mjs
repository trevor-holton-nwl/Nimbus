// Regression: a class/id rule that sets `display:` beats the UA `[hidden]{display:none}`, so any element the code
// hides with the `hidden` attribute needs a paired `sel[hidden]{display:none}` rule. Scoped to the Jobs pane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../frontend/', import.meta.url);
const css = readFileSync(new URL('styles.css', root), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = readFileSync(new URL('index.html', root), 'utf8');
const jobsSrc = ['jobs-pane', 'jobs-dialog', 'jobs-run-detail', 'jobs-model']
  .map(n => readFileSync(new URL(`admin-ops/${n}.mts`, root), 'utf8')).join('\n');

// Flat rules only (skip @media bodies' nesting by regex over simple `sel { body }` pairs).
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
const displaySetters = rules.filter(r => /(^|;|\s)display\s*:/.test(r.body) && !/display\s*:\s*none/.test(r.body));
const hiddenPairs = rules.filter(r => /display\s*:\s*none/.test(r.body) && r.sel.includes('[hidden]')).map(r => r.sel);

/** Jobs-scoped simple selectors (single class or id, optionally compound with a parent) that set display. */
const jobsSetters = displaySetters.flatMap(r => r.sel.split(',').map(s => s.trim()))
  .filter(s => /(^|[\s.#])(job-|jobs-|jr-)/.test(s) && !s.includes(':') && !s.includes('['));

/** Elements carrying `hidden`: static markup in index.html and template strings in the jobs sources. */
const hiddenTags = [...html.matchAll(/<[a-z0-9]+\b[^>]*\shidden(?=[\s>=])[^>]*>/gi), ...jobsSrc.matchAll(/<[a-z0-9]+\b[^>]*\shidden(?=[\s>=])[^>]*>/gi)].map(m => m[0]);
const tokensOf = tag => {
  const cls = (tag.match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean).map(c => '.' + c);
  const id = (tag.match(/\bid="([^"$]*)"/) || [, ''])[1];
  return id ? [...cls, '#' + id] : cls;
};
const lastSimple = sel => sel.split(/\s+/).pop();   // the subject of a descendant selector

test('.job-pane[hidden] exists', () => {
  assert.ok(hiddenPairs.some(s => s.split(',').map(x => x.trim()).includes('.job-pane[hidden]')), 'missing .job-pane[hidden] { display: none }');
});

test('any single-class display rule used on a [hidden] element of the Jobs sources has a paired [hidden] rule', () => {
  // Not only `job-*`: a shared class (btn, badge, kpi-tile ...) toggled with `hidden` in a Jobs template needs its pair too.
  const sourceTags = [...jobsSrc.matchAll(/<[a-z0-9]+\b[^>]*\shidden(?=[\s>=])[^>]*>/gi)].map(m => m[0]);
  const single = displaySetters.flatMap(r => r.sel.split(',').map(s => s.trim())).filter(s => /^\.[\w-]+$/.test(s));
  const offenders = [];
  for (const tag of sourceTags) {
    for (const cls of tokensOf(tag).filter(c => c.startsWith('.'))) {
      if (!single.includes(cls)) continue;
      const paired = hiddenPairs.some(p => p.split(',').map(x => x.trim()).some(x => x.split(/\s+/).pop() === cls + '[hidden]'));   // a scoped pair (`.job-combobox .hps-clear[hidden]`) counts
      if (!paired) offenders.push(`${cls}  <-  ${tag.slice(0, 80)}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], []);
});

test('every Jobs display-setting selector used on a [hidden] element has a paired [hidden] rule', () => {
  const offenders = [];
  for (const tag of hiddenTags) {
    const toks = tokensOf(tag);
    for (const setter of jobsSetters) {
      const subject = lastSimple(setter);
      if (!toks.some(t => subject === t || subject.endsWith(t) && /^[.#]/.test(subject) && subject.split(/(?=[.#])/).includes(t))) continue;
      const paired = hiddenPairs.some(p => p.split(',').map(x => x.trim()).some(x => x.replace(/\[hidden\]/, '') === setter || x === setter + '[hidden]'));
      if (!paired) offenders.push(`${setter}  <-  ${tag.slice(0, 80)}`);
    }
  }
  assert.deepEqual([...new Set(offenders)], []);
});
