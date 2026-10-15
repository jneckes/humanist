// Cooked-to-raw tables and escaping for JS string literals, untagged template literals and JSON string
// values (9.2 Strategy 2 steps 4–5). Environment-neutral, no dependencies beyond the offset table.
//
// "Raw" here is the literal's source text between its quotes; "cooked" is the string value the page
// sees. Every escape sequence is one atomic unit of the table (step 4), so a splice never cuts one.

import { UnitTable } from './offset-table';

export type LiteralKind = 'string' | 'template' | 'json-string';
export type LiteralQuote = "'" | '"' | '`';

/** Stands in for each `${…}` of a template literal in its cooked value (9.2 Strategy 2 step 2). */
export const PLACEHOLDER = '\uE000';

export interface JsLiteralTableOptions {
  /**
   * Templates only: the ranges of `rawContent` that hold each `${…}` substitution, from the `$` to just
   * after the matching `}`, in source order (acorn: quasis[k].end to quasis[k + 1].start). Each one is a
   * single atomic unit that cooks to PLACEHOLDER. Without it a template must have no substitutions: an
   * unescaped `${` then makes the table fail rather than guess where the expression ends.
   */
  placeholders?: readonly { start: number; end: number }[];
  /**
   * Strings only: accept legacy octal escapes (`\1`, `\01`, `\377`, `\0` before a digit) and `\8`, `\9`,
   * which only sloppy-mode scripts allow. Default true: callers build tables for literals that acorn has
   * already accepted, so a strict-mode script never reaches here with one.
   */
  legacyOctal?: boolean;
}

/**
 * Builds the cooked-to-raw table of one literal (9.2 Strategy 2 step 4). `rawContent` is the text
 * between the quotes (for templates, between the backticks). Returns null when the raw text is not a
 * valid literal of that kind, including templates whose cooked value would be invalid (an untagged
 * template cannot have one), so the caller marks the literal unaligned (`none`) instead of guessing.
 *
 * Signature (final): jsLiteralTable(rawContent, kind, quote, opts?) with opts.placeholders for templates.
 */
export function jsLiteralTable(
  rawContent: string,
  kind: LiteralKind,
  quote: LiteralQuote,
  opts: JsLiteralTableOptions = {},
): { cooked: string; table: UnitTable } | null {
  if (kind === 'string' && quote !== "'" && quote !== '"') return null;
  if (kind === 'template' && quote !== '`') return null;
  if (kind === 'json-string' && quote !== '"') return null;
  const placeholders = kind === 'template' ? (opts.placeholders ?? []) : [];
  if (kind !== 'template' && opts.placeholders && opts.placeholders.length > 0) return null;
  const legacyOctal = opts.legacyOctal ?? true;
  const raw = rawContent;
  const n = raw.length;
  const quoteCode = quote.charCodeAt(0);
  const table = new UnitTable();
  let cooked = '';
  let ph = 0;
  let i = 0;
  while (i < n) {
    if (ph < placeholders.length) {
      const p = placeholders[ph];
      if (p.start < i) return null; // an escape swallowed the start of a substitution: ranges are wrong
      if (p.start === i) {
        // A `${…}` substitution is one atomic unit that cooks to U+E000 (task contract; 9.2 Strategy 2 step 2).
        if (p.end - p.start < 3 || p.end > n || raw.charCodeAt(i) !== 0x24 || raw.charCodeAt(i + 1) !== 0x7b) return null;
        if (raw.charCodeAt(p.end - 1) !== 0x7d) return null;
        cooked += PLACEHOLDER;
        table.push(1, p.end - p.start);
        i = p.end;
        ph++;
        continue;
      }
    }
    const c = raw.charCodeAt(i);
    if (c === 0x5c) {
      const e = readEscape(raw, i, kind, legacyOctal);
      if (e === null) return null;
      cooked += e.text;
      table.push(e.text.length, e.len);
      i += e.len;
      continue;
    }
    if (kind === 'json-string') {
      // JSON: no raw control characters and no unescaped quote (ECMA-404).
      if (c < 0x20 || c === 0x22) return null;
    } else if (kind === 'string') {
      // A raw LF or CR ends a JS string with a syntax error; U+2028/U+2029 are legal since ES2019.
      if (c === quoteCode || c === 0x0a || c === 0x0d) return null;
    } else {
      if (c === 0x60) return null;
      if (c === 0x24 && raw.charCodeAt(i + 1) === 0x7b) return null; // `${` that is not a known substitution
      if (c === 0x0d) {
        // 9.2 rule 4 / ES TV: CRLF and a lone CR in a template's raw text cook to LF. CRLF is one unit.
        const len = raw.charCodeAt(i + 1) === 0x0a ? 2 : 1;
        cooked += '\n';
        table.push(1, len);
        i += len;
        continue;
      }
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const lo = raw.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        // A surrogate pair is one atomic unit, as in the HTML tables, so no splice separates its halves.
        cooked += raw.slice(i, i + 2);
        table.push(2, 2);
        i += 2;
        continue;
      }
    }
    cooked += raw[i];
    table.push(1, 1);
    i++;
  }
  if (ph !== placeholders.length) return null;
  return { cooked, table: table.finish() };
}

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}

