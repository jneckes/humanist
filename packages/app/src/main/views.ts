// The deck and document views (6.9 Reading; 6.0 The window): where the deck view goes in the content area, at
// what zoom, and what the rail, the outline and Find navigate to. Main owns these numbers, as it owns the bars'
// (layout.ts): the deck view (a WebContentsView) sits in a clipping container View over the shell's content
// area, and the shell draws the letterbox and, when the deck view is larger than the window, the scroll bars.
//
// - Deck view (9.4 reveal and generic): the deck renders at its design size and is scaled with
//   webContents.setZoomFactor (PHASE0-FINDINGS F5: CSS zoom resolves vw, vh and media queries against the small
//   window; setZoomFactor keeps the page's viewport at the design size). The deck view's own zoom mode is
//   'isolated' (Phase 1 finding: with Chromium's per-host default, the zoom reached the document's offscreen
//   render windows, which share its partition and host, and their 1600×900 walk laid out at 2723×1531).
//   - Fit (default): the design size scaled to fit the content area, centred, letterboxed.
//   - 100%: the design size at zoom 1. Fill width: scaled to the content width.
//   - Either may be larger than the content area: then the container is the content area less the scroll bars'
//     gutters, the deck view keeps its full size inside it (the container clips it), and the shell's scroll bars
//     (drag, or the wheel over them) and the wheel over a page that does not use it move the deck view.
// - Document view (scroll, single): no zoom, the page at the content width; View › Reading Width narrows the
//   view to 960 px, centred (6.9: "without touching the page's CSS").
// - Present: the whole window; decks at Fit, documents at reading width (6.9 Present).
//
// The pure parts are unit-tested (test/unit/app/views.test.ts); window.ts applies them.

import type { DetectResult, SlideState } from '@blueline/core/ipc';
import type { SlideIndex } from '@blueline/core/ipc-render';
import {
  READING_WIDTH,
  SCROLLBAR_SIZE,
  SHELL_COMMANDS,
  VIEWS_LIMITS,
  ZOOM_LIMITS,
  type DesignReport,
  type GotoRequest,
  type PageStep,
  type ShellCommand,
  type ShellIndex,
  type ViewKind,
  type WheelPan,
  type ZoomMode,
} from '@blueline/core/ipc-views';
import { DEFAULT_DESIGN } from '@blueline/core/slides';
import type { ArgsValidator, Validator } from './ipc-guard';
import type { Bounds } from './layout';

// ------------------------------------------------------------------------------------------- layout

export interface ViewLayoutInput {
  /** The content area in the window's content coordinates (DIP): between the bars, the rail and the panel. */
  area: Bounds;
  /** null until the kind is known: laid out as a deck at the design size given. */
  kind: ViewKind | null;
  /** The deck's design size (6.9); DEFAULT_DESIGN until it is known. */
  design: { w: number; h: number };
  zoomMode: ZoomMode;
  readingWidth: boolean;
  presenting: boolean;
  /** Where the shell's scroll bars are (DIP of the deck view), when the deck view is larger than the area. */
  scroll: { x: number; y: number };
  /** The display's device pixel ratio: deck sizes are snapped so they are whole device pixels when possible. */
  dpr: number;
}

export interface ViewLayout {
  /** The clipping container, in the window's content coordinates. */
  container: Bounds;
  /** The deck view, relative to the container (negative x or y: scrolled). */
  deck: Bounds;
  /** The deck view's zoom factor (setZoomFactor); 1 for documents. */
  zoom: number;
  /** What the shell's scroll bars scroll: the deck view's size and position; null when it fits. */
  scroll: { width: number; height: number; x: number; y: number } | null;
}

function clampZoom(z: number): number {
  if (!Number.isFinite(z) || z <= 0) return ZOOM_LIMITS.min;
  return Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, z));
}

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * The largest m in [n − 3, n] whose size in device pixels is whole (m × dpr an integer), so a fractional display
 * scale does not blur the deck view's edges; n itself when none is.
 */
export function snapToDevice(n: number, dpr: number): number {
  if (!Number.isFinite(dpr) || dpr <= 0 || Number.isInteger(dpr)) return n;
  for (let m = n; m >= Math.max(1, n - 3); m--) {
    const d = m * dpr;
    if (Math.abs(d - Math.round(d)) < 1e-6) return m;
  }
  return n;
}

