// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// The author's record (rule 3 of place.ts; the second hardening round). The anchors (anchors.ts) confirm a place by
// the text right around it, out to where that text is unique plus a margin. Two kinds of change got past them:
//
//   - A program that gives positional text out again by position (a deck generator run again after its slide list
//     changed, a script that renumbers slide ids and page counters) moves what told the copies apart (the id on one
//     side, the counter on the other) onto ANOTHER copy. The anchors then stand, byte for byte and once, around the
//     copy now at the author's old position, whose own slide holds another title and body, while the author's slide,
//     whole but for its new number, is somewhere else.
//   - A new card modelled on the author's (its label and the text around it), put beside it while the word next to
//     the author's label is renamed: the anchors stand around the new card, whose text past them is new, while the
//     author's card, whole but for that word, is right next to it.
//
// In both, the author's RECORD (its slide, card or data record) is still in the file, and the place the diff found is
// not in it. So the place is also checked against the record: the largest element (or JS node, for a script literal)
// around the run that holds no other copy of the run's text (widened, when the anchors already cover it on both sides,
// to the smallest element that reaches past them: a row holding the text twice). What only the author's record held
// (its text that is in no other copy's record: what tells the records apart, never the template they share) is
// compared:
//
//   a. No other copy's record may hold any of it that the place's record does not hold (in order, around the place),
//      and no copy the other program added (no image of an old copy) may hold any of the author's record, template text
//      too, that the place's record lost. Either reading of such a file fits its bytes (the records moved and were
//      renumbered, or their contents were exchanged under fixed headers), so the place is not certain (E-1).
//   b. No copy that the other program added may hold half or more of what only the author's record held in the whole
//      file: it could be the author's record changed a little, with the diff's place a copy of it.
//   c. The place's record may hold nothing that only another copy's record held: the author's slide deleted and another
//      renumbered into its place, or the two exchanged.
//
// A record is an element of the parse (parse5, as the map's) or a node of the script's syntax tree (acorn): a slide
// moved whole keeps its record, so a correct move or swap is not a note, and a neighbour's text is never taken for
// the author's. Text alone never picks a place here either: this rule only turns a write into a note.

import DiffMatchPatch from 'diff-match-patch';
import { parse as acornParse, parseExpressionAt } from 'acorn';
import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5';
import type { DeckMap, HtmlRun, LiteralRun } from '@blueline/core/types';
import { ANCHOR_FLOOR } from './anchors';

type Run = HtmlRun | LiteralRun;
type P5Node = DefaultTreeAdapterTypes.Node;

/** The most characters of a record, on each side of its copy, that are compared. */
export const RECORD_WINDOW = 4096;
/** Text counts as held by a record when a stretch of this many characters around it stands there. */
const GRAM = 8;
/** The most characters one check compares (gram sets and diffs); past that the place is not confirmed. */
const BUDGET = 24_000_000;
/** The diff of the place's record against the author's old one: a time limit, as the placement's diff has. */
const DIFF_SEC = 1;

export type RecordCheck = { ok: true } | { ok: false; why: string };

export const NOT_IN_RECORD = {
  moved:
    "another copy of the text holds what surrounded the edited place in its slide or record, and the place no longer does, so which one it is cannot be told (9.2 Write protocol step 2)",
  near: 'the deck has a new copy of the text whose slide or record holds most of what surrounded the edited place, so which one it is cannot be told (9.2 Write protocol step 2)',
  other: "the edited place's slide or record now holds what another copy's held, so which one it is cannot be told (9.2 Write protocol step 2)",
  large: 'the text is in too many places to tell its copies apart (9.2 Write protocol step 2)',
} as const;

/** One version of the file, as place.ts holds it. */
export interface RecordVersion {
  src: string;
  map: DeckMap;
}

interface Span {
  start: number;
  end: number;
  key: object;
}

interface Parsed {
  root: P5Node;
  /** Source ranges of the nodes, implied elements included (rangeOf). */
  ranges: WeakMap<object, { start: number; end: number } | null>;
  /** Syntax trees of the scripts, by the script's content start (null: it does not parse). */
  asts: Map<number, object | null>;
}

