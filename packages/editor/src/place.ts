// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// Where a stale edit goes (9.2 Write protocol step 2; lead decision E-1): the request names a run of a version
// the file has since moved on from. The run is placed by POSITION: its raw range is mapped from the client's
// version to the current source through a diff (diff_main with a time limit, no clean-up, as the locked spans are
// moved), and only a run of the same kind at exactly the mapped range, holding beforeText, with no change
// overlapping it, can be the edit's run. Text alone never picks a copy, and neither do the 32 characters of
// context around it.
//
// A diff is a minimal edit script, not the truth: it lines the run up with ANOTHER copy of its text, with no change
// overlapping it, when another program moves or copies a templated slide, deletes the author's slide while another
// place comes to hold the text (a near copy fixed, a slide renamed, a serialiser respelling the other copy), or
// changes the author's copy while a copy slides next to its unchanged context (a table cell set to another value
// and a row appended). The repair step's rules checked one side of the run, or the other copies' surroundings, and
// each of those cases got through one of them (the hardening round). So the place is written only when:
//
//   1. The text on BOTH sides of the diff's place is the run's old text there, out to where that text is unique in
//      the old version and a margin past it, and that text is nowhere else in the current version, and no copy of
//      the run's distinguishing surroundings was added (anchors.ts confirmPlace). One side is never enough: a
//      place confirmed on one side cannot be told from the author's run changed and a copy put next to that side.
//   2. No copy of the text that the other program added (a run holding beforeText that is no old copy's image)
//      carries more than ANCHOR_MARGIN characters of the run's old surroundings on both sides: such a copy could
//      be the author's slide changed a little, with the diff's place a copy of it (a slide duplicated beside the
//      author's, then the original's kicker edited).
//
// Anything else is a verbatim note (`ambiguous`), never a guess: a note keeps the author's words; a write into
// another copy changes a slide they did not touch. Two copies that differ only in where they are (identical
// slides) are told apart by their neighbours; a move of one of them cannot be seen in the text at all.

import { mapRangesClean, type CleanRange } from '@blueline/core/locked-spans';
import type { DeckMap, HtmlRun, LiteralRun, RefusalCode } from '@blueline/core/types';
import { ANCHOR_MARGIN, confirmPlace } from './anchors';

/** The most characters rule 2 compares; past that the edit is a note (a deck of thousands of copies). */
const PLACE_BUDGET = 20_000_000;

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

/** How many characters right before x[a] and y[b] are equal, comparing at most `cap`. */
function agreeBefore(x: string, a: number, y: string, b: number, cap: number): number {
  let n = 0;
  while (n < cap && n < a && n < b && x.charCodeAt(a - 1 - n) === y.charCodeAt(b - 1 - n)) n++;
  return n;
}

/** How many characters from x[a] and y[b] on are equal, comparing at most `cap`. */
function agreeAfter(x: string, a: number, y: string, b: number, cap: number): number {
  let n = 0;
  while (n < cap && a + n < x.length && b + n < y.length && x.charCodeAt(a + n) === y.charCodeAt(b + n)) n++;
  return n;
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
  // Rule 1: both sides.
  const confirmed = confirmPlace(old.src, run, cur.src, hit);
  if (!confirmed.ok) return { ok: false, why: confirmed.why, code: 'ambiguous' };
  // Rule 2: the copies the other program added.
  const images = new Set<Run>([hit]);
  others.forEach((r, i) => {
    const image = imageOf(r, mapped[i + 1]);
    if (image) images.add(image);
  });
  let budget = PLACE_BUDGET;
  const cap = ANCHOR_MARGIN + 1;
  for (const k of copiesCur) {
    if (images.has(k)) continue;
    const l = agreeBefore(cur.src, k.start, old.src, run.start, cap);
    const r = agreeAfter(cur.src, k.end, old.src, run.end, cap);
    budget -= l + r + 2;
    if (budget < 0) return { ok: false, why: 'the text is in too many places to tell its copies apart (9.2 Write protocol step 2)', code: 'ambiguous' };
    if (l > ANCHOR_MARGIN && r > ANCHOR_MARGIN) {
      return { ok: false, why: 'the text is in several places, and the deck now has another copy of it with the same surroundings (9.2 Write protocol step 2)', code: 'ambiguous' };
    }
  }
  return { ok: true, runId: hit.id };
}
