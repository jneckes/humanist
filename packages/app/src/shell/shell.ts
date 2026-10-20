// The shell UI (6.0 The window): toolbar, trust bar, the "tried to leave" bar, the Find bar, the left rail
// (thumbnails, the outline, Find results), the notes panel and the status bar. No framework. It shows text from
// documents (file names, slide titles, Find snippets, note text), so every string goes in with textContent,
// never as HTML (9.1 Shell view); the only style writes are numeric layout values through CSSOM setProperty.
// It talks to main only through window.blueline (the shell preload's contextBridge API).
//
// The deck view covers the content area (main places it over #deck-slot): the shell draws the letterbox around
// it, and, when the deck view is larger than the window (100%, Fill width), the scroll bars beside it (#deck-slot
// scrolls a spacer the deck view's size; main moves the deck view to follow). In Present it shows no chrome.

import type { AppMode, ShellApi, ShellHistory, ShellLayout, ShellMenu, ShellNote, ShellState, ShellToast } from '@blueline/core/ipc';
import type { FindHit, FindResponse, ShellIndexReady, ShellThumb } from '@blueline/core/ipc-render';
import { zoomLabel, type ShellCommand } from '@blueline/core/ipc-views';

declare global {
  interface Window {
    blueline: ShellApi;
  }
}

const api: ShellApi = window.blueline;

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const MODES: readonly AppMode[] = ['read', 'review', 'edit'];
/** The rail's thumbnail width in CSS px (main renders them at this width, at 2x: views.ts railThumbWidth). */
const THUMB_WIDTH = 152;
const THUMB_SRC = /^app:\/\/shell\/thumbs\/[0-9a-f]{16}\/[0-9a-f]{64}-\d{1,5}-\d{2,4}\.png$/;

let last: ShellState | null = null;

// ------------------------------------------------------------------------------------------- layout

function px(n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
  return `${Math.max(0, Math.min(1_000_000, v))}px`;
}

function applyLayout(l: ShellLayout): void {
  const s = document.documentElement.style;
  s.setProperty('--toolbar', px(l.toolbar));
  s.setProperty('--trust', px(l.trustBar));
  s.setProperty('--banner', px(l.banner));
  s.setProperty('--find', px(l.findBar));
  s.setProperty('--status', px(l.statusBar));
  s.setProperty('--rail', px(l.leftRail));
  s.setProperty('--panel', px(l.rightPanel));
  el('rail').classList.toggle('collapsed', !(l.leftRail > 0));
  el('panel').classList.toggle('collapsed', !(l.rightPanel > 0));
}

// ------------------------------------------------------------------------------------------- render

function trustSentence(s: ShellState): string {
  const net = s.networkAllowed;
  const edit = s.editingAllowed;
  const state =
    !net && !edit ? 'network and editing off' : net && edit ? 'network and editing on' : net ? 'network on, editing off' : 'network off, editing on';
  const reason = s.trustReason ? s.trustReason.charAt(0).toLowerCase() + s.trustReason.slice(1) : null;
  return ['Protected view', reason, state].filter((x): x is string => !!x).join(' · ');
}

function renderToolbar(s: ShellState): void {
  const name = el<HTMLButtonElement>('file-name');
  name.textContent = s.docName;
  name.title = s.docPath;
  for (const b of el('mode-switch').querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    const mode = b.dataset.mode as AppMode;
    b.setAttribute('aria-pressed', String(mode === s.appMode));
    if (mode === 'edit') {
      // 6.3, 6.10: off, with the reason, when the Edit capability is off or editing is not allowed (main decides).
      const a = s.edit;
      const available = a ? a.available : s.capabilities.edit && s.readOnlyReason === null && s.editingAllowed;
      b.disabled = !available && s.appMode !== 'edit';
      b.title = available ? 'Edit (Ctrl/Cmd+3)' : (a?.reason ?? 'Edit is not available');
    }
  }
  el<HTMLButtonElement>('present').title = 'Present (Ctrl/Cmd+Option+P). Esc ends it.';
  // The agent chip shows in Review and Edit when the agent capability is on (6.0, 6.6): Phase 4.
  el('agent-chip').hidden = true;
  renderNameChip(s);
}