/** A valid design size, else the 6.9 default. */
export function safeDesign(d: { w: number; h: number } | null | undefined): { w: number; h: number } {
  if (!d || !Number.isFinite(d.w) || !Number.isFinite(d.h)) return { ...DEFAULT_DESIGN };
  const w = Math.round(d.w);
  const h = Math.round(d.h);
  if (w < VIEWS_LIMITS.designMin || h < VIEWS_LIMITS.designMin || w > VIEWS_LIMITS.designMax || h > VIEWS_LIMITS.designMax) return { ...DEFAULT_DESIGN };
  return { w, h };
}

/**
 * The scaled deck view for a zoom mode. Fit makes the limiting side exact (that side of the page's viewport is
 * the design size exactly); Fill width makes the width exact, leaving room for a vertical scroll bar when the
 * deck is then taller than the area; 100% is zoom 1.
 */
function scaledDeck(mode: ZoomMode, area: { width: number; height: number }, design: { w: number; h: number }, dpr: number): { w: number; h: number; zoom: number } {
  const { w: W, h: H } = design;
  if (mode === 'actual') return { w: W, h: H, zoom: 1 };
  if (mode === 'fill') {
    let width = area.width;
    if (H * (width / W) > area.height) width = Math.max(1, area.width - SCROLLBAR_SIZE);
    const w = snapToDevice(Math.max(1, width), dpr);
    const zoom = clampZoom(w / W);
    return { w: Math.max(1, Math.round(W * zoom)), h: Math.max(1, Math.round(H * zoom)), zoom };
  }
  // Fit.
  const s = Math.min(area.width / W, area.height / H);
  if (!(s > 0)) return { w: Math.max(1, Math.round(W * ZOOM_LIMITS.min)), h: Math.max(1, Math.round(H * ZOOM_LIMITS.min)), zoom: ZOOM_LIMITS.min };
  if (area.width / W <= area.height / H) {
    const w = snapToDevice(Math.max(1, Math.min(area.width, Math.round(W * s))), dpr);
    const zoom = clampZoom(w / W);
    return { w: Math.max(1, Math.round(W * zoom)), h: Math.max(1, Math.round(H * zoom)), zoom };
  }
  const h = snapToDevice(Math.max(1, Math.min(area.height, Math.round(H * s))), dpr);
  const zoom = clampZoom(h / H);
  return { w: Math.max(1, Math.round(W * zoom)), h: Math.max(1, Math.round(H * zoom)), zoom };
}

/** Places a deck view of size (dw, dh) in `area`: centred where it fits, scrolled (with gutters) where it does not. */
function place(area: Bounds, dw: number, dh: number, scroll: { x: number; y: number }): Pick<ViewLayout, 'container' | 'deck' | 'scroll'> {
  let cw = area.width;
  let ch = area.height;
  let vbar = dh > ch;
  let hbar = dw > cw;
  if (vbar) cw = Math.max(0, cw - SCROLLBAR_SIZE);
  if (hbar) ch = Math.max(0, ch - SCROLLBAR_SIZE);
  // A scroll bar takes room, which can make the other side overflow too (as a browser decides its own bars).
  if (!hbar && dw > cw) {
    hbar = true;
    ch = Math.max(0, ch - SCROLLBAR_SIZE);
  }
  if (!vbar && dh > ch) {
    vbar = true;
    cw = Math.max(0, cw - SCROLLBAR_SIZE);
  }
  const maxX = Math.max(0, dw - cw);
  const maxY = Math.max(0, dh - ch);
  const sx = Math.min(maxX, Math.max(0, Math.round(Number.isFinite(scroll.x) ? scroll.x : 0)));
  const sy = Math.min(maxY, Math.max(0, Math.round(Number.isFinite(scroll.y) ? scroll.y : 0)));
  // (`0 - 0` is -0 in JavaScript; bounds are plain integers.)
  const x = dw <= cw ? Math.floor((cw - dw) / 2) : sx === 0 ? 0 : -sx;
  const y = dh <= ch ? Math.floor((ch - dh) / 2) : sy === 0 ? 0 : -sy;
  return {
    container: { x: area.x, y: area.y, width: cw, height: ch },
    deck: { x, y, width: dw, height: dh },
    scroll: hbar || vbar ? { width: dw, height: dh, x: dw > cw ? sx : 0, y: dh > ch ? sy : 0 } : null,
  };
}

