// The render service (6.7 Background renders; 9.1 Render service). Thumbnails, PDF pages, agent renders,
// before/after images and `blueline map` all render in hidden offscreen BrowserWindows:
//
// - `show: false`, sized to the viewport, `webPreferences.offscreen: { deviceScaleFactor }` (the viewport's
//   scale, 2 by default) and `enableLargerThanScreen`. Never a standalone offscreen WebContentsView: an
//   offscreen view takes its size from the window that owns it, so with no window it is 0×0 and
//   capturePage returns an empty image (6.7).
// - The document's own partition, so the partition's blueline:// handler and session policy (installed by
//   whoever owns the document: its DocWindow, or `blueline map`) apply as they do to the visible view; the
//   per-view policy (navigation, popups, webviews, WebRTC) is installed here on every render webContents.
// - The deck preload in `--bl-mode=render` (no UI, no key router). Main talks to it over
//   MainToDeck.renderRequest / DeckToMain.renderReply, and registers the webContents with the IPC guard as
//   kind `render`, so replies are accepted only from its main frame at `blueline://<docId>`.
// - At most 2 render windows per document (RenderPool).
//
// Keys (6.7 Index replay) are sent as trusted input with sendInputEvent after webContents.focus(), using
// Electron Accelerator names. Whether a key reached the deck is read from the render agent's keydown counter
// (RenderCmd keydowns), a window capture listener the preload registers before any page script, so a page
// cannot hide keys from it; if trusted keys do not reach the deck, the preload dispatches a synthetic
// KeyboardEvent, and a deck that ignores untrusted keys gets navOk: false. A trusted press that moved the deck
// never switches later presses to the fallback, and every load starts over (review finding 33).
//
// Later phases build on this module:
// - Phase 1: a RenderPool per open document for thumbnails, PDF pages and Find's text index, with the
//   viewport the visible view last reported and the stored Session.deckNav keys (acceleratorKeyFor); a
//   render waits until the document has had no write for 300 ms (6.7 step 1).
// - Phase 3: note screenshots capture the visible deck view itself (6.7 Note screenshots), not a render view.
// - Phase 4: agent renders replay `state.click` after slide.nav (6.7 step 2), measure Fit against the cached
//   pass-snapshot render served in place of the file (step 4), and return {fit, navOk} (step 5).

import { BrowserWindow, type NativeImage, type Rectangle, type WebContents } from 'electron';
import {
  MainToDeck,
  type CollectResult,
  type CurrentResult,
  type DetectResult,
  type FindResult,
  type GotoResult,
  type KeydownsResult,
  type KeyResult,
  type LocateResult,
  type NodeLocator,
  type RenderCmd,
  type RenderReply,
  type ScrollBlocksResult,
  type ScrollToResult,
  type SettleResult,
  type WalkBlock,
  type WalkNode,
  type WalkTree,
} from '@blueline/core/ipc';
import { TEXTS_MAX_CHARS, TEXTS_MAX_NODES } from '@blueline/core/dom-walk';
import type { DomTextNode } from '@blueline/core/types';
import { attachDeckView } from './channels';
import { validateDetectResult } from './ipc-guard';
import { deckUrl } from './protocol';
import { installDeckWebContentsPolicy } from './trust-hooks';

// ------------------------------------------------------------------------------------------- constants

export interface Viewport {
  w: number;
  h: number;
  dpr: number;
}

/** 6.7 step 1: the viewport the visible view last reported, or 1600×900 at 2x by default. */
export const DEFAULT_VIEWPORT: Readonly<Viewport> = Object.freeze({ w: 1600, h: 900, dpr: 2 });
/** 9.1 Render service: a pool of at most 2 render windows per document. */
export const POOL_LIMIT = 2;
/** 6.7 Index replay: after each key, wait up to 1 s for the visible slide to change. */
export const NAV_WAIT_MS = 1000;
/**
 * The isolated world main uses for its own read-only probes of a render view (a fonts/animations wait,
 * scrollTo). It is neither the page's world (0) nor the preload's (999), so the page can see none of it.
 * Electron accepts world ids 1..536870911.
 */
export const RENDER_WORLD_ID = 1029;

const LOAD_TIMEOUT_MS = 30_000;
/** Most walk nodes and blocks one collect reply may hold (as ipc-guard's IPC_LIMITS.walkNodes). */
const WALK_NODES_MAX = 200_000;
const REQUEST_TIMEOUT_MS = 15_000;
const COLLECT_TIMEOUT_MS = 60_000;
const POLL_MS = 40;

