// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// Where a stale edit goes (9.2 Write protocol step 2; lead decision E-1): the request names a run of a version
// the file has since moved on from. The run is placed by POSITION: its raw range is mapped from the client's
// version to the current source through a diff (diff_main with a time limit, no clean-up, as the locked spans are
// moved), and only a run of the same kind at exactly the mapped range, holding beforeText, with no change
// overlapping it, can be the edit's run. Text alone never picks a copy, and neither do the 32 characters of
// context around it.
//
// A position alone is not enough when beforeText is in more than one place. A minimal diff of a moved or copied
// templated slide aligns the edited heading with ANOTHER slide's heading with no change overlapping it (review
// finding 0, re-verification: a slide moved to the end, or a templated slide inserted at the top while the edited
// slide's subtitle changed). So the diff must account for every copy of the text, and the text around each copy
// must confirm the diff's choice:
//
//   1. Every old copy the diff keeps (a run of the same kind holding beforeText at exactly its mapped range) is
//      told apart from every other old copy by text the diff left unchanged around it: on one side at least, the
//      unchanged stretch reaches PLACE_MARGIN characters past the point where the two copies stop agreeing (or
//      to the start or end of both files). A moved copy fails this: the diff aligns it with another copy, and
//      what told the two apart changed.
//   2. The run's place does not hold what told another old copy apart from the run, and no other kept copy holds
//      what told the run apart from it (FEATURE_MARGIN characters past the point): each stretch is looked for with
//      a diff of the two neighbourhoods, each cut at its nearest other copy, so a change nearer the run does not
//      hide it. Either means two places each carry part of the run's surroundings. A side where the diff left the
//      place's surroundings unchanged past that point is not searched: that text is the copy's own old text, which
//      differs from the stretch right there, and a match further out is repeated markup (two lists of the same
//      items, with an unrelated change elsewhere in the file).
//   3. A copy in the current version that is no kept old copy (one the other program added, or moved) shares no
//      stretch of more than PLACE_MARGIN characters with the run's neighbourhood, and the unchanged stretch around
//      the run's place reaches PLACE_MARGIN characters past where that copy stops agreeing with the run's
//      surroundings, on both sides. A templated copy (a slide made from the same template) fails this. A copy in
//      other markup (its surroundings stop agreeing with the run's within FOREIGN_AGREEMENT characters on both
//      sides, where the run's place agrees further) passes: the same words pasted into a new paragraph.
//
// Anything else is a verbatim note (`ambiguous`), never a guess: a note keeps the author's words; a write into
// another copy changes a slide they did not touch. Two copies that differ only in where they are (identical
// slides) are told apart by their neighbours; a move of one of them cannot be seen in the text at all.

import { longestKept, mapRangesClean, stretchesKept, type CleanRange } from '@blueline/core/locked-spans';
import type { DeckMap, HtmlRun, LiteralRun, RefusalCode } from '@blueline/core/types';

/** How many characters past the point where two copies stop agreeing must be unchanged to tell them apart. */
export const PLACE_MARGIN = 32;
/** The same, for what told the run apart from an old copy, looked for around that copy's place (rule 2). */
export const FEATURE_MARGIN = 16;
/**
 * Rule 3: a copy that agrees with the run's surroundings for at most this many characters on each side is in other
 * markup than the run (another element around the same text).
 */
const FOREIGN_AGREEMENT = 8;
/** The longest stretch of context compared between two copies; agreeing further than that tells nothing apart. */
const AGREE_CAP = 1 << 20;
/** The most characters one placement compares; past that the edit is a note (a deck of thousands of copies). */
const PLACE_BUDGET = 20_000_000;
/** The deepest point where two copies stop agreeing that rule 2 looks for in another neighbourhood. */
const FEATURE_WINDOW = 1 << 16;
/**
 * How much more of a current copy's neighbourhood is searched, for text inserted between it and the stretch (a
 * change nearer the run). Kept small: in a deck of repeated markup a longer window finds the stretch somewhere by
 * chance (the local decks: notes where the place was sure).
 */