/** A few recent parses: a stale edit, its carry through another program's steps and an undo reuse them. */
const parses: { src: string; parsed: Parsed }[] = [];
const PARSES_KEPT = 2;

function parsedOf(src: string): Parsed {
  const i = parses.findIndex((p) => p.src === src);
  if (i >= 0) {
    const [hit] = parses.splice(i, 1);
    parses.push(hit);
    return hit.parsed;
  }
  // A BOM is parsed as a space, so the parse's offsets stay the source's (9.2 rule 3).
  const text = src.charCodeAt(0) === 0xfeff ? ' ' + src.slice(1) : src;
  const parsed: Parsed = { root: parseHtml(text, { sourceCodeLocationInfo: true }) as unknown as P5Node, ranges: new WeakMap(), asts: new Map() };
  parses.push({ src, parsed });
  while (parses.length > PARSES_KEPT) parses.shift();
  return parsed;
}

function childrenOf(n: P5Node): P5Node[] {
  const kids = (n as { childNodes?: P5Node[] }).childNodes ?? [];
  const content = (n as { content?: { childNodes?: P5Node[] } }).content;
  return content && content.childNodes ? [...kids, ...content.childNodes] : kids;
}

/** A node's source range; an element the parser implied (an `<html>`, `<body>` or `<tbody>` not in the file) spans its children. */
function rangeOf(n: P5Node, memo: WeakMap<object, { start: number; end: number } | null>): { start: number; end: number } | null {
  if (memo.has(n)) return memo.get(n)!;
  const loc = (n as { sourceCodeLocation?: { startOffset: number; endOffset: number } | null }).sourceCodeLocation;
  let r: { start: number; end: number } | null = loc ? { start: loc.startOffset, end: loc.endOffset } : null;
  if (!r) {
    for (const c of childrenOf(n)) {
      const cr = rangeOf(c, memo);
      if (cr) r = r ? { start: Math.min(r.start, cr.start), end: Math.max(r.end, cr.end) } : { ...cr };
    }
  }
  memo.set(n, r);
  return r;
}

/** The elements around [start, end), innermost first (by their source ranges). */
function htmlChain(parsed: Parsed, start: number, end: number): Span[] {
  const out: Span[] = [];
  let n: P5Node = parsed.root;
  for (;;) {
    let next: P5Node | null = null;
    let at: { start: number; end: number } | null = null;
    for (const c of childrenOf(n)) {
      if (!('tagName' in c)) continue;
      const r = rangeOf(c, parsed.ranges);
      if (r && r.start <= start && end <= r.end) {
        next = c;
        at = r;
        break;
      }
    }
    if (!next || !at) break;
    out.push({ start: at.start, end: at.end, key: next });
    n = next;
  }
  return out.reverse();
}

interface AstNode {
  type: string;
  start: number;
  end: number;
  [k: string]: unknown;
}

function isAstNode(v: unknown): v is AstNode {
  return !!v && typeof v === 'object' && typeof (v as AstNode).type === 'string' && typeof (v as AstNode).start === 'number' && typeof (v as AstNode).end === 'number';
}

/** The syntax tree of a script's content (classic, module or JSON data), or null. */
function astOf(parsed: Parsed, src: string, s: DeckMap['scripts'][number]): object | null {
  if (parsed.asts.has(s.contentStart)) return parsed.asts.get(s.contentStart)!;
  const content = src.slice(s.contentStart, s.contentEnd);
  let ast: object | null = null;
  const tries: Array<() => object> =
    s.kind === 'json'
      ? [() => parseExpressionAt(content, content.length - content.trimStart().length, { ecmaVersion: 'latest' }) as unknown as object]
      : (s.kind === 'module' ? (['module', 'script'] as const) : (['script', 'module'] as const)).map(
          (sourceType) => () => acornParse(content, { ecmaVersion: 'latest', sourceType }) as unknown as object,
        );
  for (const t of tries) {
    try {
      ast = t();
      break;
    } catch {
      ast = null;
    }
  }
  parsed.asts.set(s.contentStart, ast);
  return ast;
}

