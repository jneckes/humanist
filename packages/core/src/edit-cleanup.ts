// The commit clean-up and the changed-span diff (9.2 "Committing an edit", steps 3–4; 6.3 "Ending an edit").
// Environment-neutral and dependency-free: the overlay runs it on the edit field's text before it sends
// {version, runId, beforeText, afterText}, and the write queue's callers (the fuzz test, applied
// suggestions) run it the same way, so a typed edit and a scripted one take the same path.
//
// Every rule applies only to characters the edit introduced. A character in the changed region of the new text
// (between the longest common prefix and suffix) was there before, and is left as it is, when
//   - the old text held the same character at the same position relative to the unchanged prefix or suffix
//     (9.2 step 3, the NBSP rule, applied alike to the others), or
//   - a character diff of the changed region, old against new, marks it equal. This matters when one commit
//     changed a run in two places: the region then spans the untouched text between them, and an NBSP, line
//     break, zero-width space or straight quote the run already had there must stay however many the commit
//     added (in a <pre> a space for its line break is a visible change the author never made).
// The diff is a longest common subsequence of the two regions, written here (the module stays dependency-free
// for the preload bundle) as a dynamic program in a diagonal band that widens until it provably holds every
// longest one. It has a size cap and no time limit, so its answer never depends on the machine's speed. Among
// equally long ones it takes the one that pairs the most special characters at the same position, so it
// agrees with the position rule wherever that rule decides, and then the one that pairs the most of them. Past the cap (MAX_DIFF_CELLS: about 2,000 by 2,000
// characters that all changed) it keeps every character of a class the old region held: the safe side, which
// never rewrites the deck's own. Untouched text is never rewritten, so the splice stays minimal.

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

/** The characters the clean-up and smart punctuation act on. */
function isSpecial(c: number): boolean {
  return c === NBSP || c === ZWSP || c === BOM || c === CR || c === LF || c === 0x22 || c === 0x27;
}

/** The diff's budget in cells (rows times band width): 4 MB of directions, and about 50 ms at worst in Node. */
const MAX_DIFF_CELLS = 1 << 22;

/**
 * A longest common subsequence of the old region `a` and the new region `b`: for each index of `b`, whether the
 * diff marks it equal (paired with a character of `a`). Among the longest ones, the one with the most special
 * characters paired at the same position relative to the regions' start or end, then the most special characters
 * paired. null past MAX_DIFF_CELLS.
 *
 * Every alignment that pairs L characters stays within the diagonals i - j in [-(m - L), n - L] (i indexes a, j
 * indexes b): w diagonals beyond the corner ones (0 and n - m) when w >= min(n, m) - L. So a band that holds those
 * diagonals for the L it found holds every longest alignment too; when it does not, the second pass takes that w.
 */
function equalInRegion(a: string, b: string): Uint8Array | null {
  const n = a.length;
  const m = b.length;
  const equal = new Uint8Array(m);
  if (n === 0 || m === 0) return equal;
  // A score counts the pairs first, the special pairs at the same position second and the other special pairs
  // third: an equally long diff that pairs one of the deck's own special characters is the safe side.
  const unit = (m + 1) * (m + 1);
  for (let w = 16; ; ) {
    const kLo = Math.max(-m, Math.min(0, n - m) - w);
    const kHi = Math.min(n, Math.max(0, n - m) + w);
    const width = Math.min(kHi - kLo, m) + 1;
    if ((n + 1) * width > MAX_DIFF_CELLS) return null;
    // Row i holds the columns j in [max(0, i - kHi), min(m, i - kLo)], at j - max(0, i - kHi).
    const dir = new Uint8Array((n + 1) * width); // 1 pair, 2 from the row above (skip a[i-1]), 3 from the left (skip b[j-1])
    let prev = new Float64Array(width);
    let cur = new Float64Array(width);
    let prevLo = 0;
    let prevHi = Math.min(m, -kLo);
    for (let j = 0; j <= prevHi; j++) {
      prev[j] = 0;
      if (j > 0) dir[j] = 3;
    }
    for (let i = 1; i <= n; i++) {
      const lo = Math.max(0, i - kHi);
      const hi = Math.min(m, i - kLo);
      const ai = a.charCodeAt(i - 1);
      for (let j = lo; j <= hi; j++) {
        let best = -Infinity;
        let how = 0;
        if (j >= 1 && j - 1 >= prevLo && j - 1 <= prevHi && ai === b.charCodeAt(j - 1)) {
          best = prev[j - 1 - prevLo] + unit + (isSpecial(ai) ? (i === j || n - i === m - j ? m + 2 : 1) : 0);
          how = 1;
        }
        if (j >= prevLo && j <= prevHi && prev[j - prevLo] > best) {
          best = prev[j - prevLo];
          how = 2;
        }
        if (j > lo && cur[j - 1 - lo] > best) {
          best = cur[j - 1 - lo];
          how = 3;
        }
        cur[j - lo] = best;
        dir[i * width + (j - lo)] = how;
      }
      [prev, cur] = [cur, prev];
      prevLo = lo;
      prevHi = hi;
    }
    const need = Math.min(n, m) - Math.floor(prev[m - prevLo] / unit);
    if (need > w) {
      w = need; // a longer alignment may lie outside the band; none lies outside this one
      continue;
    }
    for (let i = n, j = m; i > 0 || j > 0; ) {
      const how = dir[i * width + (j - Math.max(0, i - kHi))];
      if (how === 1) {
        i--;
        j--;
        equal[j] = 1;
      } else if (how === 2) i--;
      else j--;
    }
    return equal;
  }
}

