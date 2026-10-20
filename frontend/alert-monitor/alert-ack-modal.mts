/* =============================================================================
   ALERT ACKNOWLEDGE MODAL — "Acknowledge…" on an Alert Monitor row.

   The static shell (#modal-alert-ack) lives in index.html; this module fills the body
   (#aak-body) and footer (#aak-foot) at runtime and opens/closes it through Modal.open/close
   (the single central focus trap). Submit -> AlertAcksClient.acknowledge, which refetches the
   plant's acks and fans out, so every list (bell, drawer, Dashboard summary, the pane) repaints
   itself; this module never touches the Store.

   Until convention (backend/alert_profiles/CLAUDE.md, "Naive local time"): `until` crosses the
   API as a naive ISO string interpreted as plant-local server time, never with an offset or Z.
   The picked day is sent as the END of that day (YYYY-MM-DDT23:59:59), so "until the 27th" keeps
   the alert hidden through the 27th. "No end date" sends null.
   ========================================================================== */

import { Store } from '../platform/store.mjs';
import { Util, Modal, Toast } from '../platform/foundation.mjs';
import { AlertAcksClient } from '../insights/alert-acks-client.mjs';

const t = (key: string, vars?: Record<string, string | number>): string => Util.t(key, vars);
const esc = (s: unknown): string => Util.escapeHtml(String(s ?? ''));

export const ACK_REASON_MAX = 200;
export const ACK_DEFAULT_DAYS = 7;

export type AckValidation =
  | { ok: true; reason: string; until: string | null }
  | { ok: false; field: 'reason' | 'until'; key: string };

/** Pure: the reason is required (trimmed) and at most 200 characters; until is the end of the picked day, or null with No end date. */
export function validateAck(rawReason: string, untilDay: string | null | undefined, noEnd: boolean): AckValidation {
  const reason = String(rawReason ?? '').trim();
  if (!reason) return { ok: false, field: 'reason', key: 'am.ack_err_reason' };
  if (reason.length > ACK_REASON_MAX) return { ok: false, field: 'reason', key: 'am.ack_err_long' };
  if (noEnd) return { ok: true, reason, until: null };
  const day = String(untilDay ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ok: false, field: 'until', key: 'am.ack_err_until' };
  return { ok: true, reason, until: `${day}T23:59:59` };
}

/** The default end date: the plant's today plus seven days, as YYYY-MM-DD. */
export function defaultUntilDay(plant: string): string {
  const d = new Date(Util.plantToday(plant));
  d.setDate(d.getDate() + ACK_DEFAULT_DAYS);
  return Util.dayKey(d);
}

interface AckState { plant: string; alertId: string; busy: boolean; }
interface PickerLike { setDate(d: string, fire?: boolean): void; destroy(): void; altInput?: HTMLInputElement }

let _s: AckState | null = null;
let _fp: PickerLike | null = null;

function _el<E extends HTMLElement = HTMLElement>(id: string): E | null {
  return document.getElementById(id) as E | null;
}

function _destroyPicker(): void {
  if (_fp) { try { _fp.destroy(); } catch { /* already gone */ } _fp = null; }
}

function _bodyHtml(): string {
  return `<div class="form-row"><label for="aak-reason">${esc(t('am.ack_reason'))}</label>`
    + `<textarea class="input" id="aak-reason" rows="3" maxlength="${ACK_REASON_MAX}" required></textarea>`
    + `<div class="ape-err" id="aak-err-reason" role="alert" hidden></div></div>`
    + `<div class="form-row"><label for="aak-until">${esc(t('am.ack_until'))}</label>`
    + `<input class="input" id="aak-until" type="text" autocomplete="off">`
    + `<div class="ape-err" id="aak-err-until" role="alert" hidden></div>`
    + `<label class="chk-inline"><input type="checkbox" id="aak-noend"><span>${esc(t('am.ack_noend'))}</span></label></div>`
    + `<div class="ape-hint">${esc(t('am.ack_note'))}</div>`;
}

function _footHtml(): string {
  return `<button type="button" class="btn btn-ghost" data-aak-act="cancel">${esc(t('btn.cancel'))}</button>`
    + `<button type="button" class="btn btn-primary" id="aak-save" data-aak-act="save">${esc(t('btn.save'))}</button>`;
}

