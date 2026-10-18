// Strategy 2 of the mapper: script and JSON literals (9.2 Strategy 2 steps 1–2 and 4).
//
// Every inline classic or module script is parsed with acorn from its raw slice of src (9.2 rule 4: never
// from a parser's text value) and walked with acorn-walk. JSON data blocks go through the
// position-tracking tokenizer below. Each string literal, untagged template literal and JSON string
// value is a unit; a unit whose cooked value contains `<` is parsed as one HTML fragment and each of its
// text nodes is a run, otherwise the whole unit is one run.
//
// Exclusions (documented deviations, all of them strings that are code rather than page text):
// directive prologues ('use strict'), module specifiers (import/export `from` sources and `import(…)`
// sources) and import attributes (`with { type: 'json' }`). Object keys, class member names and
// destructuring keys written as strings ARE units, because acorn-walk's default walker skips them and a
// key that is also shown as text must make a same-valued literal ambiguous rather than silently unique.
//
// Object keys that are not units (JSON object keys, identifier keys of JS object literals and class fields,
// non-computed member names, read or written, and identifier keys of object patterns) are returned as `keys`:
// a deck can render a key as text (Object.entries), so a literal with the same text is not the only source
// of that text, and the matcher treats it like an attribute value used as a key (9.2 Strategy 2 step 3:
// ambiguous, `key`). Without this, an edit of a label rendered from the key `"Retention"` was written into
// the value `"Retention"` elsewhere (the mutation probe on fixtures/decks/json-data.html showed it). Member
// names count because `totals.Bookings = 120` makes a key just as `{ Bookings: 120 }` does, and because a
// quoted key that code reads by name (`KPI.Retention`, `const { Retention } = KPI`) must not be renamed by a
// label edit (review finding 4, decision D-c).
//
// Shadow values (review findings 0 and 3, decision D-a; DeckMap.shadows) found here: the quasis of tagged
// templates and the text nodes of their fragments, and every number (numeric literals and keys in JS,
// number tokens in JSON). The page may show them, Blueline never writes them, and a literal equal to one is
// never `exact`. jsShadowStrings and fragmentTextValues give the Strategy 1 walk the same for event-handler
// attributes and script data blocks.

import { parse as acornParse, type AnyNode, type Node as AcornNode, type Program } from 'acorn';
import { fullAncestor, make, type RecursiveVisitors } from 'acorn-walk';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { decodeHtmlText, htmlTextTable, type HtmlTextOptions } from './html-tables';
import { jsLiteralTable, PLACEHOLDER, type LiteralKind, type LiteralQuote } from './js-literals';
import { composeTables, type OffsetTable } from './offset-table';
import { isWhitespaceOnly, type LineIndex } from './text';
import type { LiteralRun, LiteralUnit, ScriptInfo, ShadowKind } from './types';

/** A literal found in one script, before it is numbered. Offsets are relative to the script's content. */
export interface FoundLiteral {
  kind: LiteralKind;
  quote: LiteralQuote;
  /** Range of the content between the quotes. */
  start: number;
  end: number;
  /** The parser's own cooked value (acorn's node.value, quasis joined with U+E000, or JSON.parse). */
  cooked: string;
  placeholders?: { start: number; end: number }[];
}

export interface ExtractedLiterals {
  units: LiteralUnit[];
  literals: LiteralRun[];
  /** The input scripts with `parsed` set for every classic, module and JSON script. */
  scripts: ScriptInfo[];
  /**
   * Object keys that are not units, in source order: JSON object keys (`attr: 'json key'`), identifier keys
   * of JS object literals and class fields (`attr: 'object key'`), non-computed member names (`'member name'`)
   * and identifier keys of object patterns (`'destructuring key'`). Merged into DeckMap.keys.
   */
  keys: { value: string; attr: string; line: number }[];
  /** Shadow values found in the scripts (tagged templates, numbers), in source order; `start` indexes src. */
  shadows: FoundShadow[];
}

/** An object key found in one script; `start` is relative to the script's content. */
export interface FoundKey {
  value: string;
  start: number;
  attr: 'json key' | 'object key' | 'member name' | 'destructuring key';
}

/** A shadow value (DeckMap.shadows): text the page may show that is never a unit. */
export interface FoundShadow {
  value: string;
  kind: ShadowKind;
  start: number;
}

export interface Scanned {
  literals: FoundLiteral[];
  keys: FoundKey[];
  shadows: FoundShadow[];
}

