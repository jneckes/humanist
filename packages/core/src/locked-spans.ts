// Locked spans (section 8 "Locked spans are transformed, not searched"; P2-12). Pure functions over source text;
// main calls them on every change of the deck it learns about.
//
// A locked span is the source range of an author's direct edit (a `kind: 'edit'` note). Its offsets and its text
// are in source coordinates: `text` is `src.slice(start, end)` of the version the lock was made or last moved on,
// raw (encoded and escaped) as the file holds it (9.2 rule 2), so own writes, which are raw splices, can update
// it exactly.
//
//   1. Main keeps the content of the last deck version it knew (P2-12 persists it across restarts).
//   2. On an external change (9.2 Watcher, or a change a write absorbed, P2-4): transformLockedSpans diffs the
//      previous and current text with diff_main and maps each span's start and end through diff_xIndex. No
//      diff_cleanupSemantic: it would move the boundaries diff_xIndex maps through.
//   3. A span that a non-EQUAL operation overlaps is violated, its change recorded as {before, after}; its text is
//      not updated. An insertion exactly at a span's start or end does not overlap it. A timed-out, non-minimal
//      diff can only over-report a violation, never hide one, and so does a span whose text does not fit the
//      previous content (the transform cannot vouch for it).
//   4. (A change is not a violation when a note sent in the same pass targets that span: passes arrive in
//      Phase 4, so nothing here yet.)
//   6. Text search never moves a lock. Blueline's own write (an edit, undo or redo) is a raw splice: applyOwnWrite
//      shifts every span after it, and a span the write falls inside gets its text and offsets updated directly.

import DiffMatchPatch from 'diff-match-patch';
import type { LockedSpan } from './types';

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;
const DIFF_EQUAL = 0;

/** diff_main's time limit by default (diff-match-patch's own default, seconds). Main runs it off the reload's path. */
export const LOCK_DIFF_TIMEOUT_SEC = 1;

type Diff = [number, string];

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** A position never between the halves of a surrogate pair: moved one unit in direction `dir` when it is. */
function snap(s: string, i: number, dir: -1 | 1): number {
  return i > 0 && i < s.length && isLow(s.charCodeAt(i)) && isHigh(s.charCodeAt(i - 1)) ? i + dir : i;
}

function wellFormedSpan(s: LockedSpan, length: number): boolean {
  return Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.start <= s.end && s.end <= length;
}

function copySpan(s: LockedSpan): LockedSpan {
  const out: LockedSpan = { start: s.start, end: s.end, text: s.text, noteId: s.noteId, state: s.state };
  if (s.change) out.change = { before: s.change.before, after: s.change.after };
  return out;
}

/**
 * Where text1 offset `loc` lies in text2, placed BEFORE text inserted exactly at `loc`. diff_xIndex places it after
 * such an insertion; this is its mirror, so a span's end does not take in text inserted right after it (rule 3: an
 * insertion at the end does not overlap the span). Inside a deletion both return where the deletion was.
 */
export function xIndexBefore(diffs: Diff[], loc: number): number {
  let p1 = 0;
  let p2 = 0;
  for (const [op, text] of diffs) {
    const n = text.length;
    if (op === DIFF_INSERT) {
      if (p1 === loc) return p2;
      p2 += n;
      continue;
    }
    if (p1 + n > loc) return op === DIFF_EQUAL ? p2 + (loc - p1) : p2;
    p1 += n;
    if (op === DIFF_EQUAL) p2 += n;
  }
  return p2 + (loc - p1);
}

/** Where a range of one version lies in another (mapRange), or why it cannot be told. */
export type MappedRange = { ok: true; start: number; end: number } | { ok: false; why: 'changed' | 'timeout' };

/**
 * Where the range [start, end) of `prev` lies in `cur`, by position (9.2 Write protocol step 2: the run a stale edit
 * was made on, lead decision E-1). Diffed as transformLockedSpans diffs (diff_main with a time limit, no clean-up)
 * and mapped as it maps a span no operation overlaps: the start after and the end before any insertion at the
 * range's edges, so the result holds exactly the range's own characters (diff-match-patch strips the longest common
 * prefix, so text inserted beside a run is often aligned right at its edge). `changed`: an insertion or deletion
 * overlaps the range. `timeout`: the
 * diff reached its time limit (diff-match-patch then gives up on minimality, so its positions cannot vouch for a
 * place); measured against the limit, as diff_main's own deadline is.
 */
