// The slide adapter of the visible deck view (9.1 Preload; 9.4): detects the slide model, follows the current
// slide, and reports SlideState to main when either changes. It also collects the evidence 9.4 and 6.7 need
// from real use: whether the deck moves location.hash with the slide (hash navigation), and which keys moved
// the deck forward and back (deckNav, for index replay in the render service).

import { currentSlide, detectSlides, inferHashFormat, sameSlides, type HashFormat, type SlideModel } from '@blueline/core/slides';
import type { SlideState } from '@blueline/core/ipc';
import { listen } from './listeners';

/** Re-checks are throttled: decks animate with style writes every frame. */
const CHECK_MS = 120;
/** A key "moved the deck" when the current slide changes within this time after it (6.7: up to 1 s). */
const KEY_WINDOW_MS = 1000;
/** A hashchange this close to a slide change counts as the deck updating the hash (9.4 step 2). */
const HASH_WINDOW_MS = 1000;
/** Key names main can map to Electron accelerators (6.7 Index replay). */
const NAV_KEYS = new Set(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ']);

export interface SlideWatcherDeps {
  report(state: SlideState): void;
  /** Diagnostics: the current slide moved. */
  moved?(from: number, to: number): void;
  host(): Element | null;
}

export class SlideWatcher {
  model: SlideModel | null = null;
  private hashFormat: HashFormat | null = null;
  private lastHashChange = 0;
  private lastMoveAt = 0;
  private lastKey: { key: string; at: number; from: number } | null = null;
  private deckNav: { forward?: string; back?: string } = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSent = '';
  private structureDirty = true;
  private mo: MutationObserver | null = null;

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly deps: SlideWatcherDeps,
  ) {}

  start(): void {
    const begin = () => {
      this.structureDirty = true;
      this.check();
      this.observeRoot();
    };
    if (this.doc.readyState === 'loading') this.doc.addEventListener('DOMContentLoaded', begin, { once: true });
    else begin();
    listen(this.win, 'load', () => {
      this.structureDirty = true;
      this.schedule();
    });
    listen(this.win, 'hashchange', () => {
      this.lastHashChange = Date.now();
      this.schedule();
    });
    listen(this.win, 'scroll', () => this.schedule(), { passive: true });
    listen(this.win, 'resize', () => {
      this.structureDirty = true;
      this.schedule();
    });
    listen(this.win, 'transitionend', () => this.schedule(), true);
  }

  /** Watches the root element's subtree for slide changes (class, style, hidden, ... and structure). */
  private observeRoot(): void {
    this.mo?.disconnect();
    const root = this.doc.documentElement;
    if (!root) return;
    this.mo = new MutationObserver((records) => {
      const host = this.deps.host();
      for (const r of records) {
        if (host && (r.target === host || host.contains(r.target))) continue;
        if (r.type === 'childList') this.structureDirty = true;
        this.schedule();
        return;
      }
    });
    this.mo.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state', 'aria-current'],
    });
  }

  /** The page replaced its root element (document.open): detect again and watch the new root. */
  rootReplaced(): void {
    this.model = null;
    this.structureDirty = true;
    this.observeRoot();
    this.schedule();
  }

  /** A trusted key given to the deck (Read mode, or ArrowLeft/ArrowRight in Review and Edit). */
  noteDeckKey(key: string): void {
    if (!NAV_KEYS.has(key)) return;
    this.lastKey = { key, at: Date.now(), from: this.model?.current ?? 0 };
    this.schedule();
    // Slide engines often move after a transition or a timer: check again inside the window.
    setTimeout(() => this.schedule(), 400);
    setTimeout(() => this.schedule(), KEY_WINDOW_MS - 50);
  }

  /** The current slide index, or null when the page is a single document. */
  get current(): number | null {
    if (!this.model || this.model.kind === 'single') return null;
    return this.model.current;
  }

  get currentTitle(): string | null {
    if (!this.model || this.model.kind === 'single') return null;
    return this.model.titles[this.model.current] ?? null;
  }

  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.check();
    }, CHECK_MS);
  }

  /** Re-detects when the structure may have changed, else follows the current slide; reports changes. */
  check(): void {
    if (!this.doc.documentElement) return;
    const prev = this.model;
    const prevCurrent = prev?.current ?? null;
    let next: SlideModel;
    if (this.structureDirty || !prev) {
      next = detectSlides(this.doc, this.win, { hashFormat: this.hashFormat, host: this.deps.host() });
      this.structureDirty = false;
      if (prev && sameSlides(prev, next) && prev.navKind === next.navKind) next = { ...prev, current: next.current, hashes: next.hashes, hashFormat: next.hashFormat };
    } else {
      next = { ...prev, current: currentSlide(prev, this.win) };
    }
    const now = Date.now();
    if (prevCurrent !== null && next.current !== prevCurrent && prev && sameSlides(prev, next)) {
      this.lastMoveAt = now;
      this.deps.moved?.(prevCurrent, next.current);
      const k = this.lastKey;
      if (k && now - k.at <= KEY_WINDOW_MS) {
        if (next.current > k.from) this.deckNav.forward = k.key;
        else if (next.current < k.from) this.deckNav.back = k.key;
        this.lastKey = null;
      }
    }
    // 9.4 step 2: the deck updates the hash when a hashchange and a slide move happen together and the new
    // hash names the new slide. The format is kept for this page load.
    if (next.kind === 'generic' && !this.hashFormat && Math.abs(this.lastHashChange - this.lastMoveAt) <= HASH_WINDOW_MS && this.lastHashChange > 0) {
      const fmt = inferHashFormat(this.win.location.hash, next.current, next.ids?.[next.current] ?? null);
      if (fmt) {
        this.hashFormat = fmt;
        this.structureDirty = true;
        this.schedule();
      }
    }
    this.model = next;
    this.report();
  }

  private report(): void {
    const m = this.model;
    if (!m) return;
    const state: SlideState = { kind: m.kind, count: m.count, current: m.current, titles: m.titles.slice(), navKind: m.navKind };
    if (m.hashes) state.hashes = m.hashes.slice();
    if (m.revealIndices) state.revealIndices = m.revealIndices.map(([h, v]) => [h, v] as [number, number]);
    if (m.ids) state.ids = m.ids.slice();
    if (this.deckNav.forward || this.deckNav.back) state.deckNav = { ...this.deckNav };
    const json = JSON.stringify(state);
    if (json === this.lastSent) return;
    this.lastSent = json;
    this.deps.report(state);
  }

  /** The slide index that contains a node, or null. */
  slideOf(node: Node): number | null {
    const m = this.model;
    if (!m || m.kind === 'single') return null;
    for (let i = 0; i < m.slides.length; i++) if (m.slides[i].contains(node)) return i;
    return null;
  }
}