/**
 * Extracts the Strategy 2 units and runs of every inline script (9.2 Strategy 2). `scripts` comes from
 * the Strategy 1 walk; scripts with `src` and `other` data blocks are passed through untouched.
 * A script that fails to parse gets `parsed: false` and contributes no units (all its text is `none`).
 */
export function extractLiterals(src: string, scripts: ScriptInfo[], lines: LineIndex): ExtractedLiterals {
  const outScripts = scripts.map((s) => ({ ...s }));
  const found: (FoundLiteral & { scriptIndex: number })[] = [];
  const foundKeys: { value: string; start: number; attr: string }[] = [];
  const shadows: FoundShadow[] = [];
  for (const s of outScripts) {
    if (s.hasSrc) continue; // a script with src never runs its inline text
    if (s.kind !== 'classic' && s.kind !== 'module' && s.kind !== 'json') continue;
    if (!(s.contentStart >= 0 && s.contentStart <= s.contentEnd && s.contentEnd <= src.length)) {
      s.parsed = false; // a range that does not fit src: refuse rather than guess (9.2 rule 2)
      continue;
    }
    const content = src.slice(s.contentStart, s.contentEnd);
    const scanned = s.kind === 'json' ? scanJson(content) : scanJs(content, s.kind === 'module' ? 'module' : 'script');
    s.parsed = scanned !== null;
    if (scanned === null) continue;
    for (const k of scanned.keys) foundKeys.push({ value: k.value, start: k.start + s.contentStart, attr: k.attr });
    for (const sh of scanned.shadows) shadows.push({ ...sh, start: sh.start + s.contentStart });
    for (const l of scanned.literals) {
      found.push({
        ...l,
        start: l.start + s.contentStart,
        end: l.end + s.contentStart,
        placeholders: l.placeholders?.map((p) => ({ start: p.start + s.contentStart, end: p.end + s.contentStart })),
        scriptIndex: s.index,
      });
    }
  }
  found.sort((a, b) => a.start - b.start);

  const units: LiteralUnit[] = [];
  const literals: LiteralRun[] = [];
  for (const f of found) {
    const index = units.length;
    const unit: LiteralUnit = {
      index,
      kind: f.kind,
      quote: f.quote,
      start: f.start,
      end: f.end,
      cooked: f.cooked,
      scriptIndex: f.scriptIndex,
      html: isHtmlLiteral(f.cooked),
      aligned: false,
    };
    if (f.placeholders && f.placeholders.length > 0) unit.placeholders = f.placeholders;
    const unitTable = buildUnitTable(src, unit);
    unit.aligned = unitTable !== null;
    units.push(unit);
    const strategy = f.kind === 'json-string' ? 'json-literal' : 'script-literal';
    for (const r of unitRuns(unit, unitTable)) {
      const loc = lines.at(r.rawStart);
      literals.push({
        id: `l:${index}:${r.runIndex}`,
        strategy,
        unit: index,
        runIndex: r.runIndex,
        start: r.rawStart,
        end: r.rawEnd,
        value: r.value,
        placeholder: r.value.includes(PLACEHOLDER),
        html: r.html,
        line: loc.line,
        col: loc.col,
        aligned: r.aligned,
      });
    }
  }
  foundKeys.sort((a, b) => a.start - b.start);
  const keys = foundKeys.map((k) => ({ value: k.value, attr: k.attr, line: lines.at(k.start).line }));
  shadows.sort((a, b) => a.start - b.start);
  return { units, literals, scripts: outScripts, keys, shadows };
}

/**
 * True if a literal's cooked value holds markup, so the page shows its fragment's text nodes when it is set
 * with innerHTML and its runs are those text nodes (9.2 Strategy 2 step 2). A `<` that starts no tag,
 * comment or other markup, with no character reference, CR or NUL in the value, parses to one text node equal
 * to the whole value: such a literal reads the same through textContent and innerHTML, and is a plain
 * literal (an edit that adds `<` or `&` becomes verbatim, step 5.1; review finding 5, decision D-d).
 * decodeHtmlText reproduces parse5's data-state decoding and returns null where `<` starts markup.
 */
export function isHtmlLiteral(cooked: string): boolean {
  return cooked.includes('<') && decodeHtmlText(cooked) !== cooked;
}