export function mapRange(prev: string, cur: string, start: number, end: number, opts: { timeoutSec?: number } = {}): MappedRange {
  const m = mapRangeClean(prev, cur, start, end, opts);
  return m.ok ? { ok: true, start: m.start, end: m.end } : m;
}

/**
 * mapRange, plus how far the diff leaves the text around the range unchanged: `cleanBefore` characters right
 * before `start` and `cleanAfter` right after `end` are one EQUAL stretch with the range in both texts (no change,
 * and no insertion at the range's edges, between them and the range). A stretch that reaches the start (end) of
 * both texts is Infinity: nothing before (after) it differs at all. Used to tell whether the diff kept what tells
 * a run apart from its copies (9.2 Write protocol step 2, write-queue resolve()).
 */
export type CleanRange = { ok: true; start: number; end: number; cleanBefore: number; cleanAfter: number } | { ok: false; why: 'changed' | 'timeout' };

export function mapRangeClean(prev: string, cur: string, start: number, end: number, opts: { timeoutSec?: number } = {}): CleanRange {
  return mapRangesClean(prev, cur, [[start, end]], opts)[0];
}

/** mapRangeClean for several ranges of `prev`, with one diff. */
export function mapRangesClean(prev: string, cur: string, ranges: [number, number][], opts: { timeoutSec?: number } = {}): CleanRange[] {
  const valid = ([start, end]: [number, number]): boolean => Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= prev.length;
  if (prev === cur) return ranges.map((r) => (valid(r) ? { ok: true, start: r[0], end: r[1], cleanBefore: Infinity, cleanAfter: Infinity } : { ok: false, why: 'changed' }));
  const dmp = new DiffMatchPatch();
  const t = opts.timeoutSec;
  const limit = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : LOCK_DIFF_TIMEOUT_SEC;
  dmp.Diff_Timeout = limit;
  const t0 = performance.now();
  const diffs = dmp.diff_main(prev, cur) as Diff[];
  if (limit > 0 && performance.now() - t0 >= limit * 1000) return ranges.map(() => ({ ok: false, why: 'timeout' }));
  // The operations with their positions in both texts.
  const ops: { op: number; a: number; b: number; n: number }[] = [];
  let p = 0;
  let q = 0;
  for (const [op, text] of diffs) {
    ops.push({ op, a: p, b: q, n: text.length });
    if (op !== DIFF_INSERT) p += text.length;
    if (op !== DIFF_DELETE) q += text.length;
  }
  return ranges.map(([start, end]): CleanRange => {
    if (!valid([start, end])) return { ok: false, why: 'changed' };
    // The EQUAL operation that holds the whole range, when there is one.
    let eq: { a: number; b: number; n: number } | null = null;
    for (const o of ops) {
      if (o.op === DIFF_EQUAL) {
        if (!eq && o.a <= start && end <= o.a + o.n && (start < end || (o.a < start && start < o.a + o.n))) eq = o;
      } else if (o.op === DIFF_DELETE) {
        if (o.a < end && o.a + o.n > start) return { ok: false, why: 'changed' };
      } else if (start < o.a && o.a < end) return { ok: false, why: 'changed' };
    }
    const ms = dmp.diff_xIndex(diffs, start);
    const me = xIndexBefore(diffs, end);
    if (!eq) return { ok: true, start: ms, end: me, cleanBefore: 0, cleanAfter: 0 };
    const cleanBefore = eq.a === 0 && eq.b === 0 ? Infinity : start - eq.a;
    const cleanAfter = eq.a + eq.n === prev.length && eq.b + eq.n === cur.length ? Infinity : eq.a + eq.n - end;
    return { ok: true, start: ms, end: me, cleanBefore, cleanAfter };
  });
}

/**
 * Which stretches [start, end) of `a` a diff of `a` to `b` (diff_main with a time limit, no clean-up) leaves
 * entirely unchanged: no deletion overlaps the stretch and no insertion lies strictly inside it. Null when the diff
 * reached its time limit (its alignment then vouches for nothing). Used by the write queue to ask whether another
 * copy of a run still carries the text that told the run apart (9.2 Write protocol step 2).
 */
