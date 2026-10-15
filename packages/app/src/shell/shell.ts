// The shell UI (6.0 The window): toolbar, trust bar, the "tried to leave" bar, left rail, notes panel and
// status bar. No framework. It shows text from documents (file names, slide titles, note text), so every
// string goes in with textContent, never as HTML (9.1 Shell view); the only style writes are numeric
// layout values through CSSOM setProperty. It talks to main only through window.blueline (the shell
// preload's contextBridge API).

import type { AppMode, ShellApi, ShellLayout, ShellMenu, ShellState } from '@blueline/core/ipc';

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

// ------------------------------------------------------------------------------------------- layout

function px(n: unknown): string {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0;
  return `${Math.max(0, Math.min(10_000, v))}px`;
}

function applyLayout(l: ShellLayout): void {
  const s = document.documentElement.style;
  s.setProperty('--toolbar', px(l.toolbar));
  s.setProperty('--trust', px(l.trustBar));
  s.setProperty('--banner', px(l.banner));
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
      b.disabled = !s.capabilities.edit;
      b.title = !s.capabilities.edit
        ? 'Edit is not available in this version'
        : s.readOnlyReason ?? (s.editingAllowed ? 'Edit (Ctrl/Cmd+3)' : 'Protected view: enable editing first');
    }
  }
  // The agent chip shows in Review and Edit when the agent capability is on (6.0, 6.6): Phase 4.
  el('agent-chip').hidden = true;
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

function renderRail(s: ShellState): void {
  const list = el('slide-list');
  const items: HTMLElement[] = [];
  const slide = s.slide;
  if (slide && slide.titles.length > 0) {
    slide.titles.forEach((title, i) => {
      const li = make('li');
      if (i === slide.current) li.setAttribute('aria-current', 'true');
      li.append(make('span', 'num', String(i + 1)), make('span', 'title', title || `Slide ${i + 1}`));
      // Phase 1: clicking navigates through slide.nav, and the rail shows thumbnails (6.9).
      items.push(li);
    });
  } else {
    items.push(make('li', 'empty-note', slide ? 'One page' : 'Looking for slides…'));
  }
  list.replaceChildren(...items);
}

function renderPanel(s: ShellState): void {
  const list = el('note-list');
  if (s.notes.length === 0) {
    list.replaceChildren(make('li', 'empty-note', s.appMode === 'read' ? 'No notes' : 'No notes yet. Draw on the page or press N.'));
    return;
  }
  list.replaceChildren(
    ...s.notes.map((n) => {
      const li = make('li');
      const meta = make('div', 'meta');
      meta.append(make('span', 'status', n.status), make('span', 'id', n.id));
      if (n.kind !== 'markup') meta.append(make('span', 'kind', n.kind));
      const text = make('div', n.text.trim() ? 'text' : 'text empty', n.text.trim() ? n.text : '(no text)');
      li.append(meta, text);
      return li;
    }),
  );
}

function renderStatus(s: ShellState): void {
  const parts: string[] = [];
  const slide = s.slide;
  if (slide && slide.count > 1) {
    const word = slide.kind === 'scroll' ? 'Section' : 'Slide';
    parts.push(`${word} ${Math.min(slide.current + 1, slide.count)} of ${slide.count}`);
  }
  // Zoom (Fit, 100%, Fill width) arrives with the deck view in Phase 1 (6.9).
  parts.push('Fit', '100%', s.trust === 'protected' ? 'Protected' : 'Trusted');
  el('status-left').textContent = parts.join(' · ');
  el('status-right').textContent = s.saveState;
}

function render(s: ShellState): void {
  if (!s || typeof s !== 'object') return;
  applyLayout(s.layout);
  renderToolbar(s);
  renderTrustBar(s);
  renderBanner(s);
  renderRail(s);
  renderPanel(s);
  renderStatus(s);
}

// ------------------------------------------------------------------------------------------- toasts

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(t: { text: string; kind: 'info' | 'warn' | 'error' }): void {
  if (!t || typeof t.text !== 'string') return;
  const box = el('toast');
  box.textContent = t.text;
  box.title = t.text;
  box.className = `toast visible ${t.kind === 'warn' || t.kind === 'error' ? t.kind : 'info'}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      box.classList.remove('visible');
      toastTimer = null;
    },
    Math.min(12_000, 4000 + t.text.length * 40),
  );
}

// ------------------------------------------------------------------------------------------- actions

function popup(menu: ShellMenu, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  void api.popupMenu(menu, Math.max(0, Math.round(r.left)), Math.max(0, Math.round(r.bottom + 2)));
}

function wire(): void {
  el('file-name').addEventListener('click', (e) => popup('file', e.currentTarget as HTMLElement));
  el('share').addEventListener('click', (e) => popup('share', e.currentTarget as HTMLElement));
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
}

function start(): void {
  wire();
  api.onState(render);
  api.onToast(showToast);
  // Replies and pushes arrive in the order main sent them, so whichever arrives last is the newest.
  void api.getState().then(render);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
