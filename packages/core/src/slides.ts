// Slide detection (9.4). DOM code, used only by the deck preload (deck, render and diagnostics modes).
// It runs in the isolated world and reads the shared DOM; it never touches the page's JavaScript. Values
// that only the page's world knows (reveal.js's config) are passed in by the caller, which reads them with
// webFrame.executeJavaScript and treats them as untrusted numbers.

import type { DetectResult } from './ipc';
import type { SlideNavKind } from './types';

/** reveal.js slides: `.reveal .slides > section`, including nested (vertical) sections (9.4 step 1). */
const REVEAL_SELECTOR = '.reveal .slides > section';
/** Generic slide engine candidates (9.4 step 2). */
const GENERIC_SELECTOR = 'section, .slide, [data-slide]';
/** Default design size (6.9). */
export const DEFAULT_DESIGN = Object.freeze({ w: 1600, h: 900 });
/** Titles are trimmed to 80 characters (8 SlideRef.title). */
export const TITLE_MAX = 80;

/**
 * How a hash-routed deck spells a slide's hash (9.4 step 2: "if the deck updates the hash"). Inferred by
 * comparing `location.hash` with the current slide; anything else is not navigable by hash.
 */
export type HashFormat = '#id' | '#/id' | '#n0' | '#n1' | '#/n0' | '#/n1';

/** The detected model: the DetectResult plus the slide elements, in order. */
export interface SlideModel extends DetectResult {
  /** The slide elements (reveal: leaf sections; generic: the sibling slides; scroll: the blocks; single: body). */
  slides: Element[];
  hashFormat: HashFormat | null;
}

export interface DetectOptions {
  /** reveal.js `width`/`height` from `Reveal.getConfig()`, read from the main world by the caller (6.9). */
  revealConfig?: { width: number; height: number } | null;
  /**
   * A hash format seen to move together with the slide in this page load (sticky evidence from the slide
   * watcher). A generic deck that opens with no hash only shows it after its first move (generic-hash fixture).
   */
  hashFormat?: HashFormat | null;
  /** Elements never considered slides (the overlay's shadow host). */
  host?: Element | null;
}

/** Collapses whitespace and trims to 80 UTF-16 units without splitting a surrogate pair (8 SlideRef.title). */
export function trimTitle(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= TITLE_MAX) return t;
  let end = TITLE_MAX;
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return t.slice(0, end).trimEnd();
}

/** The slide title: the first non-empty h1-h3, else `data-title`, else "Slide N" (9.4). */
export function slideTitle(el: Element, index: number): string {
  for (const h of Array.from(el.querySelectorAll('h1, h2, h3'))) {
    const t = trimTitle(h.textContent ?? '');
    if (t) return t;
  }
  const dt = trimTitle(el.getAttribute('data-title') ?? '');
  if (dt) return dt;
  return `Slide ${index + 1}`;
}

/** Visible as 9.4 defines it for slides: a non-zero box, `visibility: visible`, opacity above 0. */
export function isSlideVisible(el: Element, win: Window): boolean {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;
  const cs = win.getComputedStyle(el);
  return cs.visibility === 'visible' && !(parseFloat(cs.opacity) <= 0);
}

function opacityOf(el: Element, win: Window): number {
  const o = parseFloat(win.getComputedStyle(el).opacity);
  return Number.isFinite(o) ? o : 1;
}

/** The hash format that makes `hash` the hash of slide `index` (with element id `id`), or null. */
export function inferHashFormat(hash: string, index: number, id: string | null): HashFormat | null {
  if (!hash || hash === '#') return null;
  let raw: string;
  try {
    raw = decodeURIComponent(hash);
  } catch {
    raw = hash;
  }
  if (id) {
    if (raw === '#' + id) return '#id';
    if (raw === '#/' + id) return '#/id';
  }
  if (raw === '#' + index) return '#n0';
  if (raw === '#' + (index + 1)) return '#n1';
  if (raw === '#/' + index) return '#/n0';
  if (raw === '#/' + (index + 1)) return '#/n1';
  return null;
}

