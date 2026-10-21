// dom-stub.mjs - a tiny mini-DOM for node tests (the repo has no jsdom/linkedom).
// Elements keep parent/child links, a working classList, attributes/dataset, simple selector
// matching (tag, #id, .class, [attr], [attr="v"], compounds, commas, descendant spaces), bubbling
// `dispatch`, and focus() that sets document.activeElement. Not a spec DOM: just what the
// frontend tests need. `makeEl(id)` keeps its original shape (id, writes, handlers, ...) so the
// older pane tests can import it unchanged.

let activeDoc = null;

function parseCompound(s) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else out.attrs.push([m[4], m[5] ?? m[6] ?? m[7] ?? null]);
  }
  return out;
}

function matchCompound(el, c) {
  if (c.tag && String(el.tagName).toLowerCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const [name, val] of c.attrs) {
    const v = el.getAttribute(name);
    if (v === null) return false;
    if (val !== null && v !== val) return false;
  }
  return true;
}

function matches(el, selector) {
  return selector.split(',').some(part => {
    const toks = part.trim().split(/\s+/).map(parseCompound);
    if (!matchCompound(el, toks[toks.length - 1])) return false;
    let node = el.parentNode, i = toks.length - 2;
    while (i >= 0 && node) { if (node.nodeType === 1 && matchCompound(node, toks[i])) i--; node = node.parentNode; }
    return i < 0;
  });
}

function descendants(el, out = []) {
  for (const ch of el.children) { out.push(ch); descendants(ch, out); }
  return out;
}

const dsKey = k => k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase());

export function makeEl(id, doc = activeDoc, tagName = 'div') {
  const handlers = {};      // last handler per type (legacy shape the pane tests read)
  const listeners = {};     // every handler per type
  const classes = new Set();
  const attrs = {};
  const el = {
    nodeType: 1, tagName: tagName.toUpperCase(), id: id || '', _doc: doc, _html: '', writes: 0, handlers, listeners,
    textContent: '', hidden: false, value: '', checked: false, title: '', disabled: false, dataset: {},
    parentNode: null, children: [], style: {}, clientHeight: 600, scrollTop: 0, rect: null, _root: false,
    get className() { return [...classes].join(' '); },
    set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; this.writes++; },
    get isConnected() { let n = this; while (n) { if (n._root) return true; n = n.parentNode; } return false; },
    get firstElementChild() { return this.children[0] || null; },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, force) => { const on = force ?? !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; },
      contains: c => classes.has(c),
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
      if (k === 'id') this.id = String(v);
      else if (k === 'class') this.className = v;
      else if (k.startsWith('data-')) this.dataset[dsKey(k)] = String(v);
    },
    getAttribute(k) {
      if (k === 'id') return this.id || (k in attrs ? attrs[k] : null);
      if (k === 'class') return classes.size ? this.className : null;
      return k in attrs ? attrs[k] : null;
    },
    hasAttribute(k) { return this.getAttribute(k) !== null; },
    removeAttribute(k) {
      delete attrs[k];
      if (k.startsWith('data-')) delete this.dataset[dsKey(k)];
    },
    addEventListener(type, fn) { handlers[type] = fn; (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      const l = listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
      if (handlers[type] === fn) delete handlers[type];
    },
    /** Fire `type` at this element, bubbling through ancestors then the document listeners. */
    dispatch(type, evt = {}) {
      const e = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stopped = true; }, ...evt };
      for (let n = this; n && !e._stopped; n = n.parentNode) { e.currentTarget = n; (n.listeners[type] || []).slice().forEach(f => f(e)); }
      if (!e._stopped && this._doc) this._doc.fire(type, e);
      return e;
    },
    appendChild(ch) {
      if (ch.parentNode) ch.parentNode.removeChild(ch);
      ch.parentNode = this; this.children.push(ch); if (!ch._doc) ch._doc = this._doc; return ch;
    },
    append(...chs) { chs.forEach(c => this.appendChild(c)); },
    removeChild(ch) { const i = this.children.indexOf(ch); if (i >= 0) { this.children.splice(i, 1); ch.parentNode = null; } return ch; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; },
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; },
    matches(sel) { return matches(this, sel); },
    querySelectorAll(sel) { return descendants(this).filter(n => matches(n, sel)); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    focus() { if (this._doc) this._doc.activeElement = this; },
    blur() { if (this._doc && this._doc.activeElement === this) this._doc.activeElement = null; },
    scrollIntoView() {},
    getBoundingClientRect() {
      const r = this.rect || { top: 0, left: 0, width: 0, height: 0 };
      return { top: r.top, left: r.left, width: r.width, height: r.height, right: r.left + r.width, bottom: r.top + r.height };
    },
  };
  return el;
}

/** A document with a connected `body`, a listener registry and `dispatch`. */
export function makeDocument() {
  const listeners = {};
  const doc = {
    activeElement: null, listeners,
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(type, fn) { const l = listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
    fire(type, e) { (listeners[type] || []).slice().forEach(f => f(e)); },
    dispatch(type, evt = {}) { const e = { type, target: doc.body, preventDefault() {}, stopPropagation() {}, ...evt }; doc.fire(type, e); return e; },
    createElement(tag) { return makeEl('', doc, tag); },
    getElementById(id) { return doc.body.querySelector('#' + id); },
    querySelector(sel) { return doc.body.querySelector(sel); },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
  };
  doc.body = makeEl('', doc, 'body');
  doc.body._root = true;
  return doc;
}

/** Installs a fresh document + window stub on globalThis; returns { doc, win, restore }. */
export function installDom({ width = 1024, height = 768 } = {}) {
  const prior = { document: globalThis.document, window: globalThis.window, activeDoc };
  const doc = makeDocument();
  const wl = {};
  const win = {
    innerWidth: width, innerHeight: height, listeners: wl,
    addEventListener(type, fn) { (wl[type] ??= []).push(fn); },
    removeEventListener(type, fn) { const l = wl[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } },
    dispatch(type, evt = {}) { (wl[type] || []).slice().forEach(f => f({ type, target: win, ...evt })); },
  };
  activeDoc = doc;
  globalThis.document = doc;
  globalThis.window = win;
  return {
    doc, win,
    restore() { globalThis.document = prior.document; globalThis.window = prior.window; activeDoc = prior.activeDoc; },
  };
}