/** Where the deck view goes and at what zoom (6.9 Views, Present). */
export function computeViewLayout(i: ViewLayoutInput): ViewLayout {
  const area: Bounds = { x: Math.floor(i.area.x), y: Math.floor(i.area.y), width: nonNeg(i.area.width), height: nonNeg(i.area.height) };
  const design = safeDesign(i.design);
  if (i.kind === 'document') {
    // 6.9 Document view: the page at the window width, no zoom; Reading Width (and Present) narrow it to 960 px.
    const narrow = i.readingWidth || i.presenting;
    const w = narrow ? Math.min(READING_WIDTH, area.width) : area.width;
    return { container: area, deck: { x: Math.floor((area.width - w) / 2), y: 0, width: w, height: area.height }, zoom: 1, scroll: null };
  }
  if (area.width < 1 || area.height < 1) {
    // Nothing to show (a minimized window, or the bars fill it): keep a valid zoom, show nothing.
    return { container: area, deck: { x: 0, y: 0, width: 0, height: 0 }, zoom: scaledDeck('fit', { width: design.w, height: design.h }, design, i.dpr).zoom, scroll: null };
  }
  const mode: ZoomMode = i.presenting ? 'fit' : i.zoomMode;
  const d = scaledDeck(mode, area, design, i.dpr);
  return { ...place(area, d.w, d.h, i.scroll), zoom: d.zoom };
}

/** 6.9: reveal and generic are decks (the deck view); scroll and single are documents. */
export function viewKindOf(kind: SlideState['kind'] | DetectResult['kind'] | null | undefined): ViewKind | null {
  if (kind === 'reveal' || kind === 'generic') return 'deck';
  if (kind === 'scroll' || kind === 'single') return 'document';
  return null;
}

/** 6.0 Status bar: "Fit · 85%", "100% · 100%", "Fill width · 120%"; documents show no zoom. */
export function zoomStatus(kind: ViewKind | null, mode: ZoomMode, zoom: number): string | null {
  if (kind === 'document') return null;
  const pct = Number.isFinite(zoom) && zoom > 0 ? Math.round(zoom * 100) : 100;
  return `${mode === 'fit' ? 'Fit' : mode === 'fill' ? 'Fill width' : '100%'} · ${pct}%`;
}

// ------------------------------------------------------------------------------------------- design size

/** How close to 1600×900 the visible view's viewport must be for a measured slide box to count (6.9). */
const DESIGN_VIEWPORT_SLACK = 2;

/**
 * The design size the visible view reported, or null to keep the current one. reveal.js gives its configured
 * width and height (any viewport); a generic deck's slide box counts only when measured at a 1600×900 viewport
 * (6.9: "the slide element's box at a 1600×900 viewport"), which is where the deck view starts (Fit of the
 * default design size). A box measured at any other viewport could follow the viewport (a deck sized in vw)
 * and shrink the view on every refit.
 */
export function acceptDesignReport(r: DesignReport): { w: number; h: number } | null {
  if (r.kind === 'generic') {
    if (Math.abs(r.viewportW - DEFAULT_DESIGN.w) > DESIGN_VIEWPORT_SLACK || Math.abs(r.viewportH - DEFAULT_DESIGN.h) > DESIGN_VIEWPORT_SLACK) return null;
  }
  const d = safeDesign({ w: r.w, h: r.h });
  return d.w === Math.round(r.w) && d.h === Math.round(r.h) ? d : null;
}

// ------------------------------------------------------------------------------------------- navigation

/**
 * What showing rail entry `entry` takes (6.9 Navigation: "clicking a thumbnail navigates through slide.nav";
 * "clicking an outline entry scrolls to its heading"). Decks use the index's SlideRef nav when it is ready,
 * else what the visible view reported (SlideState). Index decks (navKind 'index') are moved by main's keys:
 * `{ keys: target }`. Documents scroll to the entry's heading.
 *
 * `broken` names the gotos this document's deck was seen not to follow (window.ts: a hash or reveal goto that
 * did not move the slide, review finding 17: a deck that writes its hash but never reads it). Those decks are
 * moved by their keys at once.
 */
