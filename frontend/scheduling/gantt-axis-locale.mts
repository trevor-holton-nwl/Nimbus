/* gantt-axis-locale.mts — language for the Gantt time axis (month / weekday names).
 *
 * vis-timeline 7.7.3 (standalone UMD, SRI-pinned in index.html) bundles its own moment build with the
 * locales de, es, fr (and others) but NOT pt. It re-exports that moment as `vis.moment`, and the Timeline
 * `locale` option calls `moment.locale(code)` on it. So: pick the code with `axisLocaleCode()`, make sure
 * a `pt` moment locale exists with `ensureAxisLocale()` (mirrors moment 2.30.1's `pt`), then pass the code
 * as the `locale` option when the Timeline is created.
 *
 * A language change reloads the page (LangSwitcher.set), so the option is applied once at creation; there
 * is no live-switch hook. Note: de/es/fr/pt moment locales start the week on Monday (en: Sunday), so the
 * week-scale gridlines of the axis move accordingly.
 *
 * Pure module: no imports, no Store, no DOM (the `vis` object is passed in).
 */

interface MomentLike {
  locales?: () => string[];
  defineLocale?: (name: string, config: Record<string, unknown>) => unknown;
}

/** moment locale codes the axis supports; anything else falls back to English. */
const SUPPORTED = new Set(['en', 'de', 'es', 'fr', 'pt']);

export function axisLocaleCode(locale: string | null | undefined): string {
  const code = String(locale ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en';
  return SUPPORTED.has(code) ? code : 'en';
}

/** Moment 2.30.1 `pt` locale (months, weekdays, long date formats, week dow 1 / doy 4). */
export const PT_MOMENT_LOCALE: Record<string, unknown> = {
  months: 'janeiro_fevereiro_março_abril_maio_junho_julho_agosto_setembro_outubro_novembro_dezembro'.split('_'),
  monthsShort: 'jan_fev_mar_abr_mai_jun_jul_ago_set_out_nov_dez'.split('_'),
  weekdays: 'Domingo_Segunda-feira_Terça-feira_Quarta-feira_Quinta-feira_Sexta-feira_Sábado'.split('_'),
  weekdaysShort: 'Dom_Seg_Ter_Qua_Qui_Sex_Sáb'.split('_'),
  weekdaysMin: 'Do_2ª_3ª_4ª_5ª_6ª_Sá'.split('_'),
  weekdaysParseExact: true,
  longDateFormat: {
    LT: 'HH:mm',
    LTS: 'HH:mm:ss',
    L: 'DD/MM/YYYY',
    LL: 'D [de] MMMM [de] YYYY',
    LLL: 'D [de] MMMM [de] YYYY HH:mm',
    LLLL: 'dddd, D [de] MMMM [de] YYYY HH:mm',
  },
  calendar: {
    sameDay: '[Hoje às] LT',
    nextDay: '[Amanhã às] LT',
    nextWeek: 'dddd [às] LT',
    lastDay: '[Ontem às] LT',
    lastWeek(this: { day(): number }) { return (this.day() === 0 || this.day() === 6) ? '[Último] dddd [às] LT' : '[Última] dddd [às] LT'; },
    sameElse: 'L',
  },
  relativeTime: {
    future: 'em %s', past: 'há %s', s: 'segundos', ss: '%d segundos', m: 'um minuto', mm: '%d minutos',
    h: 'uma hora', hh: '%d horas', d: 'um dia', dd: '%d dias', w: 'uma semana', ww: '%d semanas',
    M: 'um mês', MM: '%d meses', y: 'um ano', yy: '%d anos',
  },
  dayOfMonthOrdinalParse: /\d{1,2}º/,
  ordinal: '%dº',
  week: { dow: 1, doy: 4 },
};

/**
 * Returns the moment locale code to hand to the Timeline `locale` option, defining `pt` first when the
 * bundled moment lacks it. Falls back to 'en' when `vis.moment` is not reachable (never throws).
 */
export function ensureAxisLocale(vis: { moment?: MomentLike } | undefined, locale: string | null | undefined): string {
  const code = axisLocaleCode(locale);
  if (code === 'en') return 'en';
  const m = vis?.moment;
  try {
    const known = typeof m?.locales === 'function' ? m.locales() : [];
    if (code === 'pt' && !known.includes('pt')) {
      if (typeof m?.defineLocale !== 'function') return 'en';
      m.defineLocale('pt', PT_MOMENT_LOCALE);
    } else if (!known.includes(code)) {
      return 'en';
    }
  } catch { return 'en'; }
  return code;
}
