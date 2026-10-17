// The plain render of the render-parity gate (SPEC 10 Phase 1: "Blueline's render ... matches Chromium headless
// (same version, same viewport)"; docs/PHASE1-PLAN.md: "the same Electron's plain render of the original file
// (no protocol, no preload)"). One hidden offscreen BrowserWindow per deck, built like a render view (6.7:
// `show: false`, sized to the viewport, offscreen at the viewport's scale, enableLargerThanScreen) but plain:
// the original file's file:// URL, no preload, a fresh partition of its own with nothing installed in it (no
// blueline:// handler, no session policy), no IPC.
//
// So that both renders see the same slide after the same steps, the plain window is driven as the render
// service drives a render view (render-service RenderView, slide-index visitSlides):
// - motion: Emulation.setEmulatedMedia(prefers-reduced-motion: reduce) through the window's own debugger,
//   after an about:blank load, exactly as RenderView.applyMotion does for background renders;
// - navigation: reveal.js by Reveal.slide(h, v) in the page's world and then every fragment shown; generic
//   engines by the same trusted keys (sendInputEvent after focus(), Accelerator names) with the same 1 s wait
//   and the same patience (slide-index pressPatiently); the hash for slides keys do not reach; documents by the
//   same scrollIntoView of the section's heading;
// - which slide shows: the render agent's own 9.4 detection (core/slides), run in an isolated world
//   (plain-probe.ts), never the page's world;
// - settling and capture: RenderView's own probe methods (waitStable, pauseAnimations, visibleTextSignature,
//   scrollToHeading, showRevealFragments, setHash, capture), borrowed onto this window so the code is
//   literally the same.

import { BrowserWindow, type WebContents } from 'electron';
import { pathToFileURL } from 'node:url';
import type { SlideIndex } from '@blueline/core/ipc-render';
import { MAX_PRESSES } from '../../../packages/app/src/main/map-command';
import { emulatedMediaCommand } from '../../../packages/app/src/main/motion';
import { NAV_WAIT_MS, RenderView, acceleratorKeyFor, type KeyPress, type NavKey, type Viewport } from '../../../packages/app/src/main/render-service';
import { pressPatiently, type replayKeys } from '../../../packages/app/src/main/slide-index';

/** The isolated world of the plain window's slide detection (plain-probe.ts). */
export const PROBE_WORLD_ID = 1041;
/** The isolated world of the harness's own freeze and read-outs, on both renders. */
export const HARNESS_WORLD_ID = 1043;

/**
 * --seed-random (diagnosis): Math.random replaced, in the page's own world and before any page script, by a
 * seeded mulberry32 that starts from the same seed on every load. Both renders get it the same way, so a deck
 * that places or writes things at random does so identically in both, and what still differs is not the
 * deck's randomness.
 */
export const SEEDED_RANDOM_JS =
  '(function(){var a=0x2f6b1d35;Object.defineProperty(Math,"random",{configurable:true,writable:true,value:function random(){' +
  'a=(a+0x6d2b79f5)|0;var t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}})})();';

/**
 * Registers `source` to run in the page's world before any script of every later document of `wc`
 * (Page.addScriptToEvaluateOnNewDocument through the view's own debugger). A fresh webContents refuses debugger
 * commands until it has loaded something, so it first loads about:blank (as RenderView.applyMotion does).
 */
export async function addInitScript(wc: WebContents, source: string): Promise<void> {
  if (!wc.getURL()) await wc.loadURL('about:blank');
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Page.enable');
  await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source });
}

const LOAD_TIMEOUT_MS = 30_000;
const POLL_MS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * RenderView's probe methods bound to another window. They read `win`, `wc`, `viewport` and the log, and the
 * close tracking a render view sets up in its constructor: `closing` (isDestroyed) and `closed`, the promise
 * that long calls race so a closed view ends a walk at once (render-service.ts). The constructor is not run,
 * so nothing of a render view's own (preload, IPC, partition) is created; `closed` never settles here, as the
 * plain window outlives every call made on it (isDestroyed still reads the window itself).
 */
export function borrowRenderProbes(win: BrowserWindow, wc: WebContents, viewport: Viewport, log: (m: string) => void): RenderView {
  const p = Object.create(RenderView.prototype) as RenderView;
  Object.defineProperties(p, {
    win: { value: win },
    wc: { value: wc },
    viewport: { value: { ...viewport } },
    opts: { value: { log } },
    closing: { value: false },
    closed: { value: new Promise<never>(() => undefined) },
  });
  return p;
}