/** Rebuilds a unit's cooked-to-raw table from src and checks that it cooks to the unit's value. */
function buildUnitTable(src: string, unit: LiteralUnit): OffsetTable | null {
  const raw = src.slice(unit.start, unit.end);
  const placeholders = unit.placeholders?.map((p) => ({ start: p.start - unit.start, end: p.end - unit.start }));
  const t = jsLiteralTable(raw, unit.kind, unit.quote, { placeholders });
  // 9.2 Strategy 2 step 4: the table is only trusted when it reproduces the parser's own cooked value.
  if (t === null || t.cooked !== unit.cooked) return null;
  return t.table;
}

interface UnitRun {
  runIndex: number;
  /** The run is a text node of the literal parsed as HTML (an HTML unit's run, or a shadow run). */
  html: boolean;
  value: string;
  /** The run's range in the unit's cooked value. */
  cookedStart: number;
  cookedEnd: number;
  /** Minimal raw range in src covering the run (the whole literal when the unit is unaligned). */
  rawStart: number;
  rawEnd: number;
  /** run.value index → raw offset relative to tableBase, or null when it could not be built. */
  table: OffsetTable | null;
  /** Absolute src offset that table offsets are relative to. */
  tableBase: number;
  /** HTML runs: how parse5 decoded the text node (for decodeHtmlText checks of a planned splice). */
  textOpts: HtmlTextOptions | null;
  /** HTML runs: run.value index → offset in the cooked slice [cookedStart, cookedEnd). */
  htmlTable: OffsetTable | null;
  aligned: boolean;
}

/** The runs of one unit (9.2 Strategy 2 step 2). Whitespace-only runs are dropped, as in Strategy 1. */
function unitRuns(unit: LiteralUnit, unitTable: OffsetTable | null): UnitRun[] {
  const cooked = unit.cooked;
  const pieces: { start: number; end: number; value: string; textOpts: HtmlTextOptions | null; shadow: boolean }[] = [];
  if (!unit.html) {
    if (!isWhitespaceOnly(cooked)) pieces.push({ start: 0, end: cooked.length, value: cooked, textOpts: null, shadow: false });
    // A literal without `<` may still reach the page through innerHTML (9.2 Strategy 2 step 5.1), which
    // shows `&amp;` as `&`. That decoded text is recorded as a shadow run: never `exact` itself (unaligned),
    // but it keeps another literal or run with the same visible text from looking unique.
    if (/[&\r\0]/.test(cooked)) {
      const decoded = decodeHtmlText(cooked);
      if (decoded !== null && decoded !== cooked && !isWhitespaceOnly(decoded)) {
        pieces.push({ start: 0, end: cooked.length, value: decoded, textOpts: null, shadow: true });
      }
    }
  } else {
    const nodes = fragmentTextNodes(cooked);
    if (nodes === null) return []; // parse5 refused the fragment: nothing here can be matched
    for (const n of nodes) {
      if (!isWhitespaceOnly(n.value)) {
        pieces.push({ start: n.start, end: n.end, value: n.value, textOpts: textOptions(n), shadow: false });
      }
    }
  }
  const out: UnitRun[] = [];
  for (const p of pieces) {
    const run: UnitRun = {
      runIndex: out.length,
      html: unit.html || p.shadow,
      value: p.value,
      cookedStart: p.start,
      cookedEnd: p.end,
      rawStart: unit.start,
      rawEnd: unit.end,
      table: null,
      tableBase: unit.start,
      textOpts: p.textOpts,
      htmlTable: null,
      aligned: false,
    };
    if (unitTable !== null && p.start >= 0 && !p.shadow) {
      const w = unitTable.widen(p.start, p.end);
      run.rawStart = unit.start + unitTable.toRaw(w.start);
      run.rawEnd = unit.start + unitTable.toRaw(w.end);
      if (!unit.html) {
        run.table = unitTable;
        run.aligned = true;
      } else {
        // Text node value → cooked slice → raw (9.2 Strategy 2 step 4): character references and JS escapes
        // are both atomic in the composed table.
        const inner = htmlTextTable(cooked.slice(p.start, p.end), p.value, p.textOpts ?? {});
        if (inner !== null && inner.length === p.value.length) {
          run.table = composeTables(inner, p.start, unitTable);
          run.htmlTable = inner;
          run.tableBase = unit.start + unitTable.toRaw(p.start);
          run.aligned = true;
        }
      }
    }
    out.push(run);
  }
  return out;
}

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MATHML_NS = 'http://www.w3.org/1998/Math/MathML';
/** HTML integration points and MathML text integration points: text in them follows HTML rules. */
const SVG_HTML_POINTS = new Set(['foreignObject', 'desc', 'title']);
const MATHML_TEXT_POINTS = new Set(['mi', 'mo', 'mn', 'ms', 'mtext', 'annotation-xml']);