const FEATURE_SLACK = 128;
/** The neighbourhood rule 3 compares on each side. */
const RELATED_WINDOW = 256;
/** The time limit of each neighbourhood diff (seconds), and of all of them for one placement (ms). */
const FEATURE_DIFF_SEC = 0.25;
const FEATURE_TIME_MS = 2000;

type Run = HtmlRun | LiteralRun;

/** One version of the file as the queue holds it. */
export interface PlaceVersion {
  src: string;
  map: DeckMap;
}

export type Placed = { ok: true; runId: string } | { ok: false; why: string; code: RefusalCode };

function allRuns(map: DeckMap): Run[] {
  return [...map.runs, ...map.literals];
}

function overlaps(r: { start: number; end: number }, s: { start: number; end: number }): boolean {
  return (r.start < s.end && s.start < r.end) || (r.start === s.start && r.end === s.end);
}

/** How many characters right before x[a] and y[b] are equal (Infinity past AGREE_CAP). */
function agreeBefore(x: string, a: number, y: string, b: number): number {
  let n = 0;
  while (n < a && n < b && x.charCodeAt(a - 1 - n) === y.charCodeAt(b - 1 - n)) {
    if (++n >= AGREE_CAP) return Infinity;
  }
  return n;
}

/** How many characters from x[a] and y[b] on are equal (Infinity past AGREE_CAP). */
function agreeAfter(x: string, a: number, y: string, b: number): number {
  let n = 0;
  while (a + n < x.length && b + n < y.length && x.charCodeAt(a + n) === y.charCodeAt(b + n)) {
    if (++n >= AGREE_CAP) return Infinity;
  }
  return n;
}

/**
 * A run's neighbourhood on one side, cut at the nearest other copy and at `reach` characters; a NUL marks the start
 * (end) of the file when the window reaches it, so "nothing before it" is text a diff can keep or not.
 */
function neighbourhood(src: string, copies: Run[], at: { start: number; end: number }, side: 'left' | 'right', reach: number): string {
  if (side === 'left') {
    const from = Math.max(0, at.start - reach, ...copies.filter((r) => r.end <= at.start && !overlaps(r, at)).map((r) => r.end));
    return (from === 0 ? '\0' : '') + src.slice(from, at.start);
  }
  const to = Math.min(src.length, at.end + reach, ...copies.filter((r) => r.start >= at.end && !overlaps(r, at)).map((r) => r.start));
  return src.slice(at.end, to) + (to === src.length ? '\0' : '');
}

/**
 * The stretch of a neighbourhood window (from `neighbourhood`) that holds the first `margin` + 1 characters past
 * agreement depth `d`, or null when the window does not reach that far (cut at another copy, or beyond the cap).
 * Near the start (end) of the file the stretch may be shorter: it then ends at the file's NUL.
 */
function stretchAt(win: string, side: 'left' | 'right', d: number, margin: number): [number, number] | null {
  if (!Number.isFinite(d) || d < 0 || d > FEATURE_WINDOW) return null;
  const w = win.length;
  if (side === 'left') {
    if (d + 1 + margin <= w) return [w - (d + 1 + margin), w - d];
    return win.charCodeAt(0) === 0 && d < w ? [0, w - d] : null;
  }
  if (d + 1 + margin <= w) return [d, d + 1 + margin];
  return win.charCodeAt(w - 1) === 0 && d < w ? [d, w] : null;
}

/**
 * Places a stale edit (see the file's comment). `old` is the client's version and `run` its run (already checked
 * to hold beforeText); `cur` is the version just read.
 */