/**
 * Whether the new text's character `code` at index i (in the changed region) was there before (see the header):
 * the position rule, or the region's diff marking it equal, or past the diff's cap, the old region holding one.
 */
function keeper(before: string, after: string, span: ChangedSpan): (i: number, code: number) => boolean {
  let equal: Uint8Array | null | undefined;
  const held = new Map<number, boolean>();
  return (i, code) => {
    if (oldHasSameAt(before, span, i, code)) return true;
    if (equal === undefined) equal = equalInRegion(before.slice(span.start, span.endBefore), after.slice(span.start, span.endAfter));
    if (equal) return equal[i - span.start] === 1;
    let h = held.get(code);
    if (h === undefined) {
      h = before.slice(span.start, span.endBefore).includes(String.fromCharCode(code));
      held.set(code, h);
    }
    return h;
  };
}

/**
 * The commit clean-up (9.2 "Committing an edit" step 3, 6.3), applied to the edit field's text before the
 * diff, to the characters the edit introduced (the header says which):
 *  - U+00A0 becomes U+0020, unless the old text had U+00A0 at the same position relative to the unchanged
 *    prefix or suffix, or the region's diff marks it the run's own (Chrome's contenteditable inserts NBSP for
 *    trailing and double spaces; a paste or Option+Space brings one);
 *  - U+200B and U+FEFF the browser inserted are removed;
 *  - line breaks (CRLF, lone CR, LF) in pasted or dictated text become single spaces (6.3; typed line
 *    breaks are impossible: Enter commits and Shift+Enter is ignored).
 * Returns the cleaned new text. Text that the edit did not change is returned as it was.
 */
export function cleanupCommit(before: string, after: string): string {
  const span = changedSpan(before, after);
  if (span.start === span.endAfter) return after; // a pure deletion introduces nothing
  let out = after.slice(0, span.start);
  const keptAt = keeper(before, after, span);
  for (let i = span.start; i < span.endAfter; i++) {
    const c = after.charCodeAt(i);
    if (c === NBSP) {
      out += keptAt(i, NBSP) ? '\u00A0' : ' ';
    } else if (c === ZWSP || c === BOM) {
      if (keptAt(i, c)) out += after[i];
      // else: inserted by the browser, dropped
    } else if (c === CR || c === LF) {
      if (keptAt(i, c)) {
        out += after[i];
      } else {
        // CRLF is one line break: one space. Its LF may lie in the unchanged suffix (a CR typed just before
        // an existing LF); then only the CR is new, and it becomes the space.
        out += ' ';
        if (c === CR && i + 1 < span.endAfter && after.charCodeAt(i + 1) === LF && !keptAt(i + 1, LF)) i++;
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
  const keptAt = keeper(before, after, span);
  for (let i = span.start; i < span.endAfter; i++) {
    const c = after.charCodeAt(i);
    const prev = i > 0 ? after.charCodeAt(i - 1) : NaN;
    if (c === 0x22 && curlyDouble && !keptAt(i, c)) {
      out += String.fromCharCode(opensAfter(prev) ? LEFT_DOUBLE : RIGHT_DOUBLE);
    } else if (c === 0x27 && curlySingle && !keptAt(i, c)) {
      out += String.fromCharCode(opensAfter(prev) ? LEFT_SINGLE : RIGHT_SINGLE);
    } else {
      out += after[i];
    }
  }
  return out + after.slice(span.endAfter);
}
