// The commit path of a typed edit, as pure code (9.2 "Committing an edit" steps 3–4, Strategy 2 step 4; 6.3).
// The deck preload's edit field and the fuzz harnesses both call commitField, so a fuzzed edit takes literally
// the same path as a typed one (section 10, Phase 2: "Each edit takes the same path as a typed edit"). Main and
// the write queue call liftPick for a node the author picked in the ambiguity picker (P2-8).
//
// Environment-neutral and dependency-free (the preload bundles it): no DOM, no parse5, no acorn.
//
// commitField, in order:
//   1. the clean-up on the field's whole text (edit-cleanup cleanupCommit: Chrome's NBSPs, inserted U+200B and
//      U+FEFF, pasted line breaks). Its rules are relative to the unchanged prefix and suffix, so they give the
//      same result on the field as on the run the change lies in;
//   2. the changed span of the field's text (edit-cleanup changedSpan);
//   3. the run: the changed span must lie inside one recorded run; an insertion at a run boundary goes to the
//      run that held the caret (9.2 step 4). A pure insertion or deletion of text equal to its neighbours has
//      several equivalent places ("ab|bc" + "b"); every one is considered, and the caret's run wins among them;
//   4. smart punctuation (6.3) on the run: "if the run already uses curly quotes", so the run's text decides,
//      while the character before the run in the field decides whether a quote at the run's start opens;
//   5. a run left empty or whitespace-only is structural (6.3): a verbatim note.
// Anything it cannot place exactly becomes a verbatim note with a typed reason; it never guesses (D5).

import { changedSpan, cleanupCommit, smartPunctuation } from './edit-cleanup';
import { normalizeForMatch } from './matcher';
import { isWhitespaceOnly } from './text';
import type { EditPick, MatchReason } from './types';

/** One text node of the edit field with its run (9.2 step 1). Offsets index the field's pre-edit text. */
export interface FieldRun {
  runId: string;
  start: number;
  end: number;
  /** The text node's text: `before.slice(start, end)`. For a picked candidate, the node's text, not the run's. */
  value: string;
}

/**
 * Why commitField made a verbatim note instead of an edit:
 *   - emptied:      the field was emptied or left whitespace-only;
 *   - run-emptied:  the change empties its run or leaves it whitespace-only (structural, 6.3);
 *   - across-runs:  the changed span crosses a run boundary or an inline element (9.2 step 4);
 *   - outside-runs: the change lies in text of the field that is not a recorded run;
 *   - boundary:     an insertion or deletion at a run boundary, and no caret run decides where it goes;
 *   - invalid:      the field's runs do not fit its text, or the text holds a lone surrogate;
 *   - page-changed: the page changed or removed the field while it was open (P2-17: "what was typed becomes a
 *                   verbatim note"). commitField never returns it; the overlay does.
 */
export type VerbatimWhy = 'emptied' | 'run-emptied' | 'across-runs' | 'outside-runs' | 'boundary' | 'invalid' | 'page-changed';

export const VERBATIM_WHYS: readonly VerbatimWhy[] = Object.freeze([
  'emptied',
  'run-emptied',
  'across-runs',
  'outside-runs',
  'boundary',
  'invalid',
  'page-changed',
]);

export type CommitResult =
  /** The run's whole text before and after: what EditRequest carries (9.2 step 5). */
  | { kind: 'edit'; runId: string; beforeText: string; afterText: string }
  /** The field's text before and after the clean-up: what the verbatim note holds (6.3, Strategy 3). */
  | { kind: 'verbatim'; before: string; after: string; why: VerbatimWhy }
  /** Nothing changed once the clean-up ran: no write and no note. */
  | { kind: 'noop' };

export interface CommitInput {
  /** The field element's textContent when the field opened. */
  before: string;
  /** Its textContent at commit. */
  after: string;
  /** Each recorded text node with its run, in any order. */
  runs: FieldRun[];
  /** The run of the text node that held the caret when the text changed, or null when unknown. */
  caretRunId: string | null;
}

// ----------------------------------------------------------------------------------------- helpers

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** True if s has no lone surrogate (UTF-8, session.json and the IPC validators cannot carry one). */
export function isWellFormedText(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHigh(c)) {
      if (!isLow(s.charCodeAt(i + 1))) return false;
      i++;
    } else if (isLow(c)) return false;
  }
  return true;
}