export type NavPlan = { goto: GotoRequest } | { keys: number } | null;

/** Goto kinds a document's deck did not follow (window.ts remembers them for the document). */
export interface BrokenGotos {
  hash?: boolean;
  reveal?: boolean;
}

export function navPlanFor(entry: number, index: Pick<SlideIndex, 'kind' | 'slides'> | null, slides: SlideState | null, broken: BrokenGotos = {}): NavPlan {
  const plan = basePlan(entry, index, slides);
  if (plan && 'goto' in plan && ((plan.goto.kind === 'hash' && broken.hash) || (plan.goto.kind === 'reveal' && broken.reveal))) return { keys: entry };
  return plan;
}

function basePlan(entry: number, index: Pick<SlideIndex, 'kind' | 'slides'> | null, slides: SlideState | null): NavPlan {
  if (!Number.isInteger(entry) || entry < 0 || entry >= VIEWS_LIMITS.index) return null;
  if (index && (index.kind === 'scroll' || index.kind === 'single')) {
    const e = index.slides[entry];
    if (!e) return null;
    // The text before the first heading is the top of the page.
    if (e.heading === null || e.heading === undefined) return { goto: { kind: 'top' } };
    return { goto: { kind: 'heading', index: e.heading } };
  }
  if (index && index.slides[entry]) {
    const nav = index.slides[entry].nav;
    switch (nav.kind) {
      case 'reveal':
        if (Array.isArray(nav.value) && Number.isInteger(nav.value[0]) && Number.isInteger(nav.value[1])) return { goto: { kind: 'reveal', h: nav.value[0], v: nav.value[1] } };
        return null;
      case 'hash':
        return typeof nav.value === 'string' && nav.value.startsWith('#') ? { goto: { kind: 'hash', hash: nav.value } } : null;
      case 'scroll':
        return { goto: { kind: 'scroll', index: typeof nav.value === 'number' ? nav.value : entry } };
      case 'index':
        return { keys: typeof nav.value === 'number' ? nav.value : entry };
      default:
        return null;
    }
  }
  if (!slides || entry >= slides.count) return null;
  switch (slides.navKind) {
    case 'reveal': {
      const p = slides.revealIndices?.[entry];
      return p ? { goto: { kind: 'reveal', h: p[0], v: p[1] } } : null;
    }
    case 'hash': {
      const h = slides.hashes?.[entry];
      return h ? { goto: { kind: 'hash', hash: h } } : { keys: entry };
    }
    case 'scroll':
      return { goto: { kind: 'scroll', index: entry } };
    case 'index':
      return { keys: entry };
    default:
      return null;
  }
}

/** PageUp / PageDown (6.9 Navigation): the neighbouring slide, or null at either end. */
export function stepTarget(current: number, count: number, dir: 1 | -1): number | null {
  if (!Number.isInteger(current) || !Number.isInteger(count) || count < 1) return null;
  const t = current + dir;
  return t >= 0 && t < count ? t : null;
}

/**
 * How many presses an index replay may make to reach a slide (6.7 Index replay): one per slide, plus the build
 * steps a deck shows before it moves on (F25), capped.
 */
export function maxReplayPresses(distance: number): number {
  return Math.min(400, Math.abs(distance) * 8 + 16);
}

/** The rail's and the outline's view of a slide index (ShellState.index). */
export function shellIndexOf(index: SlideIndex, building: boolean): ShellIndex {
  const doc = index.kind === 'scroll' || index.kind === 'single';
  const outline: ShellIndex['outline'] = [];
  if (doc) {
    for (const e of index.slides) {
      if (e.heading === null || e.heading === undefined || !e.level) continue;
      outline.push({ entry: e.index, level: e.level, title: e.title });
    }
  }
  return {
    version: index.version,
    building,
    ready: true,
    kind: index.kind,
    titles: index.slides.map((s) => s.title).slice(0, VIEWS_LIMITS.index),
    outline: outline.slice(0, VIEWS_LIMITS.index),
  };
}

