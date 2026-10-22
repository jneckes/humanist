// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// Where a stale edit goes when another program changed the file (9.2 Write protocol step 2; lead decisions E-1 and
// F-1). The request names a run of a version V the file has since moved on from, to the current version C, and
// another program's change (or a restore: a whole other version) lies between them. The edit is written only when
// the text says, with nothing to choose, which run it is:
//
//   a. beforeText is the decoded value of exactly ONE place in V and exactly one in C: one run (HTML text or a script
//      literal, a literal's shadow run too) and no shadow value (text the page may show that Blueline never writes,
//      DeckMap.shadows), as the matcher counts copies (D-a). Text in two places is never placed across another
//      program's change: no copy is ever chosen among several, however different their surroundings are.
//   b. The run's raw range, mapped from V to C through a diff (diff_main with a time limit, no clean-up, as the
//      locked spans are moved), lands exactly on that one run in C, of the same kind, with no change overlapping it.
//   c. The text on BOTH sides of the place confirms it (anchors.ts confirmPlace): a minimal diff can line the run up
//      with a run another program changed to hold its text while it changed or deleted the author's (a list item
//      deleted and the one before it set to the same value), and both sides' context tells those apart.
//
// Anything else is a verbatim note: `ambiguous` when the text is in more than one place in V or in C, `stale` when it
// is in one place but the mapping or the anchors fail (or no run holds it any more). Two identical slides swapped or
// moved, an identical copy at the place of the author's deleted slide, a slide duplicated and the original deleted,
// identical divider slides: each has the text in two places on one side, so each is a note.
//
// The queue applies this to each change another program made between V and C (write-queue.ts carryRange), with the
// value of the run at that step, and to V and C themselves; Blueline's own writes are carried exactly, not placed.

import { mapRangesClean } from '@blueline/core/locked-spans';
import type { DeckMap, HtmlRun, LiteralRun, RefusalCode } from '@blueline/core/types';
import { confirmPlace } from './anchors';

type Run = HtmlRun | LiteralRun;

/** One version of the file as the queue holds it. */
export interface PlaceVersion {
  src: string;
  map: DeckMap;
}

export type Placed = { ok: true; runId: string } | { ok: false; why: string; code: RefusalCode };

/** Why a stale edit is not placed, for the note's reason. */
export const NOT_PLACED = {
  copies:
    'the text is in more than one place and another program changed the deck, so which one the edit was made on cannot be told (9.2 Write protocol step 2)',
  gone: 'the deck changed and no run holds beforeText any more (9.2 Write protocol step 2)',
  moved: 'the deck changed where the text was, and the one run that holds it now is not where it was (9.2 Write protocol step 2)',
  timeout: 'the deck changed and the change was too large to place the edit by position (9.2 Write protocol step 2)',
} as const;

/** The runs of a version whose decoded value is `text`: HTML-text and literal runs, a literal's shadow run too. */
export function runsHolding(map: DeckMap, text: string): Run[] {
  const out: Run[] = [];
  for (const r of map.runs) if (r.value === text) out.push(r);
  for (const r of map.literals) if (r.value === text) out.push(r);
  return out;
}

/**
 * How many places of a version hold `text` (rule a): its runs, and one more for each shadow value equal to it, as
 * the matcher counts them (a literal equal to a shadow value is not the only source of its text, D-a).
 */
export function placesOf(map: DeckMap, text: string): number {
  let n = runsHolding(map, text).length;
  for (const s of map.shadows ?? []) if (s.value === text) n++;
  return n;
}

/**
 * Places a stale edit across another program's change (see the file's comment). `old` is the client's version and
 * `run` its run (already checked to hold beforeText); `cur` is the version just read, or the version after one change.
 */
export function placeStale(old: PlaceVersion, run: Run, cur: PlaceVersion, beforeText: string, timeoutSec: number): Placed {
  // a. One place in each version. The run itself is the one in `old`.
  const inCur = runsHolding(cur.map, beforeText);
  if (placesOf(old.map, beforeText) > 1 || placesOf(cur.map, beforeText) > 1) return { ok: false, why: NOT_PLACED.copies, code: 'ambiguous' };
  const hit = inCur[0];
  if (!hit) return { ok: false, why: NOT_PLACED.gone, code: 'stale' };
  // b. The diff's place is exactly that run, of the same kind: an edit never moves between parsed text and a script
  // literal, which are different places on the page.
  const at = mapRangesClean(old.src, cur.src, [[run.start, run.end]], { timeoutSec })[0];
  if (!at.ok) return { ok: false, why: at.why === 'timeout' ? NOT_PLACED.timeout : NOT_PLACED.moved, code: 'stale' };
  if (hit.id.slice(0, 2) !== run.id.slice(0, 2) || hit.start !== at.start || hit.end !== at.end) return { ok: false, why: NOT_PLACED.moved, code: 'stale' };
  // c. Both sides.
  const confirmed = confirmPlace(old.src, run, cur.src, hit);
  if (!confirmed.ok) return { ok: false, why: confirmed.why, code: 'stale' };
  return { ok: true, runId: hit.id };
}