// ------------------------------------------------------------------------------------------- the name chip (6.8)

let naming = false;

function renderNameChip(s: ShellState): void {
  const chip = el<HTMLButtonElement>('name-chip');
  const name = typeof s.userName === 'string' ? s.userName : '';
  chip.textContent = name;
  chip.hidden = naming || name.length === 0;
}

function startNaming(): void {
  if (naming) return;
  naming = true;
  const input = el<HTMLInputElement>('name-input');
  input.value = last?.userName ?? '';
  input.hidden = false;
  el('name-chip').hidden = true;
  input.focus();
  input.select();
}

function endNaming(): void {
  naming = false;
  el<HTMLInputElement>('name-input').hidden = true;
  if (last) renderNameChip(last);
}

async function saveName(): Promise<void> {
  const input = el<HTMLInputElement>('name-input');
  const value = input.value;
  endNaming();
  if (value.trim() === (last?.userName ?? '')) return;
  try {
    const r = await api.setName(value);
    if (!r.ok) showToast({ text: r.reason ?? 'The name was not changed.', kind: 'warn' });
  } catch {
    showToast({ text: 'The name was not changed.', kind: 'warn' });
  }
}

function renderTrustBar(s: ShellState): void {
  const bar = el('trust-bar');
  bar.hidden = !(s.trust === 'protected' && s.trustBarVisible);
  el('trust-text').textContent = trustSentence(s);
  el('allow-network').hidden = s.networkAllowed;
  el('enable-editing').hidden = s.editingAllowed || !s.capabilities.edit || s.readOnlyReason !== null;
}

function renderBanner(s: ShellState): void {
  el('banner').hidden = s.banner === null;
  el('banner-text').textContent = s.banner ?? '';
}

// ------------------------------------------------------------------------------------------- the rail

/** Thumbnails of the version the rail shows: slide → src. */
let thumbVersion: string | null = null;
const thumbs = new Map<number, string>();
/** The design size the rail's placeholders keep (from the slide index). */
let thumbDesign: { w: number; h: number } = { w: 1600, h: 900 };
let railKey = '';

function thumbHeight(): number {
  return Math.max(8, Math.round((THUMB_WIDTH * thumbDesign.h) / thumbDesign.w));
}

function deckTitles(s: ShellState): string[] {
  // The slide index's titles once it is ready for this version (9.4 titles, else the first line of text);
  // what the visible view detected until then.
  if (s.index?.ready && s.index.titles.length > 0 && (s.index.kind === 'reveal' || s.index.kind === 'generic')) return s.index.titles;
  return s.slide?.titles ?? [];
}

function setThumb(li: HTMLElement, slide: number): void {
  const box = li.querySelector<HTMLElement>('.thumb');
  if (!box) return;
  const src = thumbs.get(slide);
  box.style.setProperty('height', px(thumbHeight()));
  const img = box.querySelector('img');
  if (src && THUMB_SRC.test(src)) {
    if (img && img.getAttribute('src') === src) return;
    const next = make('img');
    next.alt = '';
    next.decoding = 'async';
    next.draggable = false;
    next.src = src;
    box.replaceChildren(next);
    box.classList.add('ready');
  } else if (img) {
    box.replaceChildren();
    box.classList.remove('ready');
  }
}

