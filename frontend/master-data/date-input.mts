// date-input.mts -- pure helpers for date cells in the Manage Data grids.
//
// Dates are stored and posted as YYYY-MM-DD; users see and type MM/DD/YYYY. Everything here works
// on the string's own parts (no Date parsing), so there is no timezone shift: '2026-01-01' can
// never become 12/31/2025.

/** Production Version / Routing Operation / BOM date columns, by name (the grid's column
 *  metadata carries no SQL type; user-added columns are not detected). */
export const DATE_COLUMNS: ReadonlySet<string> = new Set([
  'valid_from', 'valid_to', 'header_valid_from', 'header_valid_to', 'changed_on',
]);

export function isDateColumn(name: string): boolean {
  return DATE_COLUMNS.has(name);
}

function _validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 'MM/DD/YYYY', 'M/D/YYYY' or 'YYYY-MM-DD' (a trailing time part is ignored) -> 'YYYY-MM-DD';
 *  null for anything else or an impossible date (02/30/2026). */
export function parseUserDate(s: string | null | undefined): string | null {
  const t = String(s ?? '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (m) return _validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return _validYmd(+m[3], +m[1], +m[2]);
  return null;
}

/** What a date cell shows for a stored/typed value: an ISO date -> MM/DD/YYYY; anything else
 *  (blank, a half-typed or invalid entry) is shown exactly as it is. */
export function displayDate(value: unknown, fmtIso: (iso: string) => string): string {
  const s = value == null ? '' : String(value);
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? parseUserDate(s) : null;
  return iso ? fmtIso(iso) : s;
}

export type DateNormalizeResult =
  | { ok: true; value: string }
  | { ok: false; value: string; bad: string };

/** The value to post for a date cell: '' stays '' (clears), a parseable date becomes ISO,
 *  anything else is reported (`bad`) and never posted as typed. */
export function normalizeDateCell(value: unknown): DateNormalizeResult {
  const s = value == null ? '' : String(value).trim();
  if (!s) return { ok: true, value: '' };
  const iso = parseUserDate(s);
  return iso ? { ok: true, value: iso } : { ok: false, value: s, bad: s };
}

/** Normalise the date columns of pasted/staged rows in place. Returns one message per bad cell
 *  (1-based row number = position in `rows`), leaving the offending cell as typed. */
export function normalizeDateColumns(
  rows: Array<Record<string, unknown>>,
  isDateCol: (name: string) => boolean = isDateColumn,
): Array<{ row: number; column: string; value: string }> {
  const bad: Array<{ row: number; column: string; value: string }> = [];
  rows.forEach((row, i) => {
    for (const col of Object.keys(row)) {
      if (!isDateCol(col) || row[col] == null) continue;   // null stays null (an untouched empty date)
      const r = normalizeDateCell(row[col]);
      if (r.ok) row[col] = r.value;
      else bad.push({ row: i + 1, column: col, value: r.bad });
    }
  });
  return bad;
}