export function placeStale(old: PlaceVersion, run: Run, cur: PlaceVersion, beforeText: string, timeoutSec: number): Placed {
  const kind = run.id.slice(0, 2);
  const copiesOld = allRuns(old.map).filter((r) => r.value === beforeText);
  const copiesCur = allRuns(cur.map).filter((r) => r.value === beforeText);
  const others = copiesOld.filter((r) => !overlaps(r, run));
  const mapped = mapRangesClean(old.src, cur.src, [[run.start, run.end], ...others.map((r): [number, number] => [r.start, r.end])], { timeoutSec });
  const at = mapped[0];
  // A copy is kept when a run of the same kind (parsed text or a literal) holds the text at exactly its mapped
  // range: an edit never moves between parsed text and a script literal, which are different places on the page.
  const imageOf = (r: Run, m: CleanRange): Run | undefined =>
    m.ok ? copiesCur.find((k) => k.id.slice(0, 2) === r.id.slice(0, 2) && k.start === m.start && k.end === m.end) : undefined;
  const hit = imageOf(run, at);
  if (!hit || !at.ok || hit.id.slice(0, 2) !== kind) {
    if (!at.ok && at.why === 'timeout') return { ok: false, why: 'the deck changed and the change was too large to place the edit by position (9.2 Write protocol step 2)', code: 'stale' };
    if (copiesCur.length > 0) return { ok: false, why: 'the deck changed where the text was, and beforeText is somewhere else (9.2 Write protocol step 2)', code: 'ambiguous' };
    return { ok: false, why: 'the deck changed and no run holds beforeText any more', code: 'stale' };
  }
  if (others.length === 0 && copiesCur.length === 1) return { ok: true, runId: hit.id };
  const kept = others.map((r, i) => ({ image: imageOf(r, mapped[i + 1]), at: mapped[i + 1] }));
  const doubt = copyDoubt(old, run, cur, hit, at, others, kept, copiesOld, copiesCur);
  return doubt ? { ok: false, why: doubt, code: 'ambiguous' } : { ok: true, runId: hit.id };
}

function copyDoubt(
  old: PlaceVersion,
  run: Run,
  cur: PlaceVersion,
  hit: Run,
  clean: CleanRange & { ok: true },
  others: Run[],
  kept: { image: Run | undefined; at: CleanRange }[],
  copiesOld: Run[],
  copiesCur: Run[],
): string | null {
  let budget = PLACE_BUDGET;
  const spend = (...n: number[]): boolean => {
    for (const x of n) budget -= Number.isFinite(x) ? x : AGREE_CAP;
    return budget >= 0;
  };
  const deadline = performance.now() + FEATURE_TIME_MS;
  const late = (): boolean => performance.now() > deadline;
  const tooMany = 'the text is in too many places to tell its copies apart (9.2 Write protocol step 2)';
  const unsure = 'the text is in several places, and the change since the edit\'s version leaves too little unchanged around them to tell which copy is which (9.2 Write protocol step 2)';
  const guess = 'the text is in several places, and more than one of them carries part of the edited one\'s surroundings (9.2 Write protocol step 2)';
  const added = 'the text is in several places, and the deck now has another copy of it with the same surroundings (9.2 Write protocol step 2)';

  const all = [run, ...others];
  const raw = (r: Run): string => old.src.slice(r.start, r.end);
  const cleanOf = (i: number): CleanRange => (i === 0 ? clean : kept[i - 1].at);
  // Agreement of two old copies' surroundings (-1 when they are spelled differently: the text tells them apart).
  const agree = (x: Run, y: Run): { l: number; r: number } | null => {
    if (raw(x) !== raw(y)) return { l: -1, r: -1 };
    const l = agreeBefore(old.src, x.start, old.src, y.start);
    const r = agreeAfter(old.src, x.end, old.src, y.end);
    return spend(l, r) ? { l, r } : null;
  };

  // Rule 1, for the run and every kept old copy.
  const vsRun: ({ l: number; r: number } | undefined)[] = [];
  for (let i = 0; i < all.length; i++) {
    if (i > 0 && !kept[i - 1].image) continue;
    const c = cleanOf(i);
    if (!c.ok) continue;
    for (let j = 0; j < all.length; j++) {
      if (j === i) continue;
      const a = agree(all[i], all[j]);
      if (!a) return tooMany;
      if (i === 0) vsRun[j] = a;
      if (a.l < 0) continue;
      const left = Number.isFinite(a.l) && c.cleanBefore >= a.l + 1 + PLACE_MARGIN;
      const right = Number.isFinite(a.r) && c.cleanAfter >= a.r + 1 + PLACE_MARGIN;
      if (!left && !right) return unsure;
    }
    if (late()) return tooMany;
  }

  // Rule 2.
  for (let j = 1; j < all.length; j++) {
    const a = vsRun[j];
    if (!a || a.l < 0) continue;
    // The run's place must not hold what told copy j apart from the run.
    if (holds(old.src, copiesOld, all[j], a, PLACE_MARGIN, cur.src, copiesCur, hit, clean)) return guess;
    // Copy j's place, when the diff kept it, must not hold what told the run apart from copy j.
    const image = kept[j - 1].image;
    if (image && holds(old.src, copiesOld, run, a, FEATURE_MARGIN, cur.src, copiesCur, image, kept[j - 1].at)) return guess;
    if (late()) return tooMany;
  }

  // Rule 3.
  const images = new Set<Run>([hit, ...kept.map((k) => k.image).filter((x): x is Run => x !== undefined)]);
  const extra = copiesCur.filter((k) => !images.has(k));
  if (extra.length) {
    const tl = neighbourhood(old.src, copiesOld, run, 'left', RELATED_WINDOW);
    const tr = neighbourhood(old.src, copiesOld, run, 'right', RELATED_WINDOW);
    const hl = agreeBefore(cur.src, hit.start, old.src, run.start);
    const hr = agreeAfter(cur.src, hit.end, old.src, run.end);
    if (!spend(hl, hr)) return tooMany;
    for (const k of extra) {
      if (late()) return tooMany;
      const lk = agreeBefore(cur.src, k.start, old.src, run.start);
      const rk = agreeAfter(cur.src, k.end, old.src, run.end);
      if (!spend(lk, rk)) return tooMany;
      // A copy whose own markup differs from the run's right at the text on both sides (another element: the text
      // pasted into a new paragraph) is not the run, while the run's place agrees further on both sides.
      if (lk <= FOREIGN_AGREEMENT && rk <= FOREIGN_AGREEMENT && hl > lk && hr > rk) continue;
      const beaten = Number.isFinite(lk) && Number.isFinite(rk) && clean.cleanBefore >= lk + 1 + PLACE_MARGIN && clean.cleanAfter >= rk + 1 + PLACE_MARGIN;
      if (!beaten) return added;
      const kl = neighbourhood(cur.src, copiesCur, k, 'left', RELATED_WINDOW);
      const kr = neighbourhood(cur.src, copiesCur, k, 'right', RELATED_WINDOW);
      if (!spend(tl.length + kl.length, tr.length + kr.length)) return tooMany;
      const sl = longestKept(tl, kl, { timeoutSec: FEATURE_DIFF_SEC });
      const sr = longestKept(tr, kr, { timeoutSec: FEATURE_DIFF_SEC });
      if (sl === null || sr === null || sl > PLACE_MARGIN || sr > PLACE_MARGIN) return added;
    }
  }
  return null;
}

