// overflow-menu.mts - the shared overflow (⋯) menu primitive. One menu open at a time, appended to
// document.body and positioned with `position: fixed` against the trigger. Pure positioning and
// keyboard logic are exported separately (menuPosition / menuKeyNav) so they test without a DOM.
// Emits no Store events and imports nothing from Store: it is pure UI chrome.

export interface MenuItem {
  id: string;
  label: string;
  /** Called with the item for plain items, or with the new checked state for checkbox items. */
  onSelect: (arg: MenuItem | boolean) => void;
  disabled?: boolean;
  /** Present (true/false) = a checkbox item (role=menuitemcheckbox with a check column). */
  checked?: boolean | undefined;
  danger?: boolean;
  /** Muted second line inside the item (e.g. why it is disabled). */
  hint?: string;
  /** Rendered as data-* attributes (camelCase keys become kebab-case) so delegated page handlers can reuse them. */
  data?: Record<string, string>;
}

export interface MenuOpts {
  align?: 'end';
  /** Stable identity of the trigger across page repaints; mirrored as data-ovf-key on the trigger. */
  key?: string;
}

export interface AnchorRect { top: number; left: number; right: number; bottom: number }
export type MenuKeyResult = number | 'close' | 'select';

const MARGIN = 8;   // viewport inset
const GAP = 4;      // anchor-to-menu gap
const MIN_WIDTH = 180;

/** Where to put a `position: fixed` menu: below the anchor, flipped above when it would overflow the
 *  viewport bottom (and there is room above), clamped horizontally; `align: 'end'` right-aligns it. */
export function menuPosition(
  anchorRect: AnchorRect,
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
  align?: 'end',
): { top: number; left: number; flipped: boolean } {
  const below = anchorRect.bottom + GAP;
  const above = anchorRect.top - GAP - menuSize.height;
  const overflowsBelow = below + menuSize.height > viewport.height - MARGIN;
  const flipped = overflowsBelow && above >= MARGIN;
  let top = flipped ? above : below;
  top = Math.max(MARGIN, Math.min(top, viewport.height - MARGIN - menuSize.height));
  let left = align === 'end' ? anchorRect.right - menuSize.width : anchorRect.left;
  left = Math.max(MARGIN, Math.min(left, viewport.width - MARGIN - menuSize.width));
  // A viewport narrower than the menu still gets a sane origin.
  if (left < 0) left = 0;
  if (top < 0) top = 0;
  return { top, left, flipped };
}

/** Keyboard navigation over an enabled-mask. Returns the next active index, 'close' (Escape/Tab) or 'select'
 *  (Enter/Space). Arrows wrap and skip disabled items; Home/End jump to the first/last enabled item. */
export function menuKeyNav(activeIndex: number, key: string, enabledMask: boolean[]): MenuKeyResult {
  const n = enabledMask.length;
  const step = (from: number, dir: 1 | -1): number => {
    for (let i = 1; i <= n; i++) {
      const idx = (((from + dir * i) % n) + n) % n;
      if (enabledMask[idx]) return idx;
    }
    return activeIndex;
  };
  switch (key) {
    case 'Escape':
    case 'Tab': return 'close';
    case 'Enter':
    case ' ':
    case 'Spacebar': return 'select';
    case 'ArrowDown': return n ? step(activeIndex, 1) : activeIndex;
    case 'ArrowUp': return n ? step(activeIndex < 0 ? 0 : activeIndex, -1) : activeIndex;
    case 'Home': { const i = enabledMask.indexOf(true); return i < 0 ? activeIndex : i; }
    case 'End': { const i = enabledMask.lastIndexOf(true); return i < 0 ? activeIndex : i; }
    default: return activeIndex;
  }
}

interface OpenState {
  anchor: HTMLElement;
  menu: HTMLElement;
  key: string | undefined;
  prevKeyAttr: string | null;
  items: MenuItem[];
  els: HTMLElement[];
  active: number;
  cleanup: () => void;
}

let _open: OpenState | null = null;

const kebab = (k: string): string => k.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

function teardown(st: OpenState): void {
  st.cleanup();
  st.menu.remove();
  st.anchor.setAttribute('aria-expanded', 'false');
  if (st.key !== undefined) {
    if (st.prevKeyAttr === null) st.anchor.removeAttribute('data-ovf-key');
    else st.anchor.setAttribute('data-ovf-key', st.prevKeyAttr);
  }
}

function closeState(st: OpenState, refocus: boolean): void {
  if (_open !== st) return;
  _open = null;
  teardown(st);
  if (refocus && st.anchor.isConnected) st.anchor.focus();
}

function setActive(st: OpenState, idx: number): void {
  if (idx < 0 || idx >= st.els.length) return;
  st.active = idx;
  st.els[idx]!.focus();
}

function activate(st: OpenState, idx: number): void {
  const item = st.items[idx];
  if (!item || item.disabled) return;
  if (item.checked !== undefined) {
    item.checked = !item.checked;
    const el = st.els[idx]!;
    el.setAttribute('aria-checked', String(item.checked));
    const mark = el.querySelector('.ovf-item-check');
    if (mark) mark.textContent = item.checked ? '✓' : '';
    item.onSelect(item.checked);
    return;
  }
  closeState(st, true);
  item.onSelect(item);
}

