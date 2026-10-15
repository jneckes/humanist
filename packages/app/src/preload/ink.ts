// The ink layer (6.4 Review mode, Phase 0): tools, a pointer-capture layer that takes pointer events only
// while a drawing tool is active in Review, strokes smoothed with perfect-freehand and drawn as SVG paths in
// the shadow root, and the drawing of existing marks (Phase 0: page coordinates as stored, no re-anchoring;
// Phase 3 draws marks relative to their targets).
//
// Tools: pen (freehand; a nearly closed loop snaps to an ellipse), pin (click), box (drag a rectangle) and
// arrow (tail and head targets). The highlighter is drawn like a wide translucent pen stroke and targeted
// like a loop; snapping to text ranges with caretPositionFromPoint is Phase 3, as are the pen's underline and
// strike snaps.

import { getStroke } from 'perfect-freehand';
import type { MarkShape, MarkTool } from '@blueline/core/types';
import {
  arrowHeadPath,
  bbox,
  circled,
  ellipsePath,
  ellipsePolygon,
  fitPolyline,
  isNearlyClosedLoop,
  outlinePath,
  parsePolyline,
  pointPath,
  rectPath,
  rectPolygon,
  type Box,
  type Pt,
} from './geometry';
import { listen } from './listeners';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Main refuses a mark path over 16 KB (ipc-guard IPC_LIMITS.markPath); leave room. */
const MAX_PATH_BYTES = 15000;

export type Tool = 'select' | MarkTool;

/** A finished stroke, in viewport and page coordinates. */
export interface DrawnMark {
  tool: MarkTool;
  /** Pen loops, freehand strokes and boxes; pins and arrows have no shape (Mark.shape is optional). */
  shape?: MarkShape;
  /** SVG path in page coordinates (Mark.path). */
  path: string;
  /** Hit-test geometry in viewport coordinates: a polygon (loop, box), or the end points (arrow), or a point (pin). */
  polygon: Pt[] | null;
  ends: [Pt, Pt] | null;
  point: Pt | null;
  /** Viewport box of the mark, for placing the card. */
  box: Box;
  /** Shift was held at the start: begin a separate note (6.4). */
  separate: boolean;
}

/** A mark to draw: page-coordinate path, tool, shape and its number on its note. */
export interface InkMark {
  key: string;
  noteKey: string;
  n: number;
  tool: MarkTool;
  shape?: MarkShape;
  path: string;
  done: boolean;
}

export interface InkDeps {
  onMark(m: DrawnMark): void;
  /** Select tool: a mark was clicked; open its note's card. */
  onMarkClick(noteKey: string): void;
}

const PEN = { size: 4, thinning: 0.5, smoothing: 0.5, streamline: 0.45, simulatePressure: true };
const HIGHLIGHTER = { size: 18, thinning: 0, smoothing: 0.6, streamline: 0.5, simulatePressure: false };