/** The navigation keys the render service presses (DOM `key` values, as Session.deckNav stores them). */
export type NavKey = 'ArrowRight' | 'ArrowLeft' | 'PageDown' | 'PageUp' | ' ';

/**
 * 6.7 Index replay: sendInputEvent's `keyCode` takes Electron Accelerator key names, not DOM `key` values:
 * ArrowRight → Right, ArrowLeft → Left, PageDown → PageDown, PageUp → PageUp, the space bar → Space.
 */
export const ACCELERATOR_KEY: Readonly<Record<NavKey, string>> = Object.freeze({
  ArrowRight: 'Right',
  ArrowLeft: 'Left',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  ' ': 'Space',
});

/** The Accelerator name for a stored deckNav key (also accepts 'Space' and 'Spacebar' for the space bar), or null. */
export function acceleratorKeyFor(domKey: string): string | null {
  if (domKey === 'Space' || domKey === 'Spacebar') return ACCELERATOR_KEY[' '];
  return Object.prototype.hasOwnProperty.call(ACCELERATOR_KEY, domKey) ? ACCELERATOR_KEY[domKey as NavKey] : null;
}

export function isNavKey(k: string): k is NavKey {
  return Object.prototype.hasOwnProperty.call(ACCELERATOR_KEY, k);
}

/** The pixel size capturePage must return for `rect` (CSS px) at the viewport's scale (6.7: 1600×900 at 2x is 3200×1800). */
export function expectedCaptureSize(vp: Viewport, rect?: { width: number; height: number }): { width: number; height: number } {
  const w = rect ? rect.width : vp.w;
  const h = rect ? rect.height : vp.h;
  return { width: Math.round(w * vp.dpr), height: Math.round(h * vp.dpr) };
}

export function validViewport(vp: Viewport): boolean {
  const ok = (n: number, max: number) => Number.isFinite(n) && n > 0 && n <= max;
  return ok(vp.w, 16_384) && ok(vp.h, 16_384) && ok(vp.dpr, 4) && Number.isInteger(vp.w) && Number.isInteger(vp.h);
}

// ------------------------------------------------------------------------------------------- result checks
// validateRenderReply has already rebuilt `result` as plain JSON; these check the shape each command
// promises before main relies on it. A render view is page-controlled, so a malformed result is an error.

class BadResult extends Error {}

function rec(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadResult(`${what}: not an object`);
  return v as Record<string, unknown>;
}
function int(v: unknown, what: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new BadResult(`${what}: not an integer`);
  return v;
}
function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadResult(`${what}: not a number`);
  return v;
}
function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new BadResult(`${what}: not a boolean`);
  return v;
}
function str(v: unknown, what: string, max = 64 * 1024): string {
  if (typeof v !== 'string' || v.length > max) throw new BadResult(`${what}: not a string`);
  return v;
}
function slideOrNull(v: unknown, what: string): number | null {
  return v === null ? null : int(v, what);
}
const STAMP = /^bl-[0-9]{1,9}$/;
function locatorOf(v: unknown, what: string): NodeLocator {
  const r = rec(v, what);
  const stamp = r.stamp === null ? null : str(r.stamp, `${what}.stamp`, 12);
  if (stamp !== null && !STAMP.test(stamp)) throw new BadResult(`${what}.stamp: bad stamp`);
  return { stamp, cssPath: str(r.cssPath, `${what}.cssPath`, 8192), childIndex: int(r.childIndex, `${what}.childIndex`, 0, 1_000_000) };
}
/**
 * DomTextNode.texts (decision D-b): a fresh array of at most TEXTS_MAX_NODES strings and TEXTS_MAX_CHARS of
 * text, else undefined. Never an error: without texts the matcher's step 1 falls through to step 2 (safe).
 */
function textsOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v) || v.length > TEXTS_MAX_NODES) return undefined;
  const out: string[] = [];
  let chars = 0;
  for (const t of v) {
    if (typeof t !== 'string') return undefined;
    chars += t.length;
    if (chars > TEXTS_MAX_CHARS) return undefined;
    out.push(t);
  }
  return out;
}
function domNodeOf(v: unknown, what: string): DomTextNode {
  const r = rec(v, what);
  const stamp = r.stamp === null ? null : str(r.stamp, `${what}.stamp`, 12);
  if (stamp !== null && !STAMP.test(stamp)) throw new BadResult(`${what}.stamp: bad stamp`);
  const out: DomTextNode = { stamp, textIndex: int(r.textIndex, `${what}.textIndex`, -1, 1_000_000), data: str(r.data, `${what}.data`, 1024 * 1024) };
  const texts = textsOf(r.texts);
  if (texts) out.texts = texts;
  if (r.touched === true) out.touched = true;
  if (r.tracked === true) out.tracked = true;
  if (r.touched === true && typeof r.stampedAncestor === 'string' && r.stampedAncestor.length <= 12 && STAMP.test(r.stampedAncestor)) {
    out.stampedAncestor = r.stampedAncestor;
  }
  return out;
}
const TREES: readonly WalkTree[] = ['document', 'shadow', 'frame'];
function treeOf(v: unknown, what: string): WalkTree | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !(TREES as readonly string[]).includes(v)) throw new BadResult(`${what}: not a tree`);
  return v as WalkTree;
}
function walkNodeOf(v: unknown, what: string): WalkNode {
  const r = rec(v, what);
  const rr = rec(r.rect, `${what}.rect`);
  const out: WalkNode = {
    key: int(r.key, `${what}.key`),
    locator: locatorOf(r.locator, `${what}.locator`),
    node: domNodeOf(r.node, `${what}.node`),
    rect: { x: num(rr.x, 'x'), y: num(rr.y, 'y'), w: num(rr.w, 'w'), h: num(rr.h, 'h') },
  };
  const tree = treeOf(r.tree, `${what}.tree`);
  if (tree) out.tree = tree;
  if (r.slide !== undefined) out.slide = slideOrNull(r.slide, `${what}.slide`);
  return out;
}
function keyList(v: unknown, what: string): number[] {
  if (!Array.isArray(v) || v.length > WALK_NODES_MAX) throw new BadResult(`${what}: not a list`);
  return v.map((k, i) => int(k, `${what}[${i}]`));
}

export const resultCheck = {
  current(v: unknown): CurrentResult {
    const r = rec(v, 'current');
    const rv = r.reveal;
    let reveal: [number, number] | null = null;
    if (rv !== null && rv !== undefined) {
      if (!Array.isArray(rv) || rv.length !== 2) throw new BadResult('current.reveal: not a pair');
      reveal = [int(rv[0], 'h'), int(rv[1], 'v')];
    }
    return { current: int(r.current, 'current.current'), count: int(r.count, 'current.count'), hash: str(r.hash, 'current.hash', 8192), scrollY: num(r.scrollY, 'current.scrollY'), reveal };
  },
  goto(v: unknown): GotoResult {
    const r = rec(v, 'goto');
    const out: GotoResult = { navigated: bool(r.navigated, 'goto.navigated'), current: int(r.current, 'goto.current'), navKind: str(r.navKind, 'goto.navKind', 16) as GotoResult['navKind'] };
    if (typeof r.reason === 'string') out.reason = r.reason.slice(0, 200);
    return out;
  },
  settle(v: unknown): SettleResult {
    const r = rec(v, 'settle');
    return { fontsReady: bool(r.fontsReady, 'settle.fontsReady'), paused: int(r.paused, 'settle.paused'), sheetAdopted: bool(r.sheetAdopted, 'settle.sheetAdopted') };
  },
  find(v: unknown): FindResult {
    const r = rec(v, 'find');
    if (!Array.isArray(r.matches)) throw new BadResult('find.matches: not an array');
    return {
      truncated: bool(r.truncated, 'find.truncated'),
      matches: r.matches.map((m, i) => {
        const mr = rec(m, `find.matches[${i}]`);
        const out: FindResult['matches'][number] = {
          key: int(mr.key, 'key'),
          locator: locatorOf(mr.locator, 'locator'),
          node: domNodeOf(mr.node, 'node'),
          visible: bool(mr.visible, 'visible'),
          slide: slideOrNull(mr.slide, 'slide'),
        };
        if (mr.clipped !== undefined) out.clipped = bool(mr.clipped, 'clipped');
        const tree = treeOf(mr.tree, 'tree');
        if (tree) out.tree = tree;
        return out;
      }),
    };
  },
  /**
   * `collect` (section 10 step 4), checked here rather than by ipc-guard's validateCollectResult so the walk's
   * optional fields reach the map: each node's texts (D-b), tree and slide, and the cross-origin frames.
   */
  collect(v: unknown): CollectResult {
    const r = rec(v, 'collect');
    if (!Array.isArray(r.nodes) || r.nodes.length > WALK_NODES_MAX) throw new BadResult('collect.nodes: not a list');
    if (!Array.isArray(r.blocks) || r.blocks.length > WALK_NODES_MAX) throw new BadResult('collect.blocks: not a list');
    const nodes = r.nodes.map((n, i) => walkNodeOf(n, `collect.nodes[${i}]`));
    const blocks: WalkBlock[] = r.blocks.map((b, i) => {
      const br = rec(b, `collect.blocks[${i}]`);
      return { key: int(br.key, `collect.blocks[${i}].key`), hasInline: bool(br.hasInline, `collect.blocks[${i}].hasInline`), nodeKeys: keyList(br.nodeKeys, `collect.blocks[${i}].nodeKeys`) };
    });
    const out: CollectResult = { nodes, blocks };
    if (r.crossOriginFrames !== undefined) out.crossOriginFrames = keyList(r.crossOriginFrames, 'collect.crossOriginFrames');
    return out;
  },
  keydowns(v: unknown): KeydownsResult {
    const r = rec(v, 'keydowns');
    return { trusted: int(r.trusted, 'keydowns.trusted'), all: int(r.all, 'keydowns.all') };
  },
  scrollTo(v: unknown): ScrollToResult {
    const r = rec(v, 'scroll-to');
    return { scrollY: num(r.scrollY, 'scroll-to.scrollY'), innerHeight: num(r.innerHeight, 'scroll-to.innerHeight'), scrollHeight: num(r.scrollHeight, 'scroll-to.scrollHeight') };
  },
  locate(v: unknown): LocateResult {
    const r = rec(v, 'locate');
    return {
      found: bool(r.found, 'locate.found'),
      node: r.node === null ? null : walkNodeOf(r.node, 'locate.node'),
      visible: bool(r.visible, 'locate.visible'),
      slide: slideOrNull(r.slide, 'locate.slide'),
    };
  },
  scrollBlocks(v: unknown): ScrollBlocksResult {
    const r = rec(v, 'scroll-blocks');
    if (!Array.isArray(r.blocks)) throw new BadResult('scroll-blocks.blocks: not an array');
    return {
      blocks: r.blocks.map((b, i) => {
        const br = rec(b, `blocks[${i}]`);
        return { index: int(br.index, 'index'), cssPath: str(br.cssPath, 'cssPath', 8192), title: str(br.title, 'title', 1024), top: num(br.top, 'top'), height: num(br.height, 'height') };
      }),
    };
  },
  key(v: unknown): KeyResult {
    const r = rec(v, 'key');
    return { dispatched: bool(r.dispatched, 'key.dispatched'), current: int(r.current, 'key.current') };
  },
};

