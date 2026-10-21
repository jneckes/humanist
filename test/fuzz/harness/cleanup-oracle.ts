// An oracle for the commit clean-up that shares no code with it (SPEC 9.2 Committing an edit step 3; 6.3 Ending an
// edit and Smart punctuation; review finding 24, lead decision E-12). Both fuzz halves judge every commit with it:
// the Node fuzz (test/unit/editor/fuzz.test.ts) passes the record of what its author inserted, the Chromium one
// (fuzz-core checkCommit) has none. It is pure and imports nothing, in particular not core/edit-cleanup: its rules
// are re-derived here from the spec, so a clean-up that drops the deck's own NBSPs fails it instead of agreeing
// with itself.
//
// The rules, for each UTF-16 unit of the field's text at commit (raw) against the commit's text for the field:
//   - a unit the rules below do not name is unchanged;
//   - an NBSP, line break, U+200B, U+FEFF or straight quote the field already had is still there, unchanged, at
//     its place;
//   - an inserted NBSP, CR or LF became one space each, and an inserted CRLF one space; an inserted U+200B or
//     U+FEFF is gone;
//   - only an inserted straight quote is ever curled (to a curly quote of its kind), and only when smart
//     punctuation is on and the text that decides (6.3: the run) already uses curly quotes of that kind; then an
//     inserted one is curled. Smart punctuation runs on the cleaned text, so quotes are judged against that;
//   - 9.2 step 3's position rule: the unchanged prefix and suffix are unchanged, and an inserted NBSP, line break or
//     zero-width space stays when the old text held the same unit at the same position relative to the unchanged
//     prefix or suffix (for a straight quote the rule may only keep it straight: the run, not the field, sets the
//     span smart punctuation measures from).
// What "inserted" means is the spec's, not the author's: 9.2 step 3 is relative to the unchanged prefix and suffix,
// and the clean-up tells the field's own units in the changed region from inserted ones by a character diff (lead
// decision E-12). The author's record cannot decide: an NBSP typed next to the deck's own, a deleted character
// typed again or text that repeats its neighbours reads more than one way, and every longest common subsequence of
// the changed region (old against new) is as right as another. So the commit passes when ONE such subsequence pairs
// every special unit it kept (unless the position rule kept it) and leaves out every one it cleaned. The record
// only names units in the failure message ("the field's own", "inserted").

const NBSP = 0xa0;
const ZWSP = 0x200b;
const BOM = 0xfeff;
const CR = 0x0d;
const LF = 0x0a;
const SPACE = 0x20;
const DQ = 0x22;
const SQ = 0x27;
/** The curly quotes smart punctuation may give a straight one: [opening, closing]. */
const CURLY: Readonly<Record<number, readonly [number, number]>> = { [DQ]: [0x201c, 0x201d], [SQ]: [0x2018, 0x2019] };

/**
 * Quotes are judged on the whole field within this many units around the changed region: smart punctuation diffs
 * the run (6.3), whose changed span can reach past the field's by a slide no longer than this.
 */
const MARGIN = 256;
/** Saved LCS cells per pass of `freedom`. */
const COLUMN_BUDGET = 1 << 23;
/** Readings of the commit's text tried against the diff (they differ only where U+200B, U+FEFF or CRLF repeat). */
const MAX_READINGS = 64;

export interface CleanupCase {
  /** The field's text when it opened. */
  before: string;
  /** The field's text at commit (what the browser holds). */
  raw: string;
  /** What the commit makes of the field: the verbatim note's text after, or the field with the run's new text. */
  result: string;
  /** For each UTF-16 unit of `raw`, whether the author put it there (the fuzz's record): for the message only. */
  inserted?: ArrayLike<boolean>;
  /** The smart punctuation setting; absent when unknown (either is accepted). */
  smart?: boolean;
  /** Whether the text that decides smart punctuation already uses curly double and single quotes; absent when unknown. */
  curly?: { double: boolean; single: boolean };
}

function isSpecial(c: number): boolean {
  return c === NBSP || c === ZWSP || c === BOM || c === CR || c === LF || c === DQ || c === SQ;
}

const isQuote = (c: number) => c === DQ || c === SQ;