/** The rail's thumbnail URL: app://shell/thumbs/<windowKey>/<file> (protocol.ts serves it from that window's cache). */
export function thumbUrl(windowKey: string, file: string): string {
  return `app://shell/thumbs/${encodeURIComponent(windowKey)}/${encodeURIComponent(file)}`;
}

/** The rail's thumbnail width in CSS px for a rail this wide (renderThumbnails renders it at 2x). */
export function railThumbWidth(railWidth: number): number {
  // The rail's padding (12 px each side) and the slide number column (24 px) leave the rest to the image.
  return Math.max(32, Math.min(1024, Math.floor(railWidth - 48)));
}

// ------------------------------------------------------------------------------------------- validators

const POISON = new Set(['__proto__', 'constructor', 'prototype']);

/** A plain object's own data value getter (as ipc-guard's record()), or null when it is not one. */
function plainRecord(v: unknown): ((key: string) => unknown) | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return null;
  for (const k of Reflect.ownKeys(v as object)) if (typeof k !== 'string' || POISON.has(k)) return null;
  return (key) => {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d || !('value' in d)) return undefined;
    return d.value;
  };
}

function finiteIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

/** ViewsDeckToMain.design: { kind, w, h, viewportW, viewportH }, every number bounded. */
export const validateDesignReport: Validator<DesignReport> = (p) => {
  const r = plainRecord(p);
  if (!r) return { ok: false, why: 'not a plain object' };
  const kind = r('kind');
  if (kind !== 'reveal' && kind !== 'generic') return { ok: false, why: 'kind' };
  const w = r('w');
  const h = r('h');
  const vw = r('viewportW');
  const vh = r('viewportH');
  if (!finiteIn(w, 1, 100_000) || !finiteIn(h, 1, 100_000)) return { ok: false, why: 'size' };
  if (!finiteIn(vw, 0, 100_000) || !finiteIn(vh, 0, 100_000)) return { ok: false, why: 'viewport' };
  return { ok: true, value: { kind, w, h, viewportW: vw, viewportH: vh } };
};

/** ViewsDeckToMain.pageStep: { dir: 1 | -1 }. */
export const validatePageStep: Validator<PageStep> = (p) => {
  const r = plainRecord(p);
  if (!r) return { ok: false, why: 'not a plain object' };
  const dir = r('dir');
  if (dir !== 1 && dir !== -1) return { ok: false, why: 'dir' };
  return { ok: true, value: { dir } };
};

/** ViewsDeckToMain.wheel: { dx, dy } within ±VIEWS_LIMITS.wheel. */
export const validateWheelPan: Validator<WheelPan> = (p) => {
  const r = plainRecord(p);
  if (!r) return { ok: false, why: 'not a plain object' };
  const dx = r('dx');
  const dy = r('dy');
  if (!finiteIn(dx, -VIEWS_LIMITS.wheel, VIEWS_LIMITS.wheel) || !finiteIn(dy, -VIEWS_LIMITS.wheel, VIEWS_LIMITS.wheel)) return { ok: false, why: 'delta' };
  return { ok: true, value: { dx, dy } };
};

/** ViewsShellToMain.command(cmd): one of SHELL_COMMANDS. */
export const validateShellCommand: ArgsValidator<ShellCommand> = (args) => {
  if (args.length !== 1 || typeof args[0] !== 'string' || !(SHELL_COMMANDS as readonly string[]).includes(args[0])) return { ok: false, why: 'command' };
  return { ok: true, value: args[0] as ShellCommand };
};

/** ViewsShellToMain.show(entry): an index entry. */
export const validateShowEntry: ArgsValidator<number> = (args) => {
  if (args.length !== 1 || typeof args[0] !== 'number' || !Number.isInteger(args[0]) || args[0] < 0 || args[0] >= VIEWS_LIMITS.index) return { ok: false, why: 'entry' };
  return { ok: true, value: args[0] };
};

/** ViewsShellToMain.scroll(x, y): the shell's scroll bars, in DIP. */
export const validateScrollArgs: ArgsValidator<{ x: number; y: number }> = (args) => {
  if (args.length !== 2 || !finiteIn(args[0], 0, 1_000_000) || !finiteIn(args[1], 0, 1_000_000)) return { ok: false, why: 'scroll' };
  return { ok: true, value: { x: Math.round(args[0] as number), y: Math.round(args[1] as number) } };
};
