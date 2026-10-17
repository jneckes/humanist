// The visible-text walk, node locators and CSS paths (section 10, Phase 0, step 4; 9.3 Selectors).
// DOM code, used only by the deck preload (render and deck modes). It runs in the preload's isolated world
// and shares the DOM with the page, so everything it reads is page-controlled data: it never evaluates
// anything it reads, and every value it returns is a plain string, number or boolean.

import { isWhitespaceOnly } from './text';
import type { DomTextNode } from './types';
import type { CollectResult, FindResult, LocateResult, NodeLocator, WalkBlock, WalkNode, WalkTree } from './ipc';

/** Elements whose text is never page text (section 10 step 4; 8 TextPositionSelector). */
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);

/** Inline elements that split a block's text into runs (6.3 Inline markup; section 10 step 5). */
const INLINE_TAGS = new Set(['b', 'strong', 'i', 'em', 'a', 'code', 'span', 'br']);

/** A stamp is `bl-<n>` (9.2 Strategy 1 step 2). Anything else on a page element is the page's own doing. */
const STAMP_RE = /^bl-[0-9]{1,9}$/;

/** Most matches `find` returns; the rest is reported as truncated. */
export const FIND_LIMIT = 500;

/**
 * DomTextNode.texts (decision D-b) is omitted for a parent with more non-whitespace text nodes than this, or
 * more text (UTF-16 code units) than TEXTS_MAX_CHARS: the matcher's step 1 then falls through to step 2, which
 * is safe. The render service applies the same caps to what it accepts.
 */
export const TEXTS_MAX_NODES = 256;
export const TEXTS_MAX_CHARS = 256 * 1024;
/**
 * Each node carries its own copy of its parent's texts in a reply, so one reply carries at most this much
 * texts in all (UTF-16 code units); later nodes omit texts. Keeps a page with many long sibling text nodes
 * from pushing a collect reply past the IPC limits (ipc-guard sanitizeJson).
 */
const TEXTS_REPLY_BUDGET = 8 * 1024 * 1024;

/** Per collect/find call: each parent's texts (and their size), or null when over the caps. */
export type TextsCache = Map<object, { texts: string[]; chars: number } | null>;

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

/**
 * The data of every non-whitespace-only direct child text node of `parent`, in document order (the mapper's
 * textIndex order), or null when the parent has more than TEXTS_MAX_NODES of them or more than
 * TEXTS_MAX_CHARS of text. Computed once per parent per call when a cache is given.
 */
function parentTexts(parent: Node, cache?: TextsCache): { texts: string[]; chars: number } | null {
  const hit = cache?.get(parent);
  if (hit !== undefined) return hit;
  let out: { texts: string[]; chars: number } | null = { texts: [], chars: 0 };
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.nodeType !== TEXT_NODE) continue;
    const data = (c as Text).data;
    if (isWhitespaceOnly(data)) continue;
    out.texts.push(data);
    out.chars += data.length;
    if (out.texts.length > TEXTS_MAX_NODES || out.chars > TEXTS_MAX_CHARS) {
      out = null;
      break;
    }
  }
  cache?.set(parent, out);
  return out;
}

/**
 * The DomTextNode the matcher takes (core/types.ts). `texts` is the parent's live non-whitespace text nodes
 * (texts[textIndex] === data), so the matcher can check that the element still holds the stamp's source runs
 * before it trusts the own stamped run (9.2 Strategy 1 step 2; review finding 2, decision D-b).
 */
export function describeTextNode(node: Text, cache?: TextsCache): DomTextNode {
  const out: DomTextNode = { stamp: stampOf(node.parentElement), textIndex: textIndexOf(node), data: node.data };
  const parent = node.parentNode;
  const t = parent ? parentTexts(parent, cache) : null;
  if (t) out.texts = t.texts;
  return out;
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
  /** Marks text nodes scripts changed after parsing (DomTextNode.touched). */
  touched?: ScriptTouchTracker;
  /**
   * Skip text inside an absolutely positioned element clipped to a zero area (`clip: rect(1px, 1px, 1px,
   * 1px)`, the visually-hidden pattern of live regions such as reveal.js's `.aria-status`). Default true.
   * Section 10 step 4 would count such text (its parent's 1x1 box is non-zero), but it is not visible, and a
   * live region that repeats the slide's text makes every probe sentinel appear twice (fixtures/README.md).
   */
  skipClipped?: boolean;
}

