// The shared matcher (9.2 "Matching DOM to source at runtime" and Strategy 2 "Matching"). Used by the
// overlay (with the ClientMap it receives over IPC), by `blueline map` and by the patcher's re-check (with
// the full DeckMap). Environment-neutral and dependency-free, so the preload bundle stays small.

import { isWhitespaceOnly, looksComputed } from './text';
import type { ClientMap, DeckMap, DomTextNode, MatchCandidate, MatchReason, MatchResult, Strategy } from './types';

const PLACEHOLDER = '\uE000';
/** Most candidates a substring or normalized-text search returns; exact duplicates are all listed (9.2). */
export const MAX_SEARCH_CANDIDATES = 50;
/** Longest node text the multi-literal reason search segments (it is a report reason only, section 10). */
const MAX_SEGMENT_LENGTH = 2000;

interface Cand {
  runId: string;
  strategy: Strategy;
  start: number;
  end: number;
  line: number;
  value: string;
  aligned: boolean;
  placeholder: boolean;
  literal: boolean;
  /** Source order, for listing candidates. */
  order: number;
}

export interface MatcherOptions {
  /** The deck's file name, for the key warning "This text is also used as a key at <file>:<line>". */
  fileName?: string;
}

export type Matcher = (node: DomTextNode) => MatchResult;

function isDeckMap(map: ClientMap | DeckMap): map is DeckMap {
  return Array.isArray((map as DeckMap).units);
}

/** Whitespace collapse (HTML whitespace runs → one space, trimmed) and NFC (9.2 Strategy 2 step 3). */
export function normalizeForMatch(s: string): string {
  return s
    .replace(/[ \t\n\r\f]+/g, ' ')
    .replace(/^ | $/g, '')
    .normalize('NFC');
}

/**
 * Builds a matcher over one map version. The returned function decides `exact`, `ambiguous` or `none`
 * for a DOM text node, with the reasons of section 10 (Phase 0) and the candidates the picker lists.
 * ClientMap candidates carry -1 for start, end and line (the overlay does not hold offsets).
 */
