// The visible-text walk, node locators and CSS paths (section 10, Phase 0, step 4; 9.3 Selectors).
// DOM code, used only by the deck preload (render and deck modes). It runs in the preload's isolated world
// and shares the DOM with the page, so everything it reads is page-controlled data: it never evaluates
// anything it reads, and every value it returns is a plain string, number or boolean.

import { isWhitespaceOnly } from './text';
import type { DomTextNode } from './types';
import type { CollectResult, FindResult, LocateResult, NodeLocator, WalkBlock, WalkNode } from './ipc';

/** Elements whose text is never page text (section 10 step 4; 8 TextPositionSelector). */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/** Inline elements that split a block's text into runs (6.3 Inline markup; section 10 step 5). */
const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'a', 'code', 'span', 'br']);

/** A stamp is `bl-<n>` (9.2 Strategy 1 step 2). Anything else on a page element is the page's own doing. */
const STAMP_RE = /^bl-[0-9]{1,9}$/;

/** Most matches `find` returns; the rest is reported as truncated. */
export const FIND_LIMIT = 500;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/**
 * Index of `node` among its parent's direct child text nodes that are not whitespace-only, counted the way
 * the mapper counts `textIndex` (9.2 Strategy 1 step 2: whitespace is U+0020, tab, LF, CR and FF; NBSP is
 * not). -1 when the node itself is whitespace-only (it is never a run).
 */
export function textIndexOf(node: Text): number {
  if (isWhitespaceOnly(node.data)) return -1;
  let i = 0;
  for (let s = node.previousSibling; s; s = s.previousSibling) {
    if (s.nodeType === TEXT_NODE && !isWhitespaceOnly((s as Text).data)) i++;
  }
  return i;
}

/** Index of `node` among ALL its parent's child text nodes, whitespace-only ones included (NodeLocator.childIndex). */
export function childTextIndexOf(node: Text): number {
  let i = 0;
  for (let s = node.previousSibling; s; s = s.previousSibling) if (s.nodeType === TEXT_NODE) i++;
  return i;
}

/** The element's `data-bl-e` stamp when it has the stamp format, else null. */
export function stampOf(el: Element | null): string | null {
  if (!el) return null;
  const v = el.getAttribute('data-bl-e');
  return v !== null && STAMP_RE.test(v) ? v : null;
}

/** The DomTextNode the matcher takes (core/types.ts). */
export function describeTextNode(node: Text): DomTextNode {
  return { stamp: stampOf(node.parentElement), textIndex: textIndexOf(node), data: node.data };
}

/**
 * CSS.escape (CSSOM, "serialize an identifier"), written out so it also runs outside a browser (tests).
 * NUL becomes U+FFFD; control characters and a leading digit are escaped as code points.
 */
export function cssEscape(value: string): string {
  let out = '';
  const len = value.length;
  const first = value.charCodeAt(0);
  for (let i = 0; i < len; i++) {
    const c = value.charCodeAt(i);
    if (c === 0) {
      out += '\uFFFD';
      continue;
    }
    if (
      (c >= 0x1 && c <= 0x1f) ||
      c === 0x7f ||
      (i === 0 && c >= 0x30 && c <= 0x39) ||
      (i === 1 && c >= 0x30 && c <= 0x39 && first === 0x2d)
    ) {
      out += '\\' + c.toString(16) + ' ';
      continue;
    }
    if (i === 0 && len === 1 && c === 0x2d) {
      out += '\\' + value.charAt(i);
      continue;
    }
    if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) {
      out += value.charAt(i);
      continue;
    }
    out += '\\' + value.charAt(i);
  }
  return out;
}

/** 1-based position among the parent's element children of the same type (namespace and local name). */
function nthOfType(el: Element): number {
  let n = 1;
  for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
    if (s.localName === el.localName && s.namespaceURI === el.namespaceURI) n++;
  }
  return n;
}

/** True when `id` names exactly one element in the element's document (a duplicate id would be ambiguous). */
function uniqueId(el: Element, id: string): boolean {
  const doc = el.ownerDocument;
  if (!doc || !el.isConnected) return false;
  try {
    const all = doc.querySelectorAll('#' + cssEscape(id));
    return all.length === 1 && all[0] === el;
  } catch {
    return false;
  }
}

/**
 * CSS path of an element (9.3 Selectors stored per target; NodeLocator.cssPath): the nearest ancestor-or-self
 * with a unique id, then one `:nth-of-type` step per level down. Without such an ancestor the path starts
 * at the root element. A duplicate id is skipped, so the path always names one element.
 */
export function cssPath(el: Element): string {
  const steps: string[] = [];
  let cur: Element | null = el;
  while (cur) {
    const id = cur.getAttribute('id');
    if (id && uniqueId(cur, id)) {
      steps.unshift('#' + cssEscape(id));
      return steps.join(' > ');
    }
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      // The root element: a bare type selector, since `html:nth-of-type(1)` adds nothing.
      steps.unshift(cssEscape(cur.localName));
      break;
    }
    steps.unshift(`${cssEscape(cur.localName)}:nth-of-type(${nthOfType(cur)})`);
    cur = parent;
  }
  return steps.join(' > ');
}