/**
 * Whether the current copy `k` still holds what told old copy `x` apart from the other copy it was compared with
 * (agreement `a`): on either side, the first character past the point where they stop agreeing and `margin` more,
 * found in k's neighbourhood by a diff of the two neighbourhoods. A diff that ran out of time counts as holding it
 * (it cannot vouch that k does not). `kClean` is k's mapped range: on a side where the diff left at least the
 * stretch's length of k's surroundings unchanged, they are k's own old copy's text, which differs from x's at
 * depth d, so the side is not searched.
 */
function holds(oldSrc: string, copiesOld: Run[], x: Run, a: { l: number; r: number }, margin: number, curSrc: string, copiesCur: Run[], k: Run, kClean: CleanRange): boolean {
  for (const side of ['left', 'right'] as const) {
    const d = side === 'left' ? a.l : a.r;
    if (!Number.isFinite(d) || d < 0 || d > FEATURE_WINDOW) continue;
    const reach = d + 1 + margin;
    const unchanged = kClean.ok ? (side === 'left' ? kClean.cleanBefore : kClean.cleanAfter) : 0;
    if (unchanged >= reach) continue;
    const xw = neighbourhood(oldSrc, copiesOld, x, side, reach);
    const st = stretchAt(xw, side, d, margin);
    if (!st) continue;
    const kw = neighbourhood(curSrc, copiesCur, k, side, reach + FEATURE_SLACK);
    const got = stretchesKept(xw, kw, [st], { timeoutSec: FEATURE_DIFF_SEC });
    if (!got || got[0]) return true;
  }
  return false;
}

