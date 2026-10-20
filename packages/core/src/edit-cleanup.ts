// The commit clean-up and the changed-span diff (9.2 "Committing an edit", steps 3–4; 6.3 "Ending an edit").
// Environment-neutral and dependency-free: the overlay runs it on the edit field's text before it sends
// {version, runId, beforeText, afterText}, and the write queue's callers (the fuzz test, applied
// suggestions) run it the same way, so a typed edit and a scripted one take the same path.
//
// Every rule applies only to characters the edit introduced. A character is "introduced" when it lies in
// the changed region of the new text (between the longest common prefix and suffix), the old text did
// not hold the same character at the same position relative to the unchanged prefix or suffix (9.2 step 3,
// the NBSP rule, applied alike to the other two), and the changed region holds more of that character than
// the old text's changed region did. The count matters when one commit changed a run in two places: the
// region then spans the untouched text between them, and a line break or NBSP the run already had there must
// stay (in a <pre> a space for its line break is a visible change the author never made). Untouched text,
// including the deck's own NBSPs, zero-width spaces and line breaks, is never rewritten, so the splice stays
// minimal.

const NBSP = 0x00a0;
const ZWSP = 0x200b;
const BOM = 0xfeff;
const CR = 0x0d;
const LF = 0x0a;

export interface ChangedSpan {
  /** Length of the common prefix: the first index that differs. */
  start: number;
  /** End of the changed region in the old text (old.length minus the common suffix). */
  endBefore: number;
  /** End of the changed region in the new text. */
  endAfter: number;
}

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/**
 * The minimal changed span between two strings, from their longest common prefix and suffix (9.2 step 4).
 * The prefix and suffix never overlap, and never split a surrogate pair: a pair that differs only in its
 * low half belongs wholly to the changed span, so offsets stay on code point boundaries.
 */
export function changedSpan(before: string, after: string): ChangedSpan {
  const max = Math.min(before.length, after.length);
  let p = 0;
  while (p < max && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  // The prefix ends between the halves of a pair when its last unit is a high surrogate and the strings
  // differ right after it (they always do at p, unless one string ends there).
  if (p > 0 && isHigh(before.charCodeAt(p - 1))) p--;
  let s = 0;
  const maxSuffix = max - p;
  while (s < maxSuffix && before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)) s++;
  // The suffix starts between the halves of a pair when its first unit is a low surrogate.
  if (s > 0 && isLow(before.charCodeAt(before.length - s))) s--;
  return { start: p, endBefore: before.length - s, endAfter: after.length - s };
}

/**
 * True if the old text holds `code` at the same position as new-text index i, counted from the end of the
 * unchanged prefix or from the start of the unchanged suffix (9.2 step 3).
 */
function oldHasSameAt(before: string, span: ChangedSpan, i: number, code: number): boolean {
  // Counted from the prefix, the old index is i itself (the prefix is common to both texts).
  if (i < span.endBefore && before.charCodeAt(i) === code) return true;
  const fromSuffix = span.endBefore - (span.endAfter - i);
  if (fromSuffix >= span.start && fromSuffix < span.endBefore && before.charCodeAt(fromSuffix) === code) return true;
  return false;
}

function countIn(s: string, from: number, to: number, code: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === code) n++;
  return n;
}

/**
 * Whether the new text's character `code` at index i (in the changed region) was there before: at the same
 * position relative to the unchanged prefix or suffix, or, when one commit changed the run in two places,
 * because the changed region holds no more of that character than the old one did (the edit added none).
 */
function keptAt(before: string, after: string, span: ChangedSpan, i: number, code: number, counts: Map<number, boolean>): boolean {
  if (oldHasSameAt(before, span, i, code)) return true;
  let noneAdded = counts.get(code);
  if (noneAdded === undefined) {
    noneAdded = countIn(after, span.start, span.endAfter, code) <= countIn(before, span.start, span.endBefore, code);
    counts.set(code, noneAdded);
  }
  return noneAdded;
}

