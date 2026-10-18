// The slide index (6.9 Navigation and Find; 6.7 Background renders). One offscreen walk per document
// version (sha256) gives each slide its title, its SlideRef nav and its visible text, and the deck's design
// size. Thumbnails (thumbnails.ts), Find (find.ts) and the raster PDF (pdf.ts) are built from it.
//
// - Decks (9.4 reveal and generic) are walked as `blueline map` walks them: a generic engine with the map's
//   DeckWalker (patient keys, build steps, the hash fallback), then, when the visible view recorded other
//   keys (Session.deckNav, e.g. ArrowDown) and the walk did not reach every slide, once more with those; a
//   reveal.js deck with Reveal.slide(h, v) per slide, every fragment shown, so Find also finds the text a
//   fragment holds and a still render shows the slide's final state.
// - Documents (9.4 scroll and single) get one entry per rendered h1–h3 section, its text in document order,
//   so Find works on documents too (the outline itself is the views item's).
// - A slide's text is one string per run of text in one block (ipc-render SlideIndexEntry.text): inline runs
//   joined as the page shows them, a new string at every block boundary and line break (review finding 12).
// - Each slide is read after the scripted settle a still image waits for (decision D-5: what its scripts
//   reveal after it arrives), and a deck whose thumbnails render at the walk's own viewport (1600×900 at 2x)
//   gets the rail's thumbnails from the same walk, so the wait is paid once per slide. The settle adapts per
//   slide and version (SettleMemory), and thumbnails, PDF pages and Print share what the walk learnt.
// - The design size (6.9): reveal.js width and height, else the slide element's box at a 1600×900 viewport,
//   else 1600×900. The walk runs at 1600×900 for that reason.
// - Background renders use reduced motion (docs/PHASE1-PLAN.md): the render views emulate it.
// - A render waits until the document has had no write for 300 ms (6.7 step 1; render-service untilQuiet).
// - Cached per (fileKey, version) in memory and as JSON at <userData>/files/<fileKey>/thumbs/index-<version>.json
//   (9.7 thumbs/); once a version's index is complete, the other versions' index files go (review finding 14).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CollectResult, DetectResult, WalkNode } from '@blueline/core/ipc';
import type { CollectJoins } from '@blueline/core/dom-walk';
import type { SlideIndex, SlideIndexEntry, SlideIndexKind } from '@blueline/core/ipc-render';
import { DEFAULT_DESIGN } from '@blueline/core/slides';
import type { SlideRef } from '@blueline/core/types';
import { atomicWriteFile, readRegularFile } from './atomic-write';
import { DeckWalker, MAX_PRESSES, PRESS_RETRY_GAPS_MS } from './map-command';
import { LEFT_RAIL_WIDTH } from './layout';
import { slideRefFor } from './notes';
// thumbnails.ts imports this module too; only functions and constants used at run time cross that cycle.
import { THUMB_SCALE, removeVersionThumbs, thumbFileName, thumbPixelSize, validThumbWidth } from './thumbnails';
import { railThumbWidth } from './views';
import {
  RenderCancelled,
  RenderError,
  navKeyFor,
  rendererFor,
  renderHost,
  throwIfCancelled,
  untilQuiet,
  type KeyPress,
  type NavKey,
  type RenderHost,
  type RenderTarget,
  type RenderView,
  type Viewport,
} from './render-service';

/** 6.9: the design size is the slide element's box "at a 1600×900 viewport"; the index walks there, at 2x. */
export const INDEX_VIEWPORT: Readonly<Viewport> = Object.freeze({ w: 1600, h: 900, dpr: 2 });
/** Fallback titles from a slide's first line of text are trimmed to this many UTF-16 units. */
export const TITLE_LINE_MAX = 120;
/** Limits on what one index holds (a hostile page must not fill main's memory or app data). */
export const INDEX_LIMITS = Object.freeze({ slides: 10_000, stringsPerSlide: 20_000, charsPerSlide: 1_000_000, chars: 8_000_000 });
/** Design sizes outside 16..16384 px per side are not slide sizes (render-service validViewport caps 16384). */
const DESIGN_MIN = 16;
const DESIGN_MAX = 16_384;

// ------------------------------------------------------------------------------------------- paths (9.7)

const FILE_KEY = /^[0-9a-f]{16}$/;
const VERSION = /^[0-9a-f]{64}$/;

/** `<userData>/files/<fileKey>/thumbs/`: thumbnails and the index cache (9.7). */
export function thumbsDir(userData: string, fileKey: string): string {
  if (!FILE_KEY.test(fileKey)) throw new RenderError('invalid fileKey');
  return path.join(userData, 'files', fileKey, 'thumbs');
}

/** The index cache's file name for a version: `index-<sha256>.json`. */
export function indexFileName(version: string): string {
  if (!VERSION.test(version)) throw new RenderError('invalid version');
  return `index-${version}.json`;
}

// ------------------------------------------------------------------------------------------- pure parts