/** s with each lone surrogate replaced by U+FFFD, as UTF-8 would store it (a note cannot hold one). */
function wellFormed(s: string): string {
  if (isWellFormedText(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isHigh(c) && isLow(s.charCodeAt(i + 1))) {
      out += s[i] + s[i + 1];
      i++;
    } else out += isHigh(c) || isLow(c) ? '\uFFFD' : s[i];
  }
  return out;
}

/** UTF-16 length of the code point that ends at index `end` (1, or 2 for a surrogate pair). */
function cpBefore(s: string, end: number): number {
  return end >= 2 && isLow(s.charCodeAt(end - 1)) && isHigh(s.charCodeAt(end - 2)) ? 2 : 1;
}

/**
 * Whether smart punctuation opens a quote typed right after `prev` (one UTF-16 unit, or '' at the start).
 * edit-cleanup holds the rule; this asks it, so the rule lives in one place: in a text that already uses curly
 * double quotes, a straight `"` typed after `prev` becomes U+201C exactly when it opens.
 */
function opensAfter(prev: string): boolean {
  return smartPunctuation('\u201C', '\u201C' + prev + '"').endsWith('\u201C');
}

/** Smart punctuation on one run (6.3): the run's own text decides which quotes convert; `prev` is the field's character before it. */
function smartRun(runBefore: string, runAfter: string, prev: string): string {
  // A stand-in of the same class as `prev` (opens after it, or not), so the open-or-close decision for a quote
  // at the run's start follows the field while the curly-quote test sees only the run's text.
  const lead = prev === '' ? '' : opensAfter(prev) ? ' ' : 'a';
  return smartPunctuation(lead + runBefore, lead + runAfter).slice(lead.length);
}

/** The field's runs, sorted, after checking that each fits the field's text. null when one does not. */
function checkRuns(before: string, runs: FieldRun[]): FieldRun[] | null {
  if (!Array.isArray(runs)) return null;
  for (const r of runs) {
    if (!r || typeof r.runId !== 'string' || r.runId === '' || typeof r.value !== 'string') return null;
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end)) return null;
  }
  const out = runs.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  let last = 0;
  for (const r of out) {
    if (r.start < last || r.start >= r.end || r.end > before.length) return null;
    if (before.slice(r.start, r.end) !== r.value) return null;
    // A run never starts or ends inside a surrogate pair: a text node holds whole code points.
    if (isLow(before.charCodeAt(r.start)) || (r.end < before.length && isLow(before.charCodeAt(r.end)))) return null;
    last = r.end;
  }
  return out;
}

/**
 * The equivalent readings of the change: replacing field[a, a + len) with cleaned[a, a + len + delta) for every a
 * in [lo, hi] that is a code point boundary. changedSpan takes the longest common prefix, so a pure insertion or
 * deletion is placed as far right as it can go (hi); inserting "b" into "ab|bc" at index 1 or 2 gives the same
 * text, and so does deleting either "b". Sliding left one whole code point at a time while the text stays the
 * same finds lo, so the caret's run can take the change when one of the readings lies in it (9.2 step 4). Any
 * reading's new text is the cleaned field's own slice at that place. A replacement has one reading (lo = hi).
 * Linear in the field's length: a page cannot make the commit slow with long repeated text.
 */
interface Readings {
  lo: number;
  hi: number;
  /** Length of the replaced range in the field's old text (0 for an insertion). */
  len: number;
  /** Length of the text that replaces it. */
  ins: number;
}

function readingsOf(before: string, after: string): Readings {
  const span = changedSpan(before, after);
  const len = span.endBefore - span.start;
  const ins = span.endAfter - span.start;
  let lo = span.start;
  if ((len === 0) !== (ins === 0)) {
    // A pure insertion (or deletion) of k units at q equals one at q - n when the code point before q equals the
    // code point that ends the inserted (deleted) text: after[q - n + k, q + k) for an insertion, before[q - n + k,
    // q + k) for a deletion.
    const text = len === 0 ? after : before;
    const k = len === 0 ? ins : len;
    while (lo > 0) {
      const n = cpBefore(before, lo);
      if (text.slice(lo - n + k, lo + k) !== before.slice(lo - n, lo)) break;
      lo -= n;
    }
  }
  return { lo, hi: span.start, len, ins };
}

/** The unmapped stretches of the field: text between, before or after the recorded runs. */
function gapsOf(length: number, runs: FieldRun[]): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = [];
  let at = 0;
  for (const r of runs) {
    if (r.start > at) gaps.push({ start: at, end: r.start });
    at = Math.max(at, r.end);
  }
  if (at < length) gaps.push({ start: at, end: length });
  return gaps;
}

