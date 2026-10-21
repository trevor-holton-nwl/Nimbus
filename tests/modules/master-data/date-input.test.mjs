import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDateColumn, parseUserDate, displayDate, normalizeDateCell, normalizeDateColumns,
} from '../../../frontend/master-data/date-input.mjs';
import { Util } from '../../../frontend/platform/foundation.mjs';

test('parseUserDate accepts MM/DD/YYYY, M/D/YYYY and ISO', () => {
  assert.equal(parseUserDate('01/15/2026'), '2026-01-15');
  assert.equal(parseUserDate('1/5/2026'), '2026-01-05');
  assert.equal(parseUserDate('2026-01-15'), '2026-01-15');
  assert.equal(parseUserDate('2026-01-15T00:00:00'), '2026-01-15');
  assert.equal(parseUserDate('  12/31/9999 '), '9999-12-31');
});

test('parseUserDate has no timezone shift: 2026-01-01 never becomes 12/31/2025', () => {
  assert.equal(parseUserDate('2026-01-01'), '2026-01-01');
  assert.equal(parseUserDate('01/01/2026'), '2026-01-01');
  assert.equal(displayDate('2026-01-01', Util.fmtIsoDate), '01/01/2026');
});

test('parseUserDate rejects impossible and malformed dates', () => {
  for (const bad of ['02/30/2026', '13/01/2026', '00/10/2026', '2026-02-29', '2026-13-01', '31/12/2026',
    'abc', '', null, undefined, '01-15-2026', '1/5/26']) {
    assert.equal(parseUserDate(bad), null, String(bad));
  }
  assert.equal(parseUserDate('02/29/2024'), '2024-02-29');   // leap year
  assert.equal(parseUserDate('02/29/2100'), null);            // not a leap year
});

test('9999-12-31 round-trips through display and parse', () => {
  const shown = displayDate('9999-12-31', Util.fmtIsoDate);
  assert.equal(shown, '12/31/9999');
  assert.equal(parseUserDate(shown), '9999-12-31');
});

test('displayDate shows blanks and unreadable text as they are', () => {
  assert.equal(displayDate(null, Util.fmtIsoDate), '');
  assert.equal(displayDate('', Util.fmtIsoDate), '');
  assert.equal(displayDate('13/45/2026', Util.fmtIsoDate), '13/45/2026');
  assert.equal(displayDate('soon', Util.fmtIsoDate), 'soon');
  assert.equal(displayDate('02/30/2026', Util.fmtIsoDate), '02/30/2026');
});

test('display -> parse is the identity for unchanged cells (no spurious dirty)', () => {
  // The grid marks a row dirty only on an input event, and a date cell's input handler posts the
  // normalised value: an unchanged display string normalises back to the stored ISO value.
  for (const iso of ['2026-01-01', '2025-12-31', '9999-12-31', '2024-02-29']) {
    assert.deepEqual(normalizeDateCell(displayDate(iso, Util.fmtIsoDate)), { ok: true, value: iso });
  }
  assert.deepEqual(normalizeDateCell(''), { ok: true, value: '' });
});

test('normalizeDateCell reports an unreadable date instead of passing it through', () => {
  assert.deepEqual(normalizeDateCell('02/30/2026'), { ok: false, value: '02/30/2026', bad: '02/30/2026' });
  assert.deepEqual(normalizeDateCell(' 3/4/2026 '), { ok: true, value: '2026-03-04' });
});

test('isDateColumn names the production version / routing operation / BOM date columns', () => {
  for (const c of ['valid_from', 'valid_to', 'header_valid_from', 'header_valid_to', 'changed_on']) {
    assert.equal(isDateColumn(c), true, c);
  }
  assert.equal(isDateColumn('production_version'), false);
  assert.equal(isDateColumn('plant'), false);
});

test('normalizeDateColumns converts pasted rows to ISO and lists the bad cells', () => {
  const rows = [
    { plant: '1000', valid_from: '01/15/2026', valid_to: '12/31/9999', material_id: 'A' },
    { plant: '1000', valid_from: '02/30/2026', valid_to: '', material_id: 'B' },
    { plant: '1000', valid_from: '2026-03-01', valid_to: null, material_id: 'C' },
    { plant: '1000', VALID_FROM: '4/5/2026', material_id: 'D' },
  ];
  const bad = normalizeDateColumns(rows, (n) => isDateColumn(n.toLowerCase()));
  assert.deepEqual(bad, [{ row: 2, column: 'valid_from', value: '02/30/2026' }]);
  assert.equal(rows[0].valid_from, '2026-01-15');
  assert.equal(rows[0].valid_to, '9999-12-31');
  assert.equal(rows[1].valid_from, '02/30/2026');   // left as typed; never silently altered
  assert.equal(rows[1].valid_to, '');
  assert.equal(rows[2].valid_from, '2026-03-01');
  assert.equal(rows[2].valid_to, null);             // an untouched null date stays null
  assert.equal(rows[3].VALID_FROM, '2026-04-05');
  assert.equal(rows[0].material_id, 'A');           // non-date columns untouched
});
