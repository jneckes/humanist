// Targets from marks, minimal version (9.3 "Targets from marks"). Phase 0 resolves each mark to page elements
// and describes them for NoteOp; selectors, re-anchoring, the hit check and caret-based highlighter ranges
// are Phase 3 (full anchoring).

import { cssPath, stampOf } from '@blueline/core/dom-walk';
import { isWhitespaceOnly } from '@blueline/core/text';
import type { NoteOpMark } from '@blueline/core/ipc';
import { bbox, centroid, pointInPolygon, type Pt } from './geometry';

export type TargetDesc = NoteOpMark['targets'][number];

/** Main refuses more than 50 targets per mark, and css/text over 2 KB (ipc-guard IPC_LIMITS). */
const MAX_TARGETS = 50;
const MAX_CSS = 2000;
/** Target.text: visible text, trimmed to 300 chars (section 8). */
const MAX_TEXT = 300;

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'html', 'body']);
/** Elements whose text is never page text (as the visible-text walk, section 10 step 4). */
const TEXT_SKIP = new Set(['script', 'style', 'noscript', 'template']);
const IMAGE_TAGS = new Set(['img', 'picture', 'video', 'canvas', 'svg']);
const ROLE_RE = /^[a-z-]{1,32}$/;

/** Visible: a non-zero box, `visibility: visible`, opacity above 0 (9.3 hit-testing uses the 6.4 rule). */
function visible(el: Element, win: Window): boolean {
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;
  for (let a: Element | null = el; a; a = a.parentElement) {
    const cs = win.getComputedStyle(a);
    if (a === el && cs.visibility !== 'visible') return false;
    if (parseFloat(cs.opacity) <= 0) return false;
  }
  return true;
}

/** A leaf text-bearing element: it has a direct child text node that is not whitespace-only. */
function bearsText(el: Element): boolean {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3 && !isWhitespaceOnly((c as Text).data)) return true;
  }
  return false;
}

function isImage(el: Element): boolean {
  return IMAGE_TAGS.has(el.localName) || el.getAttribute('role') === 'img';
}

/** The topmost page element at a viewport point, skipping the overlay host (9.3: skip the overlay and the ink layer). */
export function elementAt(doc: Document, x: number, y: number, host: Element): Element | null {
  for (const el of doc.elementsFromPoint(x, y)) {
    if (el === host || host.contains(el)) continue;
    if (el.localName === 'html' || el.localName === 'body') continue;
    return el;
  }
  return null;
}

/**
 * 9.3 Ellipse or freehand loop (and box): candidates are leaf text-bearing elements and images whose box
 * center falls inside the polygon. Siblings that together cover more than 80% of their parent collapse into
 * the parent. With no candidate, the element at the polygon's centroid. Polygon in viewport coordinates.
 */