export function createMatcher(map: ClientMap | DeckMap, opts: MatcherOptions = {}): Matcher {
  const fileName = opts.fileName ?? 'deck.html';
  if (!map.utf8) {
    // 9.2 rule 1: a deck that failed the UTF-8 decode is read-only; every node is `none`.
    return () => ({ confidence: 'none', runId: null, strategy: null, candidates: [], reason: 'not-utf8' });
  }

  const deck = isDeckMap(map) ? map : null;
  const cands: Cand[] = [];
  const own = new Map<string, Cand>();
  /** Each stamp's source runs by textIndex (D-b: step 1 checks the element's live text nodes against them). */
  const byStamp = new Map<string, Cand[]>();
  const addOwn = (stamp: string, textIndex: number, c: Cand): void => {
    own.set(ownKey(stamp, textIndex), c);
    let list = byStamp.get(stamp);
    if (!list) byStamp.set(stamp, (list = []));
    if (Number.isInteger(textIndex) && textIndex >= 0) list[textIndex] = c;
  };
  if (deck) {
    for (const r of deck.runs) {
      const c: Cand = {
        runId: r.id,
        strategy: 'html-text',
        start: r.start,
        end: r.end,
        line: r.line,
        value: r.value,
        aligned: r.aligned,
        placeholder: false,
        literal: false,
        order: 0,
      };
      cands.push(c);
      addOwn(r.stamp, r.textIndex, c);
    }
    for (const l of deck.literals) {
      cands.push({
        runId: l.id,
        strategy: l.strategy,
        start: l.start,
        end: l.end,
        line: l.line,
        value: l.value,
        aligned: l.aligned !== false,
        placeholder: l.placeholder,
        literal: true,
        order: 0,
      });
    }
    // List candidates in source order.
    const sorted = cands.slice().sort((a, b) => a.start - b.start || a.end - b.end);
    sorted.forEach((c, i) => (c.order = i));
  } else {
    const cm = map as ClientMap;
    for (const r of cm.runs) {
      const c: Cand = {
        runId: r.id,
        strategy: 'html-text',
        start: -1,
        end: -1,
        line: -1,
        value: r.value,
        aligned: r.aligned,
        placeholder: false,
        literal: false,
        order: cands.length,
      };
      cands.push(c);
      addOwn(r.stamp, r.textIndex, c);
    }
    for (const l of cm.literals) {
      cands.push({
        runId: l.id,
        strategy: l.strategy ?? 'script-literal',
        start: -1,
        end: -1,
        line: -1,
        value: l.value,
        aligned: l.aligned !== false,
        placeholder: l.placeholder,
        literal: true,
        order: cands.length,
      });
    }
  }

  // Index by exact value: the common path is one Map lookup per node.
  const byValue = new Map<string, Cand[]>();
  for (const c of cands) {
    const list = byValue.get(c.value);
    if (list) list.push(c);
    else byValue.set(c.value, [c]);
  }

  // Ambiguity by key (9.2 Strategy 2 step 3): id, class, name, for, href and data-* attribute values, and
  // object keys, member names and destructuring keys (mapper-literals).
  const keySet = new Set(map.keyValues);
  // Shadow values (D-a): text the page may show from a source Blueline never writes. A literal equal to one
  // does not occur once (9.2 Strategy 2 step 3), so it is never exact. Absent (hand-built maps) is empty.
  const shadowSet = new Set<string>(deck ? (deck.shadows ?? []).map((sh) => sh.value) : ((map as ClientMap).shadowValues ?? []));
  const keyLine = new Map<string, number>();
  if (deck) for (const k of deck.keys) if (!keyLine.has(k.value)) keyLine.set(k.value, k.line);
  const keyWarning = (value: string): string | undefined => {
    if (!keySet.has(value)) return undefined;
    const line = keyLine.get(value);
    return line !== undefined
      ? `This text is also used as a key at ${fileName}:${line}`
      : `This text is also used as a key in ${fileName}`;
  };

  const toCandidate = (c: Cand): MatchCandidate => {
    const out: MatchCandidate = { runId: c.runId, strategy: c.strategy, start: c.start, end: c.end, line: c.line };
    if (c.literal) {
      const w = keyWarning(c.value);
      if (w) out.keyWarning = w;
    }
    return out;
  };
  const listed = (cs: Cand[]): MatchCandidate[] => cs.slice().sort((a, b) => a.order - b.order).map(toCandidate);
  const exact = (c: Cand): MatchResult => ({
    confidence: 'exact',
    runId: c.runId,
    strategy: c.strategy,
    candidates: [toCandidate(c)],
  });
  const ambiguous = (reason: MatchReason, cs: Cand[]): MatchResult => ({
    confidence: 'ambiguous',
    runId: null,
    strategy: null,
    candidates: listed(cs),
    reason,
  });
  const none = (reason: MatchReason, cs: Cand[] = []): MatchResult => ({
    confidence: 'none',
    runId: null,
    strategy: null,
    candidates: listed(cs),
    reason,
  });

  // Searchable runs for the near-miss reasons. Placeholder runs are pin-only (section 7), so they are
  // never offered as candidates; they only explain a `computed` node.
  const searchable = cands.filter((c) => !c.placeholder);
  let normIndex: Map<string, Cand[]> | null = null;
  const notEqual = (data: string): Cand[] => {
    if (normIndex === null) {
      normIndex = new Map();
      for (const c of searchable) {
        const k = normalizeForMatch(c.value);
        const list = normIndex.get(k);
        if (list) list.push(c);
        else normIndex.set(k, [c]);
      }
    }
    return (normIndex.get(normalizeForMatch(data)) ?? []).slice(0, MAX_SEARCH_CANDIDATES);
  };

  // All searchable values joined with NUL, so one native indexOf scan finds every run containing data.
  let hay: string | null = null;
  let hayStarts: number[] = [];
  const substring = (data: string): Cand[] => {
    const out: Cand[] = [];
    if (data.length === 0) return out;
    if (data.includes('\u0000')) {
      for (const c of searchable) {
        if (c.value.includes(data)) out.push(c);
        if (out.length >= MAX_SEARCH_CANDIDATES) break;
      }
      return out;
    }
    if (hay === null) {
      hayStarts = [];
      const parts: string[] = [];
      let pos = 0;
      for (const c of searchable) {
        hayStarts.push(pos);
        parts.push(c.value);
        pos += c.value.length + 1;
      }
      hay = parts.join('\u0000');
    }
    let from = 0;
    while (out.length < MAX_SEARCH_CANDIDATES) {
      const at = hay.indexOf(data, from);
      if (at < 0) break;
      const k = upperBound(hayStarts, at) - 1;
      out.push(searchable[k]);
      from = k + 1 < hayStarts.length ? hayStarts[k + 1] : hay.length;
    }
    return out;
  };

  // Template runs with placeholders, as wildcard patterns, for the `computed` reason.
  let patterns: string[][] | null = null;
  const matchesTemplate = (data: string): boolean => {
    if (patterns === null) {
      patterns = [];
      for (const c of cands) {
        if (!c.placeholder || !c.literal) continue;
        const pieces = c.value.split(PLACEHOLDER);
        // A run that is only substitutions and whitespace would match any text; it explains nothing.
        if (pieces.every((p) => isWhitespaceOnly(p))) continue;
        patterns.push(pieces);
      }
    }
    for (const p of patterns) if (wildcardMatch(p, data)) return true;
    return false;
  };

  // Literal values for the multi-literal segmentation.
  let litValues: Set<string> | null = null;
  let litLengths: number[] = [];
  const segmentReason = (data: string): MatchReason | null => {
    if (data.length > MAX_SEGMENT_LENGTH) return null;
    if (litValues === null) {
      litValues = new Set();
      for (const c of cands) if (c.literal && !c.placeholder && c.value.length > 0) litValues.add(c.value);
      litLengths = [...new Set([...litValues].map((v) => v.length))].sort((a, b) => a - b);
    }
    return segment(data, litValues, litLengths);
  };

  /**
   * D-b (review finding 2): the live textIndex picks the own run only while the element's direct text nodes
   * are still the source's. A script that adds or removes one (p.prepend('You are here: ')) shifts the index
   * onto a neighbour's run, which may have the same text. So the element's non-whitespace direct text nodes
   * (node.texts) must be as many as the stamp's source runs, these must cover textIndex 0..n-1 with no gap
   * (a text the mapper dropped leaves one), and every other index must hold its source value. Absent or
   * malformed texts cannot be checked.
   */
  const ownAgrees = (node: DomTextNode, mine: Cand): boolean => {
    const texts = node.texts;
    const runs = node.stamp !== null ? byStamp.get(node.stamp) : undefined;
    if (!Array.isArray(texts) || !runs || texts.length !== runs.length) return false;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r === undefined || typeof texts[i] !== 'string') return false;
      if (i === node.textIndex ? r !== mine || texts[i] !== node.data : texts[i] !== r.value) return false;
    }
    return true;
  };

  return (node: DomTextNode): MatchResult => {
    const data = node.data;
    const equal = byValue.get(data) ?? [];

    // 1. The node's own stamped run, only if its data equals the run's decoded value exactly and the
    // element's text nodes still agree with the source (D-b). Shadow values do not apply here: the node is
    // the run's own text node.
    if (node.stamp !== null) {
      const mine = own.get(ownKey(node.stamp, node.textIndex));
      // A node a script rewrote after parsing is not the run's own text node, whatever it holds now.
      if (mine && mine.value === data && node.touched !== true && ownAgrees(node, mine)) {
        // A stamped run is never preferred over a literal with the same text: the script may have
        // replaced the element's text with that literal. Another run of the same element with the same
        // text is the same doubt: a script may have swapped or removed equal text nodes (D-b).
        const twins = (byStamp.get(node.stamp) ?? []).filter((c) => c !== mine && c.value === data);
        const lits = equal.filter((c) => c.literal);
        if (twins.length + lits.length > 0) return ambiguous('duplicate', [mine, ...twins, ...lits]);
        if (!mine.aligned) return none('unaligned', [mine]);
        return exact(mine);
      }
    }

    // 2. Every stamped and literal run whose text equals the node's data, as one candidate set.
    if (equal.length === 1) {
      const c = equal[0];
      // One stamped run that is not the node's own: JS-built text, or a coincidence.
      if (!c.literal) return ambiguous('stamp-other', [c]);
      // One literal run: Strategy 2 decides. It must occur once: no other run of either kind is equal, and
      // no text Blueline never writes (a shadow value, D-a) is equal either. Shadows are never candidates.
      if (c.placeholder) return none('placeholder', [c]); // section 7: `${…}` inside the run is pin-only
      if (!c.aligned) return none('unaligned', [c]);
      if (keySet.has(c.value)) return ambiguous('key', [c]);
      if (shadowSet.has(c.value)) return ambiguous('shadow', [c]);
      return exact(c);
    }
    if (equal.length > 1) return ambiguous('duplicate', equal);

    // 3. No equal run. Near misses are `ambiguous`; anything else is `none` with a report reason.
    if (data.length === 0 || isWhitespaceOnly(data)) return none('no-match');
    const ne = notEqual(data);
    if (ne.length > 0) return ambiguous('not-equal', ne);
    const sub = substring(data);
    if (sub.length > 0) return ambiguous('substring', sub);
    if (matchesTemplate(data) || looksComputed(data)) return none('computed');
    return none(segmentReason(data) ?? 'no-match');
  };
}