export function stretchesKept(a: string, b: string, stretches: [number, number][], opts: { timeoutSec?: number } = {}): boolean[] | null {
  const dmp = new DiffMatchPatch();
  const t = opts.timeoutSec;
  const limit = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : LOCK_DIFF_TIMEOUT_SEC;
  dmp.Diff_Timeout = limit;
  const t0 = performance.now();
  const diffs = a === b ? ([[DIFF_EQUAL, a]] as Diff[]) : (dmp.diff_main(a, b) as Diff[]);
  if (a !== b && limit > 0 && performance.now() - t0 >= limit * 1000) return null;
  const deletions: [number, number][] = [];
  const insertions: number[] = [];
  let p = 0;
  for (const [op, text] of diffs) {
    if (op === DIFF_EQUAL) p += text.length;
    else if (op === DIFF_DELETE) {
      deletions.push([p, p + text.length]);
      p += text.length;
    } else insertions.push(p);
  }
  return stretches.map(([s, e]) => s <= e && !deletions.some(([x, y]) => x < e && y > s) && !insertions.some((q) => s < q && q < e));
}

/** The longest stretch of `a` that a diff of `a` to `b` leaves unchanged (null when the diff reached its time limit). */
export function longestKept(a: string, b: string, opts: { timeoutSec?: number } = {}): number | null {
  if (a === b) return a.length;
  const dmp = new DiffMatchPatch();
  const t = opts.timeoutSec;
  const limit = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : LOCK_DIFF_TIMEOUT_SEC;
  dmp.Diff_Timeout = limit;
  const t0 = performance.now();
  const diffs = dmp.diff_main(a, b) as Diff[];
  if (limit > 0 && performance.now() - t0 >= limit * 1000) return null;
  let best = 0;
  for (const [op, text] of diffs) if (op === DIFF_EQUAL && text.length > best) best = text.length;
  return best;
}

/**
 * Transforms every span from `prev` to `cur` (section 8 rules 2–3). Returns new span objects; the input is never
 * changed. `timeoutSec` is diff_main's time limit (default LOCK_DIFF_TIMEOUT_SEC; 0 means none).
 *
 * A span no operation overlaps keeps its state and text, its start mapped after and its end before any insertion
 * at its edges. A span an operation overlaps (or whose text does not fit `prev`) becomes `violated`, with
 * `change: {before: its locked text, after: what its region holds in cur}`; its region then takes in text that
 * replaced it at its edges, so `after` shows the replacement. A span already violated keeps its first `before`.
 */
export function transformLockedSpans(prev: string, cur: string, spans: LockedSpan[], opts: { timeoutSec?: number } = {}): LockedSpan[] {
  if (!Array.isArray(spans) || spans.length === 0) return [];
  if (prev === cur) return spans.map(copySpan);
  const dmp = new DiffMatchPatch();
  const t = opts.timeoutSec;
  dmp.Diff_Timeout = typeof t === 'number' && Number.isFinite(t) && t >= 0 ? t : LOCK_DIFF_TIMEOUT_SEC;
  const diffs = dmp.diff_main(prev, cur) as Diff[];
  // The non-EQUAL operations in prev's coordinates: deletions [a, b), insertions at a point.
  const deletions: [number, number][] = [];
  const insertions: number[] = [];
  let p = 0;
  for (const [op, text] of diffs) {
    if (op === DIFF_EQUAL) p += text.length;
    else if (op === DIFF_DELETE) {
      deletions.push([p, p + text.length]);
      p += text.length;
    } else insertions.push(p);
  }
  const overlapped = (s: number, e: number): boolean =>
    deletions.some(([a, b]) => a < e && b > s) || insertions.some((q) => s < q && q < e);

  return spans.map((span) => {
    const out = copySpan(span);
    const valid = wellFormedSpan(span, prev.length);
    const s = valid ? span.start : Math.min(Math.max(0, Number.isInteger(span.start) ? span.start : 0), prev.length);
    const e = valid ? span.end : Math.max(s, Math.min(Number.isInteger(span.end) ? span.end : s, prev.length));
    // Rule 3, and a span the previous content does not hold where it says: over-report, never hide.
    const hit = !valid || overlapped(s, e) || (span.state !== 'violated' && prev.slice(s, e) !== span.text);
    let ns: number;
    let ne: number;
    if (hit) {
      // Outward: the region takes in what replaced it at its edges.
      ns = snap(cur, xIndexBefore(diffs, s), -1);
      ne = snap(cur, dmp.diff_xIndex(diffs, e), 1);
    } else {
      ns = snap(cur, dmp.diff_xIndex(diffs, s), -1);
      ne = snap(cur, xIndexBefore(diffs, e), 1);
    }
    if (ne < ns) ne = ns;
    out.start = ns;
    out.end = ne;
    if (hit) {
      out.state = 'violated';
      out.change = { before: span.state === 'violated' && span.change ? span.change.before : span.text, after: cur.slice(ns, ne) };
    }
    return out;
  });
}