/** Collapses whitespace runs to one space and trims (the index's text strings). */
export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Trims to `max` UTF-16 units without splitting a surrogate pair, at a word boundary when one is near. */
export function trimLine(s: string, max: number = TITLE_LINE_MAX): string {
  const t = collapse(s);
  if (t.length <= max) return t;
  let end = max;
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  const cut = t.slice(0, end);
  const space = cut.lastIndexOf(' ');
  return (space >= max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * The slide's title: 9.4's (the first h1–h3, else data-title) as detection found it, else the slide's first
 * line of text (trimmed to 120), else "Slide N".
 */
export function slideTitleFor(detected: string | undefined, index: number, text: readonly string[]): string {
  const fallback = `Slide ${index + 1}`;
  const d = typeof detected === 'string' ? collapse(detected) : '';
  if (d && d !== fallback) return d;
  for (const t of text) {
    const line = trimLine(t);
    if (line) return line;
  }
  return fallback;
}

/** A finite design size within limits, else null. */
function sane(size: { w: number; h: number } | null | undefined): { w: number; h: number } | null {
  if (!size) return null;
  const { w, h } = size;
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  const rw = Math.round(w);
  const rh = Math.round(h);
  if (rw < DESIGN_MIN || rh < DESIGN_MIN || rw > DESIGN_MAX || rh > DESIGN_MAX) return null;
  return { w: rw, h: rh };
}

/**
 * 6.9 design size: decks take detection's (reveal.js width and height, else the slide element's box at the
 * 1600×900 index viewport); documents, and anything out of range, 1600×900.
 */
export function chooseDesignSize(kind: SlideIndexKind, detected: { w: number; h: number } | null | undefined): { w: number; h: number } {
  if (kind === 'reveal' || kind === 'generic') return sane(detected) ?? { ...DEFAULT_DESIGN };
  return { ...DEFAULT_DESIGN };
}

/** The design size as a render viewport at 2x (6.9 Save as PDF: "at the design size and 2x"). */
export function designViewport(index: Pick<SlideIndex, 'designSize'>, dpr = 2): Viewport {
  return { w: index.designSize.w, h: index.designSize.h, dpr };
}

export function isDeck(kind: SlideIndexKind): boolean {
  return kind === 'reveal' || kind === 'generic';
}

/** Bounded text for one slide: collapsed, non-empty strings, in order. */
function boundedText(strings: Iterable<string>, budget: { chars: number }): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const raw of strings) {
    const s = collapse(raw);
    if (!s) continue;
    if (out.length >= INDEX_LIMITS.stringsPerSlide || chars + s.length > INDEX_LIMITS.charsPerSlide || budget.chars < s.length) break;
    out.push(s);
    chars += s.length;
    budget.chars -= s.length;
  }
  return out;
}

/** How a walk node continues the one before it in its block (from a collect's joins; dom-walk CollectJoins). */
export type NodeJoins = Map<number, { prev: number; sep: 1 | 2 }>;

/**
 * Records a collect's block joins: each node that continues the previous visible text node of its block
 * (WalkBlock.nodeKeys order) directly (1) or after white space (2). The latest collect of a node wins.
 */
export function noteJoins(res: Pick<CollectResult, 'nodes' | 'blocks'> & CollectJoins, into: NodeJoins): void {
  const joins = res.joins;
  if (!joins || joins.length !== res.nodes.length) return;
  const pos = new Map<number, number>();
  res.nodes.forEach((n, i) => pos.set(n.key, i));
  for (const b of res.blocks) {
    for (let j = 0; j < b.nodeKeys.length; j++) {
      const k = b.nodeKeys[j];
      const i = pos.get(k);
      if (i === undefined) continue;
      const sep = joins[i];
      if (j > 0 && (sep === 1 || sep === 2)) into.set(k, { prev: b.nodeKeys[j - 1], sep });
      else into.delete(k);
    }
  }
}

/**
 * The walk's nodes as text per slide, in walk order (each collect is in document order): one string per run of
 * text in one block (ipc-render SlideIndexEntry.text). A node joins the slide's last string when `joins` says it
 * continues the node that string ended with (directly, or after a space); otherwise it starts a new one.
 */
export function textBySlide(nodes: readonly { w: Pick<WalkNode, 'node'> & Partial<Pick<WalkNode, 'key' | 'pre'>>; slide: number }[], count: number, joins?: ReadonlyMap<number, { prev: number; sep: 1 | 2 }>): string[][] {
  const per: string[][] = Array.from({ length: count }, () => []);
  const last: (number | undefined)[] = new Array(count);
  for (const n of nodes) {
    if (!(n.slide >= 0 && n.slide < count)) continue;
    const list = per[n.slide];
    const j = joins && n.w.key !== undefined ? joins.get(n.w.key) : undefined;
    // A node whose white-space preserves breaks splits at each newline: findInPage never matches across a
    // forced break, so each line is its own run (review finding 12). The first piece joins the previous run as
    // usual; the rest start new runs.
    const segs = n.w.pre ? n.w.node.data.split('\n') : [n.w.node.data];
    if (j && list.length > 0 && last[n.slide] === j.prev) list[list.length - 1] += (j.sep === 2 ? ' ' : '') + segs[0];
    else list.push(segs[0]);
    for (let k = 1; k < segs.length; k++) list.push(segs[k]);
    last[n.slide] = n.w.key;
  }
  return per;
}

/** Builds the deck entries from detection and each slide's text. */
export function deckEntries(det: Pick<DetectResult, 'kind' | 'count' | 'titles' | 'navKind' | 'hashes' | 'revealIndices' | 'ids'>, text: readonly (readonly string[])[]): SlideIndexEntry[] {
  const budget = { chars: INDEX_LIMITS.chars };
  const count = Math.min(det.count, INDEX_LIMITS.slides);
  const state = { ...det, current: 0, count };
  const out: SlideIndexEntry[] = [];
  for (let i = 0; i < count; i++) {
    const t = boundedText(text[i] ?? [], budget);
    const nav: SlideRef['nav'] = slideRefFor(i, state).nav;
    out.push({ index: i, title: slideTitleFor(det.titles[i], i, t), nav, text: t });
  }
  return out;
}

/** Builds the document entries from the outline walk: the text before the first heading only when it has any. */
export function documentEntries(sections: readonly { heading: number | null; level: 0 | 1 | 2 | 3; title: string; text: readonly string[] }[], docTitle: string): SlideIndexEntry[] {
  const budget = { chars: INDEX_LIMITS.chars };
  const out: SlideIndexEntry[] = [];
  for (const s of sections) {
    if (out.length >= INDEX_LIMITS.slides) break;
    const text = boundedText(s.text, budget);
    if (s.heading === null && text.length === 0 && sections.length > 1) continue;
    const i = out.length;
    const title = s.heading !== null && collapse(s.title) ? trimLine(s.title) : (text.length ? trimLine(text[0]) : collapse(docTitle) || `Section ${i + 1}`);
    const e: SlideIndexEntry = { index: i, title, nav: { kind: 'none', value: 0 }, text, heading: s.heading };
    if (s.heading !== null && s.level >= 1) e.level = s.level as 1 | 2 | 3;
    out.push(e);
  }
  if (out.length === 0) out.push({ index: 0, title: collapse(docTitle) || 'Section 1', nav: { kind: 'none', value: 0 }, text: [], heading: null });
  return out;
}

