// Tests for web/admin-tables.mjs — Workstream E's universal table browser.
//
// Only the two pure helpers are exercised here (paste-splitting and
// query-param construction) — everything else in the module is DOM-driven
// (renders into #admin-table-browser-host, talks to AG Grid) and is exactly
// the kind of thing this repo's test convention deliberately leaves to
// manual verification rather than a heavyweight DOM-stubbed test (see
// tests/modules/schedule-data.test.mjs for what that stubbing looks like
// when it IS worth it — not needed here since neither pure helper touches
// document/window).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdminTables, parseFilterPasteText, buildTableQueryParams } from '../../web/admin-tables.mjs';

test('parseFilterPasteText splits on newline, comma, and tab', () => {
  assert.deepEqual(parseFilterPasteText('A\nB\tC,D'), ['A', 'B', 'C', 'D']);
});

test('parseFilterPasteText trims whitespace around each value', () => {
  assert.deepEqual(parseFilterPasteText('  A  \n  B  '), ['A', 'B']);
});

test('parseFilterPasteText drops empty entries from blank lines / trailing separators', () => {
  assert.deepEqual(parseFilterPasteText('A\n\n,B,\n'), ['A', 'B']);
});

test('parseFilterPasteText dedupes repeated values', () => {
  assert.deepEqual(parseFilterPasteText('A,A,B,a'), ['A', 'B', 'a']); // dedupe is exact-match, not case-folded
});

test('parseFilterPasteText strips the Excel ".0" float suffix, matching every other paste-filter in the app', () => {
  assert.deepEqual(parseFilterPasteText('1000261702.0,42'), ['1000261702', '42']);
});

test('parseFilterPasteText returns [] for null/undefined/empty input', () => {
  assert.deepEqual(parseFilterPasteText(null), []);
  assert.deepEqual(parseFilterPasteText(undefined), []);
  assert.deepEqual(parseFilterPasteText(''), []);
});

test('buildTableQueryParams emits one repeated query param per filter value (never comma-joined)', () => {
  const filters = new Map([
    ['plant', new Set(['5512', '1006'])],
    ['material_id', new Set(['A1'])],
  ]);
  const params = buildTableQueryParams(filters);
  assert.deepEqual(params.getAll('plant').sort(), ['1006', '5512']);
  assert.deepEqual(params.getAll('material_id'), ['A1']);
  // No pagination params were requested.
  assert.equal(params.has('limit'), false);
  assert.equal(params.has('offset'), false);
});

test('buildTableQueryParams includes limit/offset only when explicitly passed', () => {
  const empty = buildTableQueryParams(new Map());
  assert.equal(empty.toString(), '');

  const paged = buildTableQueryParams(new Map(), { limit: 100, offset: 200 });
  assert.equal(paged.get('limit'), '100');
  assert.equal(paged.get('offset'), '200');
});

test('buildTableQueryParams skips a column whose filter set is empty (no degenerate empty-match param)', () => {
  const filters = new Map([['plant', new Set()], ['line', new Set(['L1'])]]);
  const params = buildTableQueryParams(filters);
  assert.equal(params.has('plant'), false);
  assert.deepEqual(params.getAll('line'), ['L1']);
});

test('buildTableQueryParams drops an empty-string value rather than sending a blank filter param', () => {
  const filters = new Map([['plant', new Set(['5512', ''])]]);
  const params = buildTableQueryParams(filters);
  assert.deepEqual(params.getAll('plant'), ['5512']);
});

test('AdminTables exposes the documented public surface', () => {
  assert.equal(typeof AdminTables.render, 'function');
  assert.equal(typeof AdminTables._selectTable, 'function');
  assert.equal(typeof AdminTables._clearAllFilters, 'function');
  assert.equal(typeof AdminTables._prevPage, 'function');
  assert.equal(typeof AdminTables._nextPage, 'function');
  assert.equal(typeof AdminTables._setPageSize, 'function');
});