function fromValidator<T>(v: { ok: true; value: T } | { ok: false; why: string }): T {
  if (!v.ok) throw new BadResult(v.why);
  return v.value;
}

// ------------------------------------------------------------------------------------------- RenderView

export class RenderError extends Error {
  override readonly name = 'RenderError';
}

export interface RenderTarget {
  docId: string;
  /** Basename served at blueline://<docId>/<fileName>. */
  fileName: string;
}

export interface RenderViewOptions {
  /** The document's session partition (9.1: same partition, protocol and trust policy as the document). */
  partition: string;
  /** dist/preload-deck.cjs */
  preload: string;
  viewport?: Viewport;
  /** realpath of the document's folder (the per-view policy's local-link rule). */
  folderReal: string;
  isProtected(): boolean;
  networkOpen(): boolean;
  log?(msg: string): void;
  /** Development builds may open devtools on a render view. Default false. */
  devTools?: boolean;
}

export interface ConsoleError {
  message: string;
  sourceId: string;
  line: number;
}

export interface KeyPress {
  key: NavKey;
  /** The current slide before and after (after waiting up to 1 s for a change). */
  from: number;
  to: number;
  moved: boolean;
  /** 'input': trusted sendInputEvent; 'synthetic': the preload's synthetic KeyboardEvent fallback. */
  via: 'input' | 'synthetic';
  /** The deck's document saw a trusted keydown (isolated-world counter), or null when that could not be read. */
  delivered: boolean | null;
  /**
   * False when the deck could only be reached with the synthetic fallback and ignored it, or when nothing
   * moved (6.7: "If a key changes nothing, it stops and sets navOk: false").
   */
  navOk: boolean;
}

export interface CaptureResult {
  image: NativeImage;
  width: number;
  height: number;
  expected: { width: number; height: number };
  /** 6.7 / Phase 0: the image has the viewport's size times its scale (1600×900 at 2x → 3200×1800). */
  sizeOk: boolean;
  empty: boolean;
}

export interface StableResult {
  fontsReady: boolean;
  /** Finite animations and transitions that were still running when the wait gave up. */
  stillRunning: number;
}