/** The parse5 decoding rules for one fragment text node (HtmlTextOptions, from html-tables). */
function textOptions(n: FragmentText): HtmlTextOptions {
  const opts: HtmlTextOptions = {};
  // parse5 drops one newline right after <pre> and <listing> (and <textarea>); html-tables keeps it out
  // of the decoded text only if the raw slice starts with one.
  if (n.firstChild && n.parentNs === HTML_NS && (n.parentTag === 'pre' || n.parentTag === 'listing' || n.parentTag === 'textarea')) {
    opts.dropLeadingNewline = true;
  }
  // U+0000 is dropped by HTML rules and becomes U+FFFD in foreign content. A wrong guess here only makes
  // the table fail its own check, so the run is refused, never misplaced.
  const foreign =
    (n.parentNs === SVG_NS && !SVG_HTML_POINTS.has(n.parentTag)) ||
    (n.parentNs === MATHML_NS && !MATHML_TEXT_POINTS.has(n.parentTag));
  if (foreign) opts.nul = 'replace';
  return opts;
}

/**
 * Elements whose text is code, never page text. Everything else counts, including `<template>` content,
 * `<textarea>` and `<noscript>`: a script may clone or show it, and a run that might reach the page must
 * make an equal literal ambiguous rather than leave it falsely unique.
 */
const CODE_ELEMENTS = new Set(['script', 'style']);

type P5Node = DefaultTreeAdapterTypes.Node;
type P5Parent = DefaultTreeAdapterTypes.ParentNode;

interface FragmentText {
  /** Range of the text node in the fragment source, or -1 when parse5 gave no location. */
  start: number;
  end: number;
  value: string;
  /** Parent element's local name and namespace ('' for the fragment itself). */
  parentTag: string;
  parentNs: string;
  /** The node is its parent's first child (the parser may have dropped a leading newline before it). */
  firstChild: boolean;
}

/**
 * The values of the text nodes of `html` parsed as one fragment that are not whitespace-only, in document
 * order (script and style text excluded; template content included). Empty when parse5 throws. For shadow
 * values: markup in raw text, data blocks, attributes and tagged templates that a page may parse.
 */
export function fragmentTextValues(html: string): string[] {
  const nodes = fragmentTextNodes(html);
  if (nodes === null) return [];
  return nodes.filter((n) => !isWhitespaceOnly(n.value)).map((n) => n.value);
}

/** Text nodes of `html` parsed as one fragment (9.2 Strategy 2 step 2), in document order. Null if parse5 throws. */
function fragmentTextNodes(html: string): FragmentText[] | null {
  let frag: DefaultTreeAdapterTypes.DocumentFragment;
  try {
    frag = parseFragment(html, { sourceCodeLocationInfo: true });
  } catch {
    return null;
  }
  const out: FragmentText[] = [];
  // Iterative walk: a literal may nest elements deeply, and recursion would be the page's to exhaust.
  const stack: { node: P5Node; parent: P5Parent; first: boolean }[] = [];
  const pushChildren = (parent: P5Parent, kids: P5Node[]): void => {
    for (let k = kids.length - 1; k >= 0; k--) stack.push({ node: kids[k], parent, first: k === 0 });
  };
  pushChildren(frag, frag.childNodes);
  while (stack.length > 0) {
    const { node, parent, first } = stack.pop()!;
    if (node.nodeName === '#text') {
      const t = node as DefaultTreeAdapterTypes.TextNode;
      const loc = t.sourceCodeLocation;
      const isEl = 'tagName' in parent;
      out.push({
        start: loc ? loc.startOffset : -1,
        end: loc ? loc.endOffset : -1,
        value: t.value,
        parentTag: isEl ? (parent as DefaultTreeAdapterTypes.Element).tagName : '',
        parentNs: isEl ? (parent as DefaultTreeAdapterTypes.Element).namespaceURI : HTML_NS,
        firstChild: first,
      });
      continue;
    }
    if (!('tagName' in node)) continue; // comments, doctypes
    const el = node as DefaultTreeAdapterTypes.Element;
    if (CODE_ELEMENTS.has(el.tagName)) continue;
    if (el.tagName === 'template' && el.namespaceURI === HTML_NS) {
      const content = (el as DefaultTreeAdapterTypes.Template).content;
      pushChildren(el, content.childNodes);
      continue;
    }
    pushChildren(el, el.childNodes);
  }
  return out;
}