function hexRun(raw: string, from: number, count: number): number | null {
  if (from + count > raw.length) return null;
  for (let k = 0; k < count; k++) if (!isHex(raw.charCodeAt(from + k))) return null;
  return parseInt(raw.slice(from, from + count), 16);
}

const SINGLE: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

/** Reads the escape sequence that starts with the backslash at `i`. Returns its cooked text and raw length. */
function readEscape(raw: string, i: number, kind: LiteralKind, legacyOctal: boolean): { text: string; len: number } | null {
  if (i + 1 >= raw.length) return null; // a lone trailing backslash would escape the closing quote
  const d = raw[i + 1];
  const dc = raw.charCodeAt(i + 1);

  if (kind === 'json-string') {
    // JSON escapes: \" \\ \/ \b \f \n \r \t \uXXXX, nothing else (ECMA-404).
    if (d === '"' || d === '\\' || d === '/') return { text: d, len: 2 };
    if (d === 'b' || d === 'f' || d === 'n' || d === 'r' || d === 't') return { text: SINGLE[d], len: 2 };
    if (d === 'u') {
      const v = hexRun(raw, i + 2, 4);
      return v === null ? null : { text: String.fromCharCode(v), len: 6 };
    }
    return null;
  }

  if (d in SINGLE) return { text: SINGLE[d], len: 2 };
  if (d === 'x') {
    const v = hexRun(raw, i + 2, 2);
    return v === null ? null : { text: String.fromCharCode(v), len: 4 };
  }
  if (d === 'u') {
    if (raw.charCodeAt(i + 2) === 0x7b) {
      // \u{…}: one or more hex digits, value at most 0x10FFFF.
      let j = i + 3;
      while (j < raw.length && isHex(raw.charCodeAt(j))) j++;
      if (j === i + 3 || raw.charCodeAt(j) !== 0x7d) return null;
      const v = parseInt(raw.slice(i + 3, j), 16);
      if (!(v <= 0x10ffff)) return null;
      return { text: String.fromCodePoint(v), len: j + 1 - i };
    }
    const v = hexRun(raw, i + 2, 4);
    return v === null ? null : { text: String.fromCharCode(v), len: 6 };
  }
  // Line continuations: backslash + LF, CR, CRLF, U+2028 or U+2029 cook to nothing (one atomic unit).
  if (dc === 0x0a || dc === 0x2028 || dc === 0x2029) return { text: '', len: 2 };
  if (dc === 0x0d) return { text: '', len: raw.charCodeAt(i + 2) === 0x0a ? 3 : 2 };
  if (dc >= 0x30 && dc <= 0x39) {
    const next = raw.charCodeAt(i + 2);
    const nextIsDigit = next >= 0x30 && next <= 0x39;
    // \0 not followed by a digit is the NUL escape, valid everywhere.
    if (dc === 0x30 && !nextIsDigit) return { text: '\0', len: 2 };
    // Anything else is legacy octal or \8 \9: never valid in templates, only in sloppy strings.
    if (kind === 'template' || !legacyOctal) return null;
    if (dc === 0x38 || dc === 0x39) return { text: d, len: 2 };
    // LegacyOctalEscapeSequence, as acorn reads it: up to three octal digits, dropping the last if > 255.
    let j = i + 1;
    while (j < raw.length && j < i + 4 && raw.charCodeAt(j) >= 0x30 && raw.charCodeAt(j) <= 0x37) j++;
    let digits = raw.slice(i + 1, j);
    let v = parseInt(digits, 8);
    if (v > 255) {
      digits = digits.slice(0, -1);
      v = parseInt(digits, 8);
    }
    return { text: String.fromCharCode(v), len: 1 + digits.length };
  }
  // Identity escape (\' \" \\ \` \$ and any other character). Keep a surrogate pair whole.
  if (dc >= 0xd800 && dc <= 0xdbff) {
    const lo = raw.charCodeAt(i + 2);
    if (lo >= 0xdc00 && lo <= 0xdfff) return { text: raw.slice(i + 1, i + 3), len: 3 };
  }
  return { text: d, len: 2 };
}