function ownKey(stamp: string, textIndex: number): string {
  return stamp + '\u0000' + textIndex;
}

function upperBound(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Glob match with `*` between pieces; leftmost placement of the middle pieces is enough for `*`-only patterns. */
function wildcardMatch(pieces: string[], s: string): boolean {
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (s.length < first.length + last.length) return false;
  if (!s.startsWith(first) || !s.endsWith(last)) return false;
  let pos = first.length;
  const limit = s.length - last.length;
  for (let k = 1; k < pieces.length - 1; k++) {
    const p = pieces[k];
    if (p.length === 0) continue;
    const at = s.indexOf(p, pos);
    if (at < 0 || at + p.length > limit) return false;
    pos = at + p.length;
  }
  return true;
}

const DIGIT = /[0-9]/;
const WS = /[ \t\n\r\f\u00a0]/;

/**
 * Can `data` be written as a concatenation of literal values, whitespace and digits? With two or more
 * literal pieces and no digits it was assembled from several literals (`multi-literal`); with a literal
 * and digits it mixes literals with computed values (`computed`). Report reasons only (section 10).
 */
function segment(data: string, lits: Set<string>, lengths: number[]): MatchReason | null {
  const L = data.length;
  // reach[i] is a set of states, one bit per (literal pieces so far, capped at 2) × (any digits so far).
  const bit = (lits: number, digits: number): number => 1 << ((lits << 1) | digits);
  const afterDigit = (here: number): number => {
    let out = 0;
    for (let lc = 0; lc <= 2; lc++) if (here & (bit(lc, 0) | bit(lc, 1))) out |= bit(lc, 1);
    return out;
  };
  const afterLiteral = (here: number): number => {
    let out = 0;
    for (let lc = 0; lc <= 2; lc++) {
      for (let d = 0; d <= 1; d++) if (here & bit(lc, d)) out |= bit(Math.min(2, lc + 1), d);
    }
    return out;
  };
  const reach = new Uint8Array(L + 1);
  reach[0] = bit(0, 0);
  for (let i = 0; i < L; i++) {
    const here = reach[i];
    if (here === 0) continue;
    const ch = data[i];
    if (WS.test(ch)) reach[i + 1] |= here;
    else if (DIGIT.test(ch)) reach[i + 1] |= afterDigit(here);
    let next = -1;
    for (const len of lengths) {
      if (i + len > L) break;
      if (lits.has(data.substr(i, len))) {
        if (next < 0) next = afterLiteral(here);
        reach[i + len] |= next;
      }
    }
  }
  const end = reach[L];
  if (end & bit(2, 0)) return 'multi-literal';
  if (end & (bit(1, 1) | bit(2, 1))) return 'computed';
  return null;
}