/** The syntax nodes around [s, e) of a script's content, innermost first, in source offsets (`base` + node offsets). */
function astChain(ast: object, s: number, e: number, base: number): Span[] {
  const out: Span[] = [];
  let n = ast as AstNode;
  if (!(n.start <= s && e <= n.end)) return out;
  out.push({ start: base + n.start, end: base + n.end, key: n });
  outer: for (;;) {
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
      const v = n[k];
      for (const c of Array.isArray(v) ? v : [v]) {
        if (isAstNode(c) && c.start <= s && e <= c.end && c !== n) {
          out.push({ start: base + c.start, end: base + c.end, key: c });
          n = c;
          continue outer;
        }
      }
    }
    break;
  }
  return out.reverse();
}

/** Everything around a run, innermost first: its syntax nodes (a script literal), then its elements. */
function chainOf(v: RecordVersion, parsed: Parsed, r: Run): Span[] {
  const html = htmlChain(parsed, r.start, r.end);
  if (r.id.startsWith('l:')) {
    const lit = r as LiteralRun;
    const unit = v.map.units[lit.unit];
    const script = unit ? v.map.scripts[unit.scriptIndex] : undefined;
    if (script && script.contentStart <= r.start && r.end <= script.contentEnd) {
      const ast = astOf(parsed, v.src, script);
      if (ast) return [...astChain(ast, r.start - script.contentStart, r.end - script.contentStart, script.contentStart), ...html];
    }
  }
  return html;
}

/**
 * Each copy's record: the largest element (or syntax node) around it that holds no other copy, or its innermost
 * one when that already holds another; the whole file when nothing is around it.
 */
/** A copy's record: its range, the element (null: the whole file), and the elements from the copy out to it. */
interface Rec {
  start: number;
  end: number;
  key: object | null;
  chain: Span[];
}

function recordsOf(v: RecordVersion, copies: Run[]): Map<Run, Rec> {
  const parsed = parsedOf(v.src);
  const chains = new Map<Run, Span[]>();
  const counts = new Map<object, number>();
  for (const c of copies) {
    const ch = chainOf(v, parsed, c);
    chains.set(c, ch);
    for (const a of ch) counts.set(a.key, (counts.get(a.key) ?? 0) + 1);
  }
  const out = new Map<Run, Rec>();
  for (const c of copies) {
    const ch = chains.get(c)!;
    if (ch.length === 0) {
      out.set(c, { start: 0, end: v.src.length, key: null, chain: ch });
      continue;
    }
    let i = 0;
    if (counts.get(ch[0].key) === 1) while (i + 1 < ch.length && counts.get(ch[i + 1].key) === 1) i++;
    // A record that the anchors already cover on both sides tells nothing more (a separator, an icon, a short text
    // repeated in the same row): the record is then the smallest element around it that reaches past them on one side,
    // other copies in it included (a row of cells, a card holding the text twice).
    while (i + 1 < ch.length && c.start - ch[i].start < ANCHOR_FLOOR && ch[i].end - c.end < ANCHOR_FLOOR) i++;
    // The whole file when even the outermost element holds this copy alone.
    const top = i + 1 === ch.length && counts.get(ch[i].key) === 1;
    out.set(c, top ? { start: 0, end: v.src.length, key: null, chain: ch } : { start: ch[i].start, end: ch[i].end, key: ch[i].key, chain: ch.slice(0, i + 1) });
  }
  return out;
}

/** The record's text on each side of its copy, at most RECORD_WINDOW characters each. */
function sides(src: string, r: { start: number; end: number }, rec: { start: number; end: number }): [string, string] {
  return [src.slice(Math.max(rec.start, r.start - RECORD_WINDOW, 0), r.start), src.slice(r.end, Math.min(rec.end, r.end + RECORD_WINDOW, src.length))];
}

function addGrams(set: Set<string>, s: string): void {
  for (let i = 0; i + GRAM <= s.length; i++) set.add(s.slice(i, i + GRAM));
}

/** Marks the characters of `s` that a gram held in `set` covers. */
function covered(s: string, set: Set<string>): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i + GRAM <= s.length; i++) if (set.has(s.slice(i, i + GRAM))) out.fill(1, i, i + GRAM);
  return out;
}

