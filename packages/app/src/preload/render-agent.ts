// The render agent (6.7 Background renders; section 10 Phase 0 `blueline map`): in `--bl-mode=render` the
// preload has no UI and no key router. It answers MainToDeck.renderRequest with DeckToMain.renderReply for
// every RenderCmd. Navigation inside the page uses the page's own engine: reveal.js through
// webFrame.executeJavaScript in the main world (the only call into the page's world, with integer arguments
// only), the hash by assignment, scrolling documents by scrollIntoView (and scroll-to, for the walk's
// viewport steps). Index navigation is main's (sendInputEvent); the agent only reports where the deck is,
// and counts the keydowns the page saw (keydowns) from a capture listener registered before any page script.

import type {
  CurrentResult,
  DetectResult,
  GotoResult,
  KeydownsResult,
  KeyResult,
  NodeLocator,
  RenderCmd,
  RenderReply,
  ScrollBlocksResult,
  ScrollToResult,
  SettleResult,
} from '@blueline/core/ipc';
import { DomWalker, ScriptTouchTracker, cssPath } from '@blueline/core/dom-walk';
import { currentSlide, detectSlides, inferHashFormat, scrollBlocks, slideIndexOf, slideTitle, toDetectResult, type HashFormat, type SlideModel } from '@blueline/core/slides';
import { adoptSheet, makePauseSheet, pauseRunning } from './animation-pause';
import { listen } from './listeners';

/** 6.7: after each navigation, wait up to 1 s for the visible slide to change. */
const NAV_WAIT_MS = 1000;
/** Settle: cap on waiting for fonts and for finite animations to end. */
const FONTS_WAIT_MS = 5000;
const FINITE_ANIMATION_WAIT_MS = 1500;
/** A main-world call that never answers (a hostile or hung page) is given up. */
const MAIN_WORLD_TIMEOUT_MS = 2000;
const STAMP = /^bl-[0-9]{1,9}$/;

export interface MainWorld {
  executeJavaScript(code: string): Promise<unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One animation frame, with a timer fallback so a throttled window cannot stall a render. */
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

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p.catch(() => fallback), delay(ms).then(() => fallback)]);
}

/** Replies are JSON values only: a round trip drops `undefined` fields and turns non-finite numbers into null. */
function plain(v: unknown): unknown {
  return v === undefined ? null : JSON.parse(JSON.stringify(v));
}

export class RenderAgent {
  private model: SlideModel | null = null;
  private hashFormat: HashFormat | null = null;
  private pauseSheet: CSSStyleSheet | null = null;
  private readonly walker: DomWalker;
  /** Keydowns the page's window has seen since this load (RenderCmd keydowns). */
  private readonly keydowns: KeydownsResult = { trusted: 0, all: 0 };

  constructor(
    private readonly win: Window,
    private readonly mainWorld: MainWorld,
    private readonly reply: (r: RenderReply) => void,
  ) {
    // 6.7 Index replay: whether trusted keys reach the deck. The agent is built synchronously at preload start,
    // before any page script, so this is the first capture listener on window: a page listener that calls
    // stopImmediatePropagation() cannot hide a key from it (review finding 33). It only counts.
    listen(
      win,
      'keydown',
      (e) => {
        this.keydowns.all++;
        if (e.isTrusted) this.keydowns.trusted++;
      },
      { capture: true, passive: true },
    );
    // Built at preload start like the key counter above, so it sees every change a page script makes.
    this.walker = new DomWalker(win, { host: () => null, touched: new ScriptTouchTracker(win.document) });
    // 9.4 step 2 evidence, as in the visible view: a hash that names the slide after a move.
    listen(win, 'hashchange', () => {
      const m = this.model;
      if (!m || m.kind !== 'generic' || this.hashFormat) return;
      const cur = currentSlide(m, win);
      const fmt = inferHashFormat(win.location.hash, cur, m.ids?.[cur] ?? null);
      if (fmt) this.hashFormat = fmt;
    });
  }

  private get doc(): Document {
    return this.win.document;
  }