function hex4(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, '0');
}

const HTML_SEQUENCES = /<(\/script|script|!--)/gi;

/**
 * Escapes text for a JS string or template literal, in the order of 9.2 Strategy 2 step 5.2:
 * `\`; the literal's quote; `${` (templates); LF, CR, tab and other C0 controls; U+2028/U+2029;
 * `</script`, `<script`, `<!--` in any case → `\x3C…`. HTML encoding (step 5.1) is the caller's job and
 * comes first.
 */
export function escapeJsText(text: string, quote: LiteralQuote, kind: 'string' | 'template'): string {
  if ((kind === 'template') !== (quote === '`')) throw new Error(`escapeJsText: quote ${quote} does not fit kind ${kind}`);
  let s = text.replace(/\\/g, '\\\\'); // 5.2.1
  s = s.split(quote).join('\\' + quote); // 5.2.2
  if (kind === 'template') s = s.replace(/\$\{/g, () => '\\${'); // 5.2.3
  s = s.replace(/[\u0000-\u001f]/g, (c) => {
    // 5.2.4
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return '\\t';
    return '\\u' + hex4(c.charCodeAt(0));
  });
  s = s.replace(/[\u2028\u2029]/g, (c) => '\\u' + hex4(c.charCodeAt(0))); // 5.2.5
  s = s.replace(HTML_SEQUENCES, (_m, rest: string) => '\\x3C' + rest); // 5.2.6
  return s;
}

/**
 * Escapes text for a JSON string value (9.2 Strategy 2 step 5.3): the quote is always `"`, `'` is never
 * escaped, control characters become `\u00XX`, and in `</script`, `<script`, `<!--` (any case) the `<`
 * becomes `<` because JSON has no `\x` escape.
 */
export function escapeJsonText(text: string): string {
  let s = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  s = s.replace(/[\u0000-\u001f]/g, (c) => '\\u' + hex4(c.charCodeAt(0)));
  s = s.replace(HTML_SEQUENCES, (_m, rest: string) => '\\u003C' + rest);
  return s;
}

/** Escapes for any literal kind: JSON values follow step 5.3, JS strings and templates step 5.2. */
export function escapeLiteralText(text: string, kind: LiteralKind, quote: LiteralQuote): string {
  return kind === 'json-string' ? escapeJsonText(text) : escapeJsText(text, quote, kind);
}

/**
 * Pre-write check for one splice inside a literal's raw content (9.2 Strategy 2 steps 4–5), for the
 * patcher. Replacing rawContent[start, end) with `insert` (already HTML-encoded and escaped) must
 *  - cook to `expectedCooked` (this catches a `$` before an inserted `{`, a digit after `\0`, …);
 *  - not form `</script`, `<script` or `<!--` (any case) across either edge of the splice, which the
 *    escaping of the inserted text alone cannot see;
 *  - not cut into a template substitution.
 * `opts.placeholders` are the substitution ranges of the content before the splice.
 */
export function checkLiteralSplice(
  rawContent: string,
  start: number,
  end: number,
  insert: string,
  kind: LiteralKind,
  quote: LiteralQuote,
  expectedCooked: string,
  opts: JsLiteralTableOptions = {},
): boolean {
  if (start < 0 || end < start || end > rawContent.length) return false;
  const delta = insert.length - (end - start);
  const shifted: { start: number; end: number }[] = [];
  for (const p of opts.placeholders ?? []) {
    if (p.end <= start) shifted.push(p);
    else if (p.start >= end) shifted.push({ start: p.start + delta, end: p.end + delta });
    else return false;
  }
  const edited = rawContent.slice(0, start) + insert + rawContent.slice(end);
  const t = jsLiteralTable(edited, kind, quote, { ...opts, placeholders: shifted });
  if (t === null || t.cooked !== expectedCooked) return false;
  const insEnd = start + insert.length;
  for (const m of edited.matchAll(HTML_SEQUENCES)) {
    const ms = m.index;
    const me = ms + m[0].length;
    // Any match that touches the inserted text, or straddles a pure deletion, was formed by the splice.
    if (ms < insEnd && me > start) return false;
  }
  return true;
}
