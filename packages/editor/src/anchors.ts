// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// Confirming a place by the text on BOTH sides of it (9.2 Write protocol step 2 and Undo case 2, lead decision
// E-1; the hardening round after the repair). A write that was planned on one version of the file (a stale edit,
// an undo or redo after another program changed the file) is placed in the current version by position, through a
// diff. A diff is a minimal edit script, not the truth: when the text is in more than one place, or another place
// starts to hold it, the diff can line the author's run up with another copy without any change overlapping it.
// So the diff's place is written only when the text around it says, on both sides, that it is the author's run:
//
//   For each side, the ANCHOR is the run's old context on that side, from its edge out to the run's UNIQUE DEPTH
//   in the old source (the shortest length at which that context occurs nowhere else in the old file) plus
//   ANCHOR_MARGIN characters, and at least ANCHOR_FLOOR characters. The place is confirmed when, on both sides,
//     1. the current source holds exactly the anchor right next to the place (or, when the anchor would reach
//        the start or end of the file, the whole old text up to it, unchanged);
//     2. the anchor occurs nowhere else in the current source;
//     3. the anchor's far end (the character that made it unique and the ANCHOR_MARGIN characters past it) occurs
//        no more often in the current source than in the old one: a copy of the run's surroundings was not added.
//
// Why both sides: a place confirmed on one side only cannot be told from another program changing the author's run
// and putting a copy of its text next to its unchanged context on that side (a table cell set to another value
// and a row ending in the old value appended; a list item deleted and the one before it set to the same value).
// Why the unique depth: text that repeats (a slide template, a table's markup) tells nothing apart; only what
// differs between the copies does, and a margin past it keeps a change there from being matched by chance.
// Anything unconfirmed is a verbatim note; a write never lands where the text cannot say it belongs.

/** Characters of context past the run's unique depth that must be unchanged on each side. */
export const ANCHOR_MARGIN = 32;
/**
 * The least context that must be unchanged on each side, however soon the run's context is unique: the run's own
 * element and what sits next to it (a slide's id two lines above its heading, a card's other fields). A copy of a
 * slide with another id, left where the author's slide was deleted, differs from it there.
 */
export const ANCHOR_FLOOR = 128;
/** The seed of the search for other places whose context agrees with the run's. */
const SEED = 8;
/** The deepest unique depth an anchor may have; past it the place is not confirmed (a deck of huge repeats). */
const MAX_DEPTH = 1 << 16;
/** How many characters one confirmation may compare; past that it is not confirmed. */
const BUDGET = 40_000_000;
/** Past this many copies in the old source, a far end is generic markup and is not counted. */
const FEATURE_CAP = 4096;

export type Confirmation = { ok: true } | { ok: false; why: string };

/** Why a place is not confirmed, for the note's reason. */
export const NOT_CONFIRMED = {
  changed: 'the text around the edited place changed, so its place in the current file cannot be confirmed (9.2 Write protocol step 2)',
  repeated: 'the text around the edited place is now in more than one place, so which one it is cannot be told (9.2 Write protocol step 2)',
  copied: 'another copy of the text around the edited place was added, so which one it is cannot be told (9.2 Write protocol step 2)',
  deep: 'the text is repeated too widely to tell its copies apart (9.2 Write protocol step 2)',
} as const;

interface Budget {
  left: number;
}

/**
 * The unique depth of the context right before `at` in src: 1 + the longest agreement between the text right
 * before `at` and the text right before any other position (at least SEED, or what lies before `at`). A result
 * larger than `at` means the context is unique only together with the start of the file. Null past the budget
 * or MAX_DEPTH.
 */
function uniqueBefore(src: string, at: number, b: Budget): number | null {
  const k = Math.min(SEED, at);
  if (k === 0) return 1;
  const seed = src.slice(at - k, at);
  let best = k - 1;
  for (let i = src.indexOf(seed); i >= 0; i = src.indexOf(seed, i + 1)) {
    const p = i + k;
    if (p === at) continue;
    let n = k;
    while (n < p && n < at && src.charCodeAt(p - 1 - n) === src.charCodeAt(at - 1 - n)) n++;
    b.left -= n + 1;
    if (b.left < 0) return null;
    if (n > best) best = n;
    if (best >= MAX_DEPTH) return null;
  }
  return best + 1;
}