export class InkLayer {
  private tool: Tool = 'select';
  private active = false; // Review mode
  private drawing: { tool: MarkTool; pts: Pt[]; separate: boolean; pointerId: number; live: SVGPathElement } | null = null;
  private readonly page: SVGGElement;
  private readonly liveLayer: SVGGElement;
  private marks: InkMark[] = [];
  private highlight: { noteKey: string; n: number } | null = null;

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly svg: SVGSVGElement,
    private readonly capture: HTMLDivElement,
    private readonly deps: InkDeps,
  ) {
    this.page = doc.createElementNS(SVG_NS, 'g') as SVGGElement;
    this.liveLayer = doc.createElementNS(SVG_NS, 'g') as SVGGElement;
    svg.append(this.page, this.liveLayer);
    this.syncScroll();
    listen(win, 'scroll', () => this.syncScroll(), { passive: true, capture: true });
    listen(win, 'resize', () => this.syncScroll(), { passive: true });

    // 6.4: preventDefault on pointerdown and mousedown, so focus and the caret stay in the open card's
    // textarea and a Wispr Flow dictation in progress still lands there.
    capture.addEventListener('pointerdown', (e) => this.onDown(e));
    capture.addEventListener('mousedown', (e) => {
      if (e.isTrusted) e.preventDefault();
    });
    capture.addEventListener('pointermove', (e) => this.onMove(e));
    capture.addEventListener('pointerup', (e) => this.onUp(e));
    capture.addEventListener('pointercancel', (e) => this.onCancel(e));
    capture.addEventListener('lostpointercapture', (e) => this.onCancel(e));
    svg.addEventListener('click', (e) => this.onSvgClick(e));
    svg.addEventListener('mousedown', (e) => {
      // Clicking a mark must not take focus from an open card either.
      if (e.isTrusted) e.preventDefault();
    });
  }

  /** Sets the tool and whether Review is active; the capture layer takes pointers only for a drawing tool in Review. */
  configure(tool: Tool, reviewActive: boolean, inkVisible: boolean): void {
    this.tool = tool;
    this.active = reviewActive;
    const drawingTool = reviewActive && tool !== 'select';
    this.capture.classList.toggle('active', drawingTool);
    this.svg.classList.toggle('hidden', !inkVisible);
    this.svg.classList.toggle('clickable', reviewActive && tool === 'select');
    if (!drawingTool && this.drawing) this.abortStroke();
  }

  private syncScroll(): void {
    this.page.setAttribute('transform', `translate(${-this.win.scrollX} ${-this.win.scrollY})`);
  }

  // ----------------------------------------------------------------------------------------------- drawing

  private onDown(e: PointerEvent): void {
    if (!e.isTrusted || !this.active || this.tool === 'select') return;
    if (e.button !== 0) return;
    if (this.drawing) {
      // A second finger or pen while drawing is ignored; the same pointer again means its pointerup was
      // lost (the window lost focus mid-stroke): drop that stroke and start over.
      if (this.drawing.pointerId !== e.pointerId) return;
      this.abortStroke();
    }
    e.preventDefault();
    try {
      this.capture.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone: the stroke still ends on pointerup/cancel.
    }
    const live = this.doc.createElementNS(SVG_NS, 'path') as SVGPathElement;
    const tool = this.tool;
    live.setAttribute('class', tool === 'box' || tool === 'arrow' ? 'live-stroke' : `live ${tool}`);
    this.liveLayer.append(live);
    this.drawing = { tool, pts: [[e.clientX, e.clientY]], separate: e.shiftKey, pointerId: e.pointerId, live };
    this.renderLive();
  }

  private onMove(e: PointerEvent): void {
    const d = this.drawing;
    if (!d || !e.isTrusted || e.pointerId !== d.pointerId) return;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const c of events.length ? events : [e]) {
      const last = d.pts[d.pts.length - 1];
      if (Math.abs(c.clientX - last[0]) + Math.abs(c.clientY - last[1]) >= 1) d.pts.push([c.clientX, c.clientY]);
    }
    this.renderLive();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drawing;
    if (!d || !e.isTrusted || e.pointerId !== d.pointerId) return;
    const last = d.pts[d.pts.length - 1];
    if (last[0] !== e.clientX || last[1] !== e.clientY) d.pts.push([e.clientX, e.clientY]);
    this.drawing = null;
    d.live.remove();
    const mark = this.finish(d.tool, d.pts, d.separate);
    if (mark) this.deps.onMark(mark);
  }

  private onCancel(e: PointerEvent): void {
    const d = this.drawing;
    if (!d || e.pointerId !== d.pointerId) return;
    if (e.type === 'lostpointercapture') return; // pointerup follows; it finishes the stroke
    this.abortStroke();
  }

  private abortStroke(): void {
    if (this.drawing) this.drawing.live.remove();
    this.drawing = null;
  }

  private renderLive(): void {
    const d = this.drawing;
    if (!d) return;
    const pts = d.pts;
    if (d.tool === 'box') {
      const b = bbox([pts[0], pts[pts.length - 1]]);
      d.live.setAttribute('d', rectPath(b));
    } else if (d.tool === 'arrow') {
      const a = pts[0];
      const b = pts[pts.length - 1];
      d.live.setAttribute('d', `M${a[0]} ${a[1]} L${b[0]} ${b[1]} ${arrowHeadPath(a, b)}`);
    } else if (d.tool === 'pin') {
      d.live.setAttribute('d', '');
    } else {
      const outline = getStroke(pts as [number, number][], d.tool === 'highlighter' ? HIGHLIGHTER : PEN);
      d.live.setAttribute('d', outlinePath(outline));
    }
  }

  /** Turns raw viewport points into a mark (page-coordinate path plus hit-test geometry), or null for a slip. */
  private finish(tool: MarkTool, pts: Pt[], separate: boolean): DrawnMark | null {
    const sx = this.win.scrollX;
    const sy = this.win.scrollY;
    const toPage = (p: Pt): Pt => [p[0] + sx, p[1] + sy];
    const first = pts[0];
    const lastPt = pts[pts.length - 1];
    const box = bbox(pts);
    switch (tool) {
      case 'pin':
        return { tool, path: pointPath(toPage(lastPt)), polygon: null, ends: null, point: lastPt, box: { x: lastPt[0], y: lastPt[1], w: 0, h: 0 }, separate };
      case 'box': {
        const b = bbox([first, lastPt]);
        if (b.w < 4 || b.h < 4) return null;
        const pb = { x: b.x + sx, y: b.y + sy, w: b.w, h: b.h };
        return { tool, shape: 'rect', path: rectPath(pb), polygon: rectPolygon(b), ends: null, point: null, box: b, separate };
      }
      case 'arrow': {
        if (Math.hypot(lastPt[0] - first[0], lastPt[1] - first[1]) < 8) return null;
        const a = toPage(first);
        const b = toPage(lastPt);
        return { tool, path: `M${r1(a[0])} ${r1(a[1])} L${r1(b[0])} ${r1(b[1])}`, polygon: null, ends: [first, lastPt], point: null, box: bbox([first, lastPt]), separate };
      }
      case 'pen':
      case 'highlighter': {
        if (box.w < 3 && box.h < 3) return null;
        if (tool === 'pen' && isNearlyClosedLoop(pts)) {
          const pb = { x: box.x + sx, y: box.y + sy, w: box.w, h: box.h };
          return { tool, shape: 'ellipse', path: ellipsePath(pb), polygon: ellipsePolygon(box), ends: null, point: null, box, separate };
        }
        const fitted = fitPolyline(pts.map(toPage), MAX_PATH_BYTES);
        // A freehand loop's hit polygon is the stroke itself (9.3), closed implicitly.
        return { tool, shape: 'freehand', path: fitted.d, polygon: pts.slice(), ends: null, point: null, box, separate };
      }
    }
  }

  // ----------------------------------------------------------------------------------------------- drawing marks

  /** Replaces the drawn marks (existing notes plus the open card's local marks). */
  setMarks(marks: InkMark[]): void {
    this.marks = marks;
    this.redraw();
  }

  /** Highlights mark n of a note (hovering the card's mark list, 6.5), or clears it. */
  setHighlight(h: { noteKey: string; n: number } | null): void {
    this.highlight = h;
    for (const g of Array.from(this.page.children)) {
      const el = g as SVGGElement;
      const on = !!h && el.dataset.note === h.noteKey && el.dataset.n === String(h.n);
      el.classList.toggle('hl', on);
    }
  }

  private redraw(): void {
    const groups: SVGGElement[] = [];
    for (const m of this.marks) {
      const g = this.drawMark(m);
      if (g) groups.push(g);
    }
    this.page.replaceChildren(...groups);
    if (this.highlight) this.setHighlight(this.highlight);
  }

  private drawMark(m: InkMark): SVGGElement | null {
    const d = this.doc;
    const g = d.createElementNS(SVG_NS, 'g') as SVGGElement;
    g.setAttribute('class', `mark ${m.tool}${m.done ? ' done' : ''}`);
    g.dataset.note = m.noteKey;
    g.dataset.n = String(m.n);
    const path = (cls: string, data: string) => {
      const p = d.createElementNS(SVG_NS, 'path');
      p.setAttribute('class', cls);
      p.setAttribute('d', data);
      g.append(p);
      return p;
    };
    const pts = parsePolyline(m.path);
    let label: Pt | null = pts && pts.length ? pts[0] : null;
    if (m.tool === 'pin' || (pts && pts.length === 1)) {
      if (!pts || !pts.length) return null;
      const c = d.createElementNS(SVG_NS, 'circle');
      c.setAttribute('class', 'pin-dot');
      c.setAttribute('cx', String(pts[0][0]));
      c.setAttribute('cy', String(pts[0][1]));
      c.setAttribute('r', '7');
      g.append(c);
      path('hit', `M${pts[0][0] - 1} ${pts[0][1]} L${pts[0][0] + 1} ${pts[0][1]}`);
      label = [pts[0][0] + 8, pts[0][1] - 8];
    } else if (m.shape === 'ellipse' || m.shape === 'rect') {
      path('stroke', m.path);
      path('hit', m.path);
      if (pts && pts.length) {
        const b = bbox(pts);
        label = [b.x + b.w, b.y];
      }
    } else if (m.tool === 'arrow' && pts && pts.length >= 2) {
      path('stroke', `${m.path} ${arrowHeadPath(pts[0], pts[pts.length - 1])}`);
      path('hit', m.path);
    } else if (pts && pts.length >= 2) {
      const outline = getStroke(pts as [number, number][], m.tool === 'highlighter' ? HIGHLIGHTER : PEN);
      path('fill', outlinePath(outline));
      path('hit', m.path);
    } else {
      // Path data this layer did not write (a received note): draw it as given; `d` is not a script or URL sink.
      path('stroke', m.path);
      path('hit', m.path);
    }
    if (label) {
      const t = d.createElementNS(SVG_NS, 'text');
      t.setAttribute('class', 'num');
      t.setAttribute('x', String(Math.round(label[0] + 4)));
      t.setAttribute('y', String(Math.round(label[1] - 4)));
      t.textContent = circled(m.n);
      g.append(t);
    }
    return g;
  }

  private onSvgClick(e: MouseEvent): void {
    if (!e.isTrusted || !this.active || this.tool !== 'select') return;
    const path = e.composedPath();
    for (const n of path) {
      const el = n as Element;
      if (el && el.nodeType === 1 && el.localName === 'g' && (el as SVGGElement).dataset?.note) {
        this.deps.onMarkClick((el as SVGGElement).dataset.note!);
        return;
      }
      if (n === this.svg) return;
    }
  }

  /** The viewport box of a note's first mark, for placing its card; null when it has no drawable mark. */
  boxOf(noteKey: string): Box | null {
    const m = this.marks.find((x) => x.noteKey === noteKey);
    if (!m) return null;
    const pts = parsePolyline(m.path);
    if (!pts || !pts.length) return null;
    const b = bbox(pts);
    return { x: b.x - this.win.scrollX, y: b.y - this.win.scrollY, w: b.w, h: b.h };
  }

}

function r1(n: number): string {
  const v = Math.round(n * 10) / 10;
  return Object.is(v, -0) ? '0' : String(v);
}