// ------------------------------------------------------------------------------------------- cache file

const KINDS: readonly SlideIndexKind[] = ['reveal', 'generic', 'scroll', 'single'];
const NAV_KINDS: readonly SlideRef['nav']['kind'][] = ['hash', 'reveal', 'index', 'scroll', 'none'];

function plain(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}
function intIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

function navOf(v: unknown): SlideRef['nav'] | null {
  if (!plain(v)) return null;
  const kind = v.kind;
  const value = v.value;
  if (typeof kind !== 'string' || !(NAV_KINDS as readonly string[]).includes(kind)) return null;
  const k = kind as SlideRef['nav']['kind'];
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return { kind: k, value };
  if (typeof value === 'string' && value.length <= 2048) return { kind: k, value };
  if (Array.isArray(value) && value.length === 2 && intIn(value[0], 0, 1e6) && intIn(value[1], 0, 1e6)) return { kind: k, value: [value[0], value[1]] };
  return null;
}

/**
 * Reads an index cache file's JSON back, rebuilt field by field; null when anything is off (the file is
 * then rebuilt, never trusted in part). App data is ours, but a damaged file must not reach Find or the rail.
 */
export function parseSlideIndex(v: unknown, version: string): SlideIndex | null {
  if (!plain(v) || v.version !== version || !VERSION.test(version)) return null;
  if (typeof v.kind !== 'string' || !(KINDS as readonly string[]).includes(v.kind)) return null;
  if (typeof v.navKind !== 'string' || !(NAV_KINDS as readonly string[]).includes(v.navKind)) return null;
  if (typeof v.complete !== 'boolean') return null;
  const ds = plain(v.designSize) ? sane({ w: Number(v.designSize.w), h: Number(v.designSize.h) }) : null;
  if (!ds) return null;
  if (!Array.isArray(v.slides) || v.slides.length < 1 || v.slides.length > INDEX_LIMITS.slides) return null;
  let chars = 0;
  const slides: SlideIndexEntry[] = [];
  for (let i = 0; i < v.slides.length; i++) {
    const s = v.slides[i];
    if (!plain(s) || s.index !== i || typeof s.title !== 'string' || s.title.length > 1024) return null;
    const nav = navOf(s.nav);
    if (!nav || !Array.isArray(s.text) || s.text.length > INDEX_LIMITS.stringsPerSlide) return null;
    const text: string[] = [];
    for (const t of s.text) {
      if (typeof t !== 'string') return null;
      chars += t.length;
      text.push(t);
    }
    if (chars > INDEX_LIMITS.chars) return null;
    const e: SlideIndexEntry = { index: i, title: s.title, nav, text };
    if (s.heading !== undefined) {
      if (s.heading !== null && !intIn(s.heading, 0, 10_000_000)) return null;
      e.heading = s.heading as number | null;
    }
    if (s.level !== undefined) {
      if (s.level !== 1 && s.level !== 2 && s.level !== 3) return null;
      e.level = s.level;
    }
    slides.push(e);
  }
  const policyTag = typeof v.policyTag === 'string' && v.policyTag.length <= 128 ? v.policyTag : undefined;
  return { version, kind: v.kind as SlideIndexKind, navKind: v.navKind as SlideRef['nav']['kind'], slides, designSize: ds, complete: v.complete, policyTag };
}

async function readCachedIndex(userData: string, fileKey: string, version: string): Promise<SlideIndex | null> {
  try {
    const bytes = await readRegularFile(path.join(thumbsDir(userData, fileKey), indexFileName(version)), 64 * 1024 * 1024);
    return parseSlideIndex(JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown, version);
  } catch {
    return null;
  }
}

async function writeCachedIndex(userData: string, fileKey: string, index: SlideIndex): Promise<void> {
  const dir = thumbsDir(userData, fileKey);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicWriteFile(path.join(dir, indexFileName(index.version)), new TextEncoder().encode(JSON.stringify(index)), { newFileMode: 0o600 });
}

const INDEX_FILE = /^index-([0-9a-f]{64})\.json$/;

/**
 * Deletes the index files of the file's other versions once this version's index is complete (9.7 thumbs/ is
 * a cache of the current version). Documents have no thumbnail run, whose prune (thumbnails.ts) would remove
 * them, so without this every external change left one more index file behind (review finding 14).
 * Thumbnails stay: the thumbnail run prunes those. Returns how many went.
 */
export async function pruneOtherIndexFiles(userData: string, fileKey: string, keepVersion: string): Promise<number> {
  const dir = thumbsDir(userData, fileKey);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    const m = INDEX_FILE.exec(name);
    if (!m || m[1] === keepVersion) continue;
    try {
      await fs.promises.unlink(path.join(dir, name));
      n++;
    } catch {
      // gone already, or in use (Windows): the next index tries again
    }
  }
  return n;
}

// ------------------------------------------------------------------------------------------- slide visits

/** Presses that show a build step on one slide before the deck moves on (a bound, not a rule of the spec). */
export const MAX_BUILD_STEPS = 64;

/**
 * Presses `key` until the deck moves, with the walk's patience (map-command PRESS_RETRY_GAPS_MS; F25): a
 * delivered key that changed nothing is pressed again after 700, 1,400 and 2,500 ms, and a press that showed
 * a build step (the visible text changed, `signature`) does not use up a retry.
 */
export async function pressPatiently(
  view: Pick<RenderView, 'pressKey'> & Partial<Pick<RenderView, 'visibleTextSignature'>>,
  key: NavKey,
  signal?: AbortSignal | null,
): Promise<KeyPress> {
  const sig = view.visibleTextSignature ? () => view.visibleTextSignature!() : null;
  let before = sig ? await sig() : '';
  let p = await view.pressKey(key);
  let misses = 0;
  for (let stills = 1; !p.moved && p.via === 'input' && p.delivered !== false && stills <= MAX_BUILD_STEPS; stills++) {
    throwIfCancelled(signal);
    const after = sig ? await sig() : '';
    const built = sig !== null && after !== before;
    before = after;
    if (!built) misses++;
    if (misses > PRESS_RETRY_GAPS_MS.length) break;
    await new Promise((r) => setTimeout(r, PRESS_RETRY_GAPS_MS[Math.max(0, misses - 1)]));
    p = await view.pressKey(key);
  }
  return p;
}