/** The same after `at`: a result larger than src.length - at means unique only together with the end of the file. */
function uniqueAfter(src: string, at: number, b: Budget): number | null {
  const k = Math.min(SEED, src.length - at);
  if (k === 0) return 1;
  const seed = src.slice(at, at + k);
  let best = k - 1;
  for (let i = src.indexOf(seed); i >= 0; i = src.indexOf(seed, i + 1)) {
    if (i === at) continue;
    let n = k;
    while (at + n < src.length && i + n < src.length && src.charCodeAt(i + n) === src.charCodeAt(at + n)) n++;
    b.left -= n + 1;
    if (b.left < 0) return null;
    if (n > best) best = n;
    if (best >= MAX_DEPTH) return null;
  }
  return best + 1;
}

/** How many times `needle` occurs in `hay` (overlapping ones too), counting at most `cap`. */
function count(hay: string, needle: string, cap: number, b: Budget): number {
  let c = 0;
  for (let i = hay.indexOf(needle); i >= 0 && c < cap; i = hay.indexOf(needle, i + 1)) {
    c++;
    b.left -= needle.length;
  }
  return c;
}

/**
 * Whether [to.start, to.end) of `cur` is the place of [at.start, at.end) of `old`, by the text on both sides (see the
 * file's comment). The two ranges are the diff's mapping; their own text is the caller's to check.
 */
export function confirmPlace(old: string, at: { start: number; end: number }, cur: string, to: { start: number; end: number }): Confirmation {
  const b: Budget = { left: BUDGET };
  const no = (why: keyof typeof NOT_CONFIRMED): Confirmation => ({ ok: false, why: NOT_CONFIRMED[why] });
  // Left.
  {
    const u = uniqueBefore(old, at.start, b);
    if (u === null) return no('deep');
    const n = Math.max(u + ANCHOR_MARGIN, ANCHOR_FLOOR);
    if (n > at.start) {
      // The anchor reaches the start of the file: everything before the place is unchanged.
      if (to.start !== at.start || cur.slice(0, to.start) !== old.slice(0, at.start)) return no('changed');
    } else {
      const anchor = old.slice(at.start - n, at.start);
      if (to.start < n || cur.slice(to.start - n, to.start) !== anchor) return no('changed');
      if (count(cur, anchor, 2, b) !== 1) return no('repeated');
      const far = old.slice(Math.max(0, at.start - u - ANCHOR_MARGIN), at.start - u + 1);
      const inOld = count(old, far, FEATURE_CAP, b);
      if (inOld < FEATURE_CAP && count(cur, far, inOld + 1, b) > inOld) return no('copied');
    }
  }
  // Right.
  {
    const u = uniqueAfter(old, at.end, b);
    if (u === null) return no('deep');
    const n = Math.max(u + ANCHOR_MARGIN, ANCHOR_FLOOR);
    const tailOld = old.length - at.end;
    if (n > tailOld) {
      if (cur.length - to.end !== tailOld || cur.slice(to.end) !== old.slice(at.end)) return no('changed');
    } else {
      const anchor = old.slice(at.end, at.end + n);
      if (to.end + n > cur.length || cur.slice(to.end, to.end + n) !== anchor) return no('changed');
      if (count(cur, anchor, 2, b) !== 1) return no('repeated');
      const far = old.slice(at.end + u - 1, at.end + u + ANCHOR_MARGIN);
      const inOld = count(old, far, FEATURE_CAP, b);
      if (inOld < FEATURE_CAP && count(cur, far, inOld + 1, b) > inOld) return no('copied');
    }
  }
  if (b.left < 0) return no('deep');
  return { ok: true };
}
