// Decoded-to-raw tables for HTML text (9.2 Strategy 1 step 5, rule 4) and the HTML text encoder.
//
// A Strategy 1 run is one DOM text node. parse5 gives its raw range in src and its decoded value; this
// module aligns the two one raw unit at a time, exactly as parse5's tokenizer decodes them:
//   - character references, through the same decoder parse5 uses (entities' EntityDecoder in Legacy mode),
//     so legacy references without `;`, numeric references and their replacement table (&#128; → €,
//     &#0;, surrogates and values past U+10FFFF → U+FFFD) and two-code-point references all agree;
//   - CRLF and lone CR → LF (9.2 rule 4);
//   - U+0000: dropped in HTML content, U+FFFD in foreign content;
//   - the one leading newline parse5 drops right after <pre> and <listing>.
// Each reference, each CRLF and each surrogate pair is one atomic unit. The table is verified by
// re-decoding the raw slice through it; any disagreement returns null and the run is unmappable (`none`).

import { DecodingMode, EntityDecoder, htmlDecodeTree } from 'entities/decode';
import { UnitTable, type OffsetTable } from './offset-table';
import type { HtmlRun, HtmlTextOptions, LineEnding } from './types';

export type { HtmlTextOptions };

type UnitKind =
  | 'char' // one code unit, decodes to itself
  | 'pair' // a surrogate pair, kept atomic so no splice separates its halves
  | 'ref' // a character reference ending in `;`
  | 'ref-open' // a character reference without `;`: a following alphanumeric or `;` could extend it
  | 'amp' // a `&` that starts no reference; what follows it decides whether one forms
  | 'crlf' // CR LF → LF
  | 'cr' // lone CR → LF
  | 'nul' // U+0000 → '' or U+FFFD
  | 'lead'; // the newline parse5 drops after <pre>/<listing>

interface RawUnit {
  kind: UnitKind;
  /** Offset of the unit in the raw slice. */
  raw: number;
  rawLen: number;
  /** What the unit decodes to (0, 1 or 2 code units). */
  dec: string;
}

const AMP = 0x26;
const LT = 0x3c;
const CR = 0x0d;
const LF = 0x0a;
const NUL = 0x00;
const SEMI = 0x3b;

function isAsciiAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

function isAsciiAlnum(c: number): boolean {
  return isAsciiAlpha(c) || (c >= 0x30 && c <= 0x39);
}

/** parse5's own conversion of a decoded code point to string (tokenizer `_emitCodePoint`). */
function cpToString(cp: number): string {
  return cp < 0x10000 ? String.fromCharCode(cp) : String.fromCodePoint(cp);
}

/**
 * Decodes the character reference whose `&` is at raw[at], with the decoder and mode parse5 uses for text
 * (tokenizer `_startCharacterReference`: DecodingMode.Legacy outside attributes). Returns null when no
 * reference starts there, and parse5 then emits the `&` as text.
 */
function decodeReference(raw: string, at: number): { len: number; text: string } | null {
  let text = '';
  const decoder = new EntityDecoder(htmlDecodeTree, (cp) => {
    // Named references with two code points call back twice with the same `consumed`.
    text += cpToString(cp);
  });
  decoder.startEntity(DecodingMode.Legacy);
  // `consumed` counts the `&` (parse5: preprocessor.pos = entityStartPos + consumed - 1).
  let len = decoder.write(raw, at + 1);
  // The slice ends where the next token starts (a tag, or EOF), which ends a reference in parse5 too.
  if (len < 0) len = decoder.end();
  if (len <= 0 || text === '') return null;
  return { len, text };
}

/**
 * Splits a raw text slice into units, as parse5's tokenizer and tree builder decode it. Null when the
 * slice cannot be one text node's raw text: a `<` that opens a tag, comment or declaration (the range
 * spans markup, e.g. foster-parented text merged across a table tag), or adjacent NULs in foreign content
 * (parse5 folds them into one U+FFFD where browsers write one per NUL).
 */
