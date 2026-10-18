// The visible deck view's Phase 1 hooks (6.9 Reading, 6.6 Reload): what main's views need from the page, and
// what they ask of it. Built by deck.ts in deck and diagnostics modes, never in render mode.
//
// - Design size (6.9): the slide engine's design size and the viewport it was measured at
//   (ViewsDeckToMain.design). Main fits the deck view with webContents.setZoomFactor; the page keeps its
//   viewport at the design size, so the overlay, ink, cards and hit-testing stay in the page's CSS pixels and
//   need no change under the zoom.
// - Navigation (6.9): MainToDeckViews.goto shows a slide (reveal.js through Reveal.slide(h, v) in the page's
//   world, integers only; a hash by assignment; a scroll block or a document heading into view). Index decks
//   are moved by main's own trusted keys; while main presses them (NavReplay) the key router treats the view
//   as Read, so a Review or Edit view lets the deck's own keys through.
// - PageUp and PageDown (6.9: "the thumbnail rail and PageUp and PageDown work too"): in Read the deck gets
//   them first; one the deck did not use (not prevented, and the slide did not move) is a step main makes. In
//   Review and Edit the key router keeps them from the deck (6.2 step 5), so main steps at once.
// - The wheel (100%, Fill width): a deck view larger than the window pans with a wheel the page did not use.
// - View state (6.6): captured on request (MainToDeckFiles.captureViewState → FilesDeckToMain.viewState) and
//   applied after the reloaded page's init, once its layout has settled; FilesDeckToMain.viewStateApplied says
//   when that is done. The busy state (an edit, a card with unsaved input) is sent whenever it changes and once
//   after each init (FilesDeckToMain.busy).
//
// Every listener is registered through listen() (listeners.ts), so it survives document.open().

import type { AppMode } from '@blueline/core/ipc';
import {
  FilesDeckToMain,
  VIEW_STATE_LIMITS,
  type CaptureViewState,
  type DeckBusy,
  type DeckViewState,
  type ViewStateReply,
} from '@blueline/core/ipc-files';
import { ViewsDeckToMain, VIEWS_LIMITS, type DesignReport, type GotoRequest, type PageStep, type WheelPan } from '@blueline/core/ipc-views';
import { currentSlide, detectSlides, type SlideModel } from '@blueline/core/slides';
import type { KeyAction } from './key-router';
import { listen } from './listeners';

/** A PageUp/PageDown the deck did not use: how long the slide may take to move before Blueline steps it. */
const PAGE_KEY_GRACE_MS = 600;
/** The busy state is looked at this often while the page is up (cheap: two field reads). */
const BUSY_POLL_MS = 200;
/** Waits for a reloaded page's layout before its view state is applied (fonts, images, the deck's own setup). */
const SETTLE_MAX_MS = 3000;
/** A main-world call that never answers (a hostile or hung page) is given up. */
const MAIN_WORLD_TIMEOUT_MS = 2000;
const LINE_PX = 16;

/** What the hooks read from the deck UI (deck-ui.ts). */
export interface ViewUi {
  appMode(): AppMode;
  slideModel(): SlideModel | null;
  busyState(): DeckBusy;
  cardDraft(): { noteId: string; draft: string } | null;
  restoreCard(noteId: string, draft: string): boolean;
}