/**
 * Blueline's own write (an edit, undo or redo; the WriteRecord's raw splice: `rawBefore` at `start` replaced by
 * `rawAfter`) moves every span without a diff (rule 6):
 *   - a span after the write (or starting exactly where an insertion lands) shifts by the write's delta;
 *   - a span before it (or ending exactly where an insertion lands) stays;
 *   - a span the write falls inside, or overlaps, gets its text and offsets updated directly: the region becomes
 *     the union of the span and the write. A violated span keeps its locked text; the change's `after` follows.
 * `opts.noteId` names the edit note this write undoes: its span is left out (the note is deleted, 6.6; a redo makes
 * a new note, which the caller locks with lockForRun).
 */
export function applyOwnWrite(
  spans: LockedSpan[],
  w: { start: number; rawBefore: string; rawAfter: string },
  opts: { noteId?: string } = {},
): LockedSpan[] {
  if (!Array.isArray(spans)) return [];
  const ws = w.start;
  const we = w.start + w.rawBefore.length;
  const delta = w.rawAfter.length - w.rawBefore.length;
  const insertion = ws === we;
  const out: LockedSpan[] = [];
  for (const span of spans) {
    if (opts.noteId !== undefined && span.noteId === opts.noteId) continue;
    const s = copySpan(span);
    if (!(Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= 0 && s.start <= s.end)) {
      out.push(s); // malformed (a damaged session.json): never moved, never trusted
      continue;
    }
    if (insertion ? ws <= s.start : we <= s.start) {
      s.start += delta;
      s.end += delta;
    } else if (ws >= s.end) {
      // After the span (an insertion exactly at its end does not join it).
    } else {
      // The write falls inside the span, or overlaps it: the region is the union of both.
      const edit = (t: string): string =>
        t.slice(0, Math.max(0, ws - span.start)) + w.rawAfter + t.slice(Math.min(t.length, Math.max(0, we - span.start)));
      const fits = span.text.length === span.end - span.start;
      if (span.state === 'violated') {
        if (s.change && s.change.after.length === span.end - span.start) s.change.after = edit(s.change.after);
      } else if (fits) {
        s.text = edit(span.text);
      } else {
        // The text does not fit its range: nothing can be updated exactly, so flag it (over-report, never hide).
        s.state = 'violated';
        s.change = { before: span.text, after: '' };
      }
      s.start = Math.min(span.start, ws);
      s.end = Math.max(span.end, we) + delta;
    }
    out.push(s);
  }
  return out;
}

/**
 * The lock of an edit note (section 8): the run's whole source range after the write and its source text. Pass
 * the new version's `src` (the text is taken from it), or a `value` that already is `src.slice(start, end)`; a
 * run's decoded `value` differs from its source wherever the run has a reference, an escape or a CRLF, and is
 * refused when its length shows it.
 */
export function lockForRun(noteId: string, run: { start: number; end: number; value: string }, src?: string): LockedSpan {
  if (!Number.isInteger(run.start) || !Number.isInteger(run.end) || run.start < 0 || run.end < run.start) {
    throw new RangeError(`lockForRun: bad range [${run.start}, ${run.end})`);
  }
  if (src !== undefined && run.end > src.length) throw new RangeError('lockForRun: the range is outside the source');
  const text = src !== undefined ? src.slice(run.start, run.end) : run.value;
  if (typeof text !== 'string' || text.length !== run.end - run.start) {
    throw new RangeError('lockForRun: value must be the source text src.slice(start, end)');
  }
  return { start: run.start, end: run.end, text, noteId, state: 'ok' };
}