function scanHtmlText(raw: string, opts: HtmlTextOptions = {}): RawUnit[] | null {
  const units: RawUnit[] = [];
  const n = raw.length;
  const nulReplace = opts.nul === 'replace';
  let i = 0;
  if (opts.dropLeadingNewline && n > 0) {
    // 9.2 Strategy 1: parse5 drops the first LF of the first whitespace token after <pre>/<listing>.
    // A reference that yields U+000A makes a whitespace token too, so it is dropped the same way.
    const c = raw.charCodeAt(0);
    if (c === CR && raw.charCodeAt(1) === LF) i = 2;
    else if (c === CR || c === LF) i = 1;
    else if (c === AMP) {
      const ref = decodeReference(raw, 0);
      if (ref !== null && ref.text === '\n') i = ref.len;
    }
    if (i > 0) units.push({ kind: 'lead', raw: 0, rawLen: i, dec: '' });
  }
  while (i < n) {
    const c = raw.charCodeAt(i);
    if (c === AMP) {
      const ref = decodeReference(raw, i);
      if (ref !== null) {
        const kind: UnitKind = raw.charCodeAt(i + ref.len - 1) === SEMI ? 'ref' : 'ref-open';
        units.push({ kind, raw: i, rawLen: ref.len, dec: ref.text });
        i += ref.len;
      } else {
        units.push({ kind: 'amp', raw: i, rawLen: 1, dec: '&' });
        i += 1;
      }
      continue;
    }
    if (c === CR) {
      // 9.2 rule 4: CRLF and lone CR become LF; the raw spelling is never normalized.
      if (raw.charCodeAt(i + 1) === LF) {
        units.push({ kind: 'crlf', raw: i, rawLen: 2, dec: '\n' });
        i += 2;
      } else {
        units.push({ kind: 'cr', raw: i, rawLen: 1, dec: '\n' });
        i += 1;
      }
      continue;
    }
    if (c === NUL) {
      if (nulReplace) {
        if (raw.charCodeAt(i + 1) === NUL) return null;
        units.push({ kind: 'nul', raw: i, rawLen: 1, dec: '\uFFFD' });
      } else {
        units.push({ kind: 'nul', raw: i, rawLen: 1, dec: '' });
      }
      i += 1;
      continue;
    }
    if (c === LT) {
      // In the data state `<` followed by a letter, `/`, `!` or `?` starts markup, never text.
      const d = raw.charCodeAt(i + 1);
      if (isAsciiAlpha(d) || d === 0x2f || d === 0x21 || d === 0x3f) return null;
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = raw.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        units.push({ kind: 'pair', raw: i, rawLen: 2, dec: raw.slice(i, i + 2) });
        i += 2;
        continue;
      }
    }
    units.push({ kind: 'char', raw: i, rawLen: 1, dec: raw[i] });
    i += 1;
  }
  return units;
}

/**
 * Decodes a raw HTML text slice the way parse5 builds a text node from it (see scanHtmlText). Null when the
 * slice is not plain text. Use it to check a planned splice before writing (9.2 Write protocol).
 */
export function decodeHtmlText(raw: string, opts: HtmlTextOptions = {}): string | null {
  const units = scanHtmlText(raw, opts);
  if (units === null) return null;
  let out = '';
  for (const u of units) out += u.dec;
  return out;
}

/** A verified decoded-to-raw table for one HTML text run. */
export interface HtmlTextTable extends OffsetTable {
  /**
   * Raw characters before decoded index 0 that decode to nothing and must stay first: the newline parse5
   * drops after <pre>/<listing>. toRaw(0) === prefix, so an insertion at the start goes after it.
   */
  readonly prefix: number;
  /** Raw length of the slice the table was built over. */
  readonly rawLength: number;
  /** The raw text spells a U+00A0 as a character reference (`&nbsp;`, `&#160;`, …) somewhere. */
  readonly usesNbspRef: boolean;
  /** True if decoded index i starts a unit (or i === length). */
  isUnitBoundary(i: number): boolean;
}

class HtmlTable implements HtmlTextTable {
  readonly usesNbspRef: boolean;

  constructor(
    private readonly inner: UnitTable,
    readonly prefix: number,
    /** Units with decLen > 0 or dropped NULs, in order, excluding the leading newline. */
    readonly units: readonly RawUnit[],
    /** Decoded start index of each unit in `units`. */
    readonly decStarts: readonly number[],
  ) {
    this.usesNbspRef = units.some((u) => (u.kind === 'ref' || u.kind === 'ref-open') && u.dec === '\u00A0');
  }

  get length(): number {
    return this.inner.length;
  }

  get rawLength(): number {
    return this.prefix + this.inner.rawLength;
  }

  toRaw(i: number): number {
    return this.prefix + this.inner.toRaw(i);
  }

  widen(start: number, end: number): { start: number; end: number } {
    return this.inner.widen(start, end);
  }

  isUnitBoundary(i: number): boolean {
    return this.inner.isUnitBoundary(i);
  }

