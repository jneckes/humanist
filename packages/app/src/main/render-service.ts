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
// - At most 2 render windows per document (DocumentRenderer, below).
//
// Keys (6.7 Index replay) are sent as trusted input with sendInputEvent after webContents.focus(), using
// Electron Accelerator names. Whether a key reached the deck is read from the render agent's keydown counter
// (RenderCmd keydowns), a window capture listener the preload registers before any page script, so a page
// cannot hide keys from it; if trusted keys do not reach the deck, the preload dispatches a synthetic
// KeyboardEvent, and a deck that ignores untrusted keys gets navOk: false. A trusted press that moved the deck
// never switches later presses to the fallback, and every load starts over (review finding 33).
//
// Phase 1 (render products: thumbnails, the slide index, Find's text, PDF pages and Print) renders through a
// DocumentRenderer per open document (at the end of this module): at most two render windows, each sized to
// its job's viewport, with reduced motion; the stored Session.deckNav keys are pressed (acceleratorKeyFor,
// ArrowDown and ArrowUp included), and a render waits until the document has had no write for 300 ms (6.7
// step 1, noteDocumentWrite). The products themselves are slide-index.ts, thumbnails.ts, find.ts, pdf.ts and
// print.ts.
//
// Later phases build on this module:
// - Phase 3: note screenshots capture the visible deck view itself (6.7 Note screenshots), not a render view.
// - Phase 4: agent renders replay `state.click` after slide.nav (6.7 step 2), measure Fit against the cached
//   pass-snapshot render served in place of the file (step 4), and return {fit, navOk} (step 5).

import { createHash } from 'node:crypto';
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
import { TEXTS_MAX_CHARS, TEXTS_MAX_NODES, type CollectJoins } from '@blueline/core/dom-walk';
import type { DomTextNode } from '@blueline/core/types';
import { attachDeckView } from './channels';
import { validateDetectResult } from './ipc-guard';
import { emulatedMediaCommand } from './motion';
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
/** How often waitScripted reads the time since the page's last DOM mutation. */
const SCRIPTED_POLL_MS = 100;

/** The keys 6.7 Index replay names (DOM `key` values); the render agent's synthetic fallback knows these. */
export type AgentNavKey = 'ArrowRight' | 'ArrowLeft' | 'PageDown' | 'PageUp' | ' ';
/**
 * The navigation keys the render service presses (DOM `key` values, as Session.deckNav stores them). The
 * visible view also records ArrowDown and ArrowUp (ipc-guard DECK_NAV_KEYS), so Index replay presses them too
 * (PHASE0-FINDINGS Still open, "Index replay keys").
 */
export type NavKey = AgentNavKey | 'ArrowDown' | 'ArrowUp';

/**
 * 6.7 Index replay: sendInputEvent's `keyCode` takes Electron Accelerator key names, not DOM `key` values:
 * ArrowRight → Right, ArrowLeft → Left, PageDown → PageDown, PageUp → PageUp, the space bar → Space.
 */
export const ACCELERATOR_KEY: Readonly<Record<AgentNavKey, string>> = Object.freeze({
  ArrowRight: 'Right',
  ArrowLeft: 'Left',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  ' ': 'Space',
});

/** The vertical arrows, which Session.deckNav may hold since Phase 0's review: ArrowDown → Down, ArrowUp → Up. */
export const VERTICAL_ACCELERATOR_KEY: Readonly<Record<'ArrowDown' | 'ArrowUp', string>> = Object.freeze({
  ArrowDown: 'Down',
  ArrowUp: 'Up',
});

function ownKey<T extends object>(o: T, k: string): k is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** The Accelerator name for a stored deckNav key (also accepts 'Space' and 'Spacebar' for the space bar), or null. */
export function acceleratorKeyFor(domKey: string): string | null {
  if (domKey === 'Space' || domKey === 'Spacebar') return ACCELERATOR_KEY[' '];
  if (ownKey(ACCELERATOR_KEY, domKey)) return ACCELERATOR_KEY[domKey];
  if (ownKey(VERTICAL_ACCELERATOR_KEY, domKey)) return VERTICAL_ACCELERATOR_KEY[domKey];
  return null;
}

export function isNavKey(k: string): k is NavKey {
  return ownKey(ACCELERATOR_KEY, k) || ownKey(VERTICAL_ACCELERATOR_KEY, k);
}

/** A key the render agent can also dispatch as a synthetic KeyboardEvent (RenderCmd key). */
export function isAgentNavKey(k: string): k is AgentNavKey {
  return ownKey(ACCELERATOR_KEY, k);
}

/**
 * The NavKey for a stored Session.deckNav value ('Space' and 'Spacebar' mean the space bar), or null when the
 * render service cannot press it. Session.deckNav is the visible view's record (ipc-guard checked it against
 * DECK_NAV_KEYS); anything else falls back to the 6.7 defaults.
 */
export function navKeyFor(domKey: string | null | undefined): NavKey | null {
  if (typeof domKey !== 'string') return null;
  if (domKey === 'Space' || domKey === 'Spacebar') return ' ';
  return isNavKey(domKey) ? domKey : null;
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
  // review finding 12: whether the node's white-space preserves line breaks (the index text splits runs there).
  if (r.pre !== undefined) out.pre = bool(r.pre, `${what}.pre`);
  return out;
}
function keyList(v: unknown, what: string): number[] {
  if (!Array.isArray(v) || v.length > WALK_NODES_MAX) throw new BadResult(`${what}: not a list`);
  return v.map((k, i) => int(k, `${what}[${i}]`));
}