/** Marks the characters of `a` that the diff of a against b keeps (EQUAL). Null on the time limit. */
function kept(a: string, b: string): Uint8Array | null {
  const out = new Uint8Array(a.length);
  if (a === b) return out.fill(1);
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = DIFF_SEC;
  const t0 = performance.now();
  const diffs = dmp.diff_main(a, b) as [number, string][];
  if (performance.now() - t0 >= DIFF_SEC * 1000) return null;
  let p = 0;
  for (const [op, text] of diffs) {
    if (op === 0) out.fill(1, p, p + text.length);
    if (op !== 1) p += text.length;
  }
  return out;
}

/**
 * Marks the characters of `s` that a gram found in `src` outside [skipStart, skipEnd) covers: text the rest of the
 * file also holds (a template's markup), by a rolling hash over the file, each hit compared in full.
 */
function elsewhere(s: string, src: string, skipStart: number, skipEnd: number): Uint8Array {
  const out = new Uint8Array(s.length);
  if (s.length < GRAM) return out;
  const B = 0x01000193;
  let pow = 1;
  for (let i = 1; i < GRAM; i++) pow = Math.imul(pow, B);
  const hashOf = (t: string, at: number): number => {
    let h = 0;
    for (let i = 0; i < GRAM; i++) h = (Math.imul(h, B) + t.charCodeAt(at + i)) | 0;
    return h;
  };
  const want = new Map<number, number[]>();
  for (let i = 0; i + GRAM <= s.length; i++) {
    const h = hashOf(s, i);
    const l = want.get(h);
    if (l) l.push(i);
    else want.set(h, [i]);
  }
  const found = new Set<string>();
  let h = src.length >= GRAM ? hashOf(src, 0) : 0;
  for (let p = 0; p + GRAM <= src.length; p++) {
    if (p > 0) h = (Math.imul(h - Math.imul(src.charCodeAt(p - 1), pow), B) + src.charCodeAt(p + GRAM - 1)) | 0;
    if (p + GRAM > skipStart && p < skipEnd) continue;
    const l = want.get(h);
    if (!l) continue;
    const g = src.slice(p, p + GRAM);
    if (found.has(g)) continue;
    for (const i of l) if (s.startsWith(g, i)) found.add(g);
  }
  for (let i = 0; i + GRAM <= s.length; i++) if (found.has(s.slice(i, i + GRAM))) out.fill(1, i, i + GRAM);
  return out;
}

function invert(c: Uint8Array, len: number): Uint8Array {
  // A character no gram covers (a side shorter than a gram) tells nothing.
  if (len < GRAM) return new Uint8Array(len);
  for (let i = 0; i < c.length; i++) c[i] = c[i] ? 0 : 1;
  return c;
}

function sum(a: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i];
  return n;
}

/**
 * Rule 3 of place.ts (see the file's comment). `run` is the client's run in `old`, `hit` the place in `cur`;
 * `copiesOld` and `copiesCur` every run of each version that holds the text (any kind), `images` the copies of
 * `cur` that are a diff image of an old copy (the hit among them).
 */