/**
 * The rightmost reading a segment (a run or a gap) can hold, or null: a range must lie inside it, an insertion
 * inside it or at its edges. Segment edges are code point boundaries, and so is every reading in [lo, hi].
 */
function fit(seg: { start: number; end: number }, r: Readings): number | null {
  const a = Math.min(r.hi, seg.end - r.len);
  return a >= Math.max(r.lo, seg.start) ? a : null;
}

// ----------------------------------------------------------------------------------------- commitField

/**
 * Turns the edit field's text at commit into one run's edit, a verbatim note or nothing (9.2 Committing an edit
 * steps 3–4). `opts.smartPunctuation` is the author's setting (6.3, default on).
 */
export function commitField(i: CommitInput, opts: { smartPunctuation: boolean }): CommitResult {
  const before = typeof i?.before === 'string' ? i.before : '';
  const raw = typeof i?.after === 'string' ? i.after : '';
  // Step 3: the clean-up, on the field's text.
  const cleaned = cleanupCommit(before, raw);
  if (cleaned === before) return { kind: 'noop' };
  const verbatim = (why: VerbatimWhy): CommitResult => ({
    kind: 'verbatim',
    before: wellFormed(before),
    // The note holds the text as the author meant it: cleaned, and with the quotes smart punctuation would have
    // given it (the field's own text decides, as there is no single run).
    after: wellFormed(opts.smartPunctuation ? smartPunctuation(before, cleaned) : cleaned),
    why,
  });
  if (!isWellFormedText(before) || !isWellFormedText(cleaned)) return verbatim('invalid');
  const runs = checkRuns(before, i.runs);
  if (!runs) return verbatim('invalid');
  if (cleaned.length === 0 || isWhitespaceOnly(cleaned)) return verbatim('emptied');

  // Step 4: which run holds the change.
  const rd = readingsOf(before, cleaned);
  const owners: { run: FieldRun; a: number }[] = [];
  for (const r of runs) {
    const a = fit(r, rd);
    if (a !== null) owners.push({ run: r, a });
  }
  const inGap = gapsOf(before.length, runs).some((g) => fit(g, rd) !== null);
  let pick: { run: FieldRun; a: number } | null = null;
  // The caret's run wins among the readings that fit it (the rightmost, the one closest to changedSpan's).
  if (typeof i.caretRunId === 'string') pick = owners.find((o) => o.run.runId === i.caretRunId) ?? null;
  if (!pick) {
    if (owners.length === 1 && !inGap) pick = owners[0];
    else if (owners.length > 1 || (owners.length === 1 && inGap)) return verbatim('boundary');
    // No run holds any reading: unmapped text (an insertion always sits in some stretch of the field), or a span
    // that crosses from one run into the next or into unmapped text.
    else return verbatim(inGap || rd.len === 0 ? 'outside-runs' : 'across-runs');
  }
  const { run, a } = pick;
  // Any reading's new text is the cleaned field's own slice at that place.
  let afterText = run.value.slice(0, a - run.start) + cleaned.slice(a, a + rd.ins) + run.value.slice(a + rd.len - run.start);
  if (opts.smartPunctuation) afterText = smartRun(run.value, afterText, run.start > 0 ? before[run.start - 1] : '');
  if (afterText === run.value) return { kind: 'noop' };
  // 6.3: an edit that empties a run (or leaves only white space) removes a text node: a structural change.
  if (afterText.length === 0 || isWhitespaceOnly(afterText)) return verbatim('run-emptied');
  return { kind: 'edit', runId: run.runId, beforeText: run.value, afterText };
}

// ----------------------------------------------------------------------------------------- picked candidates

/** HTML white space, as normalizeForMatch collapses it (9.2 Strategy 2 step 3). */
const WORD = /[^ \t\n\r\f]+/g;

interface Word {
  start: number;
  end: number;
  text: string;
}

function wordsOf(s: string): Word[] {
  const out: Word[] = [];
  WORD.lastIndex = 0;
  for (let m = WORD.exec(s); m; m = WORD.exec(s)) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  return out;
}

/**
 * Maps a position of the node's text to the run's text, when the mapping is exact: the edge of a word maps to the
 * same edge of the same word; inside a word only when the word is spelled the same in both (not only equal after
 * NFC); inside white space only when that white space is the same in both. null otherwise.
 */