export const resultCheck = {
  /**
   * `detect`: ipc-guard's validateDetectResult, plus the per-slide hashes and ids it leaves out (SlideRef.nav
   * of a hash-routed deck, 9.4 step 2; the render products need them). Each list is kept only when it has
   * one entry per slide.
   */
  detect(v: unknown): DetectResult {
    const out = fromValidator(validateDetectResult(v));
    const r = rec(v, 'detect');
    // Never an error: a list with one bad entry is dropped whole (a hash deck then navigates by keys).
    if (Array.isArray(r.hashes) && r.hashes.length === out.count && r.hashes.every((h) => typeof h === 'string' && h.startsWith('#') && h.length <= 2048)) {
      out.hashes = (r.hashes as string[]).slice();
    }
    if (Array.isArray(r.ids) && r.ids.length === out.count && r.ids.every((id) => id === null || (typeof id === 'string' && id.length <= 1024))) {
      out.ids = (r.ids as (string | null)[]).slice();
    }
    return out;
  },
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
  collect(v: unknown): CollectResult & CollectJoins {
    const r = rec(v, 'collect');
    if (!Array.isArray(r.nodes) || r.nodes.length > WALK_NODES_MAX) throw new BadResult('collect.nodes: not a list');
    if (!Array.isArray(r.blocks) || r.blocks.length > WALK_NODES_MAX) throw new BadResult('collect.blocks: not a list');
    const nodes = r.nodes.map((n, i) => walkNodeOf(n, `collect.nodes[${i}]`));
    const blocks: WalkBlock[] = r.blocks.map((b, i) => {
      const br = rec(b, `collect.blocks[${i}]`);
      return { key: int(br.key, `collect.blocks[${i}].key`), hasInline: bool(br.hasInline, `collect.blocks[${i}].hasInline`), nodeKeys: keyList(br.nodeKeys, `collect.blocks[${i}].nodeKeys`) };
    });
    const out: CollectResult & CollectJoins = { nodes, blocks };
    if (r.crossOriginFrames !== undefined) out.crossOriginFrames = keyList(r.crossOriginFrames, 'collect.crossOriginFrames');
    // The slide index's block joins (dom-walk CollectJoins): kept only whole and well formed, else dropped
    // (each node then starts a string of its own; never an error).
    if (Array.isArray(r.joins) && r.joins.length === nodes.length && r.joins.every((j) => j === 0 || j === 1 || j === 2)) out.joins = (r.joins as (0 | 1 | 2)[]).slice();
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
  override readonly name: string = 'RenderError';
}

/** What RenderView.load serves: blueline://<docId>/<fileName>, through the partition's protocol handler. */
export interface LoadTarget {
  docId: string;
  /** Basename served at blueline://<docId>/<fileName>. */
  fileName: string;
}

/**
 * What a background render needs from a document (docs/PHASE1-PLAN.md render-products): its partition and
 * docId (9.1: the render views use the document's partition, protocol, preload and trust policy), the file it
 * serves, its version (the cache key), its trust policy, the reduced-motion choice and the viewport the
 * visible view last reported. renderTargetFor builds one from a BlDocument.
 */
export interface RenderTarget extends LoadTarget {
  partition: string;
  /** realpath of the document's folder (the per-view policy's local-link rule). */
  folderReal: string;
  /** realpath of the document (derived files keep its marker, 9.9). */
  realpath: string;
  /** 9.7: first 16 hex of sha256(realpath); thumbnails and the index cache live under files/<fileKey>/thumbs/. */
  fileKey: string;
  /** sha256 hex of the bytes the document is served from (BlDocument.version). */
  version: string;
  /** The `<title>` as read from the file (BlDocument.title); the rendered document.title wins when it has one. */
  title: string;
  /** The internet marker the document opened with (BlDocument.marker), for derived files (9.9). */
  marker: string | null;
  isProtected(): boolean;
  networkOpen(): boolean;
  /** Background renders use reduced motion, so a still image shows a slide's final frame (Josh, 2026-10-17). */
  reducedMotion: boolean;
  /**
   * The viewport the visible view last reported (6.7 step 1), for renders of what the user sees (agent renders,
   * Phase 4). The render products render at the 6.9 design size instead (decks: what Fit shows; documents and
   * the index walk: 1600×900), at 2x.
   */
  viewport?: Viewport | null;
  /** Session.deckNav: the keys the visible view saw move this deck (6.7 Index replay). */
  deckNav?: { forward?: string; back?: string } | null;
  /**
   * A tag of the trust policy this render runs under (whether the network is open, the strict option and the
   * allowlist), for the product cache (review finding 15): products made under one policy are not served under
   * another, even across launches, because the file's bytes (the sha256 cache key) do not change with it.
   */
  renderPolicyTag(): string;
}

/** The policy tag the product cache keys on (review finding 15): network open, the strict option, the allowlist. */
export function renderPolicyTag(net: boolean, strict: boolean, allowlist: readonly string[]): string {
  const h = createHash('sha256');
  h.update(JSON.stringify([net, strict, [...allowlist].sort()]));
  return `${net ? 'n1' : 'n0'}${strict ? 's1' : 's0'}${h.digest('hex').slice(0, 12)}`;
}

/** The parts of a BlDocument a RenderTarget reads (documents.ts; kept structural so tests can pass fakes). */
export interface RenderableDocument extends LoadTarget {
  partition: string;
  folderReal: string;
  realpath: string;
  fileKey: string;
  version: string;
  title: string;
  marker: string | null;
  trust(): 'protected' | 'trusted';
  networkAllowed(): boolean;
  /** The strict option (6.10 Settings › Trust) in force for this document; default off when not given. */
  strict?(): boolean;
  /** The allowlist in force for this document; default empty when not given. */
  allowlist?(): readonly string[];
}

/** A RenderTarget for a document, with background renders' reduced motion (decision 1, Josh 2026-10-17). */
export function renderTargetFor(
  doc: RenderableDocument,
  opts: { viewport?: Viewport | null; deckNav?: { forward?: string; back?: string } | null; reducedMotion?: boolean } = {},
): RenderTarget {
  const networkOpen = () => doc.trust() === 'trusted' || doc.networkAllowed();
  return {
    docId: doc.docId,
    fileName: doc.fileName,
    partition: doc.partition,
    folderReal: doc.folderReal,
    realpath: doc.realpath,
    fileKey: doc.fileKey,
    version: doc.version,
    title: doc.title,
    marker: doc.marker,
    isProtected: () => doc.trust() === 'protected',
    networkOpen,
    renderPolicyTag: () => renderPolicyTag(networkOpen(), doc.strict?.() ?? false, doc.allowlist?.() ?? []),
    reducedMotion: opts.reducedMotion ?? true,
    viewport: opts.viewport ?? null,
    deckNav: opts.deckNav ?? null,
  };
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
  /**
   * Emulate `prefers-reduced-motion: reduce` on every load (background renders, Josh's decision 1 of
   * 2026-10-17), through the view's own debugger as motion.ts does for the deck view. Default false
   * (`blueline map` sets the Chromium switch instead).
   */
  reducedMotion?: boolean;
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
  private target: LoadTarget | null = null;
  /** Reduced motion is emulated on this view (it lasts while the debugger stays attached, across loads). */
  private motionReduced = false;
  private registeredDocId: string | null = null;
  private nextReq = 1;
  private readonly pending = new Map<number, Pending>();
  /**
   * Rejects when the view is closed or destroyed. Calls into Chromium that have no timeout of their own
   * (capturePage, printToPDF, loadURL) race it, so a job that disposeRenderer cut off settles, and frees what
   * its closures hold, instead of waiting forever on a destroyed webContents (the views item saw a closed
   * window's walk keep its document in memory). The exit-gate harness borrows the probe methods for a plain
   * window and gives them `closed` and `closing` of their own (test/parity/harness/plain-view.ts).
   */
  private readonly closed: Promise<never>;
  private closeWith: (e: Error) => void = () => undefined;
  /**
   * Set by close() and 'destroyed'. From then on isDestroyed() is true, so nothing touches the webContents
   * again (a navigation, a debugger attach or input sent to a closing webContents can take main down with it).
   */
  private closing = false;
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
    this.closed = new Promise<never>((_resolve, reject) => {
      this.closeWith = reject;
    });
    // Nobody may be racing it when it rejects.
    this.closed.catch(() => undefined);
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
    this.wc.once('destroyed', () => {
      this.closing = true;
      const e = this.closedError();
      this.rejectAll(e);
      this.closeWith(e);
    });
    // beforeunload cannot hold a render view open (installDeckWebContentsPolicy does the same per load).
    this.wc.on('will-prevent-unload', (e) => e.preventDefault());
  }

  static create(opts: RenderViewOptions): RenderView {
    return new RenderView(opts);
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  get loaded(): LoadTarget | null {
    return this.target;
  }

  /** The view emulates prefers-reduced-motion: reduce (RenderViewOptions.reducedMotion took effect). */
  get reducedMotion(): boolean {
    return this.motionReduced;
  }

  /** Errors the page logged to the console since the current load started (section 10 Mutation probe step 4). */
  consoleErrors(): readonly ConsoleError[] {
    return this.errors;
  }

  isDestroyed(): boolean {
    return this.closing || this.win.isDestroyed() || this.wc.isDestroyed();
  }

  /**
   * A closed view (close(), or its webContents destroyed) ends whatever its job does as cancelled: every method
   * rejects with RenderCancelled from then on, whatever the call into Chromium answered meanwhile. A render
   * process that is gone is a failure (RenderError), not a close.
   */
  private closedError(): RenderCancelled {
    return new RenderCancelled('the render view was closed');
  }

  /** `p`, or a rejection as soon as the view is closed (see `closed`); a call that fails on a closed view is cancelled. */
  private async whileOpen<T>(p: Promise<T>): Promise<T> {
    try {
      return await Promise.race([p, this.closed]);
    } catch (e) {
      if (this.isDestroyed()) throw this.closedError();
      throw e;
    }
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

  /**
   * Sends one DevTools protocol command through this view's own debugger (main-process only: nothing is
   * exposed to the page and no port is opened; motion.ts does the same for the deck view).
   */
  async cdp<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
    if (this.isDestroyed()) throw this.closedError();
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return (await Promise.race([
        this.whileOpen(this.wc.debugger.sendCommand(method, params)),
        new Promise<never>((_r, reject) => {
          timer = setTimeout(() => reject(new RenderError(`${method} timed out`)), timeoutMs);
        }),
      ])) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Emulates prefers-reduced-motion: reduce before the first load. A fresh webContents refuses
   * Emulation.setEmulatedMedia ("target closed while handling command"), so it first loads about:blank; the
   * emulation then holds across the cross-origin load of the deck (Phase 1 finding). Best effort: when the
   * debugger cannot attach (devtools open), the render keeps the deck's motion and says so.
   */
  private async applyMotion(): Promise<void> {
    if (!this.opts.reducedMotion || this.motionReduced) return;
    try {
      if (!this.wc.getURL()) await this.whileOpen(this.wc.loadURL('about:blank'));
      await this.cdp('Emulation.setEmulatedMedia', emulatedMediaCommand(true));
      this.motionReduced = true;
    } catch (e) {
      if (this.isDestroyed()) throw this.closedError();
      this.log(`render view: reduced motion not applied (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /** Loads a document of this view's partition. Resolves when the main frame finished loading. */
  async load(target: LoadTarget, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
    if (this.isDestroyed()) throw this.closedError();
    await this.applyMotion();
    if (this.isDestroyed()) throw this.closedError();
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
        this.whileOpen(this.wc.loadURL(url)),
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
    if (this.isDestroyed()) throw this.closedError();
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
    return this.checked({ type: 'detect' }, resultCheck.detect);
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

  collect(): Promise<CollectResult & CollectJoins> {
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

  /**
   * Runs `code` in main's own isolated world (RENDER_WORLD_ID), with a cap on how long it may take: `fallback`
   * when the probe fails or times out on a live view. On a closed view it rejects with RenderCancelled, before the
   * probe or as soon as the view closes during it: a fallback must never stand for the page's answer when the
   * view went away (overlayMounted's fallback is "mounted", which made a PDF cancelled by its document's close
   * fail with "a render view showed the overlay").
   */
  private async inProbeWorld<T>(code: string, timeoutMs: number, fallback: T): Promise<T> {
    if (this.isDestroyed()) throw this.closedError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let r: T;
    try {
      r = (await Promise.race([
        this.wc.executeJavaScriptInIsolatedWorld(RENDER_WORLD_ID, [{ code }]),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), timeoutMs);
        }),
        // A closed view ends the probe at once, so a walk that disposeRenderer cut off ends now, not at the timeout.
        this.closed,
      ])) as T;
    } catch {
      r = fallback;
    } finally {
      clearTimeout(timer);
    }
    if (this.isDestroyed()) throw this.closedError();
    return r;
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
      const keyCode = acceleratorKeyFor(key);
      if (keyCode === null) throw new RenderError(`not a navigation key: ${JSON.stringify(key).slice(0, 20)}`);
      if (this.isDestroyed()) throw this.closedError();
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
    // The agent's synthetic fallback knows the 6.7 keys only (RenderCmd key): a deck that moves on the
    // vertical arrows alone and refuses trusted input cannot be replayed.
    if (!isAgentNavKey(key)) return { key, from, to: from, moved: false, via: 'synthetic', delivered: false, navOk: false };
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
    if (this.isDestroyed()) throw this.closedError();
    const image = await this.whileOpen(this.wc.capturePage(rect, { stayHidden: true }));
    const size = image.getSize();
    const expected = expectedCaptureSize(this.viewport, rect);
    const sizeOk = size.width === expected.width && size.height === expected.height;
    if (!sizeOk) this.log(`render view: capture is ${size.width}×${size.height}, expected ${expected.width}×${expected.height}`);
    return { image, width: size.width, height: size.height, expected, sizeOk, empty: image.isEmpty() };
  }

  // ----------------------------------------------------------------------------------- render products
  // Read-only probes in main's own isolated world (RENDER_WORLD_ID), as waitStable does: the page sees none
  // of them, and only numbers or JSON-encoded strings are ever put into the code.

  /** The rendered document.title (whitespace collapsed, as the HTML spec's getter does), or ''. */
  async documentTitle(): Promise<string> {
    const r = await this.inProbeWorld<unknown>('(function(){var t=document.title;return typeof t==="string"?t.slice(0,4096):""})()', 2000, '');
    return typeof r === 'string' ? r : '';
  }

  /**
   * 6.9 Save as PDF / Print: whether the deck preload mounted its overlay here. Render mode has no UI (6.7),
   * so this is false on every render view; PDFs and prints refuse a view where it is not. A probe that cannot
   * answer on a live view counts as mounted (when unsure, refuse); a view closed before or during the probe
   * rejects with RenderCancelled (inProbeWorld).
   */
  async overlayMounted(): Promise<boolean> {
    const r = await this.inProbeWorld<unknown>('(function(){return !!document.querySelector("blueline-overlay")})()', 2000, true);
    return r !== false;
  }

  /**
   * 6.7 step 3 for a render that goes on to other slides: fonts, two frames and finite animations as
   * waitStable, then pauses what still runs (infinite animations) without the agent's pause sheet, which
   * would also freeze the next slide's entrance at its first frame. resumeAnimations undoes it.
   */
  async pauseAnimations(): Promise<number> {
    const r = await this.inProbeWorld<unknown>(
      '(function(){var w=window,n=0;w.__blPaused=[];try{document.getAnimations().forEach(function(a){if(a.playState==="running"){a.pause();w.__blPaused.push(a);n++}})}catch(e){}return n})()',
      2000,
      0,
    );
    return typeof r === 'number' ? r : 0;
  }

  /**
   * 6.7 step 3 for a still image of a slide (thumbnails, raster PDF pages, Print): waits until the page has
   * shown what its scripts reveal after the slide arrives. Fonts, frames and finite animations (waitStable) do
   * not cover a build a script starts on a timer (a `setTimeout` reveal, a typewriter), so a capture taken at
   * once missed it (docs/PHASE1-RESULTS.md, D5 and test/parity/fixtures/delayed-build.html). It stays at least
   * `minMs` on the slide, then until the DOM has had no mutation for `quietMs` (a MutationObserver in main's
   * own isolated world: the page sees nothing), and never longer than `maxMs`: a deck that writes a clock or
   * a ticker forever is captured at the cap. Resolves with how long it waited and whether the DOM went quiet.
   *
   * `late` (for the adaptive settle, slide-index.ts SettleMemory) says a wait with no minimum could have
   * stopped too early here: the DOM changed again after being still for `lateGapMs` (a timer's reveal), or
   * the picture still changed while the DOM was still (a chart a script draws on a canvas, which no
   * MutationObserver sees: two small frames, at that pause and at the end, differ; `watchFrames`, default on).
   * `stamp` is the page time of the last mutation seen (mutationStamp).
   */
  async waitScripted(
    opts: { minMs: number; quietMs: number; maxMs: number; lateGapMs?: number; watchFrames?: boolean },
    signal: AbortSignal | null = null,
  ): Promise<{ waitedMs: number; quiet: boolean; late: boolean; stamp: number | null }> {
    const start = Date.now();
    const installed = await this.inProbeWorld<unknown>(
      '(function(){var w=window;if(!w.__blMut){var m={last:performance.now()};w.__blMut=m;try{new MutationObserver(function(){m.last=performance.now()}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true})}catch(e){}}return true})()',
      2000,
      false,
    );
    // `late` (the adaptive settle, slide-index.ts SettleMemory): the DOM changed again after it had been still
    // for lateGapMs, the mark of a script that reveals content on a timer. A wait with no minimum could have
    // stopped at that pause and missed what came after it.
    const lateGap = opts.lateGapMs ?? Math.floor(opts.quietMs / 2);
    let pausedAt: number | null = null;
    let late = false;
    let stamp: number | null = null;
    const read = async (): Promise<{ since: number; last: number } | null> => {
      if (installed !== true) return null;
      const r = await this.inProbeWorld<unknown>('(function(){var m=window.__blMut;return m?[performance.now()-m.last,m.last]:null})()', 2000, null);
      return Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number' ? { since: r[0], last: r[1] } : null;
    };
    const watch = opts.watchFrames !== false;
    let frame0: Uint8Array | null = null;
    for (;;) {
      throwIfCancelled(signal);
      const waited = Date.now() - start;
      if (waited >= opts.maxMs || this.isDestroyed()) return { waitedMs: waited, quiet: false, late, stamp };
      const m = await read();
      if (m) {
        stamp = m.last;
        if (pausedAt !== null && m.last > pausedAt) late = true;
        if (pausedAt === null && m.since >= lateGap) {
          pausedAt = m.last;
          if (watch) frame0 = await this.frameSample();
        }
      }
      if (waited >= opts.minMs && (m ? m.since >= opts.quietMs : installed !== true)) {
        if (watch && !late && pausedAt !== null && framesDiffer(frame0, await this.frameSample())) late = true;
        return { waitedMs: Date.now() - start, quiet: true, late, stamp };
      }
      await new Promise((r) => setTimeout(r, SCRIPTED_POLL_MS));
    }
  }

  /** A small copy of the view's current frame (64 px wide, BGRA) for framesDiffer, or null when none. */
  private async frameSample(): Promise<Uint8Array | null> {
    try {
      if (this.isDestroyed()) return null;
      const image = await this.whileOpen(this.wc.capturePage(undefined, { stayHidden: true }));
      if (image.isEmpty()) return null;
      const b = image.resize({ width: 64, quality: 'good' }).toBitmap();
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch {
      return null;
    }
  }

  /**
   * The page time of the DOM's last mutation as waitScripted's observer saw it, or null when it is not
   * installed. A value later than the one a wait returned means the DOM changed after the wait.
   */
  async mutationStamp(): Promise<number | null> {
    const r = await this.inProbeWorld<unknown>('(function(){var m=window.__blMut;return m?m.last:null})()', 2000, null);
    return typeof r === 'number' ? r : null;
  }

  async resumeAnimations(): Promise<void> {
    await this.inProbeWorld('(function(){var w=window;(w.__blPaused||[]).forEach(function(a){try{a.play()}catch(e){}});w.__blPaused=[];return true})()', 2000, false);
  }

  /**
   * Shows every fragment of reveal.js slide (h, v): `Reveal.slide(h, v, f)` with an f past the last fragment,
   * so a still render shows the slide's final state. The page's world is called with integers only (9.1).
   */
  async showRevealFragments(h: number, v: number): Promise<boolean> {
    if (!Number.isInteger(h) || !Number.isInteger(v) || h < 0 || v < 0 || this.isDestroyed()) return false;
    const code = `(function(){try{var R=window.Reveal;if(!R||typeof R.slide!=="function")return false;R.slide(${h},${v},${REVEAL_ALL_FRAGMENTS});return true}catch(e){return false}})()`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r = await Promise.race([
        this.wc.executeJavaScript(code),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
        this.closed.catch(() => false),
      ]);
      return r === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A fingerprint of the text on screen: every non-blank text node that renders inside the viewport, with no
   * transparent or hidden ancestor, counted and hashed with its text. A key press that leaves the slide but
   * changes this showed a build step (F25: such a press does not use up a retry). Read in main's own world.
   */
  async visibleTextSignature(): Promise<string> {
    const r = await this.inProbeWorld<unknown>(VISIBLE_TEXT_JS, 5000, '');
    return typeof r === 'string' ? r.slice(0, 64) : '';
  }

  /** Sets location.hash (a hash-routed deck's slide, SlideRef.nav.value); the string is JSON-encoded into the code. */
  async setHash(hash: string): Promise<boolean> {
    if (typeof hash !== 'string' || !hash.startsWith('#') || hash.length > 2048) return false;
    const r = await this.inProbeWorld<unknown>(`(function(){location.hash=${JSON.stringify(hash)};return true})()`, 2000, false);
    return r === true;
  }

  /** Scrolls heading `i` of `document.querySelectorAll('h1, h2, h3')` to the top of the viewport. */
  async scrollToHeading(i: number): Promise<boolean> {
    if (!Number.isInteger(i) || i < 0 || i > 1_000_000) return false;
    const r = await this.inProbeWorld<unknown>(
      `(function(){var h=document.querySelectorAll("h1,h2,h3")[${i}];if(!h)return false;h.scrollIntoView({block:"start",inline:"nearest",behavior:"instant"});return true})()`,
      2000,
      false,
    );
    return r === true;
  }

  /**
   * A document's text in document order, cut into sections at its rendered h1–h3 headings (6.9 Find on
   * documents; the outline is the views item's). Text counts when it renders (a range over it has a box) and
   * its parent is visibility: visible; script, style, template, textarea, iframe and object contents never do.
   */
  async documentOutline(): Promise<DocumentOutline> {
    const r = await this.inProbeWorld<unknown>(OUTLINE_JS, 30_000, null);
    try {
      return outlineOf(r);
    } catch (e) {
      throw new RenderError(`document outline: malformed result (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  /**
   * The text of every style sheet the document uses, read through the view's debugger (CSS domain): linked
   * sheets from the -files origin are cross-origin to the page, so neither the page nor an isolated world can
   * read their rules (9.1 Serving), but main can. `media` is the media attribute of the sheet's owner node
   * (`<link media>`, `<style media>`), when it has one, read through DOM.describeNode: CSS.getMediaQueries
   * reports those lists without a styleSheetId, so they never reached the sheet (review finding 13); an
   * `@import url(x) <media>` list is the importing statement's, which pdf.ts reads from the sheet's text.
   * Read-only; the CSS and DOM domains are disabled again afterwards.
   */
  async styleSheets(maxChars = 16 * 1024 * 1024): Promise<{ sheets: StyleSheetText[]; truncated: boolean }> {
    const headers: { styleSheetId: string; origin: string; sourceURL: string; ownerNode: number | null }[] = [];
    const onMessage = (_e: unknown, method: string, params: unknown) => {
      if (method !== 'CSS.styleSheetAdded' || headers.length >= 10_000) return;
      const h = (params as { header?: { styleSheetId?: unknown; origin?: unknown; sourceURL?: unknown; ownerNode?: unknown } } | null)?.header;
      if (h && typeof h.styleSheetId === 'string' && typeof h.origin === 'string') {
        headers.push({
          styleSheetId: h.styleSheetId,
          origin: h.origin,
          sourceURL: typeof h.sourceURL === 'string' ? h.sourceURL : '',
          ownerNode: typeof h.ownerNode === 'number' && Number.isInteger(h.ownerNode) ? h.ownerNode : null,
        });
      }
    };
    if (this.isDestroyed()) throw this.closedError();
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3');
    this.wc.debugger.on('message', onMessage);
    const sheets: StyleSheetText[] = [];
    let truncated = false;
    try {
      await this.cdp('DOM.enable');
      // styleSheetAdded for the sheets that exist arrives before CSS.enable resolves (Phase 1 finding);
      // one more turn lets the event loop deliver any that are still queued.
      await this.cdp('CSS.enable');
      await new Promise((r) => setTimeout(r, 30));
      /** The owner node's media attribute (null: none, or not a link or style element). */
      const ownerMedia = new Map<number, string | null>();
      const mediaOf = async (node: number | null): Promise<string | null> => {
        if (node === null) return null;
        if (ownerMedia.has(node)) return ownerMedia.get(node) ?? null;
        let media: string | null = null;
        try {
          const d = await this.cdp<{ node?: { localName?: unknown; attributes?: unknown } }>('DOM.describeNode', { backendNodeId: node });
          const name = typeof d.node?.localName === 'string' ? d.node.localName : '';
          const attrs = Array.isArray(d.node?.attributes) ? d.node.attributes : [];
          if (name === 'link' || name === 'style') {
            for (let i = 0; i + 1 < attrs.length; i += 2) {
              if (typeof attrs[i] === 'string' && attrs[i].toLowerCase() === 'media' && typeof attrs[i + 1] === 'string') media = String(attrs[i + 1]).slice(0, 4096);
            }
          }
        } catch {
          // Without the media list the sheet counts as `all`: a print-only sheet then reads as print CSS only
          // through its own @page or @media print rules.
        }
        ownerMedia.set(node, media);
        return media;
      };
      let chars = 0;
      for (const h of headers) {
        // The page's own sheets only: not the user agent's, not ones devtools injected.
        if (h.origin !== 'regular') continue;
        let text: string;
        try {
          text = (await this.cdp<{ text?: unknown }>('CSS.getStyleSheetText', { styleSheetId: h.styleSheetId })).text as string;
        } catch {
          continue;
        }
        if (typeof text !== 'string') continue;
        if (chars + text.length > maxChars) {
          truncated = true;
          break;
        }
        chars += text.length;
        sheets.push({ text, url: h.sourceURL.slice(0, 2048), media: await mediaOf(h.ownerNode) });
      }
    } finally {
      this.wc.debugger.removeListener('message', onMessage);
      await this.cdp('CSS.disable').catch(() => undefined);
      await this.cdp('DOM.disable').catch(() => undefined);
    }
    return { sheets, truncated };
  }

  /** webContents.printToPDF of the loaded page (6.9 Save as PDF). */
  async printToPDF(options: Electron.PrintToPDFOptions): Promise<Uint8Array> {
    if (this.isDestroyed()) throw this.closedError();
    const buf = await this.whileOpen(this.wc.printToPDF(options));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  /** Closes the window. Whatever still waits on it rejects with RenderCancelled (disposeRenderer, the pool). */
  close(): void {
    this.closing = true;
    const e = this.closedError();
    this.rejectAll(e);
    this.closeWith(e);
    if (!this.wc.isDestroyed()) this.wc.close();
    if (!this.win.isDestroyed()) this.win.destroy();
  }
}

/**
 * True when two small frames (RenderView.frameSample) differ: more than 0.2% of their pixels by more than 16
 * in a channel. A frame that could not be taken counts as different (when unsure, wait in full).
 */
export function framesDiffer(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length || a.length === 0) return true;
  let n = 0;
  for (let i = 0; i + 3 < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 16 || Math.abs(a[i + 1] - b[i + 1]) > 16 || Math.abs(a[i + 2] - b[i + 2]) > 16) n++;
  }
  return n > (a.length / 4) * 0.002;
}

/** RenderView.visibleTextSignature: `<count>:<hash>` of the visible text (opacity and visibility of every ancestor). */
const VISIBLE_TEXT_JS =
  '(function(){var d=document,root=d.body||d.documentElement;if(!root)return "0:0";var W=innerWidth,H=innerHeight,ok=new Map(),range=d.createRange(),n=0,h=0;' +
  'function shown(el){if(!el)return true;var v=ok.get(el);if(v!==undefined)return v;var cs=getComputedStyle(el);v=cs.visibility==="visible"&&!(parseFloat(cs.opacity)<=0)&&cs.display!=="none"&&shown(el.parentElement);ok.set(el,v);return v}' +
  'var w=d.createTreeWalker(root,4);for(var t=w.nextNode();t&&n<100000;t=w.nextNode()){var s=t.data;if(!/\\S/.test(s))continue;var p=t.parentElement;if(!p||!shown(p))continue;' +
  'range.selectNodeContents(t);var r=range.getBoundingClientRect();if(!(r.width>0&&r.height>0)||r.right<=0||r.bottom<=0||r.left>=W||r.top>=H)continue;' +
  'n++;for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0}return n+":"+h})()';

/** Reveal.slide's fragment index for "every fragment shown": past any real slide's last fragment. */
const REVEAL_ALL_FRAGMENTS = 1_000_000;

/** One style sheet's text (RenderView.styleSheets). */
export interface StyleSheetText {
  text: string;
  url: string;
  /** The sheet's own media list (`<link media="print">`), or null when it has none. */
  media: string | null;
}

/** A document's text cut at its rendered h1–h3 headings (RenderView.documentOutline). */
export interface DocumentOutline {
  /** How many h1–h3 elements the document has, rendered or not (the numbering `heading` refers to). */
  headings: number;
  sections: { heading: number | null; level: 0 | 1 | 2 | 3; title: string; text: string[] }[];
  /** The walk stopped at its limits (5,000 sections, 200,000 text nodes, 4 M characters). */
  cut: boolean;
}

/**
 * The outline walk (RenderView.documentOutline). The first section holds the text before the first heading;
 * each rendered h1–h3 starts the next one, numbered by its place among all of the page's h1–h3. A section's
 * text is one string per run of text in one block, its inline runs joined as the page shows them, a space where
 * white space lies between them (ipc-render SlideIndexEntry.text): a new string starts at another block, and
 * at a line break, an inline replaced element or an inline-block, where findInPage never matches across.
 */
const OUTLINE_JS =
  '(function(){var d=document,root=d.body||d.documentElement;if(!root)return {headings:0,sections:[],cut:false};' +
  'var SKIP={SCRIPT:1,STYLE:1,NOSCRIPT:1,TEMPLATE:1,TEXTAREA:1,TITLE:1,HEAD:1,IFRAME:1,OBJECT:1,EMBED:1,"BLUELINE-OVERLAY":1};' +
  'var BREAK={BR:1,IMG:1,INPUT:1,SELECT:1,TEXTAREA:1,BUTTON:1,SVG:1,CANVAS:1,VIDEO:1,AUDIO:1,IFRAME:1,FRAME:1,OBJECT:1,EMBED:1,PICTURE:1,METER:1,PROGRESS:1,MATH:1};' +
  'var all=d.querySelectorAll("h1,h2,h3"),num=new Map();for(var i=0;i<all.length;i++)num.set(all[i],i);' +
  'var cur={heading:null,level:0,title:"",text:[]},sections=[cur],chars=0,nodes=0,cut=false,vis=new Map(),disp=new Map(),blk=new Map(),range=d.createRange();' +
  'var lastBlock=null,broke=true,space=false;' +
  'function cs(el){var v=disp.get(el);if(v===undefined){v=getComputedStyle(el);disp.set(el,v)}return v}' +
  'function visible(el){var v=vis.get(el);if(v===undefined){v=cs(el).visibility==="visible";vis.set(el,v)}return v}' +
  'function inline(el){var x=cs(el).display;return x==="inline"||x==="contents"}' +
  'function blockOf(el){var b=blk.get(el);if(b===undefined){b=el.parentElement&&inline(el)?blockOf(el.parentElement):el;blk.set(el,b)}return b}' +
  'function boxed(n){try{range.selectNodeContents(n);return range.getClientRects().length>0}catch(e){return false}}' +
  'var w=d.createTreeWalker(root,5,{acceptNode:function(n){return n.nodeType===1&&SKIP[n.nodeName.toUpperCase()]?2:1}});' +
  'for(var n=w.nextNode();n;n=w.nextNode()){' +
  'if(n.nodeType===1){if(BREAK[n.nodeName.toUpperCase()])broke=true;else if(cs(n).display!=="none"&&!inline(n))broke=true;' +
  'if(num.has(n)&&n.getClientRects().length>0&&visible(n)){var t=(n.textContent||"").replace(/\\s+/g," ").trim();' +
  'if(t){if(sections.length>=5000){cut=true;break}cur={heading:num.get(n),level:Number(n.localName.charAt(1)),title:t.slice(0,300),text:[]};sections.push(cur);broke=true}}continue}' +
  'var raw=n.data,s=raw.replace(/\\s+/g," ").trim(),p=n.parentElement;if(!s){if(raw&&p&&boxed(n))space=true;continue}if(!p||!visible(p)||!boxed(n))continue;' +
  'if(nodes>=200000||chars+s.length>4000000){cut=true;break}nodes++;chars+=s.length;var b=blockOf(p);' +
  // review finding 12: a node whose white-space preserves breaks splits at each newline (findInPage never
  // matches across a forced break); the first piece joins the previous run, the rest start new runs.
  'var ws=cs(p).whiteSpace,segs=(ws&&(ws.indexOf("pre")===0||ws==="break-spaces"))?raw.split("\\n"):[raw];' +
  'for(var gi=0;gi<segs.length;gi++){var seg=segs[gi];' +
  'if(gi===0&&!broke&&b===lastBlock&&cur.text.length){cur.text[cur.text.length-1]+=(space?" ":"")+seg}else cur.text.push(seg)}' +
  'lastBlock=b;broke=false;space=false}' +
  'for(var k=0;k<sections.length;k++){var tx=sections[k].text;for(var j=0;j<tx.length;j++)tx[j]=tx[j].replace(/\\s+/g," ").trim()}' +
  'return {headings:all.length,sections:sections,cut:cut}})()';

/** Checks the outline walk's result (it comes from a page-controlled view: a malformed one is an error). */
export function outlineOf(v: unknown): DocumentOutline {
  const r = rec(v, 'outline');
  const headings = int(r.headings, 'outline.headings', 0, 10_000_000);
  if (!Array.isArray(r.sections) || r.sections.length > 5001) throw new BadResult('outline.sections: not a list');
  let chars = 0;
  const sections = r.sections.map((s, i): DocumentOutline['sections'][number] => {
    const sr = rec(s, `outline.sections[${i}]`);
    const heading = sr.heading === null ? null : int(sr.heading, 'heading', 0, Math.max(0, headings - 1));
    const level = int(sr.level, 'level', 0, 3) as 0 | 1 | 2 | 3;
    if ((heading === null) !== (level === 0)) throw new BadResult('outline: heading and level disagree');
    if (!Array.isArray(sr.text) || sr.text.length > 200_000) throw new BadResult('outline: text not a list');
    const text = sr.text.map((t) => {
      const s2 = str(t, 'text', 4_000_000);
      chars += s2.length;
      return s2;
    });
    if (chars > 4_000_000) throw new BadResult('outline: too much text');
    return { heading, level, title: str(sr.title, 'title', 300), text };
  });
  if (sections.length === 0) sections.push({ heading: null, level: 0, title: '', text: [] });
  return { headings, sections, cut: bool(r.cut, 'outline.cut') };
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
    if (this.closed) throw new RenderCancelled('the render pool is closed');
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

// ------------------------------------------------------------------------------------------- per-document renderer
// Phase 1 render products (thumbnails, the slide index, PDF pages, Print) render through one
// DocumentRenderer per open document: at most POOL_LIMIT render windows (9.1 Render service), each sized to
// the viewport its job needs (the index walks at 1600×900, thumbnails and PDF pages at the design size),
// with reduced motion, kept for a while after a job and closed when idle.

/** A render was cancelled: a newer version of the document, or the document closed (its render views closed). */
export class RenderCancelled extends RenderError {
  override readonly name: string = 'RenderCancelled';
}

export function throwIfCancelled(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new RenderCancelled('the render was cancelled');
}

/** 6.7 step 1: "Wait until the document has had no write for 300 ms." */
export const WRITE_QUIET_MS = 300;
const lastWrites = new Map<string, number>();

/**
 * The document (by fileKey) was just written: by Blueline (an edit, Phase 2) or by someone else (the
 * watcher's reload). Renders that start within 300 ms wait (6.7 step 1). The views item calls this.
 */
export function noteDocumentWrite(fileKey: string, at: number = Date.now()): void {
  if (typeof fileKey !== 'string' || !/^[0-9a-f]{16}$/.test(fileKey)) return;
  lastWrites.set(fileKey, at);
}

/** How long a render must still wait, given the last write's time (0 when there was none, or long ago). */
export function quietDelay(lastWriteAt: number | undefined, now: number, quietMs: number = WRITE_QUIET_MS): number {
  if (lastWriteAt === undefined || !Number.isFinite(lastWriteAt)) return 0;
  return Math.max(0, Math.min(quietMs, lastWriteAt + quietMs - now));
}

/** Resolves once the document has had no write for WRITE_QUIET_MS (a write meanwhile extends the wait). */
export async function untilQuiet(fileKey: string, signal?: AbortSignal | null): Promise<void> {
  for (;;) {
    throwIfCancelled(signal);
    const wait = quietDelay(lastWrites.get(fileKey), Date.now());
    if (wait <= 0) return;
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** What every render needs from the app: the deck preload, app data, and a log. */
export interface RenderHost {
  /** dist/preload-deck.cjs */
  preload: string;
  /** app.getPath('userData'): thumbnails and the index cache go to files/<fileKey>/thumbs/ (9.7). */
  userData: string;
  log(msg: string): void;
  devTools?: boolean;
}

let currentHost: RenderHost | null = null;

/** Called once at startup (the views item; pdf-command for `blueline pdf`). */
export function setRenderHost(h: RenderHost): void {
  currentHost = { ...h };
}

export function renderHost(): RenderHost {
  if (!currentHost) throw new RenderError('the render service is not set up (setRenderHost)');
  return currentHost;
}

export function viewportKey(vp: Viewport): string {
  return `${vp.w}x${vp.h}@${vp.dpr}`;
}

/**
 * A keyed pool of at most `limit` items (render views keyed by their viewport). acquire(key) hands out an
 * idle item with that key, creates one while under the limit, replaces an idle item of another key, or waits
 * for a release. Idle items are destroyed after `idleMs`.
 */
export class ViewSlots<V> {
  private readonly items: { v: V; key: string; busy: boolean; timer: ReturnType<typeof setTimeout> | null }[] = [];
  private readonly waiters: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly make: (key: string) => V,
    private readonly destroy: (v: V) => void,
    private readonly dead: (v: V) => boolean,
    readonly limit: number = POOL_LIMIT,
    private readonly idleMs: number = 20_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > POOL_LIMIT) throw new RangeError(`a pool holds 1..${POOL_LIMIT} views`);
  }

  get size(): number {
    return this.items.length;
  }

  get busy(): number {
    return this.items.filter((i) => i.busy).length;
  }

  private drop(i: number): void {
    const [it] = this.items.splice(i, 1);
    if (it.timer) clearTimeout(it.timer);
    try {
      this.destroy(it.v);
    } catch {
      // already gone
    }
  }

  async acquire(key: string, signal?: AbortSignal | null): Promise<V> {
    for (;;) {
      if (this.closed) throw new RenderCancelled('the render pool is closed');
      throwIfCancelled(signal);
      for (let i = this.items.length - 1; i >= 0; i--) if (!this.items[i].busy && this.dead(this.items[i].v)) this.drop(i);
      const idle = this.items.find((i) => !i.busy && i.key === key);
      if (idle) {
        if (idle.timer) clearTimeout(idle.timer);
        idle.timer = null;
        idle.busy = true;
        return idle.v;
      }
      if (this.items.length >= this.limit) {
        const other = this.items.findIndex((i) => !i.busy);
        if (other >= 0) this.drop(other);
      }
      if (this.items.length < this.limit) {
        const v = this.make(key);
        this.items.push({ v, key, busy: true, timer: null });
        return v;
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        // A cancelled waiter leaves the queue, so a release never wakes it in place of a live one.
        const onAbort = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        this.waiters.push(wake);
      });
    }
  }

  release(v: V): void {
    const it = this.items.find((i) => i.v === v);
    if (!it || !it.busy) return;
    it.busy = false;
    if (this.closed || this.dead(v)) this.drop(this.items.indexOf(it));
    else {
      it.timer = setTimeout(() => {
        const i = this.items.indexOf(it);
        if (i >= 0 && !it.busy) this.drop(i);
      }, this.idleMs);
      it.timer.unref?.();
    }
    this.waiters.shift()?.();
  }

  async use<T>(key: string, fn: (v: V) => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    const v = await this.acquire(key, signal);
    try {
      return await fn(v);
    } finally {
      this.release(v);
    }
  }

  close(): void {
    this.closed = true;
    while (this.items.length) this.drop(0);
    for (const w of this.waiters.splice(0)) w();
  }
}

/** One open document's render windows (at most POOL_LIMIT), in its own partition, with reduced motion. */
export class DocumentRenderer {
  private target: RenderTarget;
  private readonly slots: ViewSlots<RenderView>;
  private closedFlag = false;

  constructor(
    target: RenderTarget,
    private readonly host: RenderHost,
    factory?: (vp: Viewport, target: RenderTarget) => RenderView,
  ) {
    this.target = target;
    const make = factory ?? ((vp: Viewport, t: RenderTarget) => this.createView(vp, t));
    this.slots = new ViewSlots<RenderView>(
      (key) => make(parseViewportKey(key), this.target),
      (v) => v.close(),
      (v) => v.isDestroyed(),
    );
  }

  /** The current target (a newer version of the same document replaces it: update()). */
  get current(): RenderTarget {
    return this.target;
  }

  /** A newer version, or a trust change (Allow network): later loads use it. */
  update(target: RenderTarget): void {
    if (target.docId !== this.target.docId || target.partition !== this.target.partition) throw new RenderError('a renderer serves one document');
    this.target = target;
  }

  private createView(vp: Viewport, t: RenderTarget): RenderView {
    return RenderView.create({
      partition: t.partition,
      preload: this.host.preload,
      viewport: vp,
      folderReal: t.folderReal,
      // Read live: Allow network applies to the next load (9.9).
      isProtected: () => this.target.isProtected(),
      networkOpen: () => this.target.networkOpen(),
      log: (m) => this.host.log(m),
      devTools: this.host.devTools === true,
      reducedMotion: t.reducedMotion,
    });
  }

  /** Runs `fn` on a render view of `vp` (waiting for one of the document's two). */
  use<T>(vp: Viewport, fn: (v: RenderView) => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (!validViewport(vp)) return Promise.reject(new RenderError('invalid viewport'));
    return this.slots.use(viewportKey(vp), fn, signal);
  }

  get views(): number {
    return this.slots.size;
  }

  /** close() ran (disposeRenderer, or a target of another partition replaced this renderer). */
  get closed(): boolean {
    return this.closedFlag;
  }

  close(): void {
    this.closedFlag = true;
    this.slots.close();
  }
}

function parseViewportKey(key: string): Viewport {
  const m = /^(\d+)x(\d+)@([0-9.]+)$/.exec(key);
  if (!m) throw new RenderError('invalid viewport key');
  return { w: Number(m[1]), h: Number(m[2]), dpr: Number(m[3]) };
}

const renderers = new Map<string, DocumentRenderer>();
/**
 * The renderer each target was last served by. A job holds its target from start to end (a PDF: the index, the
 * print-CSS try, then the raster walk, each asking rendererFor again), so a target whose renderer was closed
 * belongs to a job its document's close cancelled: it gets RenderCancelled, never a new renderer of a closed
 * document. A document opened again comes with targets of its own (renderTargetFor), so a Trusted file's stable
 * docId is served again. Weak: a finished job's target goes with it.
 */
const servedBy = new WeakMap<RenderTarget, DocumentRenderer>();

/**
 * The document's renderer (one per docId), created on first use; a newer target for it updates it. Rejects
 * (throws RenderCancelled) for a target a closed renderer served: its document closed while the job ran.
 */
export function rendererFor(target: RenderTarget, host: RenderHost = renderHost()): DocumentRenderer {
  if (servedBy.get(target)?.closed) throw new RenderCancelled('the document was closed');
  let r = renderers.get(target.docId);
  if (r && r.current.partition !== target.partition) {
    r.close();
    r = undefined;
  }
  if (!r) {
    r = new DocumentRenderer(target, host);
    renderers.set(target.docId, r);
  } else if (r.current !== target) r.update(target);
  servedBy.set(target, r);
  return r;
}

/**
 * Closes the document's render windows. The views item calls it when the document's window closes, before
 * the partition is retired (window.ts onClosed), and for an old docId after a reload gave a new one.
 */
export function disposeRenderer(docId: string): void {
  const r = renderers.get(docId);
  if (!r) return;
  renderers.delete(docId);
  r.close();
}

/** Open renderers (tests and logs). */
export function rendererCount(): number {
  return renderers.size;
}