/**
 * The freeze step both renders get after 6.7 step 3 (fonts, two frames, finite animations, then pause): every
 * animation or transition still there is put in a fixed state, finite ones at their end (finish()), infinite
 * ones stopped at time 0, so an infinite animation shows the same frame in both. Returns how many it touched.
 */
export const FREEZE_JS =
  '(function(){var n=0;try{document.getAnimations().forEach(function(a){try{var t=a.effect&&a.effect.getComputedTiming();var e=t&&t.endTime;' +
  'if(typeof e==="number"&&isFinite(e)){if(a.playState!=="finished"){a.finish();n++}}else{a.pause();a.currentTime=0;n++}}catch(x){}})}catch(x){}return n})()';

/** Runs FREEZE_JS in the harness's world of `wc`, then waits two frames for it to paint. */
export async function freezeAnimations(wc: WebContents): Promise<number> {
  const r = await withTimeout<unknown>(wc.executeJavaScriptInIsolatedWorld(HARNESS_WORLD_ID, [{ code: FREEZE_JS }]), 3000, 0);
  await withTimeout(
    wc.executeJavaScriptInIsolatedWorld(HARNESS_WORLD_ID, [
      { code: 'new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(true)})});setTimeout(function(){r(false)},500)})' },
    ]),
    1000,
    false,
  );
  return typeof r === 'number' ? r : 0;
}

/** document.characterSet, read in the harness's world ('' when it cannot be read). */
export async function charsetOf(wc: WebContents): Promise<string> {
  const r = await withTimeout<unknown>(wc.executeJavaScriptInIsolatedWorld(HARNESS_WORLD_ID, [{ code: 'document.characterSet' }]), 2000, '');
  return typeof r === 'string' ? r.slice(0, 64) : '';
}

/** window.scrollY, read in the harness's world. */
export async function scrollYOf(wc: WebContents): Promise<number> {
  const r = await withTimeout<unknown>(wc.executeJavaScriptInIsolatedWorld(HARNESS_WORLD_ID, [{ code: 'window.scrollY' }]), 2000, -1);
  return typeof r === 'number' ? r : -1;
}

export interface PlainDetect {
  kind: string;
  count: number;
  current: number;
  navKind: string;
  designSize: { w: number; h: number };
}

/** One deck's plain render window. */
export class PlainView {
  readonly win: BrowserWindow;
  readonly wc: WebContents;
  readonly probe: RenderView;
  private cur = 0;
  private started = false;
  private key: NavKey;
  private presses = 0;
  detected: PlainDetect | null = null;

  constructor(
    private readonly file: string,
    readonly viewport: Viewport,
    partition: string,
    private readonly probeSrc: string,
    private readonly keys: ReturnType<typeof replayKeys>,
    private readonly log: (m: string) => void,
    private readonly diag: { seedRandom?: boolean } = {},
  ) {
    // RenderView's window, without its preload and its partition's handler and policy (9.1 render service).
    this.win = new BrowserWindow({
      show: false,
      width: viewport.w,
      height: viewport.h,
      useContentSize: true,
      enableLargerThanScreen: true,
      frame: false,
      skipTaskbar: true,
      focusable: true,
      webPreferences: {
        offscreen: { deviceScaleFactor: viewport.dpr },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition,
        backgroundThrottling: false,
        devTools: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
        webviewTag: false,
        spellcheck: false,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
      },
    });
    this.wc = this.win.webContents;
    this.wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.wc.on('will-prevent-unload', (e) => e.preventDefault());
    this.probe = borrowRenderProbes(this.win, this.wc, viewport, log);
    this.key = keys.forward;
  }