export function targetsInPolygon(doc: Document, win: Window, poly: readonly Pt[], host: Element): Element[] {
  const box = bbox(poly);
  const found: Element[] = [];
  const body = doc.body;
  if (body && poly.length >= 3 && box.w > 0 && box.h > 0) {
    const all = body.getElementsByTagName('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el === host || SKIP.has(el.localName)) continue;
      // SVG children of an image (svg) are part of it.
      if (el.namespaceURI === 'http://www.w3.org/2000/svg' && el.localName !== 'svg' && el.localName !== 'text') continue;
      if (!(bearsText(el) || isImage(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.right < box.x || r.left > box.x + box.w || r.bottom < box.y || r.top > box.y + box.h) continue;
      if (!pointInPolygon([r.left + r.width / 2, r.top + r.height / 2], poly)) continue;
      if (!visible(el, win)) continue;
      found.push(el);
    }
  }
  let targets = dropDescendants(found);
  targets = collapseSiblings(targets, win);
  if (targets.length === 0) {
    const [cx, cy] = centroid(poly);
    const el = elementAt(doc, cx, cy, host);
    if (el) targets = [el];
  }
  return targets.slice(0, MAX_TARGETS);
}

/** An element inside another candidate is covered by it (an svg's <text>, a heading's <b>). */
function dropDescendants(els: Element[]): Element[] {
  return els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
}

/**
 * Siblings that share a parent and cover more than 80% of it collapse into the parent: either more than 80%
 * of the parent's visible element children, or more than 80% of its area. Repeats up the tree.
 */
function collapseSiblings(els: Element[], win: Window): Element[] {
  let cur = els;
  for (let round = 0; round < 6; round++) {
    const byParent = new Map<Element, Element[]>();
    for (const el of cur) {
      const p = el.parentElement;
      if (!p || p.localName === 'body' || p.localName === 'html') continue;
      let g = byParent.get(p);
      if (!g) byParent.set(p, (g = []));
      g.push(el);
    }
    let changed = false;
    const next = new Set(cur);
    for (const [parent, kids] of byParent) {
      if (kids.length < 2) continue;
      const siblings = Array.from(parent.children).filter((c) => visible(c, win));
      const byCount = siblings.length > 0 && kids.length / siblings.length > 0.8;
      const pr = parent.getBoundingClientRect();
      const parentArea = pr.width * pr.height;
      let covered = 0;
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        const w = Math.max(0, Math.min(r.right, pr.right) - Math.max(r.left, pr.left));
        const h = Math.max(0, Math.min(r.bottom, pr.bottom) - Math.max(r.top, pr.top));
        covered += w * h;
      }
      const byArea = parentArea > 0 && covered / parentArea > 0.8;
      if (byCount || byArea) {
        for (const k of kids) next.delete(k);
        next.add(parent);
        changed = true;
      }
    }
    cur = dropDescendants(Array.from(next));
    if (!changed) break;
  }
  return cur;
}

/** Target role (section 8 Target.role): heading, paragraph, list-item, image, chart, card or element. */
export function roleOf(el: Element): string {
  const n = el.localName;
  if (/^h[1-6]$/.test(n) || el.getAttribute('role') === 'heading') return 'heading';
  if (n === 'p' || n === 'blockquote' || n === 'figcaption') return 'paragraph';
  if (n === 'li' || n === 'dt' || n === 'dd') return 'list-item';
  if (n === 'img' || n === 'picture' || n === 'video' || el.getAttribute('role') === 'img') return 'image';
  if (n === 'svg' || n === 'canvas') return 'chart';
  const cls = el.getAttribute('class') ?? '';
  if (/(^|[\s_-])card($|[\s_-])/i.test(cls)) return 'card';
  return 'element';
}

/** Whitespace-collapsed text, cut to `max` UTF-16 units without splitting a surrogate pair. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let end = max;
  const c = t.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return t.slice(0, end);
}

/** Drops lone surrogates, which main refuses in any IPC string. */
function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

/**
 * The element's visible text in source case (section 8 Target.text): its text nodes in order, skipping
 * script/style/template/noscript and anything not rendered (display none, visibility hidden). Not
 * innerText, which applies text-transform: the file, and so the agent, has the source case (6.3 Source case).
 */
export function visibleText(el: Element, max = MAX_TEXT): string {
  const doc = el.ownerDocument;
  const seen = new Map<Element, boolean>();
  const shown = (p: Element | null): boolean => {
    if (!p) return false;
    let v = seen.get(p);
    if (v === undefined) {
      v = !TEXT_SKIP.has(p.localName) && (typeof p.checkVisibility !== 'function' || p.checkVisibility({ visibilityProperty: true }));
      seen.set(p, v);
    }
    return v;
  };
  let out = '';
  const walker = doc.createTreeWalker(el, 0x4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || !shown(p)) continue;
    let skip = false;
    for (let a: Element | null = p; a && a !== el; a = a.parentElement) {
      if (TEXT_SKIP.has(a.localName)) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    out += (n as Text).data;
    if (out.length > max * 4) break;
  }
  return clip(out, max);
}

/** The NoteOp description of a target: CSS path, visible text, role, stamp. */
export function describeTarget(el: Element): TargetDesc {
  let css = cssPath(el);
  if (css.length > MAX_CSS) css = '';
  const role = roleOf(el);
  return {
    css: wellFormed(css),
    text: wellFormed(visibleText(el)),
    role: ROLE_RE.test(role) ? role : 'element',
    stamp: stampOf(el),
  };
}

/** The nearest heading for a card header: the element itself, or the first heading of its nearest ancestor that has one. */
export function nearestHeading(el: Element): string | null {
  if (/^h[1-6]$/.test(el.localName)) return clip(el.textContent ?? '', 60) || null;
  for (let a: Element | null = el; a && a.localName !== 'body'; a = a.parentElement) {
    const h = a.querySelector('h1, h2, h3, h4, h5, h6');
    if (h) {
      const t = clip(h.textContent ?? '', 60);
      if (t) return t;
    }
  }
  return null;
}