// ------------------------------------------------------------------------------------------- JS scripts

type Visit = (node: AcornNode, state: unknown, override?: string) => void;

function visitKeyAndValue(node: AnyNode, st: unknown, c: Visit): void {
  const n = node as unknown as { key: AnyNode; value: AnyNode | null };
  // acorn-walk's base skips non-computed keys; a string key is still a string Literal (9.2 Strategy 2 step 2).
  if (n.key.type !== 'PrivateIdentifier') c(n.key, st, 'Expression');
  if (n.value) c(n.value, st, 'Expression');
}

const WALKER: RecursiveVisitors<unknown> = make<unknown>({
  Property: (node, st, c) => visitKeyAndValue(node, st, c as unknown as Visit),
  MethodDefinition: (node, st, c) => visitKeyAndValue(node, st, c as unknown as Visit),
  PropertyDefinition: (node, st, c) => visitKeyAndValue(node, st, c as unknown as Visit),
  ObjectPattern: (node, st, cb) => {
    const c = cb as unknown as Visit;
    for (const p of node.properties) {
      if (p.type === 'Property') {
        c(p.key, st, 'Expression');
        c(p.value, st, 'Pattern');
      } else {
        c(p.argument, st, 'Pattern');
      }
    }
  },
});

function isExcludedString(node: AnyNode, parent: AnyNode | undefined): boolean {
  if (!parent) return false;
  switch (parent.type) {
    case 'ExpressionStatement':
      return typeof parent.directive === 'string'; // directive prologue
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration':
    case 'ImportExpression':
      return parent.source === node; // module specifier
    case 'ImportAttribute':
      return true;
    default:
      return false;
  }
}

/**
 * A non-computed identifier key that becomes an own enumerable property name, so a deck can render it as
 * text: a key of an object literal (`{ Retention: 41 }`, shorthand and methods included) or a class field.
 * Class methods are not enumerable, so they do not count. Member names and destructuring keys are found by
 * scanJs itself (keysOf).
 */
function isIdentifierKey(node: AnyNode, parent: AnyNode | undefined, grand: AnyNode | undefined): boolean {
  if (node.type !== 'Identifier' || !parent) return false;
  if (parent.type === 'Property') return parent.key === node && !parent.computed && grand?.type === 'ObjectExpression';
  if (parent.type === 'PropertyDefinition') return parent.key === node && !parent.computed;
  return false;
}

/**
 * Member names and destructuring keys of one node (review finding 4, decision D-c): the property name of a
 * non-computed member expression (`o.X`, `o?.X`, `this.X`, `super.X`; read or written) and each identifier key
 * of an object pattern (`const { X } = o`, `({ X: y } = o)`, parameters). Private names (`#x`) are skipped.
 */
function keysOf(node: AnyNode): FoundKey[] {
  if (node.type === 'MemberExpression') {
    if (!node.computed && node.property.type === 'Identifier') return [{ value: node.property.name, start: node.property.start, attr: 'member name' }];
    return [];
  }
  if (node.type === 'ObjectPattern') {
    const out: FoundKey[] = [];
    for (const p of node.properties) {
      if (p.type === 'Property' && !p.computed && p.key.type === 'Identifier') out.push({ value: p.key.name, start: p.key.start, attr: 'destructuring key' });
    }
    return out;
  }
  return [];
}

/**
 * The texts a page may show for one number (D-a, `number`): String(n), and n.toLocaleString('en-US') (what
 * Intl.NumberFormat and toLocaleString give by default: "1,234") when it differs.
 */
function numberTexts(n: number | bigint): string[] {
  const plain = String(n);
  let grouped: string | null = null;
  try {
    grouped = n.toLocaleString('en-US');
  } catch {
    grouped = null;
  }
  return grouped !== null && grouped !== plain ? [plain, grouped] : [plain];
}

