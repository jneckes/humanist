// Find across slides (6.9 Find, Cmd+F): "Find searches the document's whole text, including slides that are
// not showing. It uses the text index that the background walk builds for thumbnails, and lists results by
// slide. Choosing a result navigates to that slide, then highlights the match with findInPage."
//
// - findInDeck searches the slide index (slide-index.ts), never the live page: every slide, shown or not.
//   Matching ignores case and diacritics (NFD, combining marks removed), treats curly and straight quotes,
//   dashes and every kind of space alike, and collapses whitespace; snippets keep the original spelling.
// - findOnSlide gives the views item what to ask findInPage for after navigating to the hit's slide: the
//   matched text in its original spelling and its occurrence on the slide.
// - highlightMatch drives findInPage on the deck view to that occurrence. findInPage searches the whole page,
//   including slides that are rendered but not shown (opacity 0, moved off screen; Phase 1 finding), so it
//   steps through the matches and counts only those whose selection lies inside the view.
// - validateFindArgs / validateFindShowArgs check the shell's calls (ipc-guard ArgsValidator style).

import type { WebContents } from 'electron';
import { FIND_MAX_HITS, FIND_MAX_QUERY, type FindHit, type FindResponse, type SlideIndex } from '@blueline/core/ipc-render';
import type { ArgsValidator } from './ipc-guard';

// ------------------------------------------------------------------------------------------- folding