/** The element a CSS path names, or null (invalid selector or no match). */
export function resolveCssPath(doc: Document, path: string): Element | null {
  if (!path) return null;
  try {
    return doc.querySelector(path);
  } catch {
    return null;
  }
}

/** The locator of a text node (NodeLocator): parent stamp, parent CSS path, index among the parent's text nodes. */
export function makeLocator(node: Text): NodeLocator | null {
  const parent = node.parentElement;
  if (!parent) return null;
  return { stamp: stampOf(parent), cssPath: cssPath(parent), childIndex: childTextIndexOf(node) };
}

function nthTextChild(el: Element, k: number): Text | null {
  let i = 0;
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === TEXT_NODE) {
      if (i === k) return c as Text;
      i++;
    }
  }
  return null;
}

/**
 * The text node a locator names, or null. The stamp decides when exactly one element carries it; when a
 * deck clones a stamped element (9.3 Cloned slides), the CSS path picks among the clones, and if it names
 * none of them the locator is refused (null) rather than guessed.
 */
export function resolveLocator(doc: Document, loc: NodeLocator): Text | null {
  let parent: Element | null = null;
  if (loc.stamp !== null && STAMP_RE.test(loc.stamp)) {
    const hits = doc.querySelectorAll(`[data-bl-e="${loc.stamp}"]`);
    if (hits.length === 1) parent = hits[0];
    else if (hits.length > 1) {
      const byPath = resolveCssPath(doc, loc.cssPath);
      parent = byPath && Array.prototype.indexOf.call(hits, byPath) >= 0 ? byPath : null;
      if (!parent) return null;
    }
  }
  if (!parent) parent = resolveCssPath(doc, loc.cssPath);
  if (!parent || !Number.isInteger(loc.childIndex) || loc.childIndex < 0) return null;
  return nthTextChild(parent, loc.childIndex);
}

/** `rect(t, r, b, l)` with px lengths and a zero area: the "visually hidden" clip of live regions. */
function zeroAreaClip(clip: string): boolean {
  const m = /^rect\(\s*([-\d.]+)px[\s,]+([-\d.]+)px[\s,]+([-\d.]+)px[\s,]+([-\d.]+)px\s*\)$/.exec(clip);
  if (!m) return false;
  const [top, right, bottom, left] = [m[1], m[2], m[3], m[4]].map(Number);
  return right - left <= 0 || bottom - top <= 0;
}

export interface WalkOptions {
  /** The overlay's shadow host; its subtree is never page text (section 10 step 4). */
  host?: () => Element | null;
  /**
   * Skip text inside an absolutely positioned element clipped to a zero area (`clip: rect(1px, 1px, 1px,
   * 1px)`, the visually-hidden pattern of live regions such as reveal.js's `.aria-status`). Default true.
   * Section 10 step 4 would count such text (its parent's 1x1 box is non-zero), but it is not visible, and a
   * live region that repeats the slide's text makes every probe sentinel appear twice (fixtures/README.md).
   */
  skipClipped?: boolean;
}

/**
 * The section 10 step 4 walk, and `find` / `locate` over the same rules. Keys are given once per node per
 * page load (a WeakMap), so the walker can count each node once across slides.
 */
export class DomWalker {
  private readonly keys = new WeakMap<object, number>();
  private nextKey = 1;

  constructor(
    private readonly win: Window,
    private readonly opts: WalkOptions = {},
  ) {}

  private get doc(): Document {
    return this.win.document;
  }

  /** A key unique for this page load (WalkNode.key, WalkBlock.key). */
  keyOf(o: Node): number {
    let k = this.keys.get(o);
    if (k === undefined) {
      k = this.nextKey++;
      this.keys.set(o, k);
    }
    return k;
  }

  private isSkipElement(el: Element): boolean {
    if (SKIP_TAGS.has(el.localName)) return true;
    const host = this.opts.host?.();
    return host !== null && host !== undefined && el === host;
  }