/** The hash of slide `index` in a format, or null when the slide cannot be named that way (no id). */
export function hashFor(format: HashFormat, index: number, id: string | null): string | null {
  switch (format) {
    case '#id':
      return id ? '#' + encodeURI(id).replace(/#/g, '%23') : null;
    case '#/id':
      return id ? '#/' + encodeURI(id).replace(/#/g, '%23') : null;
    case '#n0':
      return '#' + index;
    case '#n1':
      return '#' + (index + 1);
    case '#/n0':
      return '#/' + index;
    case '#/n1':
      return '#/' + (index + 1);
  }
}

function idOf(el: Element): string | null {
  const id = el.getAttribute('id');
  return id ? id : null;
}

function insideHost(el: Element, host: Element | null | undefined): boolean {
  return !!host && (el === host || host.contains(el));
}

function positivePx(v: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 100000 ? n : null;
}

/** The slide element's layout box (untransformed), or its client rect, or null. */
function boxOf(el: Element): { w: number; h: number } | null {
  const he = el as HTMLElement;
  if (typeof he.offsetWidth === 'number' && he.offsetWidth > 0 && he.offsetHeight > 0) {
    return { w: he.offsetWidth, h: he.offsetHeight };
  }
  const r = el.getBoundingClientRect();
  if (r.width >= 1 && r.height >= 1) return { w: Math.round(r.width), h: Math.round(r.height) };
  return null;
}

// ------------------------------------------------------------------------------------------- reveal.js

function detectReveal(doc: Document, win: Window, opts: DetectOptions): SlideModel | null {
  const horizontals = Array.from(doc.querySelectorAll(REVEAL_SELECTOR)).filter((s) => !insideHost(s, opts.host));
  if (horizontals.length === 0) return null;
  const slides: Element[] = [];
  const indices: [number, number][] = [];
  horizontals.forEach((h, hi) => {
    const verticals = Array.from(h.children).filter((c) => c.localName === 'section');
    if (verticals.length === 0) {
      slides.push(h);
      indices.push([hi, 0]);
    } else {
      verticals.forEach((v, vi) => {
        slides.push(v);
        indices.push([hi, vi]);
      });
    }
  });
  const current = revealCurrent(slides);
  const ids = slides.map(idOf);
  const model: SlideModel = {
    kind: 'reveal',
    count: slides.length,
    current,
    titles: slides.map((s, i) => slideTitle(s, i)),
    navKind: 'reveal',
    designSize: revealDesignSize(doc, slides[current] ?? slides[0], opts),
    revealIndices: indices,
    ids,
    slides,
    hashFormat: null,
  };
  // reveal.js with `hash: true` writes `#/<id>` or `#/<h>/<v>`. Navigation stays Reveal.slide(h, v); the
  // hashes are informational, given only when the page shows that it uses them.
  if (win.location.hash.startsWith('#/')) {
    model.hashes = slides.map((s, i) => {
      const id = ids[i];
      if (id) return '#/' + id;
      const [h, v] = indices[i];
      return v > 0 ? `#/${h}/${v}` : `#/${h}`;
    });
  }
  return model;
}

/** The leaf slide reveal.js marks `present` (a stack and its current child both carry it). */
function revealCurrent(slides: Element[]): number {
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    if (!s.classList.contains('present')) continue;
    const parent = s.parentElement;
    if (parent && parent.localName === 'section' && !parent.classList.contains('present')) continue;
    return i;
  }
  return 0;
}

function revealDesignSize(doc: Document, slide: Element | undefined, opts: DetectOptions): { w: number; h: number } {
  const cfg = opts.revealConfig;
  if (cfg && Number.isFinite(cfg.width) && Number.isFinite(cfg.height) && cfg.width >= 1 && cfg.height >= 1 && cfg.width <= 100000 && cfg.height <= 100000) {
    return { w: Math.round(cfg.width), h: Math.round(cfg.height) };
  }
  // reveal.js writes the configured size onto `.slides` as inline CSS width and height when it lays out.
  const slidesEl = doc.querySelector('.reveal .slides') as HTMLElement | null;
  if (slidesEl) {
    const w = positivePx(slidesEl.style.width);
    const h = positivePx(slidesEl.style.height);
    if (w && h) return { w: Math.round(w), h: Math.round(h) };
  }
  const box = slide ? boxOf(slide) : null;
  return box ?? { ...DEFAULT_DESIGN };
}

// ------------------------------------------------------------------------------------------- generic

function detectGeneric(doc: Document, win: Window, opts: DetectOptions): SlideModel | null {
  const groups = new Map<Element, Element[]>();
  for (const el of Array.from(doc.querySelectorAll(GENERIC_SELECTOR))) {
    if (insideHost(el, opts.host)) continue;
    const p = el.parentElement;
    if (!p) continue;
    let g = groups.get(p);
    if (!g) groups.set(p, (g = []));
    g.push(el);
  }
  let best: Element[] | null = null;
  for (const g of groups.values()) {
    // Three or more siblings, at most one or two visible at a time (9.4 step 2).
    if (g.length < 3) continue;
    let visible = 0;
    for (const s of g) if (isSlideVisible(s, win)) visible++;
    if (visible > 2) continue;
    if (!best || g.length > best.length) best = g;
  }
  if (!best) return null;
  const slides = best;
  const current = genericCurrent(slides, win);
  const ids = slides.map(idOf);
  const model: SlideModel = {
    kind: 'generic',
    count: slides.length,
    current,
    titles: slides.map((s, i) => slideTitle(s, i)),
    navKind: 'index',
    designSize: boxOf(slides[current] ?? slides[0]) ?? { ...DEFAULT_DESIGN },
    ids,
    slides,
    hashFormat: null,
  };
  applyHashNav(model, win, opts);
  return model;
}

/** The visible slide; with two visible (a transition), the more opaque one, then the first. */
function genericCurrent(slides: Element[], win: Window): number {
  let best = -1;
  let bestOpacity = -1;
  for (let i = 0; i < slides.length; i++) {
    if (!isSlideVisible(slides[i], win)) continue;
    const o = opacityOf(slides[i], win);
    if (o > bestOpacity) {
      best = i;
      bestOpacity = o;
    }
  }
  return best < 0 ? 0 : best;
}

/**
 * 9.4 step 2: navigate by hash only when the deck updates the hash. Evidence is the current hash naming
 * the current slide, or a format the watcher saw move with the slide. Every slide must be nameable in that
 * format; otherwise the deck stays `index` (refuse rather than guess).
 */
function applyHashNav(model: SlideModel, win: Window, opts: DetectOptions): void {
  const ids = model.ids ?? [];
  const fmt = inferHashFormat(win.location.hash, model.current, ids[model.current] ?? null) ?? opts.hashFormat ?? null;
  if (!fmt) return;
  const hashes: string[] = [];
  for (let i = 0; i < model.count; i++) {
    const h = hashFor(fmt, i, ids[i] ?? null);
    if (h === null) return;
    hashes.push(h);
  }
  model.navKind = 'hash';
  model.hashes = hashes;
  model.hashFormat = fmt;
}

// ------------------------------------------------------------------------------------------- scrolling

/** Outermost `section[id]` elements, or large sibling blocks (9.4 step 3). */
export function scrollBlocks(doc: Document, win: Window, host?: Element | null): Element[] {
  const sections = Array.from(doc.querySelectorAll('section[id]')).filter((s) => {
    if (insideHost(s, host)) return false;
    for (let a = s.parentElement; a; a = a.parentElement) if (a.localName === 'section' && a.hasAttribute('id')) return false;
    return true;
  });
  if (sections.length >= 2) return sections;
  return largeSiblingBlocks(doc, win, host);
}

/**
 * Siblings that are each at least half the viewport tall, three or more of them, together taller than the
 * viewport: the document scrolls through them. The parent with the most such children wins.
 */
function largeSiblingBlocks(doc: Document, win: Window, host?: Element | null): Element[] {
  const body = doc.body;
  if (!body) return [];
  const minH = win.innerHeight * 0.5;
  let best: Element[] = [];
  const visit = (parent: Element, depth: number) => {
    if (depth > 6 || insideHost(parent, host)) return;
    const big: Element[] = [];
    let total = 0;
    for (const c of Array.from(parent.children)) {
      if (insideHost(c, host)) continue;
      const r = c.getBoundingClientRect();
      if (r.height >= minH && r.width > 0) {
        big.push(c);
        total += r.height;
      }
    }
    if (big.length >= 3 && total > win.innerHeight && big.length > best.length) best = big;
    for (const c of Array.from(parent.children)) visit(c, depth + 1);
  };
  visit(body, 0);
  return best;
}

function detectScroll(doc: Document, win: Window, opts: DetectOptions): SlideModel | null {
  const blocks = scrollBlocks(doc, win, opts.host);
  if (blocks.length < 2) return null;
  return {
    kind: 'scroll',
    count: blocks.length,
    current: scrollCurrent(blocks, win),
    titles: blocks.map((s, i) => slideTitle(s, i)),
    navKind: 'scroll',
    designSize: { ...DEFAULT_DESIGN },
    ids: blocks.map(idOf),
    slides: blocks,
    hashFormat: null,
  };
}

/** The last block whose top is in the upper third of the viewport, else the first. */
function scrollCurrent(blocks: Element[], win: Window): number {
  let cur = 0;
  const line = win.innerHeight / 3;
  for (let i = 0; i < blocks.length; i++) if (blocks[i].getBoundingClientRect().top <= line) cur = i;
  return cur;
}

// ------------------------------------------------------------------------------------------- single

function detectSingle(doc: Document): SlideModel {
  const root = doc.body ?? doc.documentElement;
  const titles = [root ? slideTitle(root, 0) : 'Slide 1'];
  return {
    kind: 'single',
    count: 1,
    current: 0,
    titles,
    navKind: 'none',
    designSize: { ...DEFAULT_DESIGN },
    ids: [null],
    slides: root ? [root] : [],
    hashFormat: null,
  };
}

// ------------------------------------------------------------------------------------------- API

/** Detects the slide model in the 9.4 order: reveal.js, generic engine, scrolling document, single page. */
export function detectSlides(doc: Document, win: Window, opts: DetectOptions = {}): SlideModel {
  return detectReveal(doc, win, opts) ?? detectGeneric(doc, win, opts) ?? detectScroll(doc, win, opts) ?? detectSingle(doc);
}

/** The current slide of a model right now, without re-detecting. */
export function currentSlide(model: SlideModel, win: Window): number {
  switch (model.kind) {
    case 'reveal':
      return revealCurrent(model.slides);
    case 'generic':
      return genericCurrent(model.slides, win);
    case 'scroll':
      return scrollCurrent(model.slides, win);
    default:
      return 0;
  }
}

/** The index of the slide that contains `node`, or null. */
export function slideIndexOf(model: SlideModel, node: Node): number | null {
  for (let i = 0; i < model.slides.length; i++) if (model.slides[i].contains(node)) return i;
  return null;
}

/** The model as plain data (DetectResult), without element references, for IPC. */
export function toDetectResult(model: SlideModel): DetectResult {
  const out: DetectResult = {
    kind: model.kind,
    count: model.count,
    current: model.current,
    titles: model.titles.slice(),
    navKind: model.navKind as SlideNavKind,
    designSize: { w: model.designSize.w, h: model.designSize.h },
  };
  if (model.revealIndices) out.revealIndices = model.revealIndices.map(([h, v]) => [h, v] as [number, number]);
  if (model.hashes) out.hashes = model.hashes.slice();
  if (model.ids) out.ids = model.ids.slice();
  return out;
}

/** True when the slide list itself (not just the current slide) differs between two models. */
export function sameSlides(a: SlideModel | null, b: SlideModel | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.count !== b.count || a.navKind !== b.navKind) return false;
  for (let i = 0; i < a.slides.length; i++) if (a.slides[i] !== b.slides[i] || a.titles[i] !== b.titles[i]) return false;
  return true;
}