function renderSlides(s: ShellState): void {
  const list = el('slide-list');
  const titles = deckTitles(s);
  const current = s.slide?.current ?? -1;
  const key = `${thumbVersion}:${titles.length}:${titles.join('\u0000')}:${thumbHeight()}`;
  if (key !== railKey) {
    railKey = key;
    const items: HTMLElement[] = [];
    if (titles.length === 0) items.push(make('li', 'empty-note', s.slide ? 'One page' : 'Looking for slides…'));
    titles.forEach((title, i) => {
      const li = make('li', 'slide');
      li.dataset.slide = String(i);
      const b = make('button', 'slide-button');
      b.type = 'button';
      const label = title || `Slide ${i + 1}`;
      b.title = label;
      b.setAttribute('aria-label', `Slide ${i + 1}: ${label}`);
      const thumb = make('span', 'thumb');
      thumb.setAttribute('aria-hidden', 'true');
      b.append(make('span', 'num', String(i + 1)), thumb);
      b.addEventListener('click', () => void api.show(i));
      li.append(b, make('span', 'slide-title', label));
      items.push(li);
      setThumb(li, i);
    });
    list.replaceChildren(...items);
  }
  for (const li of list.querySelectorAll<HTMLElement>('li.slide')) {
    const on = Number(li.dataset.slide) === current;
    if (on) {
      if (li.getAttribute('aria-current') !== 'true') {
        li.setAttribute('aria-current', 'true');
        li.scrollIntoView({ block: 'nearest' });
      }
    } else li.removeAttribute('aria-current');
  }
}

function renderOutline(s: ShellState): void {
  const list = el('outline-list');
  const idx = s.index;
  const items: HTMLElement[] = [];
  if (!idx || !idx.ready) items.push(make('li', 'empty-note', 'Building the outline…'));
  else if (idx.outline.length === 0) items.push(make('li', 'empty-note', 'No headings'));
  else {
    for (const o of idx.outline) {
      const li = make('li', `level-${o.level}`);
      const b = make('button', 'outline-button', o.title || '(untitled)');
      b.type = 'button';
      b.title = o.title;
      b.addEventListener('click', () => void api.show(o.entry));
      li.append(b);
      items.push(li);
    }
  }
  list.replaceChildren(...items);
}

function renderRail(s: ShellState): void {
  const doc = s.view.kind === 'document';
  const finding = find.open;
  const history = !finding && s.history ? s.history : null;
  el('rail-title').textContent = finding ? 'Results' : history ? 'History' : doc ? 'Outline' : 'Slides';
  el('rail').setAttribute('aria-label', finding ? 'Find results' : history ? 'History' : doc ? 'Outline' : 'Slides');
  const hide = el('rail-hide');
  hide.title = history ? 'Close the history' : doc ? 'Hide the outline' : 'Hide the slides';
  hide.setAttribute('aria-label', history ? 'Close the history' : 'Hide the rail');
  hide.textContent = history ? '\u00d7' : '\u00ab';
  hide.hidden = finding;
  el('slide-list').hidden = finding || !!history || doc;
  el('outline-list').hidden = finding || !!history || !doc;
  el('result-list').hidden = !finding;
  el('history-list').hidden = !history;
  if (history) renderHistory(history);
  else if (!finding && !doc) renderSlides(s);
  else if (!finding && doc) renderOutline(s);
}

// ------------------------------------------------------------------------------------------- history (P2-11)

const CAUSES: Readonly<Record<string, string>> = {
  edit: 'before a direct edit',
  undo: 'before an undo',
  redo: 'before a redo',
  restore: 'before a restore',
  external: 'before a change outside Blueline',
};

/** The time an entry shows: hours and minutes, with the date when it is not today. */
function entryTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
}

function renderHistory(h: ShellHistory): void {
  const list = el('history-list');
  if (h.entries.length === 0) {
    list.replaceChildren(make('li', 'empty-note', 'No earlier versions yet. Blueline keeps one before each write.'));
    return;
  }
  list.replaceChildren(
    ...h.entries.map((e) => {
      const li = make('li', 'history-entry');
      li.dataset.id = e.id;
      const time = entryTime(e.at);
      li.append(make('div', 'history-time', time), make('div', 'history-cause', CAUSES[e.cause] ?? e.cause));
      // 9.2 Undo and redo 4: "Restore deck to <time>"; main shows the diff and asks before it writes.
      const b = make('button', 'history-restore', `Restore deck to ${time}`);
      b.type = 'button';
      b.disabled = !h.canRestore;
      b.title = h.canRestore ? 'Shows what changes, and asks first' : (h.reason ?? 'Edit is not available');
      b.addEventListener('click', () => void api.historyRestore(e.id));
      li.append(b);
      return li;
    }),
  );
}

