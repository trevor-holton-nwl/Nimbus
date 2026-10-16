// Layout-only affordances; no Store access, persistence, or application actions.
export function positionHelpTooltip(el: HTMLElement, viewport: Pick<Window, 'innerWidth' | 'innerHeight'>): void {
  const tip = el.querySelector<HTMLElement>('.adm-help-tip');
  if (!tip) return;
  const anchor = el.getBoundingClientRect();
  const size = tip.getBoundingClientRect();
  const gap = 8;
  const left = Math.max(gap, Math.min(anchor.left + anchor.width / 2 - size.width / 2,
    viewport.innerWidth - size.width - gap));
  const above = anchor.top - size.height - gap;
  const below = above < gap;
  const top = Math.max(gap, Math.min(below ? anchor.bottom + gap : above,
    viewport.innerHeight - size.height - gap));
  tip.style.setProperty('--tip-left', `${left}px`);
  tip.style.setProperty('--tip-top', `${top}px`);
  tip.dataset.side = below ? 'below' : 'above';
}

export function installLayoutAffordances(doc: Document = document, win: Window = window): void {
  const showHelp = (event: Event) => {
    const el = (event.target as Element | null)?.closest?.<HTMLElement>('.adm-help');
    if (el) positionHelpTooltip(el, win);
  };
  const repositionHelp = () => {
    doc.querySelectorAll<HTMLElement>('.adm-help:hover, .adm-help:focus-within')
      .forEach(el => positionHelpTooltip(el, win));
  };
  doc.addEventListener('mouseover', showHelp);
  doc.addEventListener('focusin', showHelp);
  doc.addEventListener('scroll', repositionHelp, true);
  win.addEventListener('resize', repositionHelp);
}