export interface VisitOptions {
  signal?: AbortSignal | null;
  /** Visit only these slides (thumbnails missing from the cache); default all. */
  only?: ReadonlySet<number> | null;
  log?: (msg: string) => void;
  /**
   * How long a slide may take to show what its scripts reveal (RenderView.waitScripted). Default: the adaptive
   * settle (SettleMemory): SCRIPTED_SETTLE, or QUIET_SETTLE on a slide a full wait of this version showed
   * still. A value given here is used on every slide, unchanged.
   */
  scripted?: ScriptedSettle;
}

export interface ScriptedSettle {
  minMs: number;
  quietMs: number;
  maxMs: number;
}

/**
 * The wait for script-timed content before a still image of a slide, its text in the slide index, and every
 * print of a document or a print-CSS deck (RenderView.waitScripted; decision D-5). At least 1.5 s on the
 * slide: a deck that reveals a slide's content from a timer (D5 types its draft 1.3 s after the slide
 * arrives) otherwise lost it from thumbnails, PDF pages and Find; then 400 ms without a DOM change; at most
 * 3 s (a clock or a ticker never goes quiet). It costs about 1.5 s per slide; SettleMemory makes later walks
 * of the same version cheaper where it can.
 */
export const SCRIPTED_SETTLE: Readonly<ScriptedSettle> = Object.freeze({ minMs: 1500, quietMs: 400, maxMs: 3000 });

/** The quiet-only wait: 400 ms without a DOM change, no minimum, at most 3 s (SettleMemory). */
export const QUIET_SETTLE: Readonly<ScriptedSettle> = Object.freeze({ minMs: 0, quietMs: 400, maxMs: 3000 });

/**
 * The adaptive settle of one document version (decision D-5), shared by the index walk, thumbnails, PDF pages
 * and Print. A slide gets the full wait (SCRIPTED_SETTLE) until a full wait on it has shown that its DOM, once
 * it has been still for 200 ms, stays still (RenderView.waitScripted `late` false: no script changed it after
 * a pause); from then on the quiet-only wait (QUIET_SETTLE) is enough there. A slide whose DOM changed after
 * such a pause (a timer's reveal: delayed-build.html, D5's typed draft on its fifth slide) keeps the full
 * wait. The rule is per slide, not "the first slides decide for the rest": D5 reveals by timer on one slide
 * only, which a deck-wide rule learned on its first slides would have lost. Any late change seen during or
 * after a quiet-only wait restores the full wait for every slide of the version. A document's page always keeps
 * the full wait: it is one page printed once, and a canvas a script animates below the first screen is outside
 * the viewport the picture check samples, so the quiet-only wait would print it mid-animation (review finding
 * 10). The first walk of a version (normally the index walk) pays the full wait everywhere.
 */
export class SettleMemory {
  private readonly slides = new Map<number, 'quiet' | 'full'>();
  private allFull = false;

  /** The wait slide `slide` gets (null: the whole page of a document). */
  waitFor(slide: number | null): Readonly<ScriptedSettle> {
    // A document's page (slot null) always gets the full wait. The quiet-only wait learns "quiet" from the DOM
    // going still and a viewport-sized picture not changing; a document is scrolled to its top, so a canvas a
    // script animates below the first screen (a chart's requestAnimationFrame, no DOM mutation) is neither seen
    // by the observer nor inside the picture, and the no-minimum wait would print it mid-animation (review
    // finding 10). The full wait's 1.5 s minimum covers such a build, and a document is printed once, so the
    // per-slide saving the quiet-only wait gives a deck does not apply (decision D-5: once per document).
    if (slide === null) return SCRIPTED_SETTLE;
    if (this.allFull) return SCRIPTED_SETTLE;
    const s = this.slides.get(slide);
    return s === 'quiet' ? QUIET_SETTLE : SCRIPTED_SETTLE;
  }

  /** Records what a wait of `settle` on `slide` saw (null: a document's page, which always keeps the full wait). */
  learn(slide: number | null, settle: Readonly<ScriptedSettle>, seen: { quiet: boolean; late: boolean }): void {
    // A document's page is never put on the quiet-only wait (waitFor above), so nothing is learnt for it.
    if (slide === null) return;
    const full = settle.minMs >= SCRIPTED_SETTLE.minMs;
    if (seen.late && !full) this.allFull = true;
    // A slide that never went quiet (a ticker) waits to the cap either way: kept on the full wait.
    const verdict: 'quiet' | 'full' | null = seen.late || !seen.quiet ? 'full' : full ? 'quiet' : null;
    if (verdict === null) return;
    if (this.slides.get(slide) !== 'full') this.slides.set(slide, verdict);
  }

  /** The DOM changed after a quiet-only wait ended: every slide of the version gets the full wait again. */
  changedAfterQuiet(): void {
    this.allFull = true;
  }

  /** True when slide `slide` would get the quiet-only wait. */
  isQuiet(slide: number | null): boolean {
    return this.waitFor(slide) === QUIET_SETTLE;
  }
}

const settleMemories = new Map<string, SettleMemory>();
/** Settle memories are kept for the most recent versions only. */
const SETTLE_MEMORY_MAX = 16;

/** The adaptive settle of (fileKey, version), created on first use. */
export function settleMemoryFor(fileKey: string, version: string): SettleMemory {
  const k = `${fileKey}:${version}`;
  let m = settleMemories.get(k);
  if (m) {
    settleMemories.delete(k);
  } else m = new SettleMemory();
  settleMemories.set(k, m);
  while (settleMemories.size > SETTLE_MEMORY_MAX) settleMemories.delete(settleMemories.keys().next().value as string);
  return m;
}

/**
 * The adaptive wait for what scripts reveal on slide `slot` (null: a document's page): the wait SettleMemory
 * gives it, learnt from; and when a quiet-only wait saw a late change (a timer's reveal, a picture still
 * moving), the full wait from there, so that slide is not taken early either.
 */