  /** about:blank, reduced motion (as RenderView.applyMotion), then the original file, settled (fonts, frames). */
  async loadPlain(): Promise<void> {
    if (!this.wc.getURL()) {
      await this.wc.loadURL('about:blank');
      if (this.diag.seedRandom) await addInitScript(this.wc, SEEDED_RANDOM_JS);
    }
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3');
    await this.wc.debugger.sendCommand('Emulation.setEmulatedMedia', emulatedMediaCommand(true));
    const url = pathToFileURL(this.file).href;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.wc.loadURL(url), new Promise<never>((_r, reject) => (timer = setTimeout(() => reject(new Error('plain load timed out')), LOAD_TIMEOUT_MS)))]);
    } finally {
      clearTimeout(timer);
    }
    await this.probe.waitStable();
  }

  /** loadPlain, then 9.4 detection, as visitSlides loads, settles and detects before it navigates. */
  async load(): Promise<PlainDetect> {
    await this.loadPlain();
    this.detected = await this.detect();
    this.cur = this.detected.current;
    this.started = false;
    this.presses = 0;
    this.key = this.keys.forward;
    return this.detected;
  }

  private async ensureProbe(): Promise<void> {
    const has = await withTimeout<unknown>(this.wc.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code: 'typeof globalThis.__blParityProbe' }]), 2000, null);
    if (has !== 'object') await this.wc.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code: this.probeSrc }]);
  }

  /** reveal.js width and height from the page's world (the render agent's revealConfig), as untrusted numbers. */
  private async revealConfig(): Promise<{ width: number; height: number } | null> {
    const has = await withTimeout<unknown>(this.wc.executeJavaScriptInIsolatedWorld(HARNESS_WORLD_ID, [{ code: '!!document.querySelector(".reveal .slides")' }]), 2000, false);
    if (has !== true) return null;
    const code = '(function(){try{var R=window.Reveal;if(!R||typeof R.getConfig!=="function")return null;var c=R.getConfig();return [Number(c.width),Number(c.height)];}catch(e){return null}})()';
    const r = await withTimeout<unknown>(this.wc.executeJavaScript(code), 2000, null);
    if (!Array.isArray(r) || r.length !== 2 || !r.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    return { width: r[0] as number, height: r[1] as number };
  }

  async detect(): Promise<PlainDetect> {
    await this.ensureProbe();
    const cfg = await this.revealConfig();
    const r = (await this.wc.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code: `globalThis.__blParityProbe.detect(${JSON.stringify(cfg)})` }])) as PlainDetect;
    return r;
  }

  async current(): Promise<number> {
    await this.ensureProbe();
    const r = await withTimeout<unknown>(this.wc.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code: 'globalThis.__blParityProbe.current()' }]), 2000, -1);
    return typeof r === 'number' ? r : -1;
  }

  /** RenderView's waitForChange: up to `ms` for the slide to differ from `from`, then settle and re-detect. */
  private async waitForChange(from: number, ms: number, settleMs: number | null): Promise<number> {
    const end = Date.now() + ms;
    let cur = await this.current();
    while (cur === from && Date.now() < end) {
      await sleep(POLL_MS);
      cur = await this.current();
    }
    if (settleMs === null) return cur;
    await this.probe.waitStable(settleMs);
    return (await this.detect()).current;
  }

  /**
   * RenderView.pressKey on trusted input (focus, keyDown and keyUp with the Accelerator name, up to 1 s for
   * the slide to change, settle). The plain window has no keydown counter, so `delivered` is unknown (null),
   * which pressPatiently treats as a render view whose keys arrive.
   */
  async pressKey(key: NavKey, opts: { settle?: boolean; settleMs?: number } = {}): Promise<KeyPress> {
    const settleMs = opts.settle === false ? null : (opts.settleMs ?? 1500);
    const from = settleMs === null ? await this.current() : (await this.detect()).current;
    const keyCode = acceleratorKeyFor(key);
    if (keyCode === null) throw new Error(`not a navigation key: ${key}`);
    this.wc.focus();
    this.wc.sendInputEvent({ type: 'keyDown', keyCode });
    this.wc.sendInputEvent({ type: 'keyUp', keyCode });
    const to = await this.waitForChange(from, NAV_WAIT_MS, settleMs);
    return { key, from, to, moved: to !== from, via: 'input', delivered: null, navOk: to !== from };
  }

  visibleTextSignature(): Promise<string> {
    return this.probe.visibleTextSignature();
  }

  /** visitSlides' waitForSlide: up to 1 s for slide `i`, then settle and re-detect. */
  private async waitForSlide(i: number): Promise<number> {
    const end = Date.now() + 1000;
    let cur = await this.current();
    while (cur !== i && Date.now() < end) {
      await sleep(POLL_MS);
      cur = await this.current();
    }
    await this.probe.waitStable();
    return (await this.detect()).current;
  }

  /** visitSlides' toFirstSlide: a generic deck that did not open on slide 1 goes there by hash, or back keys. */
  private async toFirst(index: SlideIndex): Promise<number> {
    const first = index.slides[0]?.nav;
    if (first && first.kind === 'hash' && typeof first.value === 'string' && (await this.probe.setHash(first.value))) {
      if ((await this.waitForSlide(0)) === 0) return 0;
    }
    let cur = (await this.detect()).current;
    for (let n = 0; cur !== 0 && n < Math.min(MAX_PRESSES, index.slides.length); n++) {
      const p = await pressPatiently(this, this.keys.back);
      if (!p.moved) break;
      cur = p.to;
    }
    return cur;
  }

  /** The agent's goto for reveal.js: Reveal.slide(h, v) in the page's world (integers only), then up to 1 s. */
  private async revealSlide(h: number, v: number, i: number): Promise<number> {
    if (!Number.isInteger(h) || !Number.isInteger(v)) return -1;
    await withTimeout(this.wc.executeJavaScript(`(function(){try{if(!window.Reveal||typeof window.Reveal.slide!=="function")return false;window.Reveal.slide(${h},${v});return true;}catch(e){return false}})()`), 2000, false);
    const end = Date.now() + NAV_WAIT_MS;
    let cur = await this.current();
    while (cur !== i && Date.now() < end) {
      await sleep(16);
      cur = await this.current();
    }
    return cur;
  }

  /** Scrolls to the top as the render agent's scroll-to does (instant, whatever the page's scroll-behavior). */
  private async scrollTop(): Promise<void> {
    await withTimeout(
      this.wc.executeJavaScriptInIsolatedWorld(HARNESS_WORLD_ID, [
        { code: 'new Promise(function(r){window.scrollTo({left:0,top:0,behavior:"instant"});requestAnimationFrame(function(){r(true)});setTimeout(function(){r(false)},250)})' },
      ]),
      2000,
      false,
    );
  }

  /**
   * Shows slide `i` as visitSlides showed it in Blueline's render view (in the same order: visitSlides visits
   * slides in the order the deck reaches them). Returns how it got there, or why not.
   */
  async goTo(i: number, index: SlideIndex): Promise<{ ok: boolean; how: string }> {
    const e = index.slides[i];
    if (!e) return { ok: false, how: 'no such slide' };
    if (index.kind === 'reveal') {
      const v = e.nav.value;
      if (!Array.isArray(v)) return { ok: false, how: 'no reveal indices' };
      const cur = await this.revealSlide(v[0], v[1], i);
      await this.probe.showRevealFragments(v[0], v[1]);
      if (cur === i || (await this.detect()).current === i) return { ok: true, how: 'reveal' };
      return { ok: false, how: `Reveal.slide showed slide ${cur + 1}` };
    }
    if (index.kind === 'generic') {
      if (!this.started) {
        this.started = true;
        if (this.cur !== 0) this.cur = await this.toFirst(index);
      }
      while (this.cur < i && this.presses < MAX_PRESSES) {
        let p = await pressPatiently(this, this.key);
        if (!p.moved && this.presses === 0 && this.keys.fallback && this.key !== this.keys.fallback) {
          this.key = this.keys.fallback;
          p = await pressPatiently(this, this.key);
        }
        if (!p.moved) break;
        this.presses++;
        this.cur = p.to;
      }
      if (this.cur === i) return { ok: true, how: 'keys' };
      if (e.nav.kind === 'hash' && typeof e.nav.value === 'string' && (await this.probe.setHash(e.nav.value))) {
        this.cur = await this.waitForSlide(i);
        if (this.cur === i) return { ok: true, how: 'hash' };
      }
      return { ok: false, how: `keys reached slide ${this.cur + 1}` };
    }
    if (typeof e.heading === 'number') {
      await this.probe.scrollToHeading(e.heading);
      return { ok: true, how: 'heading' };
    }
    await this.scrollTop();
    return { ok: true, how: 'top' };
  }

  /** printToPDF of the original file, with the options Blueline's PDF used (print CSS and documents). */
  async printToPDF(options: Electron.PrintToPDFOptions): Promise<Uint8Array> {
    const buf = await this.wc.printToPDF(options);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  close(): void {
    try {
      if (!this.wc.isDestroyed()) this.wc.close();
      if (!this.win.isDestroyed()) this.win.destroy();
    } catch (e) {
      this.log(`plain view: close failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}