function onThumb(t: ShellThumb): void {
  if (!t || typeof t.src !== 'string' || !Number.isInteger(t.slide)) return;
  if (t.version !== thumbVersion) {
    thumbVersion = t.version;
    thumbs.clear();
  }
  thumbs.set(t.slide, t.src);
  const li = el('slide-list').querySelector<HTMLElement>(`li.slide[data-slide="${t.slide}"]`);
  if (li) setThumb(li, t.slide);
}

function onIndexReady(r: ShellIndexReady): void {
  if (!r || typeof r.version !== 'string') return;
  if (r.version !== thumbVersion) {
    thumbVersion = r.version;
    thumbs.clear();
  }
  if (r.designSize && r.designSize.w > 0 && r.designSize.h > 0) thumbDesign = { w: r.designSize.w, h: r.designSize.h };
  railKey = '';
  if (last) renderRail(last);
  // 6.9 Find: a query that waited for the index (or ran on the version before a reload) runs again.
  if (find.open && find.query.trim()) void runFind(find.query);
}

// ------------------------------------------------------------------------------------------- Find (6.9)

const find = {
  open: false,
  query: '',
  hits: [] as FindHit[],
  selected: -1,
  timer: null as ReturnType<typeof setTimeout> | null,
  seq: 0,
};

function findStatus(text: string): void {
  el('find-status').textContent = text;
}

function renderResults(r: FindResponse | null): void {
  const list = el('result-list');
  if (!r || r.hits.length === 0) {
    list.replaceChildren(make('li', 'empty-note', !find.query.trim() ? 'Type to find text on every slide' : r?.pending ? 'Indexing…' : 'No results'));
    return;
  }
  const items: HTMLElement[] = [];
  let slide = -1;
  r.hits.forEach((h, i) => {
    if (h.slide !== slide) {
      slide = h.slide;
      const kind = last?.view.kind === 'document' ? 'Section' : 'Slide';
      items.push(make('li', 'result-group', `${kind} ${h.slide + 1}${h.title ? ` · ${h.title}` : ''}`));
    }
    const li = make('li', 'result');
    li.dataset.hit = String(i);
    const b = make('button', 'result-button');
    b.type = 'button';
    const sn = h.snippet;
    const a = Math.max(0, Math.min(sn.length, h.snippetMatch.start));
    const z = Math.max(a, Math.min(sn.length, h.snippetMatch.end));
    b.append(document.createTextNode(sn.slice(0, a)), make('mark', undefined, sn.slice(a, z)), document.createTextNode(sn.slice(z)));
    b.addEventListener('click', () => void selectHit(i));
    li.append(b);
    items.push(li);
  });
  list.replaceChildren(...items);
}

function markSelected(): void {
  for (const li of el('result-list').querySelectorAll<HTMLElement>('li.result')) {
    const on = Number(li.dataset.hit) === find.selected;
    if (on) {
      li.setAttribute('aria-current', 'true');
      li.scrollIntoView({ block: 'nearest' });
    } else li.removeAttribute('aria-current');
  }
}

async function runFind(query: string): Promise<void> {
  const seq = ++find.seq;
  if (!query.trim()) {
    find.hits = [];
    find.selected = -1;
    findStatus('');
    renderResults(null);
    return;
  }
  let r: FindResponse;
  try {
    r = await api.find(query);
  } catch {
    return;
  }
  if (seq !== find.seq || r.query !== find.query) return;
  find.hits = r.hits;
  find.selected = -1;
  if (r.pending) findStatus('Indexing…');
  else if (r.hits.length === 0) findStatus('No results');
  else {
    const slides = new Set(r.hits.map((h) => h.slide)).size;
    const n = r.truncated ? `${r.hits.length}+` : String(r.hits.length);
    findStatus(`${n} ${r.hits.length === 1 ? 'result' : 'results'} on ${slides} ${slides === 1 ? (last?.view.kind === 'document' ? 'section' : 'slide') : last?.view.kind === 'document' ? 'sections' : 'slides'}`);
  }
  renderResults(r);
}

