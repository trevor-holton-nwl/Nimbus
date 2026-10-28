// Guard (settings audit Wave D): a user-visible date/time must go through the pref-aware
// Util helpers, so timeFormat / dateFormat change every surface. Fails when a raw
// toLocaleDateString / toLocaleTimeString, or a bare Util.fmtDT( / fmtDTShort( /
// fmtIsoDate(, appears in frontend sources outside the allowlist below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const decoded = fileURLToPath(new URL('../../frontend/', import.meta.url));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (!['locales', 'node_modules', 'Images'].includes(name)) walk(p, out); }
    else if (/\.(mts|js)$/.test(name) && !/\.d\.mts$/.test(name)) out.push(p);
  }
  return out;
}

// path (relative to frontend/, forward slashes) -> { pattern -> why it is allowed }.
// Every entry is a DATA use or the definition itself; nothing here is a display date.
const ALLOW = {
  // The Print CSV export: a file's date text must not change with the viewer's display pref,
  // and the grid's typed-date editor parses MM/DD/YYYY HH:mm back, so it is filled with the same format.
  'scheduling/orders.mts': { 'Util.fmtDT(': 'CSV export + typed-date cell editor round-trip (DATA)' },
  // Manage Data date columns: typed MM/DD/YYYY is parsed by date-input.mts and the CSV export runs
  // through this same formatter, so the display format must stay the one the parser accepts.
  'master-data/material-grids.mts': { 'Util.fmtIsoDate(': 'editable date column + CSV export (DATA)' },
};

const PATTERNS = [
  [/\.toLocaleDateString\(/, 'toLocaleDateString('],
  [/\.toLocaleTimeString\(/, 'toLocaleTimeString('],
  [/\bUtil\.fmtDT\(/, 'Util.fmtDT('],
  [/\bUtil\.fmtDTShort\(/, 'Util.fmtDTShort('],
  [/\bUtil\.fmtIsoDate\(/, 'Util.fmtIsoDate('],
];

test('no raw locale date/time or fixed-format display helper outside the allowlist', () => {
  const offenders = [];
  for (const file of walk(decoded)) {
    const rel = relative(decoded, file).split(sep).join('/');
    if (rel === 'platform/foundation.mts') continue;   // the helper definitions (and fmtIsoDatePref's impossible-date fallback)
    const allowed = ALLOW[rel] || {};
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      for (const [re, name] of PATTERNS) {
        if (re.test(code) && !allowed[name]) offenders.push(`${rel}:${i + 1} ${name}`);
      }
      if (/(^|[^.\w])fmtIsoDate\(/.test(code) && !allowed['Util.fmtIsoDate(']) {
        offenders.push(`${rel}:${i + 1} fmtIsoDate(`);
      }
    });
  }
  assert.deepEqual(offenders, [], `use Util.fmtDTPref / fmtDTShortPref / fmtIsoDatePref / fmtDayLabelPref / _fmtTimePref instead:\n${offenders.join('\n')}`);
});

test('every allowlist entry still points at a real use (a stale entry would hide a regression)', () => {
  for (const [rel, pats] of Object.entries(ALLOW)) {
    const src = readFileSync(join(decoded, rel), 'utf8');
    for (const name of Object.keys(pats)) assert.ok(src.includes(name), `${rel} no longer contains ${name}; drop the allowlist entry`);
  }
});
