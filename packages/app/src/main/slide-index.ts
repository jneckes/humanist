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
// - The design size (6.9): reveal.js width and height, else the slide element's box at a 1600×900 viewport,
//   else 1600×900. The walk runs at 1600×900 for that reason.
// - Background renders use reduced motion (docs/PHASE1-PLAN.md): the render views emulate it.
// - A render waits until the document has had no write for 300 ms (6.7 step 1; render-service untilQuiet).
// - Cached per (fileKey, version) in memory and as JSON at <userData>/files/<fileKey>/thumbs/index-<version>.json
//   (9.7 thumbs/).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DetectResult, WalkNode } from '@blueline/core/ipc';
import type { SlideIndex, SlideIndexEntry, SlideIndexKind } from '@blueline/core/ipc-render';
import { DEFAULT_DESIGN } from '@blueline/core/slides';
import type { SlideRef } from '@blueline/core/types';
import { atomicWriteFile, readRegularFile } from './atomic-write';
import { DeckWalker, MAX_PRESSES, PRESS_RETRY_GAPS_MS } from './map-command';
import { slideRefFor } from './notes';
import {
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

/** The walk's nodes as text per slide, in walk order (each collect is in document order). */
export function textBySlide(nodes: readonly { w: Pick<WalkNode, 'node'>; slide: number }[], count: number): string[][] {
  const per: string[][] = Array.from({ length: count }, () => []);
  for (const n of nodes) {
    if (n.slide >= 0 && n.slide < count) per[n.slide].push(n.w.node.data);
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
  return { version, kind: v.kind as SlideIndexKind, navKind: v.navKind as SlideRef['nav']['kind'], slides, designSize: ds, complete: v.complete };
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
  /** How long a slide may take to show what its scripts reveal (RenderView.waitScripted); default SCRIPTED_SETTLE. */
  scripted?: ScriptedSettle;
}

export interface ScriptedSettle {
  minMs: number;
  quietMs: number;
  maxMs: number;
}

/**
 * The wait for script-timed content before a still image of a slide (RenderView.waitScripted). At least 1.5 s
 * on the slide: a deck that reveals a slide's content from a timer (D5 types its draft 1.3 s after the slide
 * arrives) otherwise lost it from thumbnails and PDF pages; then 400 ms without a DOM change; at most 3 s
 * (a clock or a ticker never goes quiet). It costs about 1.5 s per slide, and only background renders and
 * Save as PDF and Print pay it.
 */
export const SCRIPTED_SETTLE: Readonly<ScriptedSettle> = Object.freeze({ minMs: 1500, quietMs: 400, maxMs: 3000 });

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
  const scripted = opts.scripted ?? SCRIPTED_SETTLE;
  const at = async (i: number): Promise<void> => {
    if (!wanted.has(i) || done.has(i)) return;
    throwIfCancelled(signal);
    // 6.7 step 3, and what the deck's scripts reveal after the slide arrives (waitScripted), then fonts,
    // frames and the finite animations that reveal started.
    await view.waitStable();
    const w = await view.waitScripted(scripted, signal);
    if (!w.quiet) log(`render: slide ${i + 1} kept changing; captured after ${w.waitedMs} ms`);
    await view.waitStable();
    await view.pauseAnimations();
    try {
      await visit(i);
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

/** The index walk on a loaded-or-not view at INDEX_VIEWPORT. */
async function walkIndex(view: RenderView, doc: RenderTarget, signal: AbortSignal | null, log: (m: string) => void): Promise<SlideIndex> {
  throwIfCancelled(signal);
  await view.load(doc);
  await view.waitStable();
  if (await view.overlayMounted()) throw new RenderError('a render view showed the overlay; render mode has no UI (6.7)');
  const det = await view.detect();
  const kind = det.kind;
  if (kind === 'reveal') return revealIndex(view, doc, det, signal);
  if (kind === 'generic') return genericIndex(view, doc, det, signal, log);
  const outline = await view.documentOutline();
  return {
    version: doc.version,
    kind,
    navKind: det.navKind,
    slides: documentEntries(outline.sections, (await view.documentTitle()) || doc.title),
    designSize: chooseDesignSize(kind, det.designSize),
    complete: !outline.cut,
  };
}

/** reveal.js: Reveal.slide(h, v) for each slide (section 10 step 3), every fragment shown, then collect. */
async function revealIndex(view: RenderView, doc: RenderTarget, det: DetectResult, signal: AbortSignal | null): Promise<SlideIndex> {
  const count = Math.min(det.count, INDEX_LIMITS.slides);
  const seen = new Set<number>();
  const nodes: { w: WalkNode; slide: number }[] = [];
  const reached: boolean[] = new Array(count).fill(false);
  for (let i = 0; i < count; i++) {
    throwIfCancelled(signal);
    const r = await view.goto(i);
    const pair = det.revealIndices?.[i];
    if (pair) await view.showRevealFragments(pair[0], pair[1]);
    await view.waitStable();
    const cur = (await view.detect()).current;
    if (r.current === i || cur === i) reached[i] = true;
    for (const w of (await view.collect()).nodes) {
      if (seen.has(w.key)) continue;
      seen.add(w.key);
      nodes.push({ w, slide: typeof w.slide === 'number' && w.slide < count ? w.slide : Math.min(cur, count - 1) });
    }
  }
  return {
    version: doc.version,
    kind: 'reveal',
    navKind: 'reveal',
    slides: deckEntries({ ...det, count }, textBySlide(nodes, count)),
    designSize: chooseDesignSize('reveal', det.designSize),
    complete: reached.every(Boolean),
  };
}

/** A generic engine: the map's DeckWalker; then the stored deckNav keys for what it did not reach. */
async function genericIndex(view: RenderView, doc: RenderTarget, first: DetectResult, signal: AbortSignal | null, log: (m: string) => void): Promise<SlideIndex> {
  const walker = new DeckWalker(view, (m) => log(`index: ${m}`));
  const walk = await walker.walk(doc);
  throwIfCancelled(signal);
  const count = Math.min(walk.detect.count, INDEX_LIMITS.slides);
  const nodes = walk.nodes.map((n) => ({ w: n.w, slide: n.slide }));
  const reached = walk.reached.slice(0, count);
  // The hashes as known after the walk: a deck that opens with no hash shows its format only after a move.
  let det: DetectResult = { ...walk.detect, count };
  const last = await view.detect();
  if (last.kind === 'generic' && last.count === walk.detect.count) det = { ...det, navKind: last.navKind, hashes: last.hashes, ids: last.ids ?? det.ids };
  const keys = replayKeys(doc.deckNav);
  if (reached.includes(false) && !['ArrowRight', 'PageDown'].includes(keys.forward)) {
    await supplementWalk(view, doc, keys, count, reached, nodes, signal);
  }
  return {
    version: doc.version,
    kind: 'generic',
    navKind: det.navKind,
    slides: deckEntries(det, textBySlide(nodes, count)),
    designSize: chooseDesignSize('generic', first.designSize),
    complete: reached.every(Boolean),
  };
}

/** Index replay with Session.deckNav's keys (ArrowDown, Space…): reload, from slide 0, collect each new slide. */
async function supplementWalk(
  view: RenderView,
  doc: RenderTarget,
  keys: ReturnType<typeof replayKeys>,
  count: number,
  reached: boolean[],
  nodes: { w: WalkNode; slide: number }[],
  signal: AbortSignal | null,
): Promise<void> {
  await view.load(doc);
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
    throwIfCancelled(signal);
    const p = await pressPatiently(view, keys.forward, signal);
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
}

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
  const job = (async () => {
    if (!opts.force) {
      const disk = await readCachedIndex(host.userData, doc.fileKey, doc.version);
      if (disk) return disk;
    }
    await untilQuiet(doc.fileKey, opts.signal);
    const t0 = Date.now();
    const index = await rendererFor(doc, host).use(INDEX_VIEWPORT, (view) => walkIndex(view, doc, opts.signal ?? null, host.log), opts.signal);
    host.log(`slide index: ${doc.fileName}: ${index.kind}, ${index.slides.length} entries${index.complete ? '' : ' (incomplete)'} in ${Date.now() - t0} ms`);
    // An incomplete walk is not kept on disk: a later walk with the keys the visible view learns
    // (Session.deckNav) may reach every slide of the same version.
    if (index.complete) {
      try {
        await writeCachedIndex(host.userData, doc.fileKey, index);
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