function _showError(field: 'reason' | 'until', key: string | null): void {
  const err = _el(`aak-err-${field}`);
  if (!err) return;
  err.textContent = key ? t(key) : '';
  err.hidden = !key;
}

function _initPicker(day: string, plant: string): void {
  const input = _el<HTMLInputElement>('aak-until');
  if (!input) return;
  input.value = day;
  _destroyPicker();
  try {
    if (typeof flatpickr !== 'undefined') {
      _fp = flatpickr(input, {
        dateFormat: 'Y-m-d', altInput: true, altFormat: Util._dateFormatPref(), altInputClass: 'input',
        defaultDate: day, minDate: Util.dayKey(Util.plantToday(plant)),   // the plant's today, not the browser's
      }) as unknown as PickerLike;
      _fp.altInput?.setAttribute?.('aria-label', t('am.ack_until'));
    }
  } catch { _fp = null; }   // plain text input: validateAck still insists on YYYY-MM-DD
}

function _syncNoEnd(): void {
  const off = !!_el<HTMLInputElement>('aak-noend')?.checked;
  const input = _el<HTMLInputElement>('aak-until');
  if (input) input.disabled = off;
  if (_fp?.altInput) _fp.altInput.disabled = off;
  if (off) _showError('until', null);
}

function _wire(): void {
  const shell = _el('modal-alert-ack') as (HTMLElement & { _aakWired?: boolean }) | null;
  if (!shell || shell._aakWired) return;
  shell._aakWired = true;
  _el('aak-body')?.addEventListener('change', e => {
    if ((e.target as HTMLElement | null)?.id === 'aak-noend') _syncNoEnd();
  });
  _el('aak-foot')?.addEventListener('click', e => {
    const act = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-aak-act]')?.dataset.aakAct;
    if (act === 'cancel') AlertAckModal.close();
    else if (act === 'save') void AlertAckModal.submit();
  });
  _el('aak-close')?.addEventListener('click', () => AlertAckModal.close());
  shell.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !e.defaultPrevented) AlertAckModal.close();
  });
}

export const AlertAckModal = {
  open(opts: { plant: string; alertId: string }): void {
    if (!opts.plant || !opts.alertId) return;
    _s = { plant: opts.plant, alertId: opts.alertId, busy: false };
    _wire();
    const title = _el('aak-title');
    if (title) title.textContent = t('am.ack_title');
    const body = _el('aak-body');
    if (body) body.innerHTML = _bodyHtml();
    const foot = _el('aak-foot');
    if (foot) foot.innerHTML = _footHtml();
    _initPicker(defaultUntilDay(opts.plant), opts.plant);
    Modal.open('modal-alert-ack');
    _el('aak-reason')?.focus();
  },

  async submit(): Promise<void> {
    const s = _s;
    if (!s || s.busy) return;
    const v = validateAck(
      _el<HTMLTextAreaElement>('aak-reason')?.value ?? '',
      _el<HTMLInputElement>('aak-until')?.value ?? '',
      !!_el<HTMLInputElement>('aak-noend')?.checked,
    );
    _showError('reason', v.ok ? null : (v.field === 'reason' ? v.key : null));
    _showError('until', v.ok ? null : (v.field === 'until' ? v.key : null));
    if (!v.ok) return;
    s.busy = true;
    const save = _el<HTMLButtonElement>('aak-save');
    if (save) save.disabled = true;
    try {
      await AlertAcksClient.acknowledge({ plant: s.plant, alert_id: s.alertId, reason: v.reason, until: v.until });
      if (_s === s) AlertAckModal.close();
    } catch (err) {
      Toast.show((err as Error)?.message || String(err), 'error');
      s.busy = false;
      if (save) save.disabled = false;
    }
  },

  close(): void {
    if (!_s) return;
    _s = null;
    _destroyPicker();
    Modal.close('modal-alert-ack');
  },

  /** True while the modal is open for this plant (a plant switch closes it). */
  isOpenFor(plant: string | null): boolean { return !!_s && _s.plant === plant; },
};

// A plant change leaves the acknowledgement being composed meaningless.
Store.subscribe(evt => {
  if (evt.type === 'plant:selected' && _s && _s.plant !== (evt.plant as string | null)) AlertAckModal.close();
}, 'alert-ack-modal');