  /** Handles one MainToDeck.renderRequest payload. Malformed requests get an error reply when they carry a reqId. */
  async handle(payload: unknown): Promise<void> {
    const reqId = payload && typeof payload === 'object' ? (payload as { reqId?: unknown }).reqId : undefined;
    if (typeof reqId !== 'number' || !Number.isSafeInteger(reqId) || reqId < 0) return;
    const cmd = (payload as { cmd?: unknown }).cmd as RenderCmd | undefined;
    try {
      if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') throw new Error('bad command');
      const result = await this.run(cmd);
      this.reply({ reqId, ok: true, result: plain(result) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.reply({ reqId, ok: false, error: msg.slice(0, 1000) });
    }
  }

  private async run(cmd: RenderCmd): Promise<unknown> {
    switch (cmd.type) {
      case 'detect':
        return this.detect();
      case 'current':
        return this.current();
      case 'goto':
        if (!Number.isInteger(cmd.index) || cmd.index < 0) throw new Error('goto: bad index');
        return this.goto(cmd.index);
      case 'settle':
        return this.settle();
      case 'collect':
        // Each node with the slide or block that contains it (review finding 35).
        await this.ensureModel();
        return this.walker.collect((n) => this.slideOf(n));
      case 'find':
        if (typeof cmd.needle !== 'string') throw new Error('find: bad needle');
        await this.ensureModel();
        return this.walker.find(cmd.needle, (n) => this.slideOf(n));
      case 'locate':
        if (!validLocator(cmd.locator)) throw new Error('locate: bad locator');
        await this.ensureModel();
        return this.walker.locate(cmd.locator, (n) => this.slideOf(n));
      case 'scroll-blocks':
        return this.scrollBlocks();
      case 'key':
        return this.key(cmd.key);
      case 'keydowns':
        return { trusted: this.keydowns.trusted, all: this.keydowns.all };
      case 'scroll-to':
        if (typeof cmd.y !== 'number' || !Number.isFinite(cmd.y) || cmd.y < 0) throw new Error('scroll-to: bad offset');
        return this.scrollTo(cmd.y);
      default:
        throw new Error(`unknown command ${(cmd as { type: string }).type}`);
    }
  }

  private slideOf(n: Node): number | null {
    return this.model && this.model.kind !== 'single' ? slideIndexOf(this.model, n) : null;
  }

  private async ensureModel(): Promise<SlideModel> {
    if (!this.model) await this.detect();
    return this.model!;
  }

  /** reveal.js `width`/`height` from Reveal.getConfig() in the main world, as untrusted numbers (6.9). */
  private async revealConfig(): Promise<{ width: number; height: number } | null> {
    if (!this.doc.querySelector('.reveal .slides')) return null;
    const code =
      '(function(){try{var R=window.Reveal;if(!R||typeof R.getConfig!=="function")return null;' +
      'var c=R.getConfig();return [Number(c.width),Number(c.height)];}catch(e){return null}})()';
    const r = await withTimeout(this.mainWorld.executeJavaScript(code), MAIN_WORLD_TIMEOUT_MS, null);
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [w, h] = r;
    if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    return { width: w, height: h };
  }

  async detect(): Promise<DetectResult> {
    const cfg = await this.revealConfig();
    this.model = detectSlides(this.doc, this.win, { revealConfig: cfg, hashFormat: this.hashFormat, host: null });
    if (this.model.hashFormat) this.hashFormat = this.model.hashFormat;
    return toDetectResult(this.model);
  }

  private async current(): Promise<CurrentResult> {
    const m = await this.ensureModel();
    const cur = currentSlide(m, this.win);
    m.current = cur;
    return {
      current: cur,
      count: m.count,
      hash: this.win.location.hash,
      scrollY: this.win.scrollY,
      reveal: m.revealIndices ? m.revealIndices[cur] ?? null : null,
    };
  }

  /** Waits up to 1 s for the current slide to become `index` (6.7). */
  private async waitFor(m: SlideModel, index: number): Promise<number> {
    const end = Date.now() + NAV_WAIT_MS;
    let cur = currentSlide(m, this.win);
    while (cur !== index && Date.now() < end) {
      await frame(this.win);
      await delay(16);
      cur = currentSlide(m, this.win);
    }
    m.current = cur;
    return cur;
  }

  private async goto(index: number): Promise<GotoResult> {
    const m = await this.ensureModel();
    if (index >= m.count) throw new Error(`goto: index ${index} outside 0..${m.count - 1}`);
    switch (m.navKind) {
      case 'reveal': {
        const pair = m.revealIndices?.[index];
        if (!pair) throw new Error('goto: no reveal indices');
        const [h, v] = pair;
        // Integers only are ever interpolated into main-world code.
        if (!Number.isInteger(h) || !Number.isInteger(v)) throw new Error('goto: bad reveal indices');
        const ok = await withTimeout(
          this.mainWorld.executeJavaScript(
            `(function(){try{if(!window.Reveal||typeof window.Reveal.slide!=="function")return false;window.Reveal.slide(${h},${v});return true;}catch(e){return false}})()`,
          ),
          MAIN_WORLD_TIMEOUT_MS,
          false,
        );
        const cur = await this.waitFor(m, index);
        return { navigated: ok === true && cur === index, current: cur, navKind: 'reveal', ...(ok === true ? {} : { reason: 'Reveal.slide unavailable' }) };
      }
      case 'hash': {
        const hash = m.hashes?.[index];
        if (!hash) throw new Error('goto: no hash for this slide');
        this.win.location.hash = hash;
        const cur = await this.waitFor(m, index);
        return { navigated: cur === index, current: cur, navKind: 'hash' };
      }
      case 'scroll': {
        const el = m.slides[index];
        el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
        await frame(this.win);
        const cur = currentSlide(m, this.win);
        m.current = cur;
        // The block is in view even when a later, short block counts as current.
        return { navigated: true, current: cur, navKind: 'scroll' };
      }
      case 'index': {
        const cur = currentSlide(m, this.win);
        m.current = cur;
        return { navigated: false, current: cur, navKind: 'index', reason: 'index' };
      }
      default:
        return { navigated: index === 0, current: 0, navKind: m.navKind };
    }
  }

  /**
   * 6.7 step 3: fonts.ready, two animation frames, then pause animations. Finite animations and transitions
   * already running (a slide's fade-in after `goto`) are first given up to 1.5 s to end, so the capture shows
   * the slide, not a frame of its transition; whatever still runs is then paused, and the pause sheet
   * (`*{animation-play-state:paused!important}`) is adopted into the document.
   */
  private async settle(): Promise<SettleResult> {
    const fonts = this.doc.fonts;
    const fontsReady = fonts ? await withTimeout(fonts.ready.then(() => true), FONTS_WAIT_MS, false) : true;
    await frame(this.win);
    await frame(this.win);
    const finite = this.doc.getAnimations().filter((a) => {
      try {
        const end = a.effect?.getComputedTiming().endTime;
        return a.playState === 'running' && typeof end === 'number' && Number.isFinite(end);
      } catch {
        return false;
      }
    });
    if (finite.length) await withTimeout(Promise.all(finite.map((a) => a.finished.catch(() => undefined))).then(() => true), FINITE_ANIMATION_WAIT_MS, false);
    // A render window is thrown away, so nothing is ever resumed here (the deck view's Edit pause resumes,
    // animation-pause.ts).
    const paused = pauseRunning(this.doc).length;
    const sheetAdopted = this.adoptPauseSheet();
    await frame(this.win);
    return { fontsReady, paused, sheetAdopted };
  }

  private adoptPauseSheet(): boolean {
    if (!this.pauseSheet) this.pauseSheet = makePauseSheet();
    return adoptSheet(this.doc, this.pauseSheet);
  }

  /**
   * Scrolls the document to `y` (review finding 34: a scrolling or single-page walk steps through the whole
   * document, and the probe replays a stop at the same offset). The page may clamp it.
   */
  private async scrollTo(y: number): Promise<ScrollToResult> {
    this.win.scrollTo({ left: 0, top: y, behavior: 'instant' as ScrollBehavior });
    await frame(this.win);
    const d = this.doc;
    const scrollHeight = Math.max(d.documentElement?.scrollHeight ?? 0, d.body?.scrollHeight ?? 0, this.win.innerHeight);
    return { scrollY: this.win.scrollY, innerHeight: this.win.innerHeight, scrollHeight };
  }

  private async scrollBlocks(): Promise<ScrollBlocksResult> {
    const m = await this.ensureModel();
    const blocks = m.kind === 'scroll' ? m.slides : scrollBlocks(this.doc, this.win, null);
    return {
      blocks: blocks.map((el, i) => {
        const r = el.getBoundingClientRect();
        return { index: i, cssPath: cssPath(el), title: slideTitle(el, i), top: Math.round(r.top + this.win.scrollY), height: Math.round(r.height) };
      }),
    };
  }

  /**
   * 6.7 Index replay fallback: a synthetic keydown and keyup on the focused element. A deck that ignores
   * untrusted keys does not move; the caller sees `current` unchanged and reports navOk: false.
   */
  private async key(key: string): Promise<KeyResult> {
    const codes: Record<string, string> = { ArrowRight: 'ArrowRight', ArrowLeft: 'ArrowLeft', PageDown: 'PageDown', PageUp: 'PageUp', ' ': 'Space' };
    const code = codes[key];
    if (!code) throw new Error('key: not a navigation key');
    const m = await this.ensureModel();
    const from = currentSlide(m, this.win);
    const target = this.doc.activeElement ?? this.doc.body ?? this.doc.documentElement;
    const keyCode = { ArrowRight: 39, ArrowLeft: 37, PageDown: 34, PageUp: 33, ' ': 32 }[key as 'ArrowRight'] ?? 0;
    const init: KeyboardEventInit = { key, code, bubbles: true, cancelable: true, composed: true, keyCode, which: keyCode } as KeyboardEventInit;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    const end = Date.now() + NAV_WAIT_MS;
    let cur = from;
    while (cur === from && Date.now() < end) {
      await frame(this.win);
      await delay(16);
      cur = currentSlide(m, this.win);
    }
    m.current = cur;
    return { dispatched: true, current: cur };
  }
}

function validLocator(l: unknown): l is NodeLocator {
  if (!l || typeof l !== 'object') return false;
  const o = l as NodeLocator;
  return (
    (o.stamp === null || (typeof o.stamp === 'string' && STAMP.test(o.stamp))) &&
    typeof o.cssPath === 'string' &&
    o.cssPath.length <= 8192 &&
    Number.isInteger(o.childIndex) &&
    o.childIndex >= 0
  );
}
