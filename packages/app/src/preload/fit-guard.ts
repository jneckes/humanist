// The fit guard (6.3 "Fit guard"): while the author types, compare the edited element with its state before the
// edit and warn, never block, when the text now takes more lines, overflows, or leaves a widow. The comparison is
// pure (unit-tested in node); measureFit reads the layout in the deck view.
//
// 6.3 names three checks:
//   - line boxes: the distinct line tops of Range.getClientRects() over the element's contents (lineBoxes groups
//     rects whose vertical extents overlap into one line, so inline boxes of different heights on one line, and
//     the element boxes the range also reports, count once);
//   - overflow of the element, and of "its nearest ancestor with a fixed height or overflow: hidden"
//     (scrollHeight > clientHeight + 1, and the same for width);
//   - a widow: a last line with one word, or less than 15% of the block's width.
//
// The container heuristic (fitContainer). Computed style never says that a height is fixed: getComputedStyle
// gives the used height in px either way. CSS Typed OM does: Element.computedStyleMap().get('height') is the
// keyword `auto` for a content-sized box and a length (or calc) for `height: 60px`, `50vh`, `100%` (checked in
// Electron 44). So the container is the nearest ancestor of the element (below <body>) that
//   1. has overflow-x or overflow-y other than `visible` (hidden, clip, auto, scroll: its content is cut or scrolls);
//   2. or has a computed height that is not `auto`, or a max-height that is not `none` (its box does not grow with
//      the text, so text that grows past it spills over whatever is below: a slide, a card, a fixed panel);
//   3. or is absolutely or fixed positioned with both `top` and `bottom` set (its height comes from its insets).
// A percentage height whose parent is content-sized behaves as `auto` in layout but still counts here: the
// check then compares that box's scroll and client sizes, which stay equal while nothing overflows, so it only
// warns when text really spills. Without Typed OM, only rule 1 applies.

/** A client rect as the guard reads it (DOMRect in the preload; plain objects in unit tests). */
export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface LineBox extends RectLike {}

/** The guard's reading of the element at one moment. */
export interface FitState {
  /** Line boxes of the element's contents. */
  lines: number;
  /** How far the element's content overflows its box (px, 0 when it fits; width and height summed). */
  overflow: number;
  /** The same for the container (fitContainer), 0 without one. */
  containerOverflow: number;
  /** The last line is a widow (isWidow). */
  widow: boolean;
}

/** A widow's last line is shorter than this share of the block's width (6.3). */
export const WIDOW_WIDTH_SHARE = 0.15;
/** scrollHeight > clientHeight + 1 (6.3): a pixel of rounding is not an overflow. */
export const OVERFLOW_SLACK_PX = 1;

/**
 * Groups rects into line boxes: sorted by top, a rect joins the current line when it overlaps it vertically by
 * at least half of the smaller height (an inline box with a larger font, or the element box the range also
 * reports, sits on the same line); otherwise it starts a new line. Empty rects are ignored.
 */
export function lineBoxes(rects: readonly RectLike[]): LineBox[] {
  const rs = rects.filter((r) => r.bottom - r.top > 0 && r.right - r.left > 0).slice().sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  const lines: LineBox[] = [];
  for (const r of rs) {
    const cur = lines[lines.length - 1];
    if (cur) {
      const overlap = Math.min(cur.bottom, r.bottom) - Math.max(cur.top, r.top);
      const smaller = Math.min(cur.bottom - cur.top, r.bottom - r.top);
      if (overlap >= smaller / 2) {
        cur.top = Math.min(cur.top, r.top);
        cur.bottom = Math.max(cur.bottom, r.bottom);
        cur.left = Math.min(cur.left, r.left);
        cur.right = Math.max(cur.right, r.right);
        continue;
      }
    }
    lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
  }
  return lines;
}

/**
 * 6.3: a widow is a last line with one word, or less than 15% of the block's width. A single line is never a
 * widow, and a block of unknown width only counts words.
 */
export function isWidow(lines: number, lastLine: { width: number; words: number }, blockWidth: number): boolean {
  if (lines < 2) return false;
  if (lastLine.words === 1) return true;
  return blockWidth > 0 && lastLine.width < WIDOW_WIDTH_SHARE * blockWidth;
}

/** How far a box's content overflows it: scroll size beyond client size plus the slack, per axis, summed. */
export function overflowOf(box: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number }): number {
  const x = box.scrollWidth - box.clientWidth;
  const y = box.scrollHeight - box.clientHeight;
  return (x > OVERFLOW_SLACK_PX ? x : 0) + (y > OVERFLOW_SLACK_PX ? y : 0);
}

/**
 * The badge's warnings (6.3: `+1 line`, `overflows`, `widow`), against the state before the edit. An overflow
 * counts when there was none before or it grew (a deck that already spilled over warns only when the text makes
 * it worse); a widow counts when the text did not end in one before. Fewer lines warn nothing.
 */
export function fitWarnings(before: FitState, now: FitState): string[] {
  const out: string[] = [];
  const added = now.lines - before.lines;
  if (added > 0) out.push(added === 1 ? '+1 line' : `+${added} lines`);
  const grew = (b: number, n: number) => n > 0 && n > b + OVERFLOW_SLACK_PX;
  if (grew(before.overflow, now.overflow) || grew(before.containerOverflow, now.containerOverflow)) out.push('overflows');
  if (now.widow && !before.widow) out.push('widow');
  return out;
}

// ------------------------------------------------------------------------------------------- DOM