export interface ViewHooksDeps {
  send(channel: string, payload?: unknown): void;
  /** webFrame.executeJavaScript in the page's main world (reveal.js navigation; integers only). */
  executeJavaScript(code: string): Promise<unknown>;
  ui(): ViewUi | null;
  /** The overlay host: wheel events over it are the overlay's, never a pan. */
  host(): Element | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function frame(win: Window): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    win.requestAnimationFrame(() => finish());
    setTimeout(finish, 250);
  });
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** The leading part of `s` that fits in `maxBytes` of UTF-8, never splitting a surrogate pair. */
function clipUtf8(s: string, maxBytes: number): string {
  if (utf8Bytes(s) <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(s.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  const c = s.charCodeAt(end - 1);
  if (end > 0 && c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

export class ViewHooks {
  /** Main is pressing the deck's own keys (NavReplay): the key router treats the view as Read. */
  private replaying = false;
  /** Main says the deck view is larger than the window on these axes (100%, Fill width). */
  private pan = { x: false, y: false };
  private pending = { dx: 0, dy: 0, scheduled: false };
  private lastDesign = '';
  private lastBusy = '';
  private busyTimer: ReturnType<typeof setInterval> | null = null;
  private applying: Promise<void> | null = null;
  private lastHashChange = 0;

  constructor(
    private readonly win: Window,
    private readonly deps: ViewHooksDeps,
  ) {}

  /** Registers the window listeners. Call at preload start, after the key router and the input guard. */
  install(): void {
    listen(this.win, 'hashchange', () => {
      this.lastHashChange = Date.now();
    });
    // Bubble phase, registered before any page script: page listeners on elements and the document have run
    // by the time it fires, and a later look (after dispatch) sees whether any of them used the wheel.
    listen(this.win, 'wheel', (e) => this.onWheel(e), { passive: true });
  }

  /** The key router's appMode, as the hooks see it: Read while main replays the deck's keys. */
  routerMode(real: AppMode): AppMode {
    return this.replaying ? 'read' : real;
  }

  // ------------------------------------------------------------------------------------------- from main

  /** MainToDeck.init arrived (every page load): report the busy state now, and keep reporting its changes. */
  onInit(): void {
    this.lastBusy = '';
    this.reportBusy();
    if (!this.busyTimer) this.busyTimer = setInterval(() => this.reportBusy(), BUSY_POLL_MS);
    this.reportDesign();
  }

  /** MainToDeckViews.navReplay. */
  setReplay(p: unknown): void {
    this.replaying = !!(p && typeof p === 'object' && (p as { active?: unknown }).active === true);
  }

  /** MainToDeckViews.pan: { x, y } booleans. */
  setPan(p: unknown): void {
    const o = p && typeof p === 'object' ? (p as { x?: unknown; y?: unknown }) : {};
    this.pan = { x: o.x === true, y: o.y === true };
  }

  /** MainToDeckViews.goto (main is the only sender of this channel; values are still checked). */
  async goto(p: unknown): Promise<void> {
    const r = p as GotoRequest | null;
    if (!r || typeof r !== 'object') return;
    const doc = this.win.document;
    switch (r.kind) {
      case 'top':
        this.win.scrollTo({ left: 0, top: 0, behavior: 'instant' as ScrollBehavior });
        return;
      case 'reveal': {
        const { h, v } = r;
        // Integers only are ever interpolated into main-world code (as the render agent does).
        if (!Number.isInteger(h) || !Number.isInteger(v) || h < 0 || v < 0 || h >= VIEWS_LIMITS.index || v >= VIEWS_LIMITS.index) return;
        await Promise.race([
          this.deps
            .executeJavaScript(`(function(){try{if(window.Reveal&&typeof window.Reveal.slide==="function"){window.Reveal.slide(${h},${v});return true}}catch(e){}return false})()`)
            .catch(() => false),
          delay(MAIN_WORLD_TIMEOUT_MS),
        ]);
        return;
      }
      case 'hash': {
        const hash = typeof r.hash === 'string' ? r.hash : '';
        if (r.replace === true) {
          // Puts the hash back without a hashchange (a deck that did not follow the goto, review finding 17);
          // '' takes it off.
          if ((hash !== '' && !hash.startsWith('#')) || utf8Bytes(hash) > VIEWS_LIMITS.hash) return;
          try {
            const loc = this.win.location;
            if (loc.hash !== hash) this.win.history.replaceState(this.win.history.state, '', hash === '' ? loc.pathname + loc.search : hash);
          } catch {
            // a page that broke history: the hash stays
          }
          return;
        }
        if (!hash.startsWith('#') || utf8Bytes(hash) > VIEWS_LIMITS.hash) return;
        if (this.win.location.hash !== hash) this.win.location.hash = hash;
        return;
      }
      case 'scroll': {
        if (!Number.isInteger(r.index) || r.index < 0) return;
        const m = this.model() ?? detectSlides(doc, this.win, { host: this.deps.host() });
        const el = m.slides[r.index];
        el?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
        return;
      }
      case 'heading': {
        if (!Number.isInteger(r.index) || r.index < 0) return;
        // SlideIndexEntry.heading counts every h1–h3 in document order (slide-index.ts), hidden ones included.
        const el = doc.querySelectorAll('h1, h2, h3')[r.index];
        el?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
        return;
      }
    }
  }

  /** MainToDeckFiles.captureViewState: answer with the view state now (6.6 "Before reloading, it saves …"). */
  capture(p: unknown): void {
    const reqId = p && typeof p === 'object' ? (p as CaptureViewState).reqId : undefined;
    if (typeof reqId !== 'number' || !Number.isInteger(reqId) || reqId < 0) return;
    const reply: ViewStateReply = { reqId, state: this.viewState() };
    this.deps.send(FilesDeckToMain.viewState, reply);
  }

  /** MainToDeckFiles.applyViewState: restore it once the reloaded page's layout has settled. */
  apply(p: unknown): void {
    const s = p as DeckViewState | null;
    if (!s || typeof s !== 'object') return;
    const run = (this.applying ?? Promise.resolve()).then(() => this.applyNow(s)).catch(() => undefined);
    this.applying = run;
    void run.finally(() => {
      if (this.applying === run) this.applying = null;
    });
  }

  // ------------------------------------------------------------------------------------------- reports

  /** SlideState changed (the slide watcher reported): the design size may be known now. */
  onSlides(): void {
    this.reportDesign();
  }

  private model(): SlideModel | null {
    return this.deps.ui()?.slideModel() ?? null;
  }

  private reportDesign(): void {
    const m = this.model();
    if (!m || (m.kind !== 'reveal' && m.kind !== 'generic')) return;
    const r: DesignReport = {
      kind: m.kind,
      w: m.designSize.w,
      h: m.designSize.h,
      viewportW: this.win.innerWidth,
      viewportH: this.win.innerHeight,
    };
    if (!(r.w >= 1 && r.h >= 1)) return;
    const key = `${r.kind}:${r.w}x${r.h}@${r.viewportW}x${r.viewportH}`;
    if (key === this.lastDesign) return;
    this.lastDesign = key;
    this.deps.send(ViewsDeckToMain.design, r);
  }

  private reportBusy(): void {
    const ui = this.deps.ui();
    if (!ui) return;
    const b = ui.busyState();
    const key = `${b.edit}:${b.card}`;
    if (key === this.lastBusy) return;
    this.lastBusy = key;
    this.deps.send(FilesDeckToMain.busy, b);
  }

  private viewState(): DeckViewState {
    const doc = this.win.document;
    const se = doc.scrollingElement;
    const clampScroll = (n: unknown) => {
      const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
      return Math.max(-VIEW_STATE_LIMITS.scroll, Math.min(VIEW_STATE_LIMITS.scroll, v));
    };
    let hash = '';
    try {
      hash = this.win.location.hash;
    } catch {
      hash = '';
    }
    // eslint-disable-next-line no-control-regex
    if (utf8Bytes(hash) > VIEW_STATE_LIMITS.hash || /[\u0000-\u001f\u007f]/.test(hash)) hash = '';
    const m = this.model();
    const slide = m && m.kind !== 'single' && Number.isInteger(m.current) && m.current >= 0 && m.current < VIEW_STATE_LIMITS.slides ? m.current : null;
    const c = this.deps.ui()?.cardDraft() ?? null;
    return {
      scroll: { x: clampScroll(se?.scrollLeft), y: clampScroll(se?.scrollTop) },
      hash,
      slide,
      card: c ? { noteId: c.noteId, draft: clipUtf8(c.draft, VIEW_STATE_LIMITS.draft) } : null,
    };
  }

  /** Waits until the page has loaded and two frames have passed, then a little more for the deck's own setup. */
  private async settled(): Promise<void> {
    const end = Date.now() + SETTLE_MAX_MS;
    const doc = this.win.document;
    while (doc.readyState !== 'complete' && Date.now() < end) await delay(50);
    try {
      await Promise.race([doc.fonts.ready, delay(Math.max(0, end - Date.now()))]);
    } catch {
      // no font loading in this document
    }
    await frame(this.win);
    await frame(this.win);
    // Slide engines lay out on load and on their first resize; the slide watcher re-detects within 120 ms.
    await delay(150);
  }

  private async applyNow(s: DeckViewState): Promise<void> {
    try {
      await this.restore(s);
    } finally {
      // Main reuses this state for a reload that starts before now (review finding 20).
      this.deps.send(FilesDeckToMain.viewStateApplied);
    }
  }

  private async restore(s: DeckViewState): Promise<void> {
    await this.settled();
    const m = this.model();
    // The slide (6.6): reveal.js and hash decks are shown here (the reload URL already carries the hash); index
    // decks are moved by main's keys, which it presses once the new page reports its slides.
    if (m && s.slide !== null && s.slide < m.count && currentSlide(m, this.win) !== s.slide) {
      if (m.navKind === 'reveal' && m.revealIndices?.[s.slide]) {
        const [h, v] = m.revealIndices[s.slide];
        await this.goto({ kind: 'reveal', h, v });
      } else if (m.navKind === 'hash' && m.hashes?.[s.slide]) {
        await this.goto({ kind: 'hash', hash: m.hashes[s.slide] });
      } else if (m.navKind === 'scroll') {
        await this.goto({ kind: 'scroll', index: s.slide });
      }
    }
    // The scroll position: a document's place in the page, after its layout settled.
    if (!m || m.kind === 'scroll' || m.kind === 'single') {
      if (s.scroll.x !== 0 || s.scroll.y !== 0) this.win.scrollTo({ left: s.scroll.x, top: s.scroll.y, behavior: 'instant' as ScrollBehavior });
    }
    if (s.card) this.deps.ui()?.restoreCard(s.card.noteId, s.card.draft);
    this.reportBusy();
  }

  // ------------------------------------------------------------------------------------------- keys

  /**
   * The key router's decision on a keydown (deck.ts wraps the router's onDecision). PageUp and PageDown in a
   * deck: in Read the deck had them first, and Blueline steps only when the deck did not use them; in Review and
   * Edit the router kept them from the deck, so Blueline steps now (6.9 Navigation).
   */
  onKeyDecision(e: KeyboardEvent, action: KeyAction): void {
    if (!e.isTrusted || this.replaying) return;
    if (e.code !== 'PageDown' && e.code !== 'PageUp') return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const m = this.model();
    if (!m || (m.kind !== 'reveal' && m.kind !== 'generic')) return;
    const dir: 1 | -1 = e.code === 'PageDown' ? 1 : -1;
    if (action.kind === 'swallow') {
      this.step(dir);
      return;
    }
    if (action.kind !== 'pass') return;
    const from = currentSlide(m, this.win);
    const at = Date.now();
    // After the whole dispatch: was it prevented by the deck? Then watch the slide for a moment.
    setTimeout(() => {
      if (e.defaultPrevented) return;
      setTimeout(() => {
        const now = this.model();
        if (!now || currentSlide(now, this.win) !== from || this.lastHashChange >= at) return;
        this.step(dir);
      }, PAGE_KEY_GRACE_MS);
    }, 0);
  }

  private step(dir: 1 | -1): void {
    const p: PageStep = { dir };
    this.deps.send(ViewsDeckToMain.pageStep, p);
  }

  // ------------------------------------------------------------------------------------------- wheel

  /** True when the page itself scrolls something with this wheel (an element on the path, or the page). */
  private pageScrolls(e: WheelEvent): boolean {
    const doc = this.win.document;
    const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
    const host = this.deps.host();
    for (const t of e.composedPath()) {
      if (!(t instanceof Element)) continue;
      if (t === host) return true;
      const st = this.win.getComputedStyle(t);
      const ov = vertical ? st.overflowY : st.overflowX;
      if (ov !== 'auto' && ov !== 'scroll' && ov !== 'overlay') continue;
      if (vertical ? t.scrollHeight > t.clientHeight + 1 : t.scrollWidth > t.clientWidth + 1) return true;
    }
    const se = doc.scrollingElement;
    if (!se) return false;
    return vertical ? se.scrollHeight > se.clientHeight + 1 : se.scrollWidth > se.clientWidth + 1;
  }

  private onWheel(e: WheelEvent): void {
    if (!e.isTrusted || (!this.pan.x && !this.pan.y) || e.ctrlKey) return;
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? this.win.innerHeight : 1;
    const dx = this.pan.x ? e.deltaX * unit : 0;
    const dy = this.pan.y ? e.deltaY * unit : 0;
    if (dx === 0 && dy === 0) return;
    if (this.pageScrolls(e)) return;
    setTimeout(() => {
      // A page listener that used the wheel (a deck that pages on the wheel) prevented it.
      if (e.defaultPrevented) return;
      this.pending.dx += dx;
      this.pending.dy += dy;
      if (this.pending.scheduled) return;
      this.pending.scheduled = true;
      this.win.requestAnimationFrame(() => {
        const lim = VIEWS_LIMITS.wheel;
        const pan: WheelPan = { dx: Math.max(-lim, Math.min(lim, this.pending.dx)), dy: Math.max(-lim, Math.min(lim, this.pending.dy)) };
        this.pending = { dx: 0, dy: 0, scheduled: false };
        this.deps.send(ViewsDeckToMain.wheel, pan);
      });
    }, 0);
  }
}