  /** Index into `units` of the unit that holds decoded index i (i < length), skipping dropped units. */
  unitAt(i: number): number {
    let lo = 0;
    let hi = this.units.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.decStarts[mid] <= i) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    // Dropped units (dec '') share a decoded start with the next unit: step to the one that has text.
    while (found >= 0 && found < this.units.length && this.units[found].dec === '') found++;
    return found < this.units.length ? found : -1;
  }
}

/**
 * Builds the decoded-to-raw table of one HTML text node: `raw` is src sliced at the node's source range,
 * `decoded` its parse5 value. Returns null when they cannot be aligned unit by unit, or when the table
 * fails its own check; the run is then unmappable (9.2 Strategy 1, "When unsure, refuse").
 */
export function htmlTextTable(raw: string, decoded: string, opts: HtmlTextOptions = {}): HtmlTextTable | null {
  const units = scanHtmlText(raw, opts);
  if (units === null) return null;
  let prefix = 0;
  let first = 0;
  if (units.length > 0 && units[0].kind === 'lead') {
    prefix = units[0].rawLen;
    first = 1;
  }
  const inner = new UnitTable();
  const kept: RawUnit[] = [];
  const decStarts: number[] = [];
  let d = 0;
  for (let k = first; k < units.length; k++) {
    const u = units[k];
    if (u.dec.length > 0 && decoded.slice(d, d + u.dec.length) !== u.dec) return null;
    kept.push(u);
    decStarts.push(d);
    inner.push(u.dec.length, u.rawLen);
    d += u.dec.length;
  }
  if (d !== decoded.length) return null;
  inner.finish();
  const table = new HtmlTable(inner, prefix, kept, decStarts);
  return verifyTable(table, raw, decoded, opts) ? table : null;
}

/**
 * Rebuilds the decoded string from raw through the table: every slice between consecutive unit
 * boundaries must decode, on its own, to the decoded characters it maps to. This checks the table, not
 * just the scan, so a bookkeeping error can never place a splice wrongly.
 */
function verifyTable(table: HtmlTable, raw: string, decoded: string, opts: HtmlTextOptions): boolean {
  if (table.rawLength !== raw.length) return false;
  // Index 0 starts right after the dropped newline (a raw slice that decodes to nothing has only an end).
  if (table.length > 0 && table.toRaw(0) !== table.prefix) return false;
  const segOpts: HtmlTextOptions = { nul: opts.nul };
  let rebuilt = '';
  let prev = 0;
  for (let i = 1; i <= table.length; i++) {
    if (!table.isUnitBoundary(i)) continue;
    const a = table.toRaw(prev);
    const b = table.toRaw(i);
    if (b < a) return false;
    const seg = decodeHtmlText(raw.slice(a, b), segOpts);
    if (seg === null || seg !== decoded.slice(prev, i)) return false;
    rebuilt += seg;
    prev = i;
  }
  // Raw characters after the last decoded character (a trailing dropped NUL) must decode to nothing.
  const tail = decodeHtmlText(raw.slice(table.toRaw(table.length)), segOpts);
  if (tail !== '') return false;
  return rebuilt === decoded;
}

/** Rebuilds a Strategy 1 run's table from src (for the patcher and the verify step). */
export function htmlRunTable(src: string, run: Pick<HtmlRun, 'start' | 'end' | 'value' | 'textOpts'>): HtmlTextTable | null {
  return htmlTextTable(src.slice(run.start, run.end), run.value, run.textOpts ?? {});
}

export interface EncodeHtmlTextOptions {
  /** Write U+00A0 as `&nbsp;` (only when the original run used a reference for it; 9.2 Strategy 1 step 5.2). */
  nbspAsRef: boolean;
  /** The file's line ending, for any LF in the text (9.2 rule 4). Default LF. */
  lineEnding?: LineEnding;
}

/**
 * Encodes new text for an HTML text run (9.2 Strategy 1 step 5.2): `&` → `&amp;`, `<` → `&lt;`, U+00A0 →
 * `&nbsp;` when nbspAsRef. A line break is written with the file's line ending, and a CR as `&#13;`
 * (a raw CR would parse as LF). U+0000 cannot be written as HTML text; callers check the result with
 * decodeHtmlText.
 */