function mapPosition(p: number, node: string, nw: Word[], run: string, rw: Word[]): number | null {
  for (let k = 0; k < nw.length; k++) {
    if (p < nw[k].start || p > nw[k].end) continue;
    if (p === nw[k].start) return rw[k].start;
    if (p === nw[k].end) return rw[k].end;
    return rw[k].text === nw[k].text ? rw[k].start + (p - nw[k].start) : null;
  }
  // In white space: before the first word, between words k - 1 and k, or after the last.
  if (p === 0) return 0;
  if (p === node.length) return run.length;
  let k = 0;
  while (k < nw.length && nw[k].start < p) k++;
  const gs = k > 0 ? nw[k - 1].end : 0;
  const ge = k < nw.length ? nw[k].start : node.length;
  const rgs = k > 0 ? rw[k - 1].end : 0;
  const rge = k < rw.length ? rw[k].start : run.length;
  return node.slice(gs, ge) === run.slice(rgs, rge) ? rgs + (p - gs) : null;
}

/**
 * Lifts an edit of a picked candidate's node to its run (9.2 Strategy 2 step 4: "map the span from normalized to
 * cooked to raw; if that fails, the edit becomes verbatim"; P2-8). Returns the run's whole text before and after,
 * or null when the mapping is not unique or not exact:
 *   - substring: the node's text must occur exactly once in the run (overlapping occurrences count);
 *   - normalized: the two texts must be equal after whitespace collapse and NFC word for word; each end of the
 *     node's changed span maps to the run through the words around it, and the run's new text must normalize to
 *     the node's new text.
 */
export function liftToRun(
  runValue: string,
  nodeBefore: string,
  nodeAfter: string,
  how: 'substring' | 'normalized',
): { beforeText: string; afterText: string } | null {
  if (typeof runValue !== 'string' || typeof nodeBefore !== 'string' || typeof nodeAfter !== 'string') return null;
  if (nodeBefore.length === 0) return null;
  if (how === 'substring') {
    const at = runValue.indexOf(nodeBefore);
    if (at < 0) return null;
    // Overlapping occurrences are different places too ("aa" in "aaa").
    if (runValue.indexOf(nodeBefore, at + 1) >= 0) return null;
    return { beforeText: runValue, afterText: runValue.slice(0, at) + nodeAfter + runValue.slice(at + nodeBefore.length) };
  }
  if (how !== 'normalized') return null;
  const rw = wordsOf(runValue);
  const nw = wordsOf(nodeBefore);
  if (rw.length === 0 || rw.length !== nw.length) return null;
  for (let k = 0; k < rw.length; k++) if (rw[k].text.normalize('NFC') !== nw[k].text.normalize('NFC')) return null;
  const span = changedSpan(nodeBefore, nodeAfter);
  const a = mapPosition(span.start, nodeBefore, nw, runValue, rw);
  const b = mapPosition(span.endBefore, nodeBefore, nw, runValue, rw);
  if (a === null || b === null || a > b) return null;
  const afterText = runValue.slice(0, a) + nodeAfter.slice(span.start, span.endAfter) + runValue.slice(b);
  // What the page shows of the run must be what the author typed into the node.
  if (normalizeForMatch(afterText) !== normalizeForMatch(nodeAfter)) return null;
  return { beforeText: runValue, afterText };
}

/**
 * The run's whole text before and after for a picked candidate (P2-8): an `equal` pick is the run's own text, the
 * others are lifted (liftToRun). null when the node's text does not fit the run that way: the edit is then a
 * verbatim note. Main builds the EditRequest from it, and the write queue checks it again.
 */
export function liftPick(runValue: string, pick: EditPick): { beforeText: string; afterText: string } | null {
  if (!pick || typeof runValue !== 'string') return null;
  if (pick.kind === 'equal') {
    return pick.nodeBefore === runValue && typeof pick.nodeAfter === 'string' ? { beforeText: runValue, afterText: pick.nodeAfter } : null;
  }
  if (pick.kind === 'substring' || pick.kind === 'normalized') return liftToRun(runValue, pick.nodeBefore, pick.nodeAfter, pick.kind);
  return null;
}

/**
 * The pick kind for an ambiguous node's match reason (P2-8): several equal runs, a key, a shadow value or another
 * element's stamp are `equal`; `not-equal` (whitespace and NFC) is `normalized`; `substring` is `substring`.
 * `split` and `short` are never offered (22 of 22 such matches on Josh's decks were wrong-place writes, F29), and
 * nor is anything else: null.
 */
export function pickKindFor(reason: MatchReason | undefined): EditPick['kind'] | null {
  switch (reason) {
    case 'duplicate':
    case 'key':
    case 'shadow':
    case 'stamp-other':
      return 'equal';
    case 'not-equal':
      return 'normalized';
    case 'substring':
      return 'substring';
    default:
      return null;
  }
}