export async function waitAdaptive(
  view: Pick<RenderView, 'waitScripted'>,
  memory: SettleMemory,
  slot: number | null,
  signal: AbortSignal | null,
): Promise<{ waitedMs: number; quiet: boolean; late: boolean; stamp: number | null; settle: Readonly<ScriptedSettle> }> {
  let settle = memory.waitFor(slot);
  let w = await view.waitScripted(settle, signal);
  memory.learn(slot, settle, w);
  if (settle === QUIET_SETTLE && w.late) {
    settle = SCRIPTED_SETTLE;
    const more = await view.waitScripted(settle, signal);
    memory.learn(slot, settle, more);
    w = { ...more, waitedMs: w.waitedMs + more.waitedMs };
  }
  return { ...w, settle };
}

/**
 * 6.7 step 3 and what scripts reveal, as visitSlides waits before a still image: fonts, frames and finite
 * animations (waitStable); then the scripted settle (waitScripted); then fonts, frames and the finite
 * animations that reveal started. Prints and document PDFs wait this once per document (decision D-5).
 */
export async function settleScripted(
  view: Pick<RenderView, 'waitStable' | 'waitScripted'>,
  signal: AbortSignal | null = null,
  log: (m: string) => void = () => undefined,
  settle: Readonly<ScriptedSettle> | { memory: SettleMemory; slot: number | null } = SCRIPTED_SETTLE,
): Promise<{ waitedMs: number; quiet: boolean; late: boolean; stamp: number | null }> {
  await view.waitStable();
  const w = 'memory' in settle ? await waitAdaptive(view, settle.memory, settle.slot, signal) : await view.waitScripted(settle, signal);
  if (!w.quiet) log(`render: the page kept changing; went on after ${w.waitedMs} ms`);
  await view.waitStable();
  return w;
}

export interface VisitResult {
  visited: number[];
  /** Slides navigation could not show (6.7: navOk false). */
  missed: number[];
}

/** The keys that move this deck: Session.deckNav when it holds pressable keys, else the 6.7 defaults. */
export function replayKeys(deckNav: RenderTarget['deckNav']): { forward: NavKey; back: NavKey; fallback: NavKey | null } {
  const forward = navKeyFor(deckNav?.forward);
  const back = navKeyFor(deckNav?.back);
  return { forward: forward ?? 'ArrowRight', back: back ?? (forward === 'ArrowDown' ? 'ArrowUp' : 'ArrowLeft'), fallback: forward ? null : 'PageDown' };
}

/**
 * Shows every wanted slide in turn (6.7 step 2 "Replay slide.nav"), and calls `visit` once it is settled
 * (step 3: fonts, two frames, finite animations; whatever still runs is paused for the visit and resumed
 * after, so the next slide's entrance is not frozen). Loads the document first.
 *
 * - reveal.js: Reveal.slide(h, v), every fragment shown;
 * - a generic engine: from slide 0, the forward key with the walk's patience (Index replay), each slide the
 *   deck reaches; then a hash-routed deck's other slides by hash;
 * - documents: each section's heading scrolled to the top (the text before the first heading: the top).
 */
export async function visitSlides(
  view: RenderView,
  doc: RenderTarget,
  index: SlideIndex,
  visit: (slide: number) => Promise<void>,
  opts: VisitOptions = {},
): Promise<VisitResult> {
  const signal = opts.signal ?? null;
  const log = opts.log ?? (() => undefined);
  const count = index.slides.length;
  const wanted = new Set<number>();
  for (let i = 0; i < count; i++) if (!opts.only || opts.only.has(i)) wanted.add(i);
  const visited: number[] = [];
  const done = new Set<number>();
  // The adaptive settle (SettleMemory), unless the caller fixed the wait.
  const memory = opts.scripted ? null : settleMemoryFor(doc.fileKey, doc.version);
  // A document is one page: its sections share one observation.
  const pageWide = !isDeck(index.kind);
  const at = async (i: number): Promise<void> => {
    if (!wanted.has(i) || done.has(i)) return;
    throwIfCancelled(signal);
    // 6.7 step 3, and what the deck's scripts reveal after the slide arrives (waitScripted), then fonts,
    // frames and the finite animations that reveal started.
    const slot = pageWide ? null : i;
    await view.waitStable();
    const w = memory ? await waitAdaptive(view, memory, slot, signal) : { ...(await view.waitScripted(opts.scripted!, signal)), settle: opts.scripted! };
    const scripted = w.settle;
    if (!w.quiet) log(`render: slide ${i + 1} kept changing; captured after ${w.waitedMs} ms`);
    await view.waitStable();
    await view.pauseAnimations();
    try {
      await visit(i);
      if (memory && scripted === QUIET_SETTLE && typeof w.stamp === 'number') {
        const now = await view.mutationStamp();
        if (now !== null && now > w.stamp) {
          memory.changedAfterQuiet();
          log(`render: slide ${i + 1} changed after its quiet-only wait; the full wait again for every slide`);
        }
      }
    } finally {
      await view.resumeAnimations();
    }
    done.add(i);
    visited.push(i);
  };

  throwIfCancelled(signal);
  await untilQuiet(doc.fileKey, signal);
  await view.load(doc);
  await view.waitStable();
  if (await view.overlayMounted()) throw new RenderError('a render view showed the overlay; render mode has no UI (6.7)');
  const det = await view.detect();

  if (index.kind === 'reveal') {
    for (const i of [...wanted].sort((a, b) => a - b)) {
      throwIfCancelled(signal);
      const v = index.slides[i].nav.value;
      const r = await view.goto(i);
      if (Array.isArray(v)) await view.showRevealFragments(v[0], v[1]);
      if (r.current === i || (await view.detect()).current === i) await at(i);
      else log(`render: Reveal.slide could not show slide ${i + 1}`);
    }
  } else if (index.kind === 'generic') {
    const keys = replayKeys(doc.deckNav);
    let cur = det.current;
    if (cur !== 0) cur = await toFirstSlide(view, index, keys.back, signal);
    if (cur === 0) await at(0);
    let key = keys.forward;
    let presses = 0;
    while (done.size < wanted.size && presses < MAX_PRESSES && cur < count - 1) {
      throwIfCancelled(signal);
      let p = await pressPatiently(view, key, signal);
      if (!p.moved && presses === 0 && keys.fallback) {
        key = keys.fallback;
        p = await pressPatiently(view, key, signal);
      }
      if (!p.moved) break;
      presses++;
      cur = p.to;
      await at(cur);
    }
    // A hash-routed deck: whatever the keys did not reach, by its hash (9.4 step 2).
    for (const i of [...wanted].sort((a, b) => a - b)) {
      if (done.has(i)) continue;
      const v = index.slides[i].nav.value;
      if (index.slides[i].nav.kind !== 'hash' || typeof v !== 'string') continue;
      throwIfCancelled(signal);
      if (!(await view.setHash(v))) continue;
      if ((await waitForSlide(view, i)) === i) await at(i);
    }
  } else {
    for (const i of [...wanted].sort((a, b) => a - b)) {
      throwIfCancelled(signal);
      const h = index.slides[i].heading;
      if (typeof h === 'number') await view.scrollToHeading(h);
      else await view.scrollTo(0);
      await at(i);
    }
  }
  const missed = [...wanted].filter((i) => !done.has(i)).sort((a, b) => a - b);
  if (missed.length) log(`render: ${missed.length} of ${wanted.size} slides could not be shown (navOk: false)`);
  return { visited, missed };
}