/** Number shadows of a numeric Literal (numbers, bigints, numeric keys), negated too when written `-n`. */
function numberShadows(node: AnyNode, parent: AnyNode | undefined, out: FoundShadow[]): void {
  if (node.type !== 'Literal') return;
  let n: number | bigint;
  if (typeof node.value === 'number' || typeof node.value === 'bigint') n = node.value;
  else if (typeof node.bigint === 'string') {
    try {
      n = BigInt(node.bigint);
    } catch {
      return;
    }
  } else return;
  for (const v of numberTexts(n)) out.push({ value: v, kind: 'number', start: node.start });
  if (parent && parent.type === 'UnaryExpression' && parent.operator === '-' && parent.argument === node) {
    for (const v of numberTexts(-n)) out.push({ value: v, kind: 'number', start: parent.start });
  }
}

/**
 * Shadows of a template that is never a unit (a tagged template, or any template in code that is never
 * mapped): each quasi, cooked and raw (String.raw shows the raw text), and, when the template holds `<`, the
 * pieces of its fragment's text nodes between substitutions (lit-html and htm keep them as separate text
 * nodes).
 */
function templateShadows(node: AnyNode, kind: ShadowKind, out: FoundShadow[]): void {
  if (node.type !== 'TemplateLiteral') return;
  const joined: string[] = [];
  for (const q of node.quasis) {
    const cooked = q.value.cooked;
    const raw = q.value.raw;
    if (typeof cooked === 'string' && !isWhitespaceOnly(cooked)) out.push({ value: cooked, kind, start: q.start });
    if (raw !== cooked && !isWhitespaceOnly(raw)) out.push({ value: raw, kind, start: q.start });
    joined.push(typeof cooked === 'string' ? cooked : raw);
  }
  const all = joined.join(PLACEHOLDER);
  if (!all.includes('<')) return;
  for (const t of fragmentTextValues(all)) {
    for (const piece of t.split(PLACEHOLDER)) if (!isWhitespaceOnly(piece)) out.push({ value: piece, kind, start: node.start });
  }
}

/**
 * acorn parse + walk of one script's raw text (9.2 Strategy 2 step 1). Null when either fails. Offsets only
 * (node.start/end; lines come from the LineIndex): acorn's line/column objects on every node cost a fifth of
 * the parse and were never read (review finding 31).
 */
function scanJs(content: string, sourceType: 'script' | 'module'): Scanned | null {
  let ast: Program;
  try {
    ast = acornParse(content, { ecmaVersion: 'latest', sourceType });
  } catch {
    return null;
  }
  const out: FoundLiteral[] = [];
  const keys: FoundKey[] = [];
  const shadows: FoundShadow[] = [];
  // Member names and destructuring keys are listed once per script, and not when the value is already a key
  // here: keyValues lists each value once, and a deck reads the same names many times.
  const keyNames = new Set<string>();
  try {
    fullAncestor<unknown>(
      ast,
      (node, _st, ancestors) => {
        const parent = ancestors[ancestors.length - 2];
        if (isIdentifierKey(node, parent, ancestors[ancestors.length - 3])) {
          const name = (node as unknown as { name: string }).name;
          keyNames.add(name);
          keys.push({ value: name, start: node.start, attr: 'object key' });
        } else if (node.type === 'MemberExpression' || node.type === 'ObjectPattern') {
          for (const k of keysOf(node)) {
            if (keyNames.has(k.value)) continue;
            keyNames.add(k.value);
            keys.push(k);
          }
        } else if (node.type === 'Literal') {
          if (typeof node.value !== 'string') {
            numberShadows(node, parent, shadows);
            return;
          }
          if (isExcludedString(node, parent)) return;
          const quote = content[node.start];
          if (quote !== "'" && quote !== '"') return;
          out.push({ kind: 'string', quote, start: node.start + 1, end: node.end - 1, cooked: node.value });
        } else if (node.type === 'TemplateLiteral') {
          // A tagged template (String.raw included) is not a unit (9.2 Strategy 2 step 2), but the page may
          // show its text (lit-html, htm): a shadow value (D-a).
          if (parent && parent.type === 'TaggedTemplateExpression' && parent.quasi === node) {
            templateShadows(node, 'tagged-template', shadows);
            return;
          }
          const cookedParts: string[] = [];
          for (const q of node.quasis) {
            if (typeof q.value.cooked !== 'string') return; // only possible when tagged
            cookedParts.push(q.value.cooked);
          }
          const placeholders: { start: number; end: number }[] = [];
          for (let k = 0; k + 1 < node.quasis.length; k++) {
            placeholders.push({ start: node.quasis[k].end, end: node.quasis[k + 1].start });
          }
          out.push({
            kind: 'template',
            quote: '`',
            start: node.start + 1,
            end: node.end - 1,
            cooked: cookedParts.join(PLACEHOLDER),
            placeholders,
          });
        }
      },
      WALKER,
    );
  } catch {
    // acorn-walk throws on a node type it does not know: refuse the whole script rather than miss literals.
    return null;
  }
  return { literals: out, keys, shadows };
}