async function selectHit(i: number): Promise<void> {
  if (i < 0 || i >= find.hits.length) return;
  find.selected = i;
  markSelected();
  const h = find.hits[i];
  const ok = await api.findShow(h.slide, h.matchIndex).catch(() => false);
  if (!ok && find.selected === i) findStatus('That result is not on screen');
  // The keyboard stays in the Find bar: Enter goes on to the next result.
  el<HTMLInputElement>('find-input').focus();
}

function stepHit(dir: 1 | -1): void {
  const n = find.hits.length;
  if (n === 0) return;
  const next = find.selected < 0 ? (dir === 1 ? 0 : n - 1) : (find.selected + dir + n) % n;
  void selectHit(next);
}

function openFind(): void {
  find.open = true;
  el('find-bar').hidden = false;
  const input = el<HTMLInputElement>('find-input');
  input.focus();
  input.select();
  if (last) renderRail(last);
  renderResults(null);
  if (find.query.trim()) void runFind(find.query);
}

function closeFind(): void {
  if (!find.open) return;
  find.open = false;
  find.hits = [];
  find.selected = -1;
  find.seq++;
  el('find-bar').hidden = true;
  findStatus('');
  if (last) renderRail(last);
  void api.findClosed();
}

// ------------------------------------------------------------------------------------------- notes, status

/**
 * The notes panel (6.6; Phase 2's minimal list, P2-13): each note's status, id and kind, its slide and line, a
 * violated lock, the text, or an edit or verbatim note's before → after; Copy asks main, which writes the clipboard
 * (the shell has no clipboard permission).
 */
function renderPanel(s: ShellState): void {
  const list = el('note-list');
  if (s.notes.length === 0) {
    list.replaceChildren(make('li', 'empty-note', s.appMode === 'read' ? 'No notes' : s.appMode === 'edit' ? 'No notes yet. Edits you make are listed here.' : 'No notes yet. Draw on the page or press N.'));
    return;
  }
  list.replaceChildren(...s.notes.map((n) => noteItem(n)));
}

function noteItem(n: ShellNote): HTMLElement {
  const li = make('li', `note ${n.kind}`);
  li.dataset.id = n.id;
  const meta = make('div', 'meta');
  meta.append(make('span', 'status', n.status), make('span', 'id', n.id));
  if (n.kind !== 'markup') meta.append(make('span', 'kind', n.kind));
  const where: string[] = [];
  if (typeof n.slide === 'number') where.push(`slide ${n.slide + 1}`);
  if (typeof n.line === 'number') where.push(`line ${n.line}`);
  if (where.length > 0) meta.append(make('span', 'where', where.join(' · ')));
  if (n.locked === 'violated') {
    const flag = make('span', 'violated', 'changed since');
    flag.title = 'This edit was changed outside Blueline after it was written';
    meta.append(flag);
  }
  li.append(meta);
  if (n.before !== undefined && n.after !== undefined) {
    const ba = make('div', 'before-after');
    ba.append(make('span', 'before', n.before), make('span', 'arrow', ' \u2192 '), make('span', 'after', n.after));
    li.append(ba);
    if (n.kind === 'verbatim' && n.summary) li.append(make('div', 'summary', n.summary));
  } else {
    li.append(make('div', n.text.trim() ? 'text' : 'text empty', n.text.trim() ? n.text : '(no text)'));
  }
  const copy = make('button', 'copy', 'Copy');
  copy.type = 'button';
  copy.title = 'Copy this note';
  copy.addEventListener('click', () => void api.copyNote(n.id));
  li.append(copy);
  return li;
}