/** Waits up to 1 s (6.7) for slide `i` to be current; returns the current slide. */
async function waitForSlide(view: RenderView, i: number): Promise<number> {
  const end = Date.now() + 1000;
  let cur = (await view.current()).current;
  while (cur !== i && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 40));
    cur = (await view.current()).current;
  }
  await view.waitStable();
  return (await view.detect()).current;
}

/** Brings a generic deck that did not open on its first slide there: by hash, or back keys. */
async function toFirstSlide(view: RenderView, index: SlideIndex, back: NavKey, signal: AbortSignal | null): Promise<number> {
  const first = index.slides[0]?.nav;
  if (first && first.kind === 'hash' && typeof first.value === 'string' && (await view.setHash(first.value))) {
    if ((await waitForSlide(view, 0)) === 0) return 0;
  }
  let cur = (await view.detect()).current;
  for (let n = 0; cur !== 0 && n < Math.min(MAX_PRESSES, index.slides.length); n++) {
    throwIfCancelled(signal);
    const p = await pressPatiently(view, back, signal);
    if (!p.moved) break;
    cur = p.to;
  }
  return cur;
}

// ------------------------------------------------------------------------------------------- the walk

/** What one index walk carries: its document, the adaptive settle, the rail's thumbnails it takes, the log. */
interface IndexWalk {
  doc: RenderTarget;
  signal: AbortSignal | null;
  log: (m: string) => void;
  memory: SettleMemory;
  /** The rail's thumbnails, taken at each settled slide (null: not from this walk). */
  thumbs: IndexThumbs | null;
  joins: NodeJoins;
}

/** Thumbnails the index walk writes as it goes (decision D-5: one wait per slide for the index and the rail). */
interface IndexThumbs {
  dir: string;
  width: number;
  px: { width: number; height: number };
  taken: Set<number>;
}

/**
 * The rail's thumbnails can come from the index walk when the deck's thumbnails render at the index walk's own
 * viewport: designViewport(index, THUMB_SCALE) is INDEX_VIEWPORT (a deck whose design size is 1600×900).
 */
export function indexWalkTakesThumbs(kind: SlideIndexKind, design: { w: number; h: number }, width: number | null): boolean {
  if (!isDeck(kind) || width === null || !validThumbWidth(width)) return false;
  return design.w === INDEX_VIEWPORT.w && design.h === INDEX_VIEWPORT.h && THUMB_SCALE === INDEX_VIEWPORT.dpr;
}

/**
 * The settle before the walk reads slide `slide` (decision D-5: the index collects a slide's text after the
 * same scripted settle as a still image), then the rail's thumbnail of it when the walk takes them.
 */
async function settleSlide(view: RenderView, walk: IndexWalk, slide: number): Promise<void> {
  const w = await waitAdaptive(view, walk.memory, slide, walk.signal);
  const settle = w.settle;
  if (!w.quiet) walk.log(`index: slide ${slide + 1} kept changing; read after ${w.waitedMs} ms`);
  await view.waitStable();
  if (walk.thumbs && !walk.thumbs.taken.has(slide)) {
    walk.thumbs.taken.add(slide);
    await takeThumb(view, walk, walk.thumbs, slide);
    if (settle === QUIET_SETTLE && typeof w.stamp === 'number') {
      const now = await view.mutationStamp();
      if (now !== null && now > w.stamp) walk.memory.changedAfterQuiet();
    }
  }
}