export function encodeHtmlText(text: string, opts: EncodeHtmlTextOptions): string {
  const nl = opts.lineEnding ?? '\n';
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep: string | null = null;
    if (c === AMP) rep = '&amp;';
    else if (c === LT) rep = '&lt;';
    else if (c === 0xa0 && opts.nbspAsRef) rep = '&nbsp;';
    else if (c === LF && nl !== '\n') rep = nl;
    else if (c === CR) rep = '&#13;';
    if (rep !== null) {
      out += text.slice(from, i) + rep;
      from = i + 1;
    }
  }
  return out + text.slice(from);
}

export interface HtmlTextSplice {
  /** Raw range relative to the run's raw slice. start === end is a pure insertion. */
  start: number;
  end: number;
  /** Encoded replacement. Empty for a pure deletion. */
  text: string;
}

export interface PlanHtmlTextEditArgs {
  /** The run's raw slice (src.slice(run.start, run.end)). */
  raw: string;
  /** The run's decoded value before the edit, and the value it must hold after. */
  before: string;
  after: string;
  opts?: HtmlTextOptions;
  nbspAsRef: boolean;
  lineEnding?: LineEnding;
  /** The changed span (edit-cleanup's changedSpan); computed from common prefix and suffix when absent. */
  span?: { start: number; endBefore: number; endAfter: number };
}

/**
 * Plans the minimal raw splice for an HTML text edit (9.2 Strategy 1 step 5): map the changed span through
 * the table, widening it so neither end is inside a reference, CRLF or surrogate pair; encode the new
 * characters; splice only that range, so untouched references keep their spelling.
 *
 * A reference without `;` and a bare `&` are open on their right: new text after them can change how they
 * decode (`&not` + `in;` reads `&notin;`). The plan is checked by decoding the spliced run; when that fails,
 * the span is widened back over such a unit, which is then re-encoded (`¬`, `&amp;`), and checked again.
 * Returns null when no splice reproduces `after`: the edit becomes `verbatim`.
 */
export function planHtmlTextEdit(args: PlanHtmlTextEditArgs): HtmlTextSplice | null {
  const opts = args.opts ?? {};
  const table = htmlTextTable(args.raw, args.before, opts);
  if (table === null) return null;
  const { before, after } = args;
  const span = args.span ?? commonSpan(before, after);
  if (
    span.start < 0 ||
    span.start > span.endBefore ||
    span.start > span.endAfter ||
    span.endBefore > before.length ||
    span.endAfter > after.length ||
    before.slice(0, span.start) !== after.slice(0, span.start) ||
    before.slice(span.endBefore) !== after.slice(span.endAfter)
  ) {
    return null;
  }
  const w = table.widen(span.start, span.endBefore);
  const attempt = (a: number, b: number): HtmlTextSplice | null => {
    // Same suffix length on both sides: after-index = before-index + (endAfter - endBefore).
    const afterEnd = b + (span.endAfter - span.endBefore);
    const text = encodeHtmlText(after.slice(a, afterEnd), { nbspAsRef: args.nbspAsRef, lineEnding: args.lineEnding });
    const start = table.toRaw(a);
    const end = table.toRaw(b);
    const next = args.raw.slice(0, start) + text + args.raw.slice(end);
    return decodeHtmlText(next, opts) === after ? { start, end, text } : null;
  };
  const first = attempt(w.start, w.end);
  if (first !== null) return first;
  const back = openUnitBefore(table, w.start);
  if (back === null || back >= w.start) return null;
  return attempt(back, w.end);
}

/** Common prefix and suffix of two strings, as a changed span. */
function commonSpan(a: string, b: string): { start: number; endBefore: number; endAfter: number } {
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  return { start: p, endBefore: a.length - s, endAfter: b.length - s };
}

/**
 * The decoded start of the open unit that new text at decoded index i could extend: a reference without
 * `;` ending at i, or a bare `&` followed only by reference-name characters up to i. Null if none.
 */
function openUnitBefore(table: HtmlTextTable, i: number): number | null {
  const t = table as HtmlTable;
  if (i <= 0) return null;
  let k = t.unitAt(i - 1);
  if (k < 0) return null;
  if (t.units[k].kind === 'ref-open') return t.decStarts[k];
  // Walk back over the characters a reference name can hold (`#`, `x`, digits and letters).
  while (k >= 0) {
    const u = t.units[k];
    if (u.kind === 'amp') return t.decStarts[k];
    if (u.kind === 'nul' && u.dec === '') {
      k--;
      continue;
    }
    if (u.kind !== 'char') return null;
    const c = u.dec.charCodeAt(0);
    if (!isAsciiAlnum(c) && c !== 0x23) return null;
    k--;
  }
  return null;
}