const INLINE_DISPLAYS = new Set(['inline', 'contents']);
/** Words per last line looked at; a last line holds far fewer. */
const MAX_WORDS_SCANNED = 400;

function typedValue(el: Element, prop: string): string | null {
  const f = (el as Element & { computedStyleMap?: () => { get(p: string): unknown } }).computedStyleMap;
  if (typeof f !== 'function') return null;
  try {
    const v = f.call(el).get(prop);
    return v === null || v === undefined ? null : String(v);
  } catch {
    return null;
  }
}

/** The nearest ancestor with a fixed height or overflow other than visible (see the heuristic above), or null. */
export function fitContainer(el: Element, win: Window): Element | null {
  for (let a = el.parentElement; a; a = a.parentElement) {
    const n = a.localName;
    if (n === 'body' || n === 'html') return null;
    const cs = win.getComputedStyle(a);
    if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return a;
    const h = typedValue(a, 'height');
    if (h !== null && h !== 'auto') return a;
    const mh = typedValue(a, 'max-height');
    if (mh !== null && mh !== 'none') return a;
    if ((cs.position === 'absolute' || cs.position === 'fixed') && cs.top !== 'auto' && cs.bottom !== 'auto' && h !== null) return a;
  }
  return null;
}

/** The element's block: itself unless it is inline, else its nearest ancestor that is not. */
function blockOf(el: Element, win: Window): Element {
  let cur: Element = el;
  while (cur.parentElement && INLINE_DISPLAYS.has(win.getComputedStyle(cur).display)) cur = cur.parentElement;
  return cur;
}

function contentWidth(el: Element, win: Window): number {
  const cs = win.getComputedStyle(el);
  const w = (el as HTMLElement).clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  return w > 0 ? w : el.getBoundingClientRect().width;
}

/**
 * Words on the last line. Words are found in the element's whole text, so a word split across inline elements
 * ("Bold<b>er</b>") counts once; each is placed by its last character, scanning from the end until a word sits on
 * an earlier line.
 */
function lastLineWords(el: Element, last: LineBox): number {
  const doc = el.ownerDocument;
  const texts: { t: Text; start: number }[] = [];
  let all = '';
  const walker = doc.createTreeWalker(el, 0x4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    texts.push({ t: n as Text, start: all.length });
    all += (n as Text).data;
  }
  const ends: number[] = [];
  const re = /[^ \t\n\r\f\u00a0]+/g;
  for (let m = re.exec(all); m; m = re.exec(all)) ends.push(m.index + m[0].length);
  const range = doc.createRange();
  let words = 0;
  for (let k = ends.length - 1, scanned = 0; k >= 0 && scanned < MAX_WORDS_SCANNED; k--, scanned++) {
    // The word's last character: a whole surrogate pair when it ends in one.
    const end = ends[k];
    const lo = all.charCodeAt(end - 1);
    const hi = all.charCodeAt(end - 2);
    const at = end >= 2 && lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff ? end - 2 : end - 1;
    let i = texts.length - 1;
    while (i > 0 && texts[i].start > at) i--;
    const { t, start } = texts[i];
    range.setStart(t, at - start);
    range.setEnd(t, Math.min(t.data.length, end - start));
    const r = range.getBoundingClientRect();
    if (!(r.width > 0 || r.height > 0)) continue; // not rendered (collapsed white space, hidden)
    const c = (r.top + r.bottom) / 2;
    if (c >= last.top && c <= last.bottom) words++;
    else if (c < last.top) break;
  }
  return words;
}

/**
 * Reads the element's FitState now: its line boxes, its own overflow (block elements only: an inline box has no
 * scroll size), the container's overflow, and whether the last line is a widow.
 */
export function measureFit(el: Element, win: Window, container: Element | null): FitState {
  const doc = el.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(el);
  const lines = lineBoxes(Array.from(range.getClientRects()));
  const inline = INLINE_DISPLAYS.has(win.getComputedStyle(el).display);
  const overflow = inline ? 0 : overflowOf(el as HTMLElement);
  const containerOverflow = container && container.isConnected ? overflowOf(container as HTMLElement) : 0;
  let widow = false;
  if (lines.length >= 2) {
    const last = lines[lines.length - 1];
    widow = isWidow(lines.length, { width: last.right - last.left, words: lastLineWords(el, last) }, contentWidth(blockOf(el, win), win));
  }
  return { lines: lines.length, overflow, containerOverflow, widow };
}

/**
 * 6.3 Fit guard with 6.3 Source case (lead decision E-10, review finding 10): the reading of the text as it renders
 * once the field closes. While a field is open its element shows the file's case (text-transform: none,
 * font-variant-caps: normal); `rendered` lists those inline properties with the values the element had before the
 * field set them ([property, value, priority], value '' for none). They are put back for the reading and the field's
 * overrides restored right after, in the same task, so nothing is painted in between.
 */
export function measureFitAs(el: HTMLElement, win: Window, container: Element | null, rendered: readonly (readonly [string, string, string])[]): FitState {
  if (rendered.length === 0) return measureFit(el, win, container);
  const set = (list: readonly (readonly [string, string, string])[]) => {
    for (const [prop, value, prio] of list) {
      if (value) el.style.setProperty(prop, value, prio);
      else el.style.removeProperty(prop);
    }
  };
  const editing = rendered.map(([prop]) => [prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)] as const);
  set(rendered);
  try {
    return measureFit(el, win, container);
  } finally {
    set(editing);
  }
}