/**
 * The commit clean-up (9.2 "Committing an edit" step 3, 6.3), applied to the edit field's text before the
 * diff:
 *  - U+00A0 becomes U+0020, unless the old text had U+00A0 at the same position relative to the unchanged
 *    prefix or suffix (Chrome's contenteditable inserts NBSP for trailing and double spaces);
 *  - U+200B and U+FEFF the browser inserted are removed;
 *  - line breaks (CRLF, lone CR, LF) in pasted or dictated text become single spaces (6.3; typed line
 *    breaks are impossible: Enter commits and Shift+Enter is ignored).
 * Returns the cleaned new text. Text that the edit did not change is returned as it was.
 */
export function cleanupCommit(before: string, after: string): string {
  const span = changedSpan(before, after);
  if (span.start === span.endAfter) return after; // a pure deletion introduces nothing
  let out = after.slice(0, span.start);
  const counts = new Map<number, boolean>();
  for (let i = span.start; i < span.endAfter; i++) {
    const c = after.charCodeAt(i);
    if (c === NBSP) {
      out += keptAt(before, after, span, i, NBSP, counts) ? '\u00A0' : ' ';
    } else if (c === ZWSP || c === BOM) {
      if (keptAt(before, after, span, i, c, counts)) out += after[i];
      // else: inserted by the browser, dropped
    } else if (c === CR || c === LF) {
      if (keptAt(before, after, span, i, c, counts)) {
        out += after[i];
      } else {
        // CRLF is one line break: one space. Its LF may lie in the unchanged suffix (a CR typed just before
        // an existing LF); then only the CR is new, and it becomes the space.
        out += ' ';
        if (c === CR && i + 1 < span.endAfter && after.charCodeAt(i + 1) === LF && !keptAt(before, after, span, i + 1, LF, counts)) i++;
      }
    } else {
      out += after[i];
    }
  }
  return out + after.slice(span.endAfter);
}

const LEFT_DOUBLE = 0x201c;
const RIGHT_DOUBLE = 0x201d;
const LEFT_SINGLE = 0x2018;
const RIGHT_SINGLE = 0x2019;

/** A quote after one of these (or at the start) opens; anything else closes or is an apostrophe. */
function opensAfter(prev: number): boolean {
  return (
    Number.isNaN(prev) ||
    prev === 0x20 ||
    prev === 0x09 ||
    prev === 0x0a ||
    prev === 0x0d ||
    prev === 0x0c ||
    prev === NBSP ||
    prev === 0x28 || // (
    prev === 0x5b || // [
    prev === 0x7b || // {
    prev === 0x2014 || // em dash
    prev === 0x2013 || // en dash
    prev === 0x2d || // -
    prev === 0x2f || // /
    prev === LEFT_DOUBLE ||
    prev === LEFT_SINGLE
  );
}

/**
 * Smart punctuation (6.3, default on, a setting): if the run already uses curly double quotes, straight
 * double quotes the edit introduced become curly; likewise for single quotes and apostrophes. A quote opens
 * at the start or after whitespace, an opening bracket, a dash, a slash or another opening quote, and closes
 * (or is an apostrophe) otherwise. Nothing else changes, and text the edit did not introduce is untouched.
 * Apply it to the clean-up's result, before sending the edit.
 */
export function smartPunctuation(before: string, after: string): string {
  const curlyDouble = before.includes('“') || before.includes('”');
  const curlySingle = before.includes('‘') || before.includes('’');
  if (!curlyDouble && !curlySingle) return after;
  const span = changedSpan(before, after);
  let out = after.slice(0, span.start);
  const counts = new Map<number, boolean>();
  for (let i = span.start; i < span.endAfter; i++) {
    const c = after.charCodeAt(i);
    const prev = i > 0 ? after.charCodeAt(i - 1) : NaN;
    if (c === 0x22 && curlyDouble && !keptAt(before, after, span, i, c, counts)) {
      out += String.fromCharCode(opensAfter(prev) ? LEFT_DOUBLE : RIGHT_DOUBLE);
    } else if (c === 0x27 && curlySingle && !keptAt(before, after, span, i, c, counts)) {
      out += String.fromCharCode(opensAfter(prev) ? LEFT_SINGLE : RIGHT_SINGLE);
    } else {
      out += after[i];
    }
  }
  return out + after.slice(span.endAfter);
}