/** 6.0 Status bar: position, zoom, trust state; the save state (or a task, or a deferred reload) on the right. */
function renderStatus(s: ShellState): void {
  const parts: string[] = [];
  const slide = s.slide;
  if (slide && slide.count > 1) {
    const word = slide.kind === 'scroll' ? 'Section' : 'Slide';
    parts.push(`${word} ${Math.min(slide.current + 1, slide.count)} of ${slide.count}`);
  }
  if (s.view.kind !== 'document') parts.push(`${zoomLabel(s.view.zoomMode)} · ${Math.round((s.view.zoom || 1) * 100)}%`);
  else if (s.view.readingWidth) parts.push('Reading width');
  parts.push(s.trust === 'protected' ? 'Protected' : 'Trusted');
  el('status-left').textContent = parts.join(' · ');
  const right: string[] = [];
  if (s.status.task) right.push(s.status.task);
  if (s.status.reloadDeferred) right.push('Deck changed · reloads when you finish');
  if (s.status.fileGone) right.push('File missing');
  if (s.saveState) right.push(s.saveState);
  el('status-right').textContent = right.join(' · ');
}

// ------------------------------------------------------------------------------------------- scrolling

let scrollSending = false;
let scrollKey = '';

/** A deck view larger than the window (100%, Fill width): #deck-slot scrolls a spacer of its size. */
function renderScroll(s: ShellState): void {
  const slot = el('deck-slot');
  const sc = s.view.scroll;
  slot.classList.toggle('scrolling', sc !== null);
  const spacer = el('deck-spacer');
  spacer.style.setProperty('width', px(sc ? sc.width : 0));
  spacer.style.setProperty('height', px(sc ? sc.height : 0));
  const key = sc ? `${sc.width}x${sc.height}` : '';
  if (sc && key !== scrollKey) {
    slot.scrollLeft = sc.x;
    slot.scrollTop = sc.y;
  }
  scrollKey = key;
}

function onSlotScroll(): void {
  if (scrollSending) return;
  scrollSending = true;
  requestAnimationFrame(() => {
    scrollSending = false;
    const slot = el('deck-slot');
    if (!slot.classList.contains('scrolling')) return;
    void api.scroll(Math.max(0, slot.scrollLeft), Math.max(0, slot.scrollTop));
  });
}

function render(s: ShellState): void {
  if (!s || typeof s !== 'object') return;
  last = s;
  applyLayout(s.layout);
  document.body.classList.toggle('presenting', s.view.presenting);
  // Main's layout drops the Find bar (layout.findBar 0) when Find ended elsewhere, and while presenting (6.9
  // Present: the chrome is hidden). Either way Find closes in main too (closeFind: stopFindInPage, the query
  // cleared, the layout without the bar; a no-op when main already closed it): a bar that is gone must not leave
  // the find highlight on the presented slide, or an empty strip after Present (review finding 19).
  if (find.open && !(s.layout.findBar > 0)) closeFind();
  renderToolbar(s);
  renderTrustBar(s);
  renderBanner(s);
  renderRail(s);
  renderPanel(s);
  renderStatus(s);
  renderScroll(s);
}

// ------------------------------------------------------------------------------------------- toasts

let toastTimer: ReturnType<typeof setTimeout> | null = null;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const ACTION_RE = /^[a-z][a-z-]{0,31}$/;