/**
 * Shadow values of JS code that Blueline never maps (D-a): every string literal and template quasi (with
 * `kind`), and every number (`number`). For inline event-handler attributes (`functionBody`: the value is a
 * function body, so `return` is allowed) and script data blocks that parse as JS (SVG scripts and the like).
 * Offsets are relative to `code`. Null when acorn cannot parse it (the caller keeps the raw text alone).
 */
export function jsShadowValues(code: string, kind: ShadowKind, opts: { functionBody?: boolean } = {}): FoundShadow[] | null {
  let ast: Program | null = null;
  for (const sourceType of opts.functionBody ? (['script'] as const) : (['script', 'module'] as const)) {
    try {
      ast = acornParse(code, { ecmaVersion: 'latest', sourceType, allowReturnOutsideFunction: !!opts.functionBody });
      break;
    } catch {
      ast = null;
    }
  }
  if (ast === null) return null;
  const out: FoundShadow[] = [];
  try {
    fullAncestor<unknown>(
      ast,
      (node, _st, ancestors) => {
        const parent = ancestors[ancestors.length - 2];
        if (node.type === 'Literal') {
          if (typeof node.value === 'string') {
            if (!isWhitespaceOnly(node.value)) out.push({ value: node.value, kind, start: node.start });
          } else numberShadows(node, parent, out);
        } else if (node.type === 'TemplateLiteral') {
          templateShadows(node, kind, out);
        }
      },
      WALKER,
    );
  } catch {
    return null;
  }
  return out;
}

// ----------------------------------------------------------------------------------------- JSON blocks

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * Position-tracking JSON tokenizer (9.2 Strategy 2 step 2, JSON blocks). Strict ECMA-404 grammar, as
 * JSON.parse reads it; iterative, so nesting depth cannot exhaust the stack. Returns each string VALUE
 * (object keys are not units) with its content range, or null if the text is not valid JSON.
 */
export function scanJsonLiterals(text: string): FoundLiteral[] | null {
  return scanJson(text)?.literals ?? null;
}

/**
 * scanJsonLiterals plus the object keys (cooked), which the matcher treats as keys (module comment), and the
 * numbers as shadow values (D-a: String(n), the token as written when it differs, and the en-US grouped form).
 * Exported for script data blocks that hold JSON (application/ld+json, importmap): their strings and keys are
 * shadow values too.
 */