function hex(c: number): string {
  return `U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 9.2 step 3's unchanged prefix and suffix of two texts, as the changed regions' bounds. */
function changedRegion(s: string, t: string): { pre: number; endS: number; endT: number } {
  const max = Math.min(s.length, t.length);
  let pre = 0;
  while (pre < max && s.charCodeAt(pre) === t.charCodeAt(pre)) pre++;
  let suf = 0;
  while (suf < max - pre && s.charCodeAt(s.length - 1 - suf) === t.charCodeAt(t.length - 1 - suf)) suf++;
  return { pre, endS: s.length - suf, endT: t.length - suf };
}

/** A value below any reachable LCS length: a cell outside the band, or a constraint no alignment meets. */
const NONE = -1e9;

/** PAIR: the unit must be paired; SKIP: it must be left out; anything else is free. */
const PAIR = 1;
const SKIP = 2;

/**
 * The diagonals (i - j, i indexing a and j indexing b) that hold every longest common subsequence of a and b, and
 * its length. An alignment with L pairs keeps within [-(m - L), n - L], that is within w = min(n, m) - L of the
 * corner diagonals 0 and n - m: a band with w at least that, measured with the L it finds, holds them all. A
 * long text with few changes then costs a narrow band, not n times m.
 */
function lcsBand(a: string, b: string): { kLo: number; kHi: number; total: number } {
  const n = a.length;
  const m = b.length;
  for (let w = 16; ; ) {
    const kLo = Math.max(-m, Math.min(0, n - m) - w);
    const kHi = Math.min(n, Math.max(0, n - m) + w);
    const total = columns(a, b, kLo, kHi, null, null);
    const need = Math.min(n, m) - total;
    if (need <= w) return { kLo, kHi, total };
    w = need;
  }
}

/**
 * The LCS table of a and b in the band, column by column (column j: a[0..i) against b[0..j) for the rows i of the
 * band, at i - j - kLo), with b's units constrained by `need`. Saves the columns `save` names, each before its
 * unit of b. Returns the length, or -1 when no alignment meets the constraints.
 */
function columns(a: string, b: string, kLo: number, kHi: number, need: Uint8Array | null, save: Map<number, Float64Array> | null): number {
  const n = a.length;
  const m = b.length;
  const width = kHi - kLo + 1;
  let prev = new Float64Array(width).fill(NONE);
  let cur = new Float64Array(width).fill(NONE);
  for (let i = Math.max(0, kLo); i <= Math.min(n, kHi); i++) prev[i - kLo] = 0;
  for (let j = 1; j <= m; j++) {
    save?.get(j - 1)?.set(prev);
    const c = b.charCodeAt(j - 1);
    const nd = need ? need[j - 1] : 0;
    cur.fill(NONE);
    const lo = Math.max(0, j + kLo);
    const hi = Math.min(n, j + kHi);
    for (let i = lo; i <= hi; i++) {
      let best = i > lo ? cur[i - 1 - j - kLo] : NONE; // a[i - 1] left out
      if (nd !== PAIR && i - (j - 1) <= kHi) best = Math.max(best, prev[i - (j - 1) - kLo]); // b[j - 1] left out
      if (nd !== SKIP && i >= 1 && a.charCodeAt(i - 1) === c) best = Math.max(best, prev[i - 1 - (j - 1) - kLo] + 1); // paired
      cur[i - j - kLo] = best;
    }
    [prev, cur] = [cur, prev];
  }
  save?.get(m)?.set(prev);
  const total = prev[n - m - kLo];
  return total < 0 ? -1 : total;
}

/** The same table read from the end: column j holds a[i..n) against b[j..m). Saves the columns `save` names. */
function columnsBack(a: string, b: string, kLo: number, kHi: number, save: Map<number, Float64Array>): void {
  const n = a.length;
  const m = b.length;
  const width = kHi - kLo + 1;
  let next = new Float64Array(width).fill(NONE);
  let cur = new Float64Array(width).fill(NONE);
  for (let i = Math.max(0, m + kLo); i <= Math.min(n, m + kHi); i++) next[i - m - kLo] = 0;
  save.get(m)?.set(next);
  for (let j = m - 1; j >= 0; j--) {
    const c = b.charCodeAt(j);
    cur.fill(NONE);
    const lo = Math.max(0, j + kLo);
    const hi = Math.min(n, j + kHi);
    for (let i = hi; i >= lo; i--) {
      let best = i < hi ? cur[i + 1 - j - kLo] : NONE; // a[i] left out
      if (i - (j + 1) >= kLo) best = Math.max(best, next[i - (j + 1) - kLo]); // b[j] left out
      if (i < n && a.charCodeAt(i) === c) best = Math.max(best, next[i - j - kLo] + 1); // paired: (i + 1) - (j + 1) = i - j
      cur[i - j - kLo] = best;
    }
    [next, cur] = [cur, next];
    save.get(j)?.set(next);
  }
}

/**
 * For each special unit of t[lo, hiT): whether some longest common subsequence of s[lo, hiS) and t[lo, hiT) pairs
 * it (canPair) and whether some leaves it out (canSkip). Units outside count as paired (the unchanged text).
 */
function freedom(s: string, t: string, lo: number, hiS: number, hiT: number): { canPair: Uint8Array; canSkip: Uint8Array } {
  const canPair = new Uint8Array(t.length).fill(1);
  const canSkip = new Uint8Array(t.length);
  const a = s.slice(lo, hiS);
  const b = t.slice(lo, hiT);
  const specials: number[] = [];
  for (let j = 0; j < b.length; j++) if (isSpecial(b.charCodeAt(j))) specials.push(j);
  if (specials.length === 0) return { canPair, canSkip };
  const { kLo, kHi, total } = lcsBand(a, b);
  const width = kHi - kLo + 1;
  const chunk = Math.max(1, Math.floor(COLUMN_BUDGET / width));
  for (let c0 = 0; c0 < specials.length; c0 += chunk) {
    const js = specials.slice(c0, c0 + chunk);
    const P = new Map<number, Float64Array>(js.map((j) => [j, new Float64Array(width)]));
    const Q = new Map<number, Float64Array>(js.map((j) => [j + 1, new Float64Array(width)]));
    columns(a, b, kLo, kHi, null, P);
    columnsBack(a, b, kLo, kHi, Q);
    for (const j of js) {
      const pj = P.get(j)!;
      const qj = Q.get(j + 1)!;
      const c = b.charCodeAt(j);
      let pair = 0;
      let skip = 0;
      for (let i = Math.max(0, j + kLo); i <= Math.min(a.length, j + kHi) && !(pair && skip); i++) {
        const here = pj[i - j - kLo];
        // Left out: the path goes from (i, j) to (i, j + 1).
        if (i - (j + 1) >= kLo && here + qj[i - (j + 1) - kLo] === total) skip = 1;
        // Paired with a[i]: from (i, j) to (i + 1, j + 1), on the same diagonal.
        if (i < a.length && a.charCodeAt(i) === c && here + 1 + qj[i - j - kLo] === total) pair = 1;
      }
      canPair[lo + j] = pair;
      canSkip[lo + j] = skip;
    }
  }
  return { canPair, canSkip };
}

/** What a step of a reading may do with a special unit; `q` is the result's offset the unit maps to. */
interface Rules {
  keep(p: number, q: number): boolean;
  clean(p: number, q: number): boolean;
  /** A straight quote at p becomes the curly one at q. */
  curl(p: number, q: number): boolean;
}

/** One step of a reading, back to the state it came from: (p * (result.length + 1) + q) * 2, plus 1 if it curled. */
type Back = number;

/**
 * Every reading of `result` as `raw` with 9.2 step 3 and 6.3 applied: for each offset p of raw, the result offsets
 * q a reading reaches there, each with the steps that reach it. The rules say which steps each unit may take.
 */
function readings(raw: string, result: string, rules: Rules): Map<number, Back[]>[] {
  const m = raw.length;
  const w = result.length + 1;
  const at: Map<number, Back[]>[] = Array.from({ length: m + 1 }, () => new Map());
  at[0].set(0, []);
  for (let p = 0; p < m; p++) {
    if (at[p].size === 0) continue;
    const u = raw.charCodeAt(p);
    for (const q of at[p].keys()) {
      const back = (p * w + q) * 2;
      const go = (p2: number, q2: number, curled = false) => {
        const list = at[p2].get(q2);
        if (list) list.push(back + (curled ? 1 : 0));
        else at[p2].set(q2, [back + (curled ? 1 : 0)]);
      };
      const r = q < result.length ? result.charCodeAt(q) : NaN;
      if (!isSpecial(u)) {
        if (r === u) go(p + 1, q + 1);
      } else if (u === NBSP || u === LF) {
        if (r === u && rules.keep(p, q)) go(p + 1, q + 1);
        if (r === SPACE && rules.clean(p, q)) go(p + 1, q + 1);
      } else if (u === ZWSP || u === BOM) {
        if (r === u && rules.keep(p, q)) go(p + 1, q + 1);
        if (rules.clean(p, q)) go(p + 1, q);
      } else if (u === CR) {
        if (r === CR && rules.keep(p, q)) go(p + 1, q + 1);
        if (r === SPACE && rules.clean(p, q)) {
          if (raw.charCodeAt(p + 1) !== LF) go(p + 1, q + 1);
          else {
            // CRLF is one line break: one space for both, or the CR's space and the field's own LF.
            if (rules.clean(p + 1, q)) go(p + 2, q + 1);
            if (result.charCodeAt(q + 1) === LF && rules.keep(p + 1, q + 1)) go(p + 2, q + 2);
          }
        }
      } else {
        if (r === u && rules.keep(p, q)) go(p + 1, q + 1);
        if ((r === CURLY[u][0] || r === CURLY[u][1]) && rules.curl(p, q)) go(p + 1, q + 1, true);
      }
    }
  }
  return at;
}

/** A complete reading: for each unit of raw, what the commit did with it, and the result offset it maps to. */
interface Reading {
  /** 'k' kept, 'c' cleaned (a space or dropped), 'q' curled; '' for the units no rule names. */
  did: string[];
  /** The result offset each unit of raw maps to (a dropped unit: where it would have been). */
  to: Int32Array;
}

/** Up to `limit` complete readings, walking the steps back from the end (iteratively: a field can be long). */
function completeReadings(raw: string, result: string, at: Map<number, Back[]>[], limit: number): Reading[] {
  const w = result.length + 1;
  const out: Reading[] = [];
  const did: string[] = new Array(raw.length).fill('');
  const to = new Int32Array(raw.length);
  // Each frame: a state and the index of the next step back to try from it.
  const stack: { p: number; q: number; k: number }[] = [{ p: raw.length, q: result.length, k: 0 }];
  let budget = Math.max(200_000, 8 * (raw.length + 1) * limit);
  while (stack.length > 0 && out.length < limit && --budget > 0) {
    const f = stack[stack.length - 1];
    if (f.p === 0) {
      out.push({ did: did.slice(), to: to.slice() });
      stack.pop();
      continue;
    }
    const backs = at[f.p].get(f.q) ?? [];
    if (f.k >= backs.length) {
      stack.pop();
      continue;
    }
    const b = backs[f.k++];
    const st = Math.floor(b / 2);
    const p0 = Math.floor(st / w);
    const q0 = st % w;
    const u = raw.charCodeAt(p0);
    const r = result.charCodeAt(q0);
    for (let x = p0; x < f.p; x++) {
      to[x] = q0;
      did[x] = !isSpecial(raw.charCodeAt(x)) ? '' : b % 2 === 1 ? 'q' : x === p0 && r === u && f.q > q0 ? 'k' : 'c';
    }
    // CR cleaned with the field's own LF kept: the LF maps to the result's LF.
    if (f.p - p0 === 2 && f.q - q0 === 2) {
      to[p0 + 1] = q0 + 1;
      did[p0 + 1] = 'k';
    }
    stack.push({ p: p0, q: q0, k: 0 });
  }
  return out;
}

/** Where every reading stops: the last offset of raw a reading reaches, its unit and the result's unit there. */
function stuck(raw: string, result: string, at: Map<number, Back[]>[], rec: ArrayLike<boolean> | undefined, head: string): string {
  let p = raw.length;
  while (p > 0 && at[p].size === 0) p--;
  let q = Infinity;
  for (const k of at[p].keys()) q = Math.min(q, k);
  const u = p < raw.length ? raw.charCodeAt(p) : NaN;
  const what = Number.isNaN(u) ? 'the end of the field' : `${hex(u)}${rec ? (rec[p] ? ' (inserted)' : " (the field's own)") : ''}`;
  const got = q < result.length ? hex(result.charCodeAt(q)) : 'nothing';
  return `${head} at offset ${p} of the field: ${what}; the commit has ${got} there`;
}

/**
 * Judges the commit's text for the field against 9.2 step 3 and 6.3 (the header). Returns why it fails, or null.
 * The reason names offsets and code points only, never the text (a local deck's text stays out of reports).
 */
export function judgeCleanup(c: CleanupCase): string | null {
  const { before, raw, result } = c;
  const rec = c.inserted;
  const any: Rules = { keep: () => true, clean: () => true, curl: () => true };
  // First, any reading at all: the commit's text is the raw text with only the clean-up's and smart punctuation's
  // changes. One reading gives the cleaned text smart punctuation saw: the result with its curled quotes straight.
  const loose = readings(raw, result, any);
  if (!loose[raw.length].has(result.length)) return stuck(raw, result, loose, rec, "[clean-up] the commit is not the field's text with only the clean-up's changes");
  const cleanedOf = (r: Reading): string => {
    let s = result;
    for (let p = 0; p < raw.length; p++) if (r.did[p] === 'q') s = s.slice(0, r.to[p]) + String.fromCharCode(raw.charCodeAt(p)) + s.slice(r.to[p] + 1);
    return s;
  };
  const first = completeReadings(raw, result, loose, 1)[0];
  const cleaned = first ? cleanedOf(first) : result;

  // 9.2 step 3's position rule on the field's text, exactly as the clean-up's span sees it.
  const span = changedRegion(before, raw);
  const samePlace = (p: number): boolean => {
    if (p < span.pre || p >= span.endT) return true;
    const u = raw.charCodeAt(p);
    if (p < span.endS && before.charCodeAt(p) === u) return true;
    const j = span.endS - (span.endT - p);
    return j >= span.pre && j < span.endS && before.charCodeAt(j) === u;
  };
  // For quotes, the same rule on the cleaned text, only ever to keep one straight (the run sets the span).
  const quoteSamePlace = (cl: string, q: number): boolean => {
    const u = cl.charCodeAt(q);
    return before.charCodeAt(q) === u || before.charCodeAt(before.length - cl.length + q) === u;
  };
  const usesCurly = (u: number): boolean | undefined => (c.curly ? (u === DQ ? c.curly.double : c.curly.single) : undefined);
  const mustCurl = (u: number) => c.smart === true && usesCurly(u) === true;
  const mayCurl = (u: number) => c.smart !== false && usesCurly(u) !== false;

  // Each unit on its own: some longest common subsequence must allow what the commit did with it.
  const free = freedom(before, raw, span.pre, span.endS, span.endT);
  const qspan = changedRegion(before, cleaned);
  const qlo = Math.max(0, qspan.pre - MARGIN);
  const qhiS = Math.min(before.length, qspan.endS + MARGIN);
  const qhiT = Math.min(cleaned.length, qspan.endT + MARGIN);
  const freeQ = freedom(before, cleaned, qlo, qhiS, qhiT);
  const rules: Rules = {
    keep: (p, q) => {
      const u = raw.charCodeAt(p);
      if (!isQuote(u)) return free.canPair[p] === 1 || samePlace(p);
      return !mustCurl(u) || freeQ.canPair[q] === 1 || quoteSamePlace(cleaned, q) || samePlace(p);
    },
    clean: (p) => free.canSkip[p] === 1 && !samePlace(p),
    curl: (p, q) => mayCurl(raw.charCodeAt(p)) && freeQ.canSkip[q] === 1,
  };
  const strict = readings(raw, result, rules);
  if (!strict[raw.length].has(result.length)) return stuck(raw, result, strict, rec, '[clean-up] the commit does not follow 9.2 step 3');

  // All units at once: one longest common subsequence of the changed region must pair every special unit the
  // commit kept (but for the position rule's) and leave out every one it cleaned; likewise for the quotes.
  const regionB = before.slice(span.pre, span.endS);
  const regionF = raw.slice(span.pre, span.endT);
  const band = lcsBand(regionB, regionF);
  for (const r of completeReadings(raw, result, strict, MAX_READINGS)) {
    const need = new Uint8Array(regionF.length);
    for (let p = span.pre; p < span.endT; p++) {
      if (isQuote(raw.charCodeAt(p))) continue;
      if (r.did[p] === 'c') need[p - span.pre] = SKIP;
      else if (r.did[p] === 'k' && !samePlace(p)) need[p - span.pre] = PAIR;
    }
    if (columns(regionB, regionF, band.kLo, band.kHi, need, null) !== band.total) continue;
    const cl = cleanedOf(r);
    const winB = before.slice(qlo, Math.min(before.length, qspan.endS + MARGIN));
    const winC = cl.slice(qlo, Math.min(cl.length, qspan.endT + MARGIN));
    const needQ = new Uint8Array(winC.length);
    for (let p = 0; p < raw.length; p++) {
      const u = raw.charCodeAt(p);
      const q = r.to[p] - qlo;
      if (!isQuote(u) || q < 0 || q >= winC.length) continue;
      if (r.did[p] === 'q') needQ[q] = SKIP;
      else if (mustCurl(u) && !quoteSamePlace(cl, r.to[p]) && !samePlace(p)) needQ[q] = PAIR;
    }
    const qband = lcsBand(winB, winC);
    if (columns(winB, winC, qband.kLo, qband.kHi, needQ, null) === qband.total) return null;
  }
  return '[clean-up] the units the commit kept and cleaned fit no single diff of the changed region (9.2 step 3)';
}