function hideToast(): void {
  el('toast').classList.remove('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = null;
}

/**
 * A toast in the status bar. With actions (P2-14: "Make a note"), each is a button that names the toast's token
 * and the action's id; main checks both against the toast it showed last and runs its own action.
 */
function showToast(t: ShellToast): void {
  if (!t || typeof t.text !== 'string') return;
  const box = el('toast');
  const text = make('span', 'toast-text', t.text);
  const parts: HTMLElement[] = [text];
  const token = typeof t.token === 'string' && TOKEN_RE.test(t.token) ? t.token : null;
  const actions = token && Array.isArray(t.actions) ? t.actions.filter((a) => a && typeof a.id === 'string' && ACTION_RE.test(a.id) && typeof a.label === 'string').slice(0, 3) : [];
  for (const a of actions) {
    const b = make('button', 'toast-action', a.label);
    b.type = 'button';
    b.addEventListener('click', () => {
      hideToast();
      void api.toastAction(token!, a.id).catch(() => undefined);
    });
    parts.push(b);
  }
  box.replaceChildren(...parts);
  box.title = t.text;
  box.className = `toast visible ${t.kind === 'warn' || t.kind === 'error' ? t.kind : 'info'}${actions.length > 0 ? ' actionable' : ''}`;
  if (toastTimer) clearTimeout(toastTimer);
  // A toast with a button stays long enough to be pressed.
  const ms = actions.length > 0 ? 15_000 : Math.min(12_000, 4000 + t.text.length * 40);
  toastTimer = setTimeout(() => {
    box.classList.remove('visible');
    toastTimer = null;
  }, ms);
}

// ------------------------------------------------------------------------------------------- actions

function popup(menu: ShellMenu, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  void api.popupMenu(menu, Math.max(0, Math.round(r.left)), Math.max(0, Math.round(r.bottom + 2)));
}

function command(cmd: ShellCommand): void {
  void api.command(cmd);
}

function wire(): void {
  el('file-name').addEventListener('click', (e) => popup('file', e.currentTarget as HTMLElement));
  el('share').addEventListener('click', (e) => popup('share', e.currentTarget as HTMLElement));
  el('present').addEventListener('click', () => command('present'));
  el('trust-more').addEventListener('click', (e) => popup('trust-overflow', e.currentTarget as HTMLElement));
  for (const b of el('mode-switch').querySelectorAll<HTMLButtonElement>('button[data-mode]')) {
    b.addEventListener('click', () => {
      const mode = b.dataset.mode as AppMode;
      if ((MODES as readonly string[]).includes(mode)) void api.setMode(mode);
    });
  }
  el('allow-network').addEventListener('click', () => void api.allowNetwork());
  el('enable-editing').addEventListener('click', () => void api.enableEditing());
  el('trust-close').addEventListener('click', () => void api.dismissTrustBar());
  el('banner-open').addEventListener('click', () => void api.openInBrowser());
  el('banner-close').addEventListener('click', () => void api.dismissBanner());
  el('rail-hide').addEventListener('click', () => {
    if (last?.history) void api.historyClose();
    else command('toggle-rail');
  });
  // 6.8: the name chip. Typing goes to the shell's own input, never to the deck.
  el('name-chip').addEventListener('click', () => startNaming());
  const nameInput = el<HTMLInputElement>('name-input');
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveName();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      endNaming();
    }
  });
  nameInput.addEventListener('blur', () => {
    if (naming) void saveName();
  });
  el('deck-slot').addEventListener('scroll', onSlotScroll, { passive: true });

  // The Find bar: typing never reaches the deck (the keyboard is in the shell's own page).
  const input = el<HTMLInputElement>('find-input');
  input.addEventListener('input', () => {
    find.query = input.value;
    if (find.timer) clearTimeout(find.timer);
    find.timer = setTimeout(() => {
      find.timer = null;
      void runFind(find.query);
    }, 120);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      stepHit(e.shiftKey ? -1 : 1);
    }
  });
  el('find-next').addEventListener('click', () => stepHit(1));
  el('find-prev').addEventListener('click', () => stepHit(-1));
  el('find-close').addEventListener('click', () => closeFind());
  document.addEventListener('keydown', (e) => {
    // Esc anywhere in the shell closes the Find bar (Present's Esc is main's, in before-input-event).
    if (e.key === 'Escape' && find.open && e.target !== input) closeFind();
  });
}

function start(): void {
  wire();
  api.onState(render);
  api.onToast(showToast);
  api.onThumb(onThumb);
  api.onIndexReady(onIndexReady);
  api.onFindOpen(openFind);
  api.onScrollTo((p) => {
    const slot = el('deck-slot');
    if (!p || !slot.classList.contains('scrolling')) return;
    slot.scrollLeft = Math.max(0, Number(p.x) || 0);
    slot.scrollTop = Math.max(0, Number(p.y) || 0);
  });
  // Replies and pushes arrive in the order main sent them, so whichever arrives last is the newest.
  void api.getState().then(render);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