export function checkRecord(
  old: RecordVersion,
  run: Run,
  cur: RecordVersion,
  hit: Run,
  copiesOld: Run[],
  copiesCur: Run[],
  images: Set<Run>,
): RecordCheck {
  const kind = hit.id.slice(0, 2);
  // Nothing to tell apart: no other copy now, and none before.
  if (copiesCur.every((k) => k === hit) && copiesOld.every((c) => c === run)) return { ok: true };
  let budget = BUDGET - old.src.length;
  const recOld = recordsOf(old, copiesOld.includes(run) ? copiesOld : [...copiesOld, run]);
  const recCur = recordsOf(cur, copiesCur.includes(hit) ? copiesCur : [...copiesCur, hit]);
  const r0 = recOld.get(run)!;
  const rh = recCur.get(hit)!;
  // The other copies that could be the author's: of the same kind, in a record apart from the place's. A copy whose
  // record holds the place's, or lies in it (a short text whose record was widened past the anchors), shares the
  // place's text: what its record holds says nothing about which copy is the author's.
  const rivals = copiesCur.filter((k) => {
    if (k === hit || k.id.slice(0, 2) !== kind) return false;
    const rk = recCur.get(k)!;
    return rk.key === null || rk.end <= rh.start || rh.end <= rk.start;
  });
  // The author's record, no larger than the place's: the smallest element around the run that reaches as far on
  // both sides as the place's record does (what lies beyond it belongs to the neighbours).
  const reachL = Math.min(RECORD_WINDOW, hit.start - rh.start);
  const reachR = Math.min(RECORD_WINDOW, rh.end - hit.end);
  let rec: { start: number; end: number } = r0;
  for (const a of r0.chain) {
    if (run.start - a.start >= reachL && a.end - run.end >= reachR) {
      rec = a;
      break;
    }
  }
  const O = sides(old.src, run, rec);
  // a. What tells the records apart: the record's text that no other copy's record holds.
  const common = new Set<string>();
  for (const c of copiesOld) {
    if (c === run) continue;
    const rc = recOld.get(c)!;
    if (rc.start < rec.end && rec.start < rc.end) continue; // the same record (two copies in one element)
    for (const s of sides(old.src, c, rc)) {
      budget -= s.length;
      if (budget < 0) return { ok: false, why: NOT_IN_RECORD.large };
      addGrams(common, s);
    }
  }
  const distinct = O.map((s) => invert(covered(s, common), s.length));
  // b. What only the author's record holds in the whole file (never a template's markup).
  const own = O.map((s) => invert(elsewhere(s, old.src, rec.start, rec.end), s.length));
  const total = sum(own[0]) + sum(own[1]);
  // What the place's record holds of it, in order around the place.
  const H = sides(cur.src, hit, rh);
  const missing: Uint8Array[] = [];
  const lost: Uint8Array[] = [];
  for (let s = 0; s < 2; s++) {
    budget -= O[s].length + H[s].length;
    const k = kept(O[s], H[s]);
    if (!k) return { ok: false, why: NOT_IN_RECORD.large };
    const m = new Uint8Array(O[s].length);
    const l = new Uint8Array(O[s].length);
    for (let i = 0; i < m.length; i++) {
      l[i] = k[i] ? 0 : 1;
      m[i] = distinct[s][i] && !k[i] ? 1 : 0;
    }
    missing.push(m);
    lost.push(l);
  }
  const anyMissing = sum(missing[0]) + sum(missing[1]) > 0;
  const anyLost = sum(lost[0]) + sum(lost[1]) > 0;
  // c. The place's record holds what another copy's record held and the author's did not: the author's slide gone or
  // emptied, and another's content at its place (a deleted slide renumbered over), or the two exchanged. Only as far
  // around the place as the author's record reached: beyond it lie the neighbours.
  const mine = new Set<string>();
  for (const x of O) addGrams(mine, x);
  const near = [H[0].slice(Math.max(0, H[0].length - O[0].length)), H[1].slice(0, O[1].length)];
  for (const x of near) {
    budget -= x.length;
    for (let i = 0; i + GRAM <= x.length; i++) {
      const g = x.slice(i, i + GRAM);
      if (common.has(g) && !mine.has(g)) return { ok: false, why: NOT_IN_RECORD.other };
    }
  }
  for (const k of rivals) {
    const added = !images.has(k);
    if (!anyMissing && !(added && (anyLost || total > 0))) continue;
    const set = new Set<string>();
    for (const s of sides(cur.src, k, recCur.get(k)!)) {
      budget -= s.length;
      addGrams(set, s);
    }
    if (budget < 0) return { ok: false, why: NOT_IN_RECORD.large };
    let holds = 0;
    for (let s = 0; s < 2; s++) {
      const c = covered(O[s], set);
      for (let i = 0; i < c.length; i++) {
        if (!c[i]) continue;
        // Another copy's image holds what told the author's record apart; a copy the other program added holds any of
        // the author's record that the place lost (a template's text too: it may be the author's record, renamed).
        if (missing[s][i] || (added && lost[s][i])) return { ok: false, why: NOT_IN_RECORD.moved };
        holds += own[s][i];
      }
    }
    if (added && total > 0 && 2 * holds >= total) return { ok: false, why: NOT_IN_RECORD.near };
  }
  return { ok: true };
}
