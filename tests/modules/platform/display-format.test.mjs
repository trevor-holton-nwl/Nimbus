// Settings audit Wave D: timeFormat / dateFormat reach every display helper, and already
// built flatpickr instances pick the prefs up live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Util } from '../../../frontend/platform/foundation.mjs';
import { dayStepLabel } from '../../../frontend/platform/day-stepper.mjs';

globalThis.window = globalThis.window || {};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The few flatpickr date tokens NIMBUS offers (m d Y j M n), enough to check token routing. */
const fakeFlatpickr = {
  formatDate(date, tok) {
    const p = n => String(n).padStart(2, '0');
    const map = { m: p(date.getMonth() + 1), d: p(date.getDate()), Y: String(date.getFullYear()),
      j: String(date.getDate()), M: MONTHS[date.getMonth()], n: String(date.getMonth() + 1) };
    return tok.replace(/[mdYjMn]/g, c => map[c]);
  },
  l10ns: { default: { firstDayOfWeek: 0 } },
};

/** Run `fn` with the prefs resolver and the flatpickr global stubbed, restoring both. */
function withPrefs(prefs, fn) {
  const prior = globalThis.flatpickr;
  globalThis.flatpickr = fakeFlatpickr;
  Util.setPreferenceResolver(key => prefs[key]);
  try { return fn(); } finally {
    Util.setPreferenceResolver(() => undefined);
    if (prior === undefined) delete globalThis.flatpickr; else globalThis.flatpickr = prior;
  }
}

const D = new Date(2026, 9, 28, 15, 4, 5);   // 28 Oct 2026 15:04:05 local

const FORMATS = [
  ['m/d/Y', '10/28/2026', '10/28'],
  ['d/m/Y', '28/10/2026', '28/10'],
  ['Y-m-d', '2026-10-28', '10-28'],
  ['j M Y', '28 Oct 2026', '28 Oct'],
  ['M j, Y', 'Oct 28, 2026', 'Oct 28'],
];

for (const [tok, full, short] of FORMATS) {
  for (const tf of ['12h', '24h']) {
    test(`display helpers follow dateFormat ${tok} and timeFormat ${tf}`, () => {
      withPrefs({ dateFormat: tok, timeFormat: tf }, () => {
        const time = tf === '24h' ? '15:04' : '03:04 PM';
        assert.equal(Util.fmtDTPref(D), `${full} ${time}`);
        assert.equal(Util.fmtDTShortPref(D), `${short} ${time}`);
        assert.equal(Util.fmtDateShortPref(D), short);
        assert.equal(Util.fmtIsoDatePref('2026-10-28'), full);
        assert.equal(Util.fmtIsoDatePref('2026-10-28T09:00:00'), full);
        assert.equal(Util.fmtIsoStampPref('2026-10-28T15:04:05Z', true), `${full} ${tf === '24h' ? '15:04:05' : '03:04:05 PM'}`);
        assert.equal(Util.fmtIsoStampPref('2026-10-28 15:04:05', false), `${full} ${time}`);
      });
    });
  }
}

test('null / invalid input gives the same placeholders the fixed-format helpers gave', () => {
  withPrefs({ dateFormat: 'd/m/Y', timeFormat: '24h' }, () => {
    for (const f of [Util.fmtDTPref, Util.fmtDTShortPref, Util.fmtDateShortPref, Util.fmtDayLabelPref]) {
      assert.equal(f(null), ''); assert.equal(f(undefined), ''); assert.equal(f('garbage'), '');
    }
    assert.equal(Util.fmtIsoDatePref(null), '');
    assert.equal(Util.fmtIsoDatePref(undefined), '');
    assert.equal(Util.fmtIsoDatePref(''), '');
    assert.equal(Util.fmtIsoDatePref('not a date'), 'not a date');
    assert.equal(Util.fmtIsoDatePref('2026-02-30'), Util.fmtIsoDate('2026-02-30'), 'an impossible date does not roll over');
    assert.equal(Util.fmtIsoStampPref(null), '');
    assert.equal(Util.fmtIsoStampPref('not a date'), 'not a date');
  });
});

test('fmtIsoStampPref uses the wall-clock parts as served (no zone shift, midnight is 12 AM)', () => {
  withPrefs({ dateFormat: 'm/d/Y', timeFormat: '12h' }, () => {
    assert.equal(Util.fmtIsoStampPref('2026-10-28T00:30:00Z'), '10/28/2026 12:30 AM');
    assert.equal(Util.fmtIsoStampPref('2026-10-28T12:00:00Z'), '10/28/2026 12:00 PM');
    assert.equal(Util.fmtIsoStampPref('2026-10-28'), '10/28/2026', 'a date-only string has no time part');
  });
});