/** Spaces that read as a space (U+00A0 no-break, U+2007 figure, U+202F narrow no-break, ideographic, BOM). */
const SPACE = /[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u;
const FOLD_CHARS: Readonly<Record<string, string>> = Object.freeze({
  // Curly and prime quotes, guillemets: straight quotes.
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2032': "'", '\u02bc': "'",
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '\u2033': '"', '\u00ab': '"', '\u00bb': '"',
  // Hyphens, dashes and minus: a hyphen-minus.
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  // The ellipsis: three full stops.
  '\u2026': '...',
  // Zero-width characters and the soft hyphen fold to nothing.
  '\u200b': '', '\u200c': '', '\u200d': '', '\u2060': '', '\u00ad': '',
});
const MARKS = /\p{M}/gu;

/** A folded string and, for each of its UTF-16 units, the original range it came from. */
export interface Folded {
  text: string;
  /** start[i]: index in the original of the code point that produced folded unit i. */
  start: number[];
  /** end[i]: end (exclusive) in the original of that code point. */
  end: number[];
}

/** Folds one code point: case and diacritics removed (NFD, lower case, NFD again, marks dropped). */
export function foldCodePoint(cp: string): string {
  const f = FOLD_CHARS[cp];
  if (f !== undefined) return f;
  return cp.normalize('NFD').toLowerCase().normalize('NFD').replace(MARKS, '');
}

/** Folds `s` for matching (see the module comment), keeping the map back to the original. */
export function fold(s: string): Folded {
  const out: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let lastSpace = true; // leading whitespace is dropped
  let i = 0;
  for (const cp of s) {
    const at = i;
    i += cp.length;
    if (SPACE.test(cp)) {
      if (!lastSpace) {
        out.push(' ');
        start.push(at);
        end.push(i);
        lastSpace = true;
      } else if (end.length && out[out.length - 1] === ' ') end[end.length - 1] = i;
      continue;
    }
    const f = foldCodePoint(cp);
    for (let k = 0; k < f.length; k++) {
      out.push(f[k]);
      start.push(at);
      end.push(i);
    }
    if (f.length) lastSpace = false;
  }
  // Trailing whitespace is dropped.
  if (out.length && out[out.length - 1] === ' ') {
    out.pop();
    start.pop();
    end.pop();
  }
  return { text: out.join(''), start, end };
}

/** The query as matched: folded, at most FIND_MAX_QUERY units. */
export function foldQuery(query: string): string {
  return fold(query.slice(0, FIND_MAX_QUERY)).text;
}

// ------------------------------------------------------------------------------------------- snippets

/** Characters of context before and after a match in a snippet. */
export const SNIPPET_BEFORE = 40;
export const SNIPPET_AFTER = 60;

/**
 * An extract of `text` around [start, end): up to 40 characters before and 60 after, cut at a word boundary
 * when one is near, with "…" where text was cut. Returns the match's offsets inside the snippet.
 */
export function makeSnippet(text: string, start: number, end: number): { snippet: string; start: number; end: number } {
  let a = Math.max(0, start - SNIPPET_BEFORE);
  let b = Math.min(text.length, end + SNIPPET_AFTER);
  if (a > 0) {
    const sp = text.indexOf(' ', a);
    if (sp >= 0 && sp < start) a = sp + 1;
  }
  if (b < text.length) {
    const sp = text.lastIndexOf(' ', b);
    if (sp > end) b = sp;
  }
  // Never split a surrogate pair at either edge.
  if (a > 0 && isLowSurrogate(text.charCodeAt(a))) a--;
  if (b < text.length && isLowSurrogate(text.charCodeAt(b))) b++;
  const pre = a > 0 ? '\u2026' : '';
  const post = b < text.length ? '\u2026' : '';
  const body = text.slice(a, b);
  return { snippet: pre + body + post, start: pre.length + (start - a), end: pre.length + (end - a) };
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

// ------------------------------------------------------------------------------------------- search

/** The slide's searchable text: its strings in order, one space between them (a phrase may span two). */
export function slideText(strings: readonly string[]): string {
  return strings.join(' ');
}

/**
 * Every match of `query` in the index, by slide, then by position (6.9 Find). Case- and diacritic-insensitive.
 * At most FIND_MAX_HITS hits (`truncated` says there were more).
 */
export function searchIndex(index: SlideIndex, query: string): { hits: FindHit[]; truncated: boolean } {
  const q = foldQuery(typeof query === 'string' ? query : '');
  const hits: FindHit[] = [];
  if (!q) return { hits, truncated: false };
  // A document is one page: findInPage counts its matches across all sections.
  const pageWide = index.kind === 'scroll' || index.kind === 'single';
  let pageCount = 0;
  for (const slide of index.slides) {
    const text = slideText(slide.text);
    const f = fold(text);
    let onSlide = 0;
    for (let at = f.text.indexOf(q); at >= 0; at = f.text.indexOf(q, at + q.length)) {
      if (hits.length >= FIND_MAX_HITS) return { hits, truncated: true };
      const os = f.start[at];
      const oe = f.end[at + q.length - 1];
      const snip = makeSnippet(text, os, oe);
      hits.push({
        slide: slide.index,
        title: slide.title,
        snippet: snip.snippet,
        snippetMatch: { start: snip.start, end: snip.end },
        matchIndex: pageWide ? pageCount : onSlide,
        text: text.slice(os, oe),
      });
      onSlide++;
      pageCount++;
    }
  }
  return { hits, truncated: false };
}

/** 6.9 Find over the slide index: FindHit[] ordered by slide (docs/PHASE1-PLAN.md render-products). */
export function findInDeck(index: SlideIndex, query: string): FindHit[] {
  return searchIndex(index, query).hits;
}

/** The shell's Find reply. `index` null means the index is still being built (pending). */
export function findResponse(index: SlideIndex | null, query: string): FindResponse {
  if (!index) return { query, version: null, hits: [], truncated: false, pending: true };
  const r = searchIndex(index, query);
  return { query, version: index.version, hits: r.hits, truncated: r.truncated, pending: false };
}

/**
 * What findInPage needs once the deck view shows the hit's slide (6.9 Find): the matched text as the slide
 * spells it, and which of the matches on the slide this is (on a document, on the page). findInPage itself
 * ignores case and diacritics, so the text finds the same occurrences Find counted.
 */
export function findOnSlide(
  hit: Pick<FindHit, 'text' | 'matchIndex'>,
  index?: Pick<SlideIndex, 'kind'>,
): { text: string; occurrence: number; pageWide: boolean; options: { matchCase: false } } {
  const pageWide = index ? index.kind === 'scroll' || index.kind === 'single' : false;
  return { text: hit.text, occurrence: hit.matchIndex, pageWide, options: { matchCase: false } };
}

/** The hit a shell's Find-show call names, checked against the current index (the shell names, main decides). */
export function hitFor(index: SlideIndex, query: string, slide: number, matchIndex: number): FindHit | null {
  for (const h of searchIndex(index, query).hits) if (h.slide === slide && h.matchIndex === matchIndex) return h;
  return null;
}

// ------------------------------------------------------------------------------------------- findInPage

/** The part of a WebContents highlightMatch drives (narrow, so tests can pass a fake). */
export type FindInPageTarget = Pick<WebContents, 'findInPage' | 'stopFindInPage' | 'on' | 'removeListener'>;

export interface FoundInPage {
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  selectionArea: { x: number; y: number; width: number; height: number };
  finalUpdate: boolean;
}

/** findInPage reports selections in the view's own coordinates (DIP; setZoomFactor scales them). */
export function inView(r: FoundInPage['selectionArea'], view: { width: number; height: number }): boolean {
  return r.width > 0 && r.height > 0 && r.x + r.width > 0 && r.y + r.height > 0 && r.x < view.width && r.y < view.height;
}

/** What highlightMatch did: the active match's ordinal, or ok false. */
export interface HighlightResult {
  ok: boolean;
  ordinal: number;
  matches: number;
  /**
   * The active match's selection as findInPage reported it (view DIP). For a match findInPage had to scroll
   * the page to, that is where it was before the scroll (Phase 1 finding): only a deck's unscrolled view gives
   * its position on screen.
   */
  rect?: FoundInPage['selectionArea'];
}

/** Steps through at most this many matches; beyond it the first visible one is highlighted. */
export const HIGHLIGHT_MAX_STEPS = 200;

function findOnce(wc: FindInPageTarget, text: string, newSession: boolean, timeoutMs: number): Promise<FoundInPage | null> {
  return new Promise((resolve) => {
    let id = -1;
    const timer = setTimeout(() => done(null), timeoutMs);
    const onFound = (_e: unknown, r: FoundInPage) => {
      if (r && r.requestId === id && r.finalUpdate) done(r);
    };
    const done = (r: FoundInPage | null) => {
      clearTimeout(timer);
      wc.removeListener('found-in-page', onFound as never);
      resolve(r);
    };
    wc.on('found-in-page', onFound as never);
    // Electron: findNext true begins a new session; false asks for the next match of the session.
    id = wc.findInPage(text, { findNext: newSession, forward: true, matchCase: false });
  });
}

/**
 * Highlights occurrence `occurrence` (0-based) among the matches of `text` that lie inside the view (6.9 Find:
 * "highlights the match with findInPage"). The page is the deck view showing the hit's slide; `view` is its
 * size. A document (`pageWide`) is one page that findInPage scrolls through: there the occurrence counts every
 * match of the page. Returns the ordinal highlighted, or ok false when the text is not on screen.
 */
export async function highlightMatch(
  wc: FindInPageTarget,
  req: { text: string; occurrence: number; pageWide?: boolean },
  view: { width: number; height: number },
  opts: { timeoutMs?: number; retryMs?: number } = {},
): Promise<HighlightResult> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const text = req.text.slice(0, FIND_MAX_QUERY);
  if (!text.trim()) return { ok: false, ordinal: 0, matches: 0 };
  const done = (ok: boolean, last: FoundInPage | null, matches: number): HighlightResult =>
    last ? { ok, ordinal: last.activeMatchOrdinal, matches, rect: { ...last.selectionArea } } : { ok, ordinal: 0, matches };
  wc.stopFindInPage('clearSelection');
  let r = await findOnce(wc, text, true, timeoutMs);
  if (!r || r.matches === 0) {
    // Right after a load or a slide change the first request can report no matches (Phase 1 finding).
    await new Promise((res) => setTimeout(res, opts.retryMs ?? 150));
    wc.stopFindInPage('clearSelection');
    r = await findOnce(wc, text, true, timeoutMs);
  }
  if (!r || r.matches === 0) return { ok: false, ordinal: 0, matches: 0 };
  const total = r.matches;
  if (req.pageWide) {
    // A document: the occurrence counts across the page, and findInPage scrolls each match into view.
    const want = Math.min(Math.max(0, req.occurrence), total - 1) + 1;
    for (let s = 0; r && r.activeMatchOrdinal !== want && s < Math.min(total, HIGHLIGHT_MAX_STEPS); s++) r = await findOnce(wc, text, false, timeoutMs);
    const reached = !!r && r.activeMatchOrdinal === want;
    return done(reached && req.occurrence < total, r, total);
  }
  const steps = Math.min(total, HIGHLIGHT_MAX_STEPS);
  const visible: number[] = [];
  const seen = new Set<number>();
  for (let s = 0; s < steps && r; s++) {
    if (!seen.has(r.activeMatchOrdinal)) {
      seen.add(r.activeMatchOrdinal);
      if (inView(r.selectionArea, view)) visible.push(r.activeMatchOrdinal);
    }
    if (seen.size >= steps) break;
    r = await findOnce(wc, text, false, timeoutMs);
  }
  visible.sort((a, b) => a - b);
  if (visible.length === 0) return done(false, r, total);
  const want = visible[Math.min(Math.max(0, req.occurrence), visible.length - 1)];
  for (let s = 0; r && r.activeMatchOrdinal !== want && s <= steps; s++) r = await findOnce(wc, text, false, timeoutMs);
  const ok = !!r && r.activeMatchOrdinal === want;
  return done(ok && req.occurrence < visible.length, r, total);
}

// ------------------------------------------------------------------------------------------- shell calls

/** Controls refused in a query: they are never typed, and a query is shown back in the shell. */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** RenderShellChannels.find: [query: string]. */
export const validateFindArgs: ArgsValidator<string> = (args) => {
  if (args.length !== 1) return { ok: false, why: 'expected one argument' };
  const q = args[0];
  if (typeof q !== 'string') return { ok: false, why: 'query: not a string' };
  if (q.length > FIND_MAX_QUERY) return { ok: false, why: 'query: too long' };
  if (CONTROL.test(q)) return { ok: false, why: 'query: control characters' };
  return { ok: true, value: String(q) };
};

/** RenderShellChannels.findShow: [slide: number, matchIndex: number]. */
export const validateFindShowArgs: ArgsValidator<{ slide: number; matchIndex: number }> = (args) => {
  if (args.length !== 2) return { ok: false, why: 'expected two arguments' };
  const [slide, matchIndex] = args;
  const okInt = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
  if (!okInt(slide, 9_999)) return { ok: false, why: 'slide: not an index' };
  if (!okInt(matchIndex, 1_000_000)) return { ok: false, why: 'matchIndex: not an index' };
  return { ok: true, value: { slide, matchIndex } };
};