/**
 * Where a text node lives (review finding 32). The walk enters open shadow roots and the documents of
 * same-origin frames (srcdoc, about:blank, blob:), so that visible text is counted and a probe sentinel that
 * lands there is seen. Closed shadow roots cannot be seen from the page at all, and a cross-origin frame's
 * document is null (it is reported, not walked).
 */
interface Scope {
  tree: WalkTree;
  /** The scope's own window: computed styles of its elements, and a frame's viewport. */
  win: Window;
  /** Where the scope's viewport sits in the top viewport (a frame's content box), CSS px. */
  ox: number;
  oy: number;
  /** The part of the top viewport the scope can paint into: the viewport, cut by every frame's content box. */
  clip: { left: number; top: number; right: number; bottom: number };
  /** Every frame element on the way down is visible (its own rect and ancestors). */
  shown: boolean;
  /** Prepended to the CSS path of the scope's locators: '' for the document, else the host or frame path and a separator. */
  prefix: string;
  /** The top-document node that holds the scope (the outermost shadow host or frame), for slide numbers. */
  anchor: Node | null;
}

/** The node's parent element; for text directly under a shadow root, the root's host. */
function ownerElement(n: Node): Element | null {
  const p = n.parentNode;
  if (!p) return null;
  if (p.nodeType === ELEMENT_NODE) return p as Element;
  return (p as ShadowRoot).host ?? null;
}

/** The element's parent in the flat tree: its slot when slotted, else its parent, else its shadow root's host. */
function flatParent(el: Element): Element | null {
  const slot = (el as Element & { assignedSlot?: Element | null }).assignedSlot;
  if (slot) return slot;
  if (el.parentElement) return el.parentElement;
  const p = el.parentNode;
  return p && p.nodeType === 11 /* DOCUMENT_FRAGMENT_NODE */ ? ((p as ShadowRoot).host ?? null) : null;
}

/** getComputedStyle from the element's own window (a frame's elements are styled by the frame). */
function styleOf(el: Element, fallback: Window): CSSStyleDeclaration {
  const w = el.ownerDocument?.defaultView ?? fallback;
  return w.getComputedStyle(el);
}

/**
 * The section 10 step 4 walk, and `find` / `locate` over the same rules. Keys are given once per node per
 * page load (a WeakMap), so the walker can count each node once across slides.
 */
/**
 * Which text nodes scripts changed (DomTextNode.touched). Built at preload start, before any page script, so
 * it sees every change. After readyState leaves 'loading', a changed text node, a text node a script
 * inserted, and every text child of an element whose children a script changed count as touched. While the
 * document is still loading, insertions and data appends may be the parser's own, but the parser never
 * removes a text node: a record that removes one is a script (`el.textContent = …` from an inline script at
 * the end of <body>, as Josh's real decks write their slide counters), so its target and its added text
 * nodes count as touched then too. Isolated-world safe: it observes the shared DOM.
 */
export class ScriptTouchTracker {
  private readonly nodes = new WeakSet<object>();
  private readonly parents = new WeakSet<object>();
  /** Elements a script inserted: every text node inside one is a script's (GSAP SplitText wraps each word). */
  private readonly inserted = new WeakSet<object>();
  private readonly observer: MutationObserver | null;
  private parsed: boolean;

  constructor(private readonly doc: Document) {
    this.parsed = doc.readyState !== 'loading';
    const View = doc.defaultView as (Window & { MutationObserver?: typeof MutationObserver }) | null;
    const MO = View?.MutationObserver ?? (typeof MutationObserver === 'function' ? MutationObserver : undefined);
    this.observer = MO ? new MO((records) => this.take(records)) : null;
    this.observer?.observe(doc, { subtree: true, childList: true, characterData: true });
    if (!this.parsed) {
      doc.addEventListener('readystatechange', () => {
        if (doc.readyState === 'loading') return;
        // Records queued before this point were the parser's: deliver them as such first.
        if (this.observer) this.take(this.observer.takeRecords(), true);
        this.parsed = true;
      });
    }
  }

  private take(records: MutationRecord[], parserTime = !this.parsed): void {
    for (const r of records) {
      if (parserTime) {
        // During parsing only a removed text node is certain to be a script's doing.
        if (r.type !== 'childList' || !Array.prototype.some.call(r.removedNodes, (n: Node) => n.nodeType === 3)) continue;
      }
      if (r.type === 'characterData') this.nodes.add(r.target);
      else if (r.type === 'childList') {
        this.parents.add(r.target);
        r.addedNodes.forEach((n) => {
          if (n.nodeType === 3) this.nodes.add(n);
          else if (n.nodeType === 1 || n.nodeType === 11) this.inserted.add(n);
        });
      }
    }
  }

