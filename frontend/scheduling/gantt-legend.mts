// scheduling/gantt-legend.mjs — GanttLegend: the "Reading the scheduling
// board" popup (#modal-gantt-legend in index.html). The modal's static markup
// is a miniature board drawn with the board's own CSS tokens (styles.css,
// "GANTT BOARD LEGEND"); this module only wires its interaction:
//
//   - numbered pins on the scene (button.lg-pin[data-key]) and key rows
//     (li.lg-k[data-key]) light up every scene element sharing the key
//     (.lg-el[data-key]) and fade the rest; hover previews, click/Enter
//     makes the pin sticky until Escape, another pin or a click elsewhere;
//   - a callout beside the active pin repeats the key row's text on wide
//     screens (CSS hides it below 960px, where the key row itself is enough);
//   - Escape clears a sticky pin first, then closes the dialog (Modal.open
//     gives us the focus trap and the aria-* dialog semantics; Escape itself
//     only closes the confirm dialog centrally, so it is handled here).
//
// Owns nothing else: open() is what the toolbar button calls, close() is what
// the ✕ and Close buttons call, init() is run once from app boot.
import { Util, Modal } from '../platform/foundation.mjs';

const MODAL_ID = 'modal-gantt-legend';
const WIDE_MQ = '(min-width: 960px)';

export const GanttLegend = {
  _wired: false,
  _hover: null as string | null,
  _sticky: null as string | null,

  init(): void {
    if (GanttLegend._wired) return;
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    GanttLegend._wired = true;

    const closeBtn = document.getElementById('btn-gantt-legend-close');
    if (closeBtn) {
      closeBtn.setAttribute('aria-label', Util.t('btn.close'));
      closeBtn.addEventListener('click', () => GanttLegend.close());
    }
    document.getElementById('btn-gantt-legend-done')?.addEventListener('click', () => GanttLegend.close());

    modal.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      if (GanttLegend._sticky) GanttLegend._setSticky(null);
      else GanttLegend.close();
    });

    const scene = modal.querySelector<HTMLElement>('.lg-scene');
    if (!scene) return;

    scene.querySelectorAll<HTMLButtonElement>('.lg-pin[data-key]').forEach(pin => {
      const key = pin.dataset.key as string;
      pin.addEventListener('mouseenter', () => GanttLegend._preview(key));
      pin.addEventListener('mouseleave', () => GanttLegend._preview(null));
      pin.addEventListener('focus', () => GanttLegend._preview(key));
      pin.addEventListener('blur', () => GanttLegend._preview(null));
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        GanttLegend._setSticky(GanttLegend._sticky === key ? null : key);
      });
    });
    scene.querySelectorAll<HTMLElement>('.lg-el[data-key]').forEach(el => {
      const key = el.dataset.key as string;
      el.addEventListener('mouseenter', () => GanttLegend._preview(key));
      el.addEventListener('mouseleave', () => GanttLegend._preview(null));
    });
    // A click on the scene that is not a pin releases a sticky pin.
    scene.addEventListener('click', () => { if (GanttLegend._sticky) GanttLegend._setSticky(null); });

    modal.querySelectorAll<HTMLElement>('.lg-k[data-key]').forEach(row => {
      const key = row.dataset.key as string;
      row.addEventListener('mouseenter', () => GanttLegend._preview(key));
      row.addEventListener('mouseleave', () => GanttLegend._preview(null));
    });
  },

  open(): void {
    Modal.open(MODAL_ID);
  },

  close(): void {
    GanttLegend._hover = null;
    GanttLegend._sticky = null;
    GanttLegend._render();
    Modal.close(MODAL_ID);
  },

  _preview(key: string | null): void {
    GanttLegend._hover = key;
    GanttLegend._render();
  },

  _setSticky(key: string | null): void {
    GanttLegend._sticky = key;
    GanttLegend._render();
    if (!key) return;
    const row = document.querySelector<HTMLElement>(`#${MODAL_ID} .lg-k[data-key="${key}"]`);
    // On narrow screens there is no callout: bring the key row into view instead.
    if (row && !window.matchMedia(WIDE_MQ).matches) {
      try { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { row.scrollIntoView(); }
    }
  },

  _render(): void {
    const modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    const active = GanttLegend._sticky ?? GanttLegend._hover;
    const scene = modal.querySelector<HTMLElement>('.lg-scene');
    scene?.classList.toggle('lg-focus', !!active);
    modal.querySelectorAll<HTMLElement>('[data-key]').forEach(el => {
      el.classList.toggle('is-on', !!active && el.dataset.key === active);
      if (el.classList.contains('lg-pin')) el.classList.toggle('is-sticky', !!GanttLegend._sticky && el.dataset.key === GanttLegend._sticky);
    });
    GanttLegend._renderCallout(active);
  },

  _renderCallout(key: string | null): void {
    const callout = document.getElementById('lg-callout');
    const scene = document.querySelector<HTMLElement>(`#${MODAL_ID} .lg-scene`);
    if (!callout || !scene) return;
    const pin = key ? scene.querySelector<HTMLElement>(`.lg-pin[data-key="${key}"]`) : null;
    const row = key ? document.querySelector<HTMLElement>(`#${MODAL_ID} .lg-k[data-key="${key}"]`) : null;
    if (!pin || !row) { callout.hidden = true; return; }
    const num = callout.querySelector<HTMLElement>('.lg-callout-num');
    const title = callout.querySelector<HTMLElement>('.lg-callout-t');
    const desc = callout.querySelector<HTMLElement>('.lg-callout-d');
    if (num) num.textContent = pin.textContent?.trim() || '';
    if (title) title.textContent = row.querySelector('.lg-k-t')?.textContent || '';
    if (desc) desc.textContent = row.querySelector('.lg-k-d')?.textContent || '';
    callout.hidden = false;

    // Below the pin (it may hang over the key list, which is what the sticky
    // scene's z-index is for), flipped above only when it would run past the
    // modal; clamped horizontally to the scene box. Measured after unhiding
    // so the width is real.
    const sceneRect = scene.getBoundingClientRect();
    const pinRect = pin.getBoundingClientRect();
    const modalRect = (document.getElementById(MODAL_ID)?.querySelector('.modal') ?? scene).getBoundingClientRect();
    const w = callout.offsetWidth, h = callout.offsetHeight;
    const GAP = 8;
    let left = pinRect.left + pinRect.width / 2 - sceneRect.left - w / 2;
    left = Math.max(0, Math.min(left, sceneRect.width - w));
    let top = pinRect.bottom - sceneRect.top + GAP;
    if (pinRect.bottom + GAP + h > modalRect.bottom - 8) top = pinRect.top - sceneRect.top - GAP - h;
    callout.style.left = `${Math.round(left)}px`;
    callout.style.top = `${Math.round(top)}px`;
  },
};