  /** Every text node under the root, in document order, not inside the overlay host or a skipped element. */
  private *textNodes(): Generator<Text> {
    const doc = this.doc;
    const root = doc.documentElement;
    if (!root) return;
    const skip = (el: Element) => this.isSkipElement(el);
    const walker = doc.createTreeWalker(root, 0x1 | 0x4 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode(n: Node): number {
        if (n.nodeType === ELEMENT_NODE) return skip(n as Element) ? 2 /* FILTER_REJECT */ : 3 /* FILTER_SKIP */;
        return 1; /* FILTER_ACCEPT */
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) yield n as Text;
  }

  /**
   * A per-call cache of "every ancestor-or-self passes": `visibility: visible`, opacity above 0, not a
   * skipped element (section 10 step 4), and not clipped away (WalkOptions.skipClipped).
   */
  private chainCache = new Map<Element, boolean>();

  private chainOk(el: Element | null): boolean {
    if (!el) return true;
    const cached = this.chainCache.get(el);
    if (cached !== undefined) return cached;
    let ok = !this.isSkipElement(el);
    if (ok) {
      const cs = this.win.getComputedStyle(el);
      ok = cs.visibility === 'visible' && !(parseFloat(cs.opacity) <= 0);
      if (ok && this.opts.skipClipped !== false && (cs.position === 'absolute' || cs.position === 'fixed')) {
        ok = !zeroAreaClip(cs.clip);
      }
    }
    if (ok) ok = this.chainOk(el.parentElement);
    this.chainCache.set(el, ok);
    return ok;
  }

  /** Section 10 step 4 for one text node (the data test, the parent's rect, every ancestor's style). */
  isVisible(node: Text): boolean {
    if (isWhitespaceOnly(node.data)) return false;
    const parent = node.parentElement;
    if (!parent || !parent.isConnected) return false;
    const r = parent.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    // "A non-zero rect inside the viewport": any overlap with the viewport counts.
    if (!(r.right > 0 && r.bottom > 0 && r.left < this.win.innerWidth && r.top < this.win.innerHeight)) return false;
    return this.chainOk(parent);
  }

  private nodeRect(node: Text): { x: number; y: number; w: number; h: number } {
    const range = this.doc.createRange();
    range.selectNodeContents(node);
    let r = range.getBoundingClientRect();
    if (!(r.width > 0 || r.height > 0)) r = node.parentElement!.getBoundingClientRect();
    return { x: round2(r.left), y: round2(r.top), w: round2(r.width), h: round2(r.height) };
  }

  private walkNode(node: Text): WalkNode | null {
    const locator = makeLocator(node);
    if (!locator) return null;
    return { key: this.keyOf(node), locator, node: describeTextNode(node), rect: this.nodeRect(node) };
  }

  /** The nearest ancestor-or-self whose display is not `inline` or `contents`: the node's block. */
  private blockOf(el: Element): Element {
    let cur: Element = el;
    while (cur.parentElement) {
      const d = this.win.getComputedStyle(cur).display;
      if (d !== 'inline' && d !== 'contents') return cur;
      cur = cur.parentElement;
    }
    return cur;
  }

  /** The block has an inline element (b, strong, i, em, a, code, span, br) whose own block is this block. */
  private hasInline(block: Element): boolean {
    const all = block.getElementsByTagName('*');
    const n = Math.min(all.length, 2000);
    for (let i = 0; i < n; i++) {
      const el = all[i];
      if (!INLINE_TAGS.has(el.localName)) continue;
      if (el.parentElement && this.blockOf(el.parentElement) === block) return true;
    }
    return false;
  }

  /** Visible text nodes and their blocks right now (RenderCmd collect; section 10 steps 4-5). */
  collect(): CollectResult {
    this.chainCache = new Map();
    const nodes: WalkNode[] = [];
    const byBlock = new Map<Element, number[]>();
    for (const t of this.textNodes()) {
      if (!this.isVisible(t)) continue;
      const w = this.walkNode(t);
      if (!w) continue;
      nodes.push(w);
      const block = this.blockOf(t.parentElement!);
      let keys = byBlock.get(block);
      if (!keys) byBlock.set(block, (keys = []));
      keys.push(w.key);
    }
    const blocks: WalkBlock[] = [];
    for (const [block, nodeKeys] of byBlock) {
      blocks.push({ key: this.keyOf(block), hasInline: this.hasInline(block), nodeKeys });
    }
    return { nodes, blocks };
  }

  /** Every text node whose data contains `needle`, visible or not (RenderCmd find). */
  find(needle: string, slideOf: (n: Node) => number | null = () => null): FindResult {
    this.chainCache = new Map();
    const matches: FindResult['matches'] = [];
    if (!needle) return { matches, truncated: false };
    let truncated = false;
    for (const t of this.textNodes()) {
      if (!t.data.includes(needle)) continue;
      if (matches.length >= FIND_LIMIT) {
        truncated = true;
        break;
      }
      const locator = makeLocator(t);
      if (!locator) continue;
      matches.push({ key: this.keyOf(t), locator, node: describeTextNode(t), visible: this.isVisible(t), slide: slideOf(t) });
    }
    return { matches, truncated };
  }

  /** The text node at a locator (RenderCmd locate). */
  locate(loc: NodeLocator, slideOf: (n: Node) => number | null = () => null): LocateResult {
    this.chainCache = new Map();
    const t = resolveLocator(this.doc, loc);
    if (!t) return { found: false, node: null, visible: false, slide: null };
    const host = this.opts.host?.();
    for (let a: Element | null = t.parentElement; a; a = a.parentElement) {
      if (SKIP_TAGS.has(a.localName) || (host && a === host)) return { found: false, node: null, visible: false, slide: null };
    }
    const w = this.walkNode(t);
    return { found: w !== null, node: w, visible: this.isVisible(t), slide: slideOf(t) };
  }
}

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