  /**
   * True when a script changed the node, its parent's children, or inserted an element the node is inside.
   * A mutation record names only the inserted element, not the text nodes built inside it before insertion.
   */
  isTouched(node: Text): boolean {
    if (this.observer) this.take(this.observer.takeRecords());
    if (this.nodes.has(node)) return true;
    if (node.parentNode !== null && this.parents.has(node.parentNode)) return true;
    for (let p: Node | null = node.parentNode; p; p = p.parentNode) if (this.inserted.has(p)) return true;
    return false;
  }
}

export class DomWalker {
  private readonly keys = new WeakMap<object, number>();
  private nextKey = 1;
  /** Per collect/find call: each parent's texts, and how much texts the reply may still carry. */
  private textsCache: TextsCache = new Map();
  private textsBudget = TEXTS_REPLY_BUDGET;
  /** Per collect/find call: frames whose document the page cannot read, with the scope they sit in. */
  private opaqueFrames: { frame: Element; scope: Scope }[] = [];

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

  private topScope(): Scope {
    return { tree: 'document', win: this.win, ox: 0, oy: 0, clip: { left: 0, top: 0, right: this.win.innerWidth, bottom: this.win.innerHeight }, shown: true, prefix: '', anchor: null };
  }

  /** Starts a collect/find/locate call: fresh per-call caches. */
  private begin(): void {
    this.chainCache = new Map();
    this.clipCache = new Map();
    this.textsCache = new Map();
    this.textsBudget = TEXTS_REPLY_BUDGET;
    this.opaqueFrames = [];
  }

  /**
   * Every text node of the document in document order, not inside the overlay host or a skipped element,
   * with the open shadow roots and same-origin frame documents it holds (review finding 32).
   */
  private *textNodes(): Generator<{ t: Text; scope: Scope }> {
    const root = this.doc.documentElement;
    if (root) yield* this.walkTree(root, this.topScope(), 0);
  }