function build(st: OpenState, items: MenuItem[]): void {
  items.forEach((item, idx) => {
    const isCheck = item.checked !== undefined;
    const el = document.createElement('button');
    el.setAttribute('type', 'button');
    el.className = 'ovf-item' + (item.danger ? ' ovf-item-danger' : '');
    el.setAttribute('role', isCheck ? 'menuitemcheckbox' : 'menuitem');
    el.setAttribute('tabindex', '-1');
    if (isCheck) el.setAttribute('aria-checked', String(!!item.checked));
    if (item.disabled) el.setAttribute('aria-disabled', 'true');
    for (const [k, v] of Object.entries(item.data ?? {})) el.setAttribute('data-' + kebab(k), v);
    if (isCheck) {
      const mark = document.createElement('span');
      mark.className = 'ovf-item-check';
      mark.setAttribute('aria-hidden', 'true');
      mark.textContent = item.checked ? '✓' : '';
      el.appendChild(mark);
    }
    const body = document.createElement('span');
    body.className = 'ovf-item-body';
    const label = document.createElement('span');
    label.className = 'ovf-label';
    label.textContent = item.label;
    body.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'ovf-hint';
      hint.textContent = item.hint;
      body.appendChild(hint);
    }
    el.appendChild(body);
    el.addEventListener('click', () => activate(st, idx));
    el.addEventListener('mouseover', () => { if (!item.disabled) setActive(st, idx); });
    st.menu.appendChild(el);
    st.els.push(el);
  });
}

function open(anchor: HTMLElement, items: MenuItem[], opts: MenuOpts = {}): { close(): void } {
  if (_open && _open.anchor === anchor) { closeState(_open, false); return { close() {} }; }   // toggle
  if (_open) closeState(_open, false);

  const menu = document.createElement('div');
  menu.className = 'ovf-menu';
  menu.setAttribute('role', 'menu');
  menu.style.position = 'fixed';
  menu.style.visibility = 'hidden';
  const st: OpenState = {
    anchor, menu, key: opts.key, prevKeyAttr: anchor.getAttribute('data-ovf-key'),
    items: items.map(i => ({ ...i })), els: [], active: -1, cleanup: () => {},
  };
  build(st, st.items);
  document.body.appendChild(menu);

  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');
  if (opts.key !== undefined) anchor.setAttribute('data-ovf-key', opts.key);

  const mr = menu.getBoundingClientRect();
  const ar = anchor.getBoundingClientRect();
  const pos = menuPosition(ar, { width: mr.width || MIN_WIDTH, height: mr.height || 0 },
    { width: window.innerWidth, height: window.innerHeight }, opts.align);
  menu.style.top = pos.top + 'px';
  menu.style.left = pos.left + 'px';
  menu.style.visibility = '';

  const mask = () => st.items.map(i => !i.disabled);
  const onKey = (e: KeyboardEvent): void => {
    const r = menuKeyNav(st.active, e.key, mask());
    if (r === 'close') { e.preventDefault(); closeState(st, true); }
    else if (r === 'select') { e.preventDefault(); activate(st, st.active); }
    else if (r !== st.active || e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') e.preventDefault();
      setActive(st, r);
    }
  };
  const onOutside = (e: Event): void => {
    const t = e.target as Node | null;
    if (t && (menu.contains(t) || anchor.contains(t))) return;
    closeState(st, false);
  };
  const onScroll = (e: Event): void => {
    const t = e.target as Node | null;
    if (t && t.nodeType === 1 && menu.contains(t)) return;
    closeState(st, false);
  };
  const onResize = (): void => closeState(st, false);
  menu.addEventListener('keydown', onKey as EventListener);
  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  st.cleanup = () => {
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
  };

  _open = st;
  const first = mask().indexOf(true);
  if (first >= 0) setActive(st, first);
  return { close() { closeState(st, true); } };
}

function closeAll(): void {
  if (_open) closeState(_open, false);
}

function isOpen(): boolean {
  return _open !== null;
}

/** Call at the end of a page paint that replaces innerHTML: closes the menu if its trigger left the
 *  DOM and, when a trigger with the same data-ovf-key exists in the new DOM, hands focus to it. */
function reconcile(): void {
  const st = _open;
  if (!st || st.anchor.isConnected) return;
  const key = st.key;
  const hadFocus = !document.activeElement || document.activeElement === document.body
    || st.menu.contains(document.activeElement) || st.anchor.contains(document.activeElement);
  _open = null;
  teardown(st);
  if (key === undefined || !hadFocus) return;
  const next = Array.from(document.querySelectorAll<HTMLElement>('[data-ovf-key]'))
    .find(el => el.getAttribute('data-ovf-key') === key);
  if (next) next.focus();
}

export const OverflowMenu = { open, closeAll, isOpen, reconcile };