test('the fixed-format DATA helpers are unchanged by the prefs', () => {
  withPrefs({ dateFormat: 'Y-m-d', timeFormat: '12h' }, () => {
    assert.equal(Util.fmtDT(D), '10/28/2026 15:04');
    assert.equal(Util.fmtDTShort(D), '10/28 15:04');
    assert.equal(Util.fmtIsoDate('2026-10-28'), '10/28/2026');
  });
});

test('converted call sites follow the pref: day stepper label, Dashboard short date', async () => {
  const { Dashboard } = await import('../../../frontend/insights/insights-ui.mjs');
  withPrefs({ dateFormat: 'd/m/Y', timeFormat: '24h' }, () => {
    assert.match(dayStepLabel('2026-10-28', ['2026-10-26', '2026-10-27']), /28\/10$/);
    assert.equal(Dashboard._dateNumeric(new Date(2026, 9, 28)), '28/10');
  });
  withPrefs({ dateFormat: 'M j, Y' }, () => {
    assert.match(dayStepLabel('2026-10-28', ['2026-10-26', '2026-10-27']), /Oct 28$/);
    assert.equal(Dashboard._dateNumeric(new Date(2026, 9, 28)), 'Oct 28');
  });
});

/** A fake `.flatpickr-input` host with a minimal live instance. */
function fakePicker(config, firstDayOfWeek = 0) {
  const calls = [];
  const fp = {
    config: { ...config }, l10n: { firstDayOfWeek, weekdays: { shorthand: ['x'] } },
    set(k, v) { calls.push([k, v]); if (k === 'altFormat') this.config.altFormat = v; if (k === 'locale') this.l10n = v; },
  };
  return { el: { _flatpickr: fp }, fp, calls };
}
const rootOf = (...pickers) => ({ querySelectorAll: () => pickers.map(p => p.el) });

test('refreshFlatpickrPrefs re-applies altFormat per picker kind and the week start to existing pickers', () => {
  const dateOnly = fakePicker({ altInput: true, altFormat: 'm/d/Y' });
  const datetime = fakePicker({ altInput: true, enableTime: true, altFormat: 'm/d/Y · G:i K' });
  const timeOnly = fakePicker({ altInput: true, enableTime: true, noCalendar: true, altFormat: 'G:i K' });
  const plain = fakePicker({ altInput: false });
  withPrefs({ dateFormat: 'Y-m-d', timeFormat: '24h', firstDayOfWeek: 1 }, () => {
    const n = Util.refreshFlatpickrPrefs(rootOf(dateOnly, datetime, timeOnly, plain));
    assert.equal(n, 4);
    assert.equal(dateOnly.fp.config.altFormat, 'Y-m-d');
    assert.equal(datetime.fp.config.altFormat, 'Y-m-d · H:i');
    assert.equal(timeOnly.fp.config.altFormat, 'H:i');
    assert.deepEqual(plain.calls.map(c => c[0]), ['locale'], 'a picker with no alt input only gets the week start');
    for (const p of [dateOnly, datetime, plain]) assert.equal(p.fp.l10n.firstDayOfWeek, 1);
    assert.deepEqual(dateOnly.fp.l10n.weekdays, { shorthand: ['x'] }, 'the rest of the instance locale is kept');
    assert.equal(timeOnly.calls.some(c => c[0] === 'locale'), false, 'a time-only picker has no calendar to re-week');
    // Idempotent: a second pass with nothing changed touches no option.
    const before = dateOnly.calls.length;
    Util.refreshFlatpickrPrefs(rootOf(dateOnly));
    assert.equal(dateOnly.calls.length, before);
  });
});

test('refreshFlatpickrPrefs ignores non-picker nodes and survives a throwing picker', () => {
  const good = fakePicker({ altInput: true, altFormat: 'm/d/Y' });
  const bad = { el: { _flatpickr: { config: { altInput: true }, l10n: {}, set() { throw new Error('torn down'); } } } };
  withPrefs({ dateFormat: 'd/m/Y' }, () => {
    const n = Util.refreshFlatpickrPrefs({ querySelectorAll: () => [{}, bad.el, good.el] });
    assert.equal(n, 1);
    assert.equal(good.fp.config.altFormat, 'd/m/Y');
    assert.equal(Util.refreshFlatpickrPrefs(null), globalThis.document ? Util.refreshFlatpickrPrefs() : 0);
  });
});