  private *walkTree(root: Node, scope: Scope, depth: number): Generator<{ t: Text; scope: Scope }> {
    const doc = root.nodeType === 9 ? (root as Document) : root.ownerDocument;
    if (!doc) return;
    const skip = (el: Element) => this.isSkipElement(el);
    const walker = doc.createTreeWalker(root, 0x1 | 0x4 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode(n: Node): number {
        if (n.nodeType === ELEMENT_NODE) return skip(n as Element) ? 2 /* FILTER_REJECT */ : 1; /* FILTER_ACCEPT */
        return 1; /* FILTER_ACCEPT */
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === TEXT_NODE) {
        yield { t: n as Text, scope };
        continue;
      }
      if (depth >= 16) continue;
      const el = n as Element;
      // Open shadow roots only: a closed root is null here, as it is to the page.
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) yield* this.walkTree(sr, { ...scope, tree: 'shadow', prefix: `${scope.prefix}${cssPath(el)} >>> `, anchor: scope.anchor ?? el }, depth + 1);
      if (el.localName === 'iframe' || el.localName === 'frame') yield* this.frameTree(el, scope, depth + 1);
    }
  }

  /** A frame's document, when the page can read it (same origin), positioned in the top viewport. */
  private *frameTree(frame: Element, scope: Scope, depth: number): Generator<{ t: Text; scope: Scope }> {
    let fdoc: Document | null = null;
    try {
      fdoc = (frame as HTMLIFrameElement).contentDocument;
    } catch {
      fdoc = null;
    }
    const fwin = fdoc?.defaultView ?? null;
    if (!fdoc || !fwin || !fdoc.documentElement) {
      // Cross-origin (data:, the -files origin, the network) or not loaded: reported, never walked.
      if (!fdoc) this.opaqueFrames.push({ frame, scope });
      return;
    }
    const r = frame.getBoundingClientRect();
    const cs = styleOf(frame, scope.win);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const fe = frame as HTMLElement;
    const ox = scope.ox + r.left + (fe.clientLeft || 0) + pl;
    const oy = scope.oy + r.top + (fe.clientTop || 0) + pt;
    const w = Math.max(0, (fe.clientWidth || 0) - pl - pr);
    const h = Math.max(0, (fe.clientHeight || 0) - pt - pb);
    const clip = {
      left: Math.max(scope.clip.left, ox),
      top: Math.max(scope.clip.top, oy),
      right: Math.min(scope.clip.right, ox + w),
      bottom: Math.min(scope.clip.bottom, oy + h),
    };
    const shown = scope.shown && r.width > 0 && r.height > 0 && this.chainOk(frame, scope.win);
    const inner: Scope = { tree: 'frame', win: fwin, ox, oy, clip, shown, prefix: `${scope.prefix}${cssPath(frame)} >>frame>> `, anchor: scope.anchor ?? frame };
    yield* this.walkTree(fdoc.documentElement, inner, depth);
  }

  /**
   * A per-call cache of "every ancestor-or-self passes": `visibility: visible`, opacity above 0, not a
   * skipped element (section 10 step 4), and not clipped away (WalkOptions.skipClipped). The chain follows
   * the flat tree, so it crosses shadow roots to their hosts; a frame's own chain is checked in its scope.
   */
  private chainCache = new Map<Element, boolean>();

  private chainOk(el: Element | null, fallback: Window = this.win): boolean {
    if (!el) return true;
    const cached = this.chainCache.get(el);
    if (cached !== undefined) return cached;
    let ok = !this.isSkipElement(el);
    if (ok) {
      const cs = styleOf(el, fallback);
      ok = cs.visibility === 'visible' && !(parseFloat(cs.opacity) <= 0);
      if (ok && this.opts.skipClipped !== false && (cs.position === 'absolute' || cs.position === 'fixed')) {
        ok = !zeroAreaClip(cs.clip);
      }
    }
    if (ok) ok = this.chainOk(flatParent(el), fallback);
    this.chainCache.set(el, ok);
    return ok;
  }

  /** Per-call cache: the element or an ancestor is absolutely or fixed positioned and clipped to a zero area. */
  private clipCache = new Map<Element, boolean>();

  private inZeroClip(el: Element | null, fallback: Window = this.win): boolean {
    if (!el) return false;
    const cached = this.clipCache.get(el);
    if (cached !== undefined) return cached;
    const cs = styleOf(el, fallback);
    const v = ((cs.position === 'absolute' || cs.position === 'fixed') && zeroAreaClip(cs.clip)) || this.inZeroClip(flatParent(el), fallback);
    this.clipCache.set(el, v);
    return v;
  }

  /** Section 10 step 4 for one text node of the top document (the data test, the parent's rect, every ancestor's style). */
  isVisible(node: Text): boolean {
    return this.visibleIn(node, this.topScope());
  }

  private visibleIn(node: Text, scope: Scope): boolean {
    if (isWhitespaceOnly(node.data)) return false;
    if (!scope.shown) return false;
    const parent = ownerElement(node);
    if (!parent || !parent.isConnected) return false;
    const r = parent.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    // "A non-zero rect inside the viewport": any overlap with the viewport (and every frame it is in) counts.
    const c = scope.clip;
    if (!(r.right + scope.ox > c.left && r.bottom + scope.oy > c.top && r.left + scope.ox < c.right && r.top + scope.oy < c.bottom)) return false;
    return this.chainOk(parent, scope.win);
  }

  private nodeRect(node: Text, scope: Scope): { x: number; y: number; w: number; h: number } {
    const range = (node.ownerDocument ?? this.doc).createRange();
    range.selectNodeContents(node);
    let r = range.getBoundingClientRect();
    if (!(r.width > 0 || r.height > 0)) r = ownerElement(node)!.getBoundingClientRect();
    return { x: round2(r.left + scope.ox), y: round2(r.top + scope.oy), w: round2(r.width), h: round2(r.height) };
  }

  /** The node's DomTextNode, with its parent's texts while the reply's texts budget lasts. */
  private describe(node: Text): DomTextNode {
    const d = describeTextNode(node, this.textsCache);
    if (this.opts.touched) d.tracked = true;
    if (this.opts.touched?.isTouched(node)) {
      d.touched = true;
      for (let el: Element | null = node.parentElement; el; el = el.parentElement) {
        const s = stampOf(el);
        if (s) {
          d.stampedAncestor = s;
          break;
        }
      }
    }
    if (d.texts) {
      const t = node.parentNode ? this.textsCache.get(node.parentNode) : null;
      const cost = t ? t.chars + t.texts.length : 0;
      if (cost > this.textsBudget) delete d.texts;
      else this.textsBudget -= cost;
    }
    return d;
  }

  /** The node's locator; in a shadow root or frame, its CSS path follows the host or frame path (never resolvable). */
  private locatorIn(node: Text, scope: Scope): NodeLocator | null {
    if (scope.tree === 'document') return makeLocator(node);
    const parent = node.parentElement;
    if (parent) return { stamp: stampOf(parent), cssPath: scope.prefix + cssPath(parent), childIndex: childTextIndexOf(node) };
    // Text directly under a shadow root.
    return ownerElement(node) ? { stamp: null, cssPath: scope.prefix + '#shadow-root', childIndex: childTextIndexOf(node) } : null;
  }

  private walkNode(node: Text, scope: Scope, slideOf?: (n: Node) => number | null): WalkNode | null {
    const locator = this.locatorIn(node, scope);
    if (!locator) return null;
    const w: WalkNode = { key: this.keyOf(node), locator, node: this.describe(node), rect: this.nodeRect(node, scope) };
    if (scope.tree !== 'document') w.tree = scope.tree;
    if (slideOf) w.slide = slideOf(scope.anchor ?? node);
    return w;
  }

  /** The nearest ancestor-or-self whose display is not `inline` or `contents`: the node's block. */
  private blockOf(el: Element): Element {
    let cur: Element = el;
    while (cur.parentElement) {
      const d = styleOf(cur, this.win).display;
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

  /**
   * Visible text nodes and their blocks right now (RenderCmd collect; section 10 steps 4-5). `slideOf` gives
   * each node the slide or block that contains it (review finding 35).
   */
  collect(slideOf?: (n: Node) => number | null): CollectResult {
    this.begin();
    const nodes: WalkNode[] = [];
    const byBlock = new Map<Element, number[]>();
    for (const { t, scope } of this.textNodes()) {
      if (!this.visibleIn(t, scope)) continue;
      const w = this.walkNode(t, scope, slideOf);
      if (!w) continue;
      nodes.push(w);
      const block = this.blockOf(ownerElement(t)!);
      let keys = byBlock.get(block);
      if (!keys) byBlock.set(block, (keys = []));
      keys.push(w.key);
    }
    const blocks: WalkBlock[] = [];
    for (const [block, nodeKeys] of byBlock) {
      blocks.push({ key: this.keyOf(block), hasInline: this.hasInline(block), nodeKeys });
    }
    const out: CollectResult = { nodes, blocks };
    // Visible frames whose text the page cannot read: their content is visible but uncounted.
    const opaque: number[] = [];
    for (const { frame, scope } of this.opaqueFrames) {
      if (!scope.shown) continue;
      const r = frame.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      const c = scope.clip;
      if (!(r.right + scope.ox > c.left && r.bottom + scope.oy > c.top && r.left + scope.ox < c.right && r.top + scope.oy < c.bottom)) continue;
      if (this.chainOk(frame, scope.win)) opaque.push(this.keyOf(frame));
    }
    if (opaque.length > 0) out.crossOriginFrames = opaque;
    return out;
  }

  /**
   * Every text node whose data contains `needle`, visible or not (RenderCmd find), in the document, its open
   * shadow roots and its same-origin frames. Each match says whether it is clipped to a zero area (the
   * skipClipped rule, which the probe uses to tell reveal.js's live region from a hidden copy; finding 31).
   */
  find(needle: string, slideOf: (n: Node) => number | null = () => null): FindResult {
    this.begin();
    const matches: FindResult['matches'] = [];
    if (!needle) return { matches, truncated: false };
    let truncated = false;
    for (const { t, scope } of this.textNodes()) {
      if (!t.data.includes(needle)) continue;
      if (matches.length >= FIND_LIMIT) {
        truncated = true;
        break;
      }
      const locator = this.locatorIn(t, scope);
      if (!locator) continue;
      const m: FindResult['matches'][number] = {
        key: this.keyOf(t),
        locator,
        node: this.describe(t),
        visible: this.visibleIn(t, scope),
        slide: slideOf(scope.anchor ?? t),
        clipped: this.inZeroClip(ownerElement(t), scope.win),
      };
      if (scope.tree !== 'document') m.tree = scope.tree;
      matches.push(m);
    }
    return { matches, truncated };
  }

  /** The text node at a locator (RenderCmd locate). */
  locate(loc: NodeLocator, slideOf: (n: Node) => number | null = () => null): LocateResult {
    this.begin();
    const t = resolveLocator(this.doc, loc);
    if (!t) return { found: false, node: null, visible: false, slide: null };
    const host = this.opts.host?.();
    for (let a: Element | null = t.parentElement; a; a = a.parentElement) {
      if (SKIP_TAGS.has(a.localName) || (host && a === host)) return { found: false, node: null, visible: false, slide: null };
    }
    const scope = this.topScope();
    const w = this.walkNode(t, scope);
    return { found: w !== null, node: w, visible: this.visibleIn(t, scope), slide: slideOf(t) };
  }
}

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
