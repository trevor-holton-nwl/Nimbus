// priority-lists/mapping.mjs — modal-DOM adapter for the priority-list
// column-mapping modal. Extracted verbatim from plant-and-administration.mts
// (Phase P2 of docs/architecture/domain-refactor-plan.md).
import { Util } from '../platform/foundation.mjs';

/** Value of the mapping modal's "— use row order —" rank-column option. Must
 *  match `brain.ROW_ORDER_SENTINEL` and the static `<option>` in
 *  `frontend/index.html`'s `#pl-mapping-rank-col`. An explicit sentinel (rather than
 *  `''`) is what lets the backend tell "the user chose row order" apart from
 *  "no rank_column was sent", instead of silently auto-detecting a column the
 *  user just declined. */
const ROW_ORDER_SENTINEL = '__row_order__';

/** Minimal modal-DOM adapter for the Task 10 `#modal-priority-mapping` markup
 *  (`frontend/index.html`) — shown when a priority-list upload's headers don't
 *  match the expected value/rank column names and the backend responds
 *  `{status:'needs_mapping', headers, sample}` (see `Plant._uploadPriorityList`
 *  above). Deliberately tiny: it only shuttles the user's column picks back
 *  to whichever `onConfirm` callback the caller supplied. */
export const PriorityListMapping = (() => {
  let _onConfirm: ((valueCol: string, rankCol: string) => void) | null = null;
  // Fired only when the modal is DISMISSED (backdrop / × / Cancel), never when
  // confirm() closes it — confirm() clears this first. Lets the caller undo the
  // "Uploading <file>…" status line it set before the needs_mapping round-trip.
  let _onCancel: (() => void) | null = null;

  // headers/sample come straight from the uploaded spreadsheet's own column
  // names and cell values — genuinely untrusted content (e.g. a header of
  // `<img src=x onerror=...>` would otherwise execute in an admin's
  // browser). Same escape regex this file uses everywhere else (see
  // `_renderOptimization`'s local `esc`).

  function open(headers: string[], sample: Record<string, unknown>[],
                onConfirm: (v: string, r: string) => void, onCancel?: () => void): void {
    _onConfirm = onConfirm;
    _onCancel = onCancel || null;
    const valSel = document.getElementById('pl-mapping-value-col') as HTMLSelectElement;
    const rankSel = document.getElementById('pl-mapping-rank-col') as HTMLSelectElement;
    valSel.innerHTML = headers.map(h => `<option value="${Util.escapeHtml(h)}">${Util.escapeHtml(h)}</option>`).join('');
    // ROW_ORDER_SENTINEL, not '' — an empty value is indistinguishable server-side
    // from "the client sent no rank_column at all", so brain.py's
    // _resolve_priority_list_columns fell through to auto-detection and could rank
    // by a column (e.g. ORDER) the user had just explicitly declined. Must stay in
    // sync with brain.ROW_ORDER_SENTINEL and index.html's static <option>.
    rankSel.innerHTML = `<option value="${ROW_ORDER_SENTINEL}">${Util.t('ui.mapping_rank_none')}</option>` +
      headers.map(h => `<option value="${Util.escapeHtml(h)}">${Util.escapeHtml(h)}</option>`).join('');
    const sampleEl = document.getElementById('pl-mapping-sample');
    if (sampleEl) {
      sampleEl.innerHTML = `<table class="pl-sample-table"><thead><tr>${headers.map(h => `<th>${Util.escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${
        sample.slice(0, 5).map(row => `<tr>${headers.map(h => `<td>${Util.escapeHtml(row[h])}</td>`).join('')}</tr>`).join('')
      }</tbody></table>`;
    }
    const el = document.getElementById('modal-priority-mapping');
    if (el) el.hidden = false;
  }

  function close(): void {
    const el = document.getElementById('modal-priority-mapping');
    if (el) el.hidden = true;
    const cancelled = _onCancel;
    _onConfirm = null;
    _onCancel = null;
    // confirm() nulls _onCancel before calling close(), so this only fires for a
    // genuine dismissal.
    if (cancelled) cancelled();
  }

  function confirm(): void {
    const valSel = document.getElementById('pl-mapping-value-col') as HTMLSelectElement;
    const rankSel = document.getElementById('pl-mapping-rank-col') as HTMLSelectElement;
    const cb = _onConfirm;
    _onCancel = null;
    close();
    if (cb) cb(valSel.value, rankSel.value);
  }

  return { open, close, confirm };
})();