interface Pending {
  resolve(r: RenderReply): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * fonts.ready and two animation frames, then up to `maxMs` for finite animations and transitions to end
 * (a slide's entrance). Unlike the agent's `settle` it pauses nothing: the walk of `blueline map` goes on to
 * other slides, whose entrance animations must still run. Every wait is capped, so a page cannot stall it.
 */
function stableJs(maxMs: number): string {
  return (
    '(function(){var d=document,w=window;function t(ms){return new Promise(function(r){setTimeout(r,ms)})}' +
    'function f(){return new Promise(function(r){var done=false;w.requestAnimationFrame(function(){if(!done){done=true;r()}});setTimeout(function(){if(!done){done=true;r()}},250)})}' +
    'function running(){try{return d.getAnimations().filter(function(a){try{var e=a.effect&&a.effect.getComputedTiming().endTime;return a.playState==="running"&&typeof e==="number"&&isFinite(e)}catch(x){return false}})}catch(x){return []}}' +
    'var fonts=d.fonts?Promise.race([d.fonts.ready.then(function(){return true},function(){return false}),t(5000).then(function(){return false})]):Promise.resolve(true);' +
    'return fonts.then(function(ok){return f().then(f).then(function(){var a=running();' +
    `if(!a.length)return {fontsReady:ok,stillRunning:0};return Promise.race([Promise.all(a.map(function(x){return x.finished.catch(function(){})})),t(${Math.max(0, Math.floor(maxMs))})]).then(f).then(function(){return {fontsReady:ok,stillRunning:running().length}})` +
    '})})})()'
  );
}

/** One hidden offscreen render window. Create with RenderView.create; close with close(). */
export class RenderView {
  readonly win: BrowserWindow;
  readonly wc: WebContents;
  readonly viewport: Viewport;
  private target: RenderTarget | null = null;
  private registeredDocId: string | null = null;
  private nextReq = 1;
  private readonly pending = new Map<number, Pending>();
  private errors: ConsoleError[] = [];
  private gone: string | null = null;
  /**
   * Whether trusted input reaches this deck: null until a key press tells (6.7 Index replay, Phase 0 check).
   * Per load: load() forgets it.
   */
  trustedKeys: boolean | null = null;

  private constructor(private readonly opts: RenderViewOptions) {
    const vp = opts.viewport ?? DEFAULT_VIEWPORT;
    if (!validViewport(vp)) throw new RenderError('invalid viewport');
    this.viewport = { ...vp };
    this.win = new BrowserWindow({
      show: false,
      width: vp.w,
      height: vp.h,
      useContentSize: true,
      enableLargerThanScreen: true,
      frame: false,
      skipTaskbar: true,
      focusable: true,
      webPreferences: {
        offscreen: { deviceScaleFactor: vp.dpr },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: opts.partition,
        preload: opts.preload,
        additionalArguments: ['--bl-mode=render'],
        // A hidden page would otherwise get throttled timers and frames, and the walk would crawl.
        backgroundThrottling: false,
        devTools: opts.devTools === true,
        navigateOnDragDrop: false,
        // Nobody can answer alert() or confirm() in a hidden window: Electron would block the page, and
        // even app.exit, until the dialog closed (Phase 0 finding). With dialogs off they return at once.
        disableDialogs: true,
        webviewTag: false,
        spellcheck: false,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
      },
    });
    this.wc = this.win.webContents;
    this.wc.on('console-message', (e) => {
      if (e.level !== 'error') return;
      if (this.errors.length >= 1000) return;
      this.errors.push({ message: String(e.message).slice(0, 2000), sourceId: String(e.sourceId).slice(0, 2000), line: Number(e.lineNumber) || 0 });
    });
    // A load's errors start when its document commits: what the previous page logs while it unloads (a
    // blocked beforeunload prompt, a pagehide handler) belongs to that page, not to the new load.
    this.wc.on('did-navigate', () => {
      this.errors = [];
    });
    this.wc.on('render-process-gone', (_e, d) => {
      this.gone = d.reason;
      this.rejectAll(new RenderError(`the render process is gone (${d.reason})`));
    });
    this.wc.once('destroyed', () => this.rejectAll(new RenderError('the render view was closed')));
    // beforeunload cannot hold a render view open (installDeckWebContentsPolicy does the same per load).
    this.wc.on('will-prevent-unload', (e) => e.preventDefault());
  }

  static create(opts: RenderViewOptions): RenderView {
    return new RenderView(opts);
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  get loaded(): RenderTarget | null {
    return this.target;
  }

  /** Errors the page logged to the console since the current load started (section 10 Mutation probe step 4). */
  consoleErrors(): readonly ConsoleError[] {
    return this.errors;
  }

  isDestroyed(): boolean {
    return this.win.isDestroyed() || this.wc.isDestroyed();
  }

  private rejectAll(e: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(e);
    }
  }

  /** Registers this webContents with the IPC guard for `docId` (kind render) and installs the per-view policy. */
  private attach(docId: string): void {
    if (this.registeredDocId === docId) return;
    attachDeckView(this.wc, { docId, kind: 'render' }, { renderReply: (_from, r) => this.onReply(r) });
    installDeckWebContentsPolicy(this.wc, {
      docId,
      folderReal: this.opts.folderReal,
      isProtected: () => this.opts.isProtected(),
      networkOpen: () => this.opts.networkOpen(),
      // Nobody can click in a render view: links and popups are refused, never opened.
      onUserLink: () => undefined,
      openLocalHtml: () => undefined,
      onBlocked: (url, why) => this.log(`render view: navigation blocked (${why}): ${url.slice(0, 200)}`),
    });
    this.registeredDocId = docId;
  }

  private onReply(r: RenderReply): void {
    const p = this.pending.get(r.reqId);
    if (!p) return;
    this.pending.delete(r.reqId);
    clearTimeout(p.timer);
    p.resolve(r);
  }

  /** Loads a document of this view's partition. Resolves when the main frame finished loading. */
  async load(target: RenderTarget, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
    if (this.isDestroyed()) throw new RenderError('the render view was closed');
    this.attach(target.docId);
    // Replies from the previous document can never arrive now.
    this.rejectAll(new RenderError('the render view loaded another page'));
    this.errors = [];
    this.gone = null;
    this.target = target;
    // A new page: what the last one taught about keys does not carry over (review finding 33).
    this.trustedKeys = null;
    const url = deckUrl(target.docId, target.fileName);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.wc.loadURL(url),
        new Promise<never>((_r, reject) => {
          timer = setTimeout(() => reject(new RenderError(`loading ${target.fileName} timed out`)), timeoutMs);
        }),
      ]);
    } catch (e) {
      throw e instanceof RenderError ? e : new RenderError(`${target.fileName} could not be loaded: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sends one RenderCmd to the render agent and waits for its reply. Rejects on an error reply or timeout. */
  async request(cmd: RenderCmd, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.isDestroyed()) throw new RenderError('the render view was closed');
    if (this.gone) throw new RenderError(`the render process is gone (${this.gone})`);
    const reqId = this.nextReq++;
    const reply = await new Promise<RenderReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new RenderError(`render request ${cmd.type} timed out`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      this.wc.send(MainToDeck.renderRequest, { reqId, cmd });
    });
    if (!reply.ok) throw new RenderError(`render request ${cmd.type} failed: ${reply.error ?? 'error'}`);
    return reply.result;
  }

  private async checked<T>(cmd: RenderCmd, check: (v: unknown) => T, timeoutMs?: number): Promise<T> {
    const r = await this.request(cmd, timeoutMs);
    try {
      return check(r);
    } catch (e) {
      throw new RenderError(`render request ${cmd.type}: malformed result (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  detect(): Promise<DetectResult> {
    return this.checked({ type: 'detect' }, (v) => fromValidator(validateDetectResult(v)));
  }

  current(): Promise<CurrentResult> {
    return this.checked({ type: 'current' }, resultCheck.current);
  }

  goto(index: number): Promise<GotoResult> {
    return this.checked({ type: 'goto', index }, resultCheck.goto);
  }

  /** 6.7 step 3: fonts.ready, two animation frames, animations paused (the agent's `settle`). */
  settle(): Promise<SettleResult> {
    return this.checked({ type: 'settle' }, resultCheck.settle, 20_000);
  }

  collect(): Promise<CollectResult> {
    return this.checked({ type: 'collect' }, resultCheck.collect, COLLECT_TIMEOUT_MS);
  }

  find(needle: string): Promise<FindResult> {
    return this.checked({ type: 'find', needle }, resultCheck.find, COLLECT_TIMEOUT_MS);
  }

  locate(locator: NodeLocator): Promise<LocateResult> {
    return this.checked({ type: 'locate', locator }, resultCheck.locate);
  }

  scrollBlocks(): Promise<ScrollBlocksResult> {
    return this.checked({ type: 'scroll-blocks' }, resultCheck.scrollBlocks);
  }

  /** Runs `code` in main's own isolated world (RENDER_WORLD_ID), with a cap on how long it may take. */
  private async inProbeWorld<T>(code: string, timeoutMs: number, fallback: T): Promise<T> {
    if (this.isDestroyed()) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return (await Promise.race([
        this.wc.executeJavaScriptInIsolatedWorld(RENDER_WORLD_ID, [{ code }]),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), timeoutMs);
        }),
      ])) as T;
    } catch {
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Waits for the page to be still enough to read: fonts, two frames, and finite animations or transitions
   * (up to `maxMs`). Pauses nothing (see stableJs).
   */
  async waitStable(maxMs = 1500): Promise<StableResult> {
    const r = await this.inProbeWorld<unknown>(stableJs(maxMs), maxMs + 7000, null);
    if (r && typeof r === 'object') {
      const o = r as { fontsReady?: unknown; stillRunning?: unknown };
      return { fontsReady: o.fontsReady === true, stillRunning: typeof o.stillRunning === 'number' ? o.stillRunning : 0 };
    }
    return { fontsReady: false, stillRunning: 0 };
  }

  /** Scrolls the page to its top (scrolling documents: content above the first block, section 10 step 3). */
  async scrollToTop(): Promise<void> {
    await this.inProbeWorld('window.scrollTo(0,0);true', 2000, false);
  }

  /** Scrolls the document to `y` CSS px from its top, through the render agent (review finding 34). */
  scrollTo(y: number): Promise<ScrollToResult> {
    if (!Number.isFinite(y) || y < 0) throw new RenderError('invalid scroll offset');
    return this.checked({ type: 'scroll-to', y: Math.round(y) }, resultCheck.scrollTo);
  }

  /**
   * Sets CSS `zoom` on the page's root element, as the deck view's Fit does (6.9: "Fit uses a CSS zoom on the
   * deck view's root, set by the preload"; the Diagnostics Fit check compares it with setZoomFactor). A
   * CSSOM property write, never a style string.
   */
  async setRootZoom(zoom: number): Promise<boolean> {
    if (!Number.isFinite(zoom) || zoom <= 0 || zoom > 10) throw new RenderError('invalid zoom');
    const r = await this.inProbeWorld<unknown>(
      `(function(){var e=document.documentElement;if(!e)return false;e.style.setProperty("zoom",${JSON.stringify(String(zoom))});return true;})()`,
      2000,
      false,
    );
    return r === true;
  }

  /** `document.documentElement.dataset[name]` (a page's own test hooks, e.g. data-page-keys), or null. */
  async rootData(name: string): Promise<string | null> {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(name)) throw new RenderError('invalid data attribute name');
    const r = await this.inProbeWorld<unknown>(`(function(){var e=document.documentElement;var v=e&&e.dataset[${JSON.stringify(name)}];return typeof v==="string"?v:null;})()`, 2000, null);
    return typeof r === 'string' ? r : null;
  }

  /**
   * How many trusted keydowns the page's window has seen since this load: the render agent's counter, which
   * the preload registers before any page script (review finding 33). Null when it cannot be read.
   */
  async trustedKeydowns(): Promise<number | null> {
    try {
      return (await this.checked({ type: 'keydowns' }, resultCheck.keydowns)).trusted;
    } catch {
      return null;
    }
  }

  /** The current slide, re-detected (a deck that rebuilds its slides would leave a cached model stale). */
  private async currentSlide(): Promise<number> {
    return (await this.detect()).current;
  }

  /**
   * Waits up to `ms` for the current slide to differ from `from` (6.7: "waits up to 1 s for the visible slide
   * to change"), then lets the page settle and re-detects. The polling reads the agent's cached slide model:
   * re-detecting during a cross-fade can see two slides at once and pick another sibling set. The settled
   * re-detect afterwards also catches a deck that rebuilt its slide elements.
   */
  private async waitForChange(from: number, ms: number, settleMs: number | null): Promise<number> {
    const end = Date.now() + ms;
    let cur = (await this.current()).current;
    while (cur === from && Date.now() < end) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      cur = (await this.current()).current;
    }
    if (settleMs === null) return cur;
    await this.waitStable(settleMs);
    return this.currentSlide();
  }

  /**
   * 6.7 Index replay: presses one navigation key and waits up to 1 s for the visible slide to change.
   * Trusted input first (webContents.focus(), then sendInputEvent keyDown and keyUp with the Accelerator
   * name). If the page's document never saw a trusted keydown, trusted keys do not reach this offscreen
   * deck: the preload dispatches a synthetic KeyboardEvent instead, and a deck that ignores it gets
   * navOk: false.
   *
   * `settle: false` (a key in the middle of a replay) returns as soon as the slide changed, from the agent's
   * cached slide model, without waiting for the transition or re-detecting; the last key of a replay settles.
   */
  async pressKey(key: NavKey, opts: { settle?: boolean; settleMs?: number } = {}): Promise<KeyPress> {
    const settleMs = opts.settle === false ? null : (opts.settleMs ?? 1500);
    const from = settleMs === null ? (await this.current()).current : await this.currentSlide();
    const before = this.trustedKeys === false ? null : await this.trustedKeydowns();
    if (this.trustedKeys !== false) {
      const keyCode = ACCELERATOR_KEY[key];
      this.wc.focus();
      this.wc.sendInputEvent({ type: 'keyDown', keyCode });
      this.wc.sendInputEvent({ type: 'keyUp', keyCode });
      const to = await this.waitForChange(from, NAV_WAIT_MS, settleMs);
      const after = before === null ? null : await this.trustedKeydowns();
      const delivered = before === null || after === null ? null : after > before;
      if (to !== from) {
        // The deck moved on trusted input: trusted keys reach it. Never latch the synthetic fallback after a
        // press that moved the deck (review finding 33), whatever the counter read.
        this.trustedKeys = true;
        return { key, from, to, moved: true, via: 'input', delivered, navOk: true };
      }
      if (delivered !== null) this.trustedKeys = delivered;
      if (delivered !== false) return { key, from, to, moved: false, via: 'input', delivered, navOk: false };
      this.log('render view: trusted keys do not reach this offscreen deck; using synthetic keys');
    }
    // The agent waits up to 1 s for the slide to change after its synthetic key.
    await this.checked({ type: 'key', key }, resultCheck.key, NAV_WAIT_MS + REQUEST_TIMEOUT_MS);
    const to = await this.waitForChange(from, 0, settleMs);
    return { key, from, to, moved: to !== from, via: 'synthetic', delivered: false, navOk: to !== from };
  }

  /**
   * capturePage of the whole viewport or `rect` (CSS px), with the 6.7 size check: the image must be the
   * viewport (or rect) size times the scale.
   */
  async capture(rect?: Rectangle): Promise<CaptureResult> {
    if (this.isDestroyed()) throw new RenderError('the render view was closed');
    const image = await this.wc.capturePage(rect, { stayHidden: true });
    const size = image.getSize();
    const expected = expectedCaptureSize(this.viewport, rect);
    const sizeOk = size.width === expected.width && size.height === expected.height;
    if (!sizeOk) this.log(`render view: capture is ${size.width}×${size.height}, expected ${expected.width}×${expected.height}`);
    return { image, width: size.width, height: size.height, expected, sizeOk, empty: image.isEmpty() };
  }

  close(): void {
    this.rejectAll(new RenderError('the render view was closed'));
    if (!this.wc.isDestroyed()) this.wc.close();
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

// ------------------------------------------------------------------------------------------- RenderPool

/**
 * At most `limit` (2) render views of one document (9.1 Render service). acquire() hands out an idle view,
 * creates one while under the limit, or waits for a release; views are reused across requests.
 */
export class RenderPool {
  private readonly idle: RenderView[] = [];
  private readonly busy = new Set<RenderView>();
  private readonly waiters: ((v: RenderView) => void)[] = [];
  private closed = false;

  constructor(
    private readonly factory: () => RenderView,
    readonly limit: number = POOL_LIMIT,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > POOL_LIMIT) throw new RangeError(`a pool holds 1..${POOL_LIMIT} views`);
  }

  get size(): number {
    return this.idle.length + this.busy.size;
  }

  async acquire(): Promise<RenderView> {
    if (this.closed) throw new RenderError('the render pool is closed');
    let v = this.idle.pop();
    while (v && v.isDestroyed()) v = this.idle.pop();
    if (!v && this.size < this.limit) v = this.factory();
    if (v) {
      this.busy.add(v);
      return v;
    }
    return new Promise<RenderView>((resolve) => this.waiters.push(resolve));
  }

  release(v: RenderView): void {
    if (!this.busy.delete(v)) return;
    if (this.closed || v.isDestroyed()) {
      v.close();
      // A waiter gets a fresh view in place of the dead one.
      const w = this.closed ? undefined : this.waiters.shift();
      if (w) {
        const nv = this.factory();
        this.busy.add(nv);
        w(nv);
      }
      return;
    }
    const w = this.waiters.shift();
    if (w) {
      this.busy.add(v);
      w(v);
    } else this.idle.push(v);
  }

  /** acquire, run, release. */
  async use<T>(fn: (v: RenderView) => Promise<T>): Promise<T> {
    const v = await this.acquire();
    try {
      return await fn(v);
    } finally {
      this.release(v);
    }
  }

  close(): void {
    this.closed = true;
    for (const v of this.idle.splice(0)) v.close();
    for (const v of this.busy) v.close();
    this.busy.clear();
  }
}