export function scanJson(text: string): Scanned | null {
  const out: FoundLiteral[] = [];
  const keys: FoundKey[] = [];
  const shadows: FoundShadow[] = [];
  const n = text.length;
  const stack: number[] = []; // 0 = array, 1 = object
  const ARR = 0;
  const OBJ = 1;
  let i = 0;
  // value | afterValue | key | firstInArray | firstInObject
  let state: 'value' | 'after' | 'key' | 'arr0' | 'obj0' = 'value';

  const skipWs = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  // Returns the index just after the closing quote of the string that starts at i, or -1.
  const scanString = (from: number): number => {
    let j = from + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 0x22) return j + 1;
      if (c < 0x20) return -1;
      if (c === 0x5c) {
        const d = text.charCodeAt(j + 1);
        if (d === 0x75) {
          for (let k = 2; k < 6; k++) {
            const h = text.charCodeAt(j + k);
            if (!((h >= 0x30 && h <= 0x39) || (h >= 0x41 && h <= 0x46) || (h >= 0x61 && h <= 0x66))) return -1;
          }
          j += 6;
          continue;
        }
        // \" \\ \/ \b \f \n \r \t
        if (d === 0x22 || d === 0x5c || d === 0x2f || d === 0x62 || d === 0x66 || d === 0x6e || d === 0x72 || d === 0x74) {
          j += 2;
          continue;
        }
        return -1;
      }
      j++;
    }
    return -1;
  };

  for (;;) {
    skipWs();
    if (state === 'after') {
      if (stack.length === 0) {
        if (i !== n) return null; // trailing garbage
        break;
      }
      const c = text[i];
      const top = stack[stack.length - 1];
      if (c === ',') {
        i++;
        state = top === ARR ? 'value' : 'key';
      } else if ((c === ']' && top === ARR) || (c === '}' && top === OBJ)) {
        i++;
        stack.pop();
      } else return null;
      continue;
    }
    if (state === 'arr0') {
      if (text[i] === ']') {
        i++;
        stack.pop();
        state = 'after';
      } else state = 'value';
      continue;
    }
    if (state === 'obj0') {
      if (text[i] === '}') {
        i++;
        stack.pop();
        state = 'after';
      } else state = 'key';
      continue;
    }
    if (state === 'key') {
      if (text[i] !== '"') return null;
      const e = scanString(i);
      if (e < 0) return null;
      let key: string;
      try {
        key = JSON.parse(text.slice(i, e)) as string;
      } catch {
        return null;
      }
      keys.push({ value: key, start: i + 1, attr: 'json key' });
      i = e;
      skipWs();
      if (text[i] !== ':') return null;
      i++;
      state = 'value';
      continue;
    }
    // state === 'value'
    if (i >= n) return null;
    const c = text[i];
    if (c === '{') {
      stack.push(OBJ);
      i++;
      state = 'obj0';
    } else if (c === '[') {
      stack.push(ARR);
      i++;
      state = 'arr0';
    } else if (c === '"') {
      const e = scanString(i);
      if (e < 0) return null;
      let cooked: string;
      try {
        cooked = JSON.parse(text.slice(i, e)) as string;
      } catch {
        return null;
      }
      out.push({ kind: 'json-string', quote: '"', start: i + 1, end: e - 1, cooked });
      i = e;
      state = 'after';
    } else if (c === 't' || c === 'f' || c === 'n') {
      const word = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
      if (!text.startsWith(word, i)) return null;
      i += word.length;
      state = 'after';
    } else {
      NUMBER.lastIndex = i;
      if (!NUMBER.test(text)) return null;
      const token = text.slice(i, NUMBER.lastIndex);
      const values = numberTexts(Number(token));
      if (!values.includes(token)) values.push(token);
      for (const v of values) shadows.push({ value: v, kind: 'number', start: i });
      i = NUMBER.lastIndex;
      state = 'after';
    }
  }
  // Belt and braces: the page reads the block with JSON.parse, so the grammar must agree with it.
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  return { literals: out, keys, shadows };
}

// --------------------------------------------------------------------------------- for the patcher

/** How one literal run maps to src, for the patcher (9.2 Strategy 2 steps 4–5). */
export interface LiteralRunMapping {
  /** Cooked-to-raw table of the whole unit; raw offsets are relative to unit.start. */
  unitTable: OffsetTable;
  /** The run's range in the unit's cooked value. */
  cookedStart: number;
  cookedEnd: number;
  /**
   * run.value index → raw offset relative to rawStart. For HTML runs it is the text node's decoded-to-
   * cooked table composed with the unit table, so character references and escapes are both atomic.
   */
  table: OffsetTable;
  /** Absolute src offset that `table` offsets are relative to (run.value index 0 starts at rawStart + table.toRaw(0)). */
  rawStart: number;
  /** HTML runs only: the parse5 decoding rules of the text node, for decodeHtmlText checks. Null otherwise. */
  textOpts: HtmlTextOptions | null;
  /**
   * run.value index → index in the unit's cooked value, for the expected cooked value of an edit (9.2
   * Strategy 2 step 5.4). Meaningful at unit boundaries of `table` (after widen()).
   */
  toCooked(i: number): number;
}

/**
 * Rebuilds the mapping of run `runIndex` of `unit` from the same src the map was built from. Null when
 * the unit or the run is unaligned, or the run does not exist: the edit then becomes `verbatim`.
 */
export function literalRunMapping(src: string, unit: LiteralUnit, runIndex: number): LiteralRunMapping | null {
  if (unit.start < 0 || unit.end > src.length || unit.end < unit.start) return null;
  const unitTable = buildUnitTable(src, unit);
  if (unitTable === null) return null;
  const run = unitRuns(unit, unitTable)[runIndex];
  if (!run || !run.aligned || run.table === null) return null;
  const html = run.htmlTable;
  return {
    unitTable,
    cookedStart: run.cookedStart,
    cookedEnd: run.cookedEnd,
    table: run.table,
    rawStart: run.tableBase,
    textOpts: run.textOpts,
    toCooked: (i: number) => run.cookedStart + (html === null ? i : html.toRaw(i)),
  };
}