/** One rail thumbnail from the settled slide, as thumbnails.ts renders it (paused, resized, PNG, atomic). */
async function takeThumb(view: RenderView, walk: IndexWalk, t: IndexThumbs, slide: number): Promise<void> {
  try {
    const file = path.join(t.dir, thumbFileName(walk.doc.version, slide, t.width));
    if (await fs.promises.lstat(file).then((st) => st.isFile() && st.size > 0, () => false)) return;
    await view.pauseAnimations();
    let png: Buffer | null = null;
    try {
      const cap = await view.capture();
      if (!cap.empty) png = cap.image.resize({ width: t.px.width, height: t.px.height, quality: 'best' }).toPNG();
    } finally {
      await view.resumeAnimations();
    }
    if (!png) return;
    throwIfCancelled(walk.signal);
    await fs.promises.mkdir(t.dir, { recursive: true, mode: 0o700 });
    await atomicWriteFile(file, new Uint8Array(png.buffer, png.byteOffset, png.byteLength), { newFileMode: 0o600 });
  } catch (e) {
    if (e instanceof RenderCancelled) throw e;
    // The thumbnail run renders what the walk could not.
    walk.log(`index: slide ${slide + 1}: no thumbnail (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Methods of a render view that show another slide or position (a settle is due before the next read). */
const MOVES: ReadonlySet<string> = new Set(['load', 'pressKey', 'goto', 'setHash', 'scrollTo', 'scrollToTop', 'scrollToHeading', 'showRevealFragments']);

/**
 * The render view the map's DeckWalker walks for the index: whenever the deck moved since the last wait (a
 * load, a key, a hash), its waitStable, which the walker calls before every collect, also waits for what the
 * slide's scripts reveal and takes the slide's thumbnail (settleSlide); its collect records the block joins.
 * Everything else is the view itself.
 */
function settlingView(view: RenderView, walk: IndexWalk, count: () => number): RenderView {
  let moved = true;
  return new Proxy(view, {
    get(target, prop) {
      if (prop === 'waitStable') {
        return async (maxMs?: number) => {
          const r = await target.waitStable(maxMs);
          if (!moved) return r;
          moved = false;
          const cur = Math.min(Math.max(0, (await target.detect()).current), Math.max(0, count() - 1));
          await settleSlide(target, walk, cur);
          return r;
        };
      }
      if (prop === 'collect') {
        return async () => {
          const res = await target.collect();
          noteJoins(res, walk.joins);
          return res;
        };
      }
      const v: unknown = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (typeof prop === 'string' && MOVES.has(prop)) {
        return (...a: unknown[]) => {
          moved = true;
          return fn.apply(target, a);
        };
      }
      return fn.bind(target);
    },
  });
}

/** The index walk on a loaded-or-not view at INDEX_VIEWPORT. */
async function walkIndex(view: RenderView, doc: RenderTarget, signal: AbortSignal | null, log: (m: string) => void, opts: { userData: string; thumbWidth: number | null }): Promise<SlideIndex> {
  throwIfCancelled(signal);
  await view.load(doc);
  await view.waitStable();
  if (await view.overlayMounted()) throw new RenderError('a render view showed the overlay; render mode has no UI (6.7)');
  const det = await view.detect();
  const kind = det.kind;
  const memory = settleMemoryFor(doc.fileKey, doc.version);
  const walk: IndexWalk = { doc, signal, log, memory, thumbs: null, joins: new Map() };
  const design = chooseDesignSize(kind, det.designSize);
  if (indexWalkTakesThumbs(kind, design, opts.thumbWidth)) {
    const width = opts.thumbWidth as number;
    walk.thumbs = { dir: thumbsDir(opts.userData, doc.fileKey), width, px: thumbPixelSize(design, width), taken: new Set() };
  }
  if (kind === 'reveal') return revealIndex(view, walk, det);
  if (kind === 'generic') return genericIndex(view, walk, det);
  // A document is one page: what its scripts fill in after load is read after one settle (decision D-5).
  await settleScripted(view, signal, log, { memory, slot: null });
  const outline = await view.documentOutline();
  return {
    version: doc.version,
    kind,
    navKind: det.navKind,
    slides: documentEntries(outline.sections, (await view.documentTitle()) || doc.title),
    designSize: design,
    complete: !outline.cut,
  };
}

/** reveal.js: Reveal.slide(h, v) for each slide (section 10 step 3), every fragment shown, settled, then collect. */
async function revealIndex(view: RenderView, walk: IndexWalk, det: DetectResult): Promise<SlideIndex> {
  const count = Math.min(det.count, INDEX_LIMITS.slides);
  const seen = new Set<number>();
  const nodes: { w: WalkNode; slide: number }[] = [];
  const reached: boolean[] = new Array(count).fill(false);
  for (let i = 0; i < count; i++) {
    throwIfCancelled(walk.signal);
    const r = await view.goto(i);
    const pair = det.revealIndices?.[i];
    if (pair) await view.showRevealFragments(pair[0], pair[1]);
    await view.waitStable();
    await settleSlide(view, walk, i);
    const cur = (await view.detect()).current;
    if (r.current === i || cur === i) reached[i] = true;
    const res = await view.collect();
    noteJoins(res, walk.joins);
    for (const w of res.nodes) {
      if (seen.has(w.key)) continue;
      seen.add(w.key);
      nodes.push({ w, slide: typeof w.slide === 'number' && w.slide < count ? w.slide : Math.min(cur, count - 1) });
    }
  }
  return {
    version: walk.doc.version,
    kind: 'reveal',
    navKind: 'reveal',
    slides: deckEntries({ ...det, count }, textBySlide(nodes, count, walk.joins)),
    designSize: chooseDesignSize('reveal', det.designSize),
    complete: reached.every(Boolean),
  };
}

/** A generic engine: the map's DeckWalker (on settlingView); then the stored deckNav keys for what it did not reach. */
async function genericIndex(view: RenderView, walk: IndexWalk, first: DetectResult): Promise<SlideIndex> {
  const doc = walk.doc;
  const settling = settlingView(view, walk, () => first.count);
  const walker = new DeckWalker(settling, (m) => walk.log(`index: ${m}`));
  const result = await walker.walk(doc);
  throwIfCancelled(walk.signal);
  const count = Math.min(result.detect.count, INDEX_LIMITS.slides);
  const nodes = result.nodes.map((n) => ({ w: n.w, slide: n.slide }));
  const reached = result.reached.slice(0, count);
  // The hashes as known after the walk: a deck that opens with no hash shows its format only after a move.
  let det: DetectResult = { ...result.detect, count };
  const last = await view.detect();
  if (last.kind === 'generic' && last.count === result.detect.count) det = { ...det, navKind: last.navKind, hashes: last.hashes, ids: last.ids ?? det.ids };
  const keys = replayKeys(doc.deckNav);
  if (reached.includes(false) && !['ArrowRight', 'PageDown'].includes(keys.forward)) {
    await supplementWalk(settling, walk, keys, count, reached, nodes);
  }
  return {
    version: doc.version,
    kind: 'generic',
    navKind: det.navKind,
    slides: deckEntries(det, textBySlide(nodes, count, walk.joins)),
    designSize: chooseDesignSize('generic', first.designSize),
    complete: reached.every(Boolean),
  };
}

/**
 * Index replay with Session.deckNav's keys (ArrowDown, Space…): reload, from slide 0, collect each new slide
 * (on settlingView: each one settled first, as the walk's own).
 */
async function supplementWalk(
  view: RenderView,
  walk: IndexWalk,
  keys: ReturnType<typeof replayKeys>,
  count: number,
  reached: boolean[],
  nodes: { w: WalkNode; slide: number }[],
): Promise<void> {
  await view.load(walk.doc);
  await view.waitStable();
  const seenText = new Set(nodes.map((n) => `${n.slide}\u0000${n.w.node.data}`));
  const take = async (cur: number) => {
    reached[cur] = true;
    for (const w of (await view.collect()).nodes) {
      const slide = typeof w.slide === 'number' && w.slide < count ? w.slide : cur;
      const k = `${slide}\u0000${w.node.data}`;
      if (seenText.has(k)) continue;
      seenText.add(k);
      nodes.push({ w, slide });
    }
  };
  let cur = (await view.detect()).current;
  if (cur === 0) await take(0);
  for (let presses = 0; presses < MAX_PRESSES && cur < count - 1 && reached.includes(false); presses++) {
    throwIfCancelled(walk.signal);
    const p = await pressPatiently(view, keys.forward, walk.signal);
    if (!p.moved) break;
    cur = p.to;
    await view.waitStable();
    await take(cur);
  }
}

// ------------------------------------------------------------------------------------------- the API

export interface BuildIndexOptions {
  signal?: AbortSignal | null;
  host?: RenderHost;
  /** Rebuild even when a cached index exists. */
  force?: boolean;
  /**
   * The width (CSS px) of the rail thumbnails the walk writes as it goes, when the deck's thumbnails render at
   * the walk's own viewport (indexWalkTakesThumbs). Default the rail's (views.ts railThumbWidth of
   * layout.ts LEFT_RAIL_WIDTH), so the window's thumbnail run finds them cached; null: none.
   */
  thumbWidth?: number | null;
}

/** The rail's thumbnail width (the window asks renderThumbnails for this one). */
export const RAIL_THUMB_WIDTH = railThumbWidth(LEFT_RAIL_WIDTH);

const memory = new Map<string, SlideIndex>();
/** Walks in flight, with the signal of the caller that started them (a later caller never joins an aborted one). */
const building = new Map<string, { job: Promise<SlideIndex>; signal: AbortSignal | null }>();
/** Memory cache entries are kept for the most recent versions only (an index may hold up to 8 M characters). */
const MEMORY_MAX = 8;

function cacheKey(fileKey: string, version: string): string {
  return `${fileKey}:${version}`;
}

/** The cached index of (fileKey, version), from memory only; null when it was never built in this run. */
export function cachedSlideIndex(fileKey: string, version: string): SlideIndex | null {
  return memory.get(cacheKey(fileKey, version)) ?? null;
}

function remember(fileKey: string, index: SlideIndex): void {
  const k = cacheKey(fileKey, index.version);
  memory.delete(k);
  memory.set(k, index);
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string);
}

/** Forgets every cached index of a file except `keepVersion` (memory only; thumbnails.ts prunes the disk). */
export function forgetOtherIndexes(fileKey: string, keepVersion: string): void {
  for (const k of [...memory.keys()]) if (k.startsWith(`${fileKey}:`) && k !== cacheKey(fileKey, keepVersion)) memory.delete(k);
}

/**
 * The slide index of the document's current version: from memory, else from its cache file, else one walk
 * in a render view (6.7 Background renders). Concurrent calls for the same version share one walk.
 */
export async function buildSlideIndex(doc: RenderTarget, opts: BuildIndexOptions = {}): Promise<SlideIndex> {
  if (!VERSION.test(doc.version)) throw new RenderError('invalid document version');
  const host = opts.host ?? renderHost();
  const key = cacheKey(doc.fileKey, doc.version);
  if (!opts.force) {
    const hit = memory.get(key);
    if (hit) return hit;
    const pending = building.get(key);
    // A walk its caller aborted (a window closed, its render views disposed) fails; a new caller walks again.
    if (pending && !pending.signal?.aborted) return pending.job;
  }
  const ptag = doc.renderPolicyTag();
  const pruneOthers = async (): Promise<void> => {
    const n = await pruneOtherIndexFiles(host.userData, doc.fileKey, doc.version);
    if (n) host.log(`slide index: removed ${n} index files of older versions`);
  };
  const job = (async () => {
    if (!opts.force) {
      const disk = await readCachedIndex(host.userData, doc.fileKey, doc.version);
      if (disk && (disk.policyTag ?? '') === ptag) {
        if (disk.complete) await pruneOthers();
        return disk;
      }
      if (disk) {
        // Cached under a different trust policy (review finding 15): a Protected render blocks non-allowlisted
        // hosts, so its index and thumbnails miss remote text and images. Drop this version's thumbnails so the
        // walk re-renders them under the policy now, and rebuild the index.
        const n = await removeVersionThumbs(host.userData, doc.fileKey, doc.version);
        host.log(`slide index: ${doc.fileName}: cached under a different trust policy; rebuilding (removed ${n} thumbnails)`);
      }
    }
    await untilQuiet(doc.fileKey, opts.signal);
    const t0 = Date.now();
    const thumbWidth = opts.thumbWidth === undefined ? RAIL_THUMB_WIDTH : opts.thumbWidth;
    const index = await rendererFor(doc, host).use(INDEX_VIEWPORT, (view) => walkIndex(view, doc, opts.signal ?? null, host.log, { userData: host.userData, thumbWidth }), opts.signal);
    index.policyTag = ptag;
    host.log(`slide index: ${doc.fileName}: ${index.kind}, ${index.slides.length} entries${index.complete ? '' : ' (incomplete)'} in ${Date.now() - t0} ms`);
    // An incomplete walk is not kept on disk: a later walk with the keys the visible view learns
    // (Session.deckNav) may reach every slide of the same version.
    if (index.complete) {
      try {
        await writeCachedIndex(host.userData, doc.fileKey, index);
        await pruneOthers();
      } catch (e) {
        host.log(`slide index: not cached (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    return index;
  })();
  const entry = { job, signal: opts.signal ?? null };
  building.set(key, entry);
  try {
    const index = await job;
    remember(doc.fileKey, index);
    return index;
  } finally {
    if (building.get(key) === entry) building.delete(key);
  }
}
