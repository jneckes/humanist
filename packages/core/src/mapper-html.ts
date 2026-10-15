// Strategy 1 (9.2): parse the deck with parse5, stamp every element that has non-whitespace direct text,
// and record each such text node as a run with its raw range and decoded value. The same parse yields
// the script list for Strategy 2, the key values (9.2 Matching, ambiguity by key), the parse errors
// (9.2 Verify) and the served copy's edits (stamps, stripped data-bl-e, Protected resource hints).
//
// The served copy must parse to the same tree as the map, with each stamp on exactly the elements the map
// says. Two parser behaviours put one start tag's attributes on several elements:
//   - reconstruction and the adoption agency clone formatting elements (a, b, em, …) with the token's
//     attributes, so a stamp lands on every clone. Clones share the token's `attrs` array in parse5, so the
//     walk groups elements by it, and a (stamp, textIndex) held by two elements is not recorded at all;
//   - the Noah's Ark clause compares attributes, so adding a stamp can change which formatting elements
//     are reconstructed. The parse is instrumented to see every push onto the list of active formatting
//     elements; an element that ever shares the list with three of the same tag is never stamped.
// And parse5 8 builds a different tree from Chromium's here (each found by a differential fuzz against
// Electron 44's parser):
//   - an end tag that matches an open SVG or MathML element while an HTML element is current: parse5 pops
//     to the foreign element, the HTML spec and Chromium ignore the tag;
//   - a <select> holding tags other than option, optgroup and hr: Chromium's relaxed <select> parser keeps
//     them, parse5 drops them; <selectedcontent>, and select, option, optgroup or datalist inside SVG or
//     MathML, also parse differently.
// Everything parsed after such a point may sit elsewhere in the page, so each run that ends after the first
// one is kept (for uniqueness) but unaligned: it is never written.

import { html as P5, Parser, type DefaultTreeAdapterMap, type DefaultTreeAdapterTypes, type Token } from 'parse5';
import { htmlTextTable } from './html-tables';
import { findNotesBlockIn } from './notes-block';
import { isHtmlWhitespace, isWhitespaceOnly, type LineIndex } from './text';
import type { HtmlRun, HtmlTextOptions, ScriptInfo, ServedPlan } from './types';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;
type Template = DefaultTreeAdapterTypes.Template;
type Attr = Token.Attribute;

const NS_HTML = 'http://www.w3.org/1999/xhtml';
const NS_SVG = 'http://www.w3.org/2000/svg';
const NS_MATHML = 'http://www.w3.org/1998/Math/MathML';

/**
 * Elements whose direct text is never mapped. 9.2 Strategy 1 step 4 names script, style, template,
 * textarea and title. noscript (raw text, since decks run with scripting on), xmp, iframe, noembed,
 * noframes and plaintext are also tokenized as raw text, where `&amp;` is not a reference: encoding an edit
 * as HTML text there would be wrong, so they are refused too.
 */
const SKIP_TEXT = new Set([
  'script',
  'style',
  'template',
  'textarea',
  'title',
  'noscript',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'plaintext',
]);

/**
 * Start tags parse5 8 keeps inside <select> ("in select" insertion mode). It ignores every other tag there,
 * while Chromium's relaxed <select> parser keeps them, so the two trees differ inside such a <select>.
 */
const SELECT_CONTENT = new Set(['option', 'optgroup', 'hr', 'script', 'template']);

/** Elements whose parsing Chromium changed for customizable <select>. */
const SELECT_FAMILY = new Set(['select', 'option', 'optgroup', 'datalist']);

/** True if an SVG or MathML element is open (the parser is in or under foreign content). */
function inForeign(oe: { items: unknown[]; stackTop: number }): boolean {
  for (let i = oe.stackTop; i >= 0; i--) {
    const el = oe.items[i] as Element;
    if (el.namespaceURI !== NS_HTML) return true;
  }
  return false;
}

/** Attributes whose values count as keys (9.2 Strategy 2 Matching, ambiguity by key). */
const KEY_ATTRS = new Set(['id', 'class', 'name', 'for', 'href']);

/** Resource hints the Protected served copy removes from <link rel> (9.9 Network policy). */
const HINT_RELS = new Set(['dns-prefetch', 'preconnect', 'prefetch', 'prerender']);

/** JavaScript MIME type essences (HTML: "JavaScript MIME type essence match"). */
const JS_MIME = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
]);

export const STAMP_ATTR = 'data-bl-e';

export interface HtmlMapOptions {
  /**
   * The notes block's range in src (removed before mapping), or null. When undefined, the walk finds it in
   * its own parse (section 8) and parses again without it only if there is one.
   */
  notesBlock?: { start: number; end: number } | null;
  lines: LineIndex;
  /** False for a deck that failed UTF-8: no stamps and no runs (9.1 Charset); strips and hints still apply. */
  utf8: boolean;
}

export interface HtmlMapResult {
  /** The notes block range used (found, or as given). */
  notesBlock: { start: number; end: number } | null;
  runs: HtmlRun[];
  stampCount: number;
  scripts: ScriptInfo[];
  keys: { value: string; attr: string; line: number }[];
  keyValues: string[];
  parseErrors: { code: string; offset: number }[];
  served: ServedPlan;
}

/** ASCII lowercase only, as HTML compares names and keywords. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Strips leading and trailing ASCII whitespace (HTML "strip leading and trailing ASCII whitespace"). */
function stripAsciiWs(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isHtmlWhitespace(s.charCodeAt(a))) a++;
  while (b > a && isHtmlWhitespace(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

function splitAsciiWs(s: string): string[] {
  return s.split(/[\t\n\f\r ]+/).filter((t) => t.length > 0);
}

function isElement(n: Node): n is Element {
  return 'tagName' in n;
}

function isText(n: Node): n is TextNode {
  return n.nodeName === '#text';
}

function getAttr(el: { attrs: Attr[] }, name: string): string | null {
  for (const a of el.attrs) if (a.name === name && !a.prefix) return a.value;
  return null;
}

/** A start tag token as the tokenizer emitted it (before the tree builder adjusted names). */
interface StartTagRecord {
  tagName: string;
  /** Parse coordinates. */
  start: number;
  end: number;
  attrs: { name: string; value: string; start: number; end: number }[];
}

interface ParseResult {
  doc: DefaultTreeAdapterTypes.Document;
  tags: StartTagRecord[];
  errors: { code: string; offset: number }[];
  /** `attrs` arrays (one per start tag token) of formatting elements Noah's Ark could ever compare. */
  noahRisky: Set<Attr[]>;
  /** Parse offsets of end tags where parse5 pops a foreign element that the HTML spec would not. */
  divergences: number[];
}

/**
 * parse5.parse(text, {sourceCodeLocationInfo: true}) (9.2 Strategy 1 step 1), with two read-only probes:
 * every start tag token (so attributes the tree does not keep, such as a second <body>'s, are seen) and
 * every push onto the list of active formatting elements (Noah's Ark). Both use parse5 internals
 * (`Parser`, `onStartTag`, `activeFormattingElements`); test/unit/core/mapper-html.test.ts pins them.
 */
function instrumentedParse(text: string): ParseResult {
  const errors: { code: string; offset: number }[] = [];
  const parser = new Parser<DefaultTreeAdapterMap>({
    sourceCodeLocationInfo: true,
    onParseError: (e) => errors.push({ code: e.code, offset: e.startOffset }),
  });
  const tags: StartTagRecord[] = [];
  const onStartTag = parser.onStartTag;
  const divergences: number[] = [];
  parser.onStartTag = function (this: typeof parser, token: Token.TagToken) {
    const loc = token.location;
    // Chromium's customizable-<select> parsing (not in parse5 8) also changes <selectedcontent> anywhere,
    // and the select family inside SVG or MathML: treat both as a divergence point.
    if (loc && (token.tagName === 'selectedcontent' || (SELECT_FAMILY.has(token.tagName) && inForeign(parser.openElements)))) {
      divergences.push(loc.startOffset);
    }
    if (loc) {
      tags.push({
        tagName: token.tagName,
        start: loc.startOffset,
        end: loc.endOffset,
        attrs: token.attrs.map((a) => {
          const al = loc.attrs?.[a.name];
          return { name: a.name, value: a.value, start: al ? al.startOffset : -1, end: al ? al.endOffset : -1 };
        }),
      });
    }
    onStartTag.call(this, token);
  };
  const noahRisky = new Set<Attr[]>();
  const afe = parser.activeFormattingElements;
  const pushElement = afe.pushElement;
  afe.pushElement = function (this: typeof afe, element: Element, token: Token.TagToken) {
    // Noah's Ark compares the new element with the entries after the last marker that share its tag
    // name; with fewer than three such entries it can never fire. Attributes are ignored here on purpose:
    // stamps and stripped data-bl-e change them, so equality in one parse says nothing about the other.
    const same: Element[] = [];
    for (const entry of afe.entries) {
      if (!('element' in entry)) break; // a marker
      const el = entry.element;
      if (el.tagName === element.tagName && el.namespaceURI === element.namespaceURI) same.push(el);
    }
    if (same.length >= 3) {
      noahRisky.add(element.attrs);
      for (const el of same) noahRisky.add(el.attrs);
    }
    pushElement.call(this, element, token);
  };
  const onEndTag = parser.onEndTag;
  parser.onEndTag = function (this: typeof parser, token: Token.TagToken) {
    // parse5's "any other end tag" (genericEndTagInBody) takes the first open element with the token's tag
    // id, whatever its namespace; the spec matches HTML elements only. Flag the token when that first match
    // is foreign and an HTML element is current (otherwise parse5 handles it as foreign content, correctly).
    // Not stopping at special elements over-reports, which only refuses more.
    const oe = parser.openElements;
    if (token.location && oe.current && 'namespaceURI' in oe.current && oe.current.namespaceURI === NS_HTML) {
      for (let i = oe.stackTop; i > 0; i--) {
        const el = oe.items[i] as Element;
        if (oe.tagIDs[i] === token.tagID && (token.tagID !== P5.TAG_ID.UNKNOWN || el.tagName === token.tagName)) {
          if (el.namespaceURI !== NS_HTML) divergences.push(token.location.startOffset);
          break;
        }
      }
    }
    onEndTag.call(this, token);
  };
  parser.tokenizer.write(text, true);
  return { doc: parser.document, tags, errors, noahRisky, divergences };
}

/**
 * Attribute ranges of one start tag, tokenized as the HTML tokenizer's tag states do (before/after
 * attribute name, attribute value in its three forms, self-closing start tag). parse5 keeps the location of
 * an attribute's first occurrence only; this finds duplicates too, so no `data-bl-e` survives.
 */
function scanStartTagAttributes(src: string, start: number, end: number): { name: string; start: number; end: number }[] | null {
  const out: { name: string; start: number; end: number }[] = [];
  if (src.charCodeAt(start) !== 0x3c) return null;
  let i = start + 1;
  const isWs = (c: number) => c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (isWs(c) || c === 0x2f || c === 0x3e) break;
    i++;
  }
  let name = '';
  let attrStart = -1;
  let nameEnd = -1;
  const finish = (e: number) => {
    out.push({ name: asciiLower(name), start: attrStart, end: e });
    attrStart = -1;
  };
  type S = 'before' | 'name' | 'after' | 'beforeValue' | 'dq' | 'sq' | 'unq' | 'afterQuoted' | 'self';
  let s: S = 'before';
  while (i < end) {
    const c = src.charCodeAt(i);
    switch (s) {
      case 'before':
        if (isWs(c)) i++;
        else if (c === 0x2f) {
          s = 'self';
          i++;
        } else if (c === 0x3e) return i === end - 1 ? out : null;
        else {
          // `=` here starts a name that begins with `=` (unexpected-equals-sign-before-attribute-name).
          attrStart = i;
          name = src[i];
          i++;
          s = 'name';
        }
        break;
      case 'name':
        if (isWs(c) || c === 0x2f || c === 0x3e) {
          nameEnd = i;
          s = 'after';
        } else if (c === 0x3d) {
          nameEnd = i;
          i++;
          s = 'beforeValue';
        } else {
          name += src[i];
          i++;
        }
        break;
      case 'after':
        if (isWs(c)) i++;
        else if (c === 0x2f) {
          finish(nameEnd);
          i++;
          s = 'self';
        } else if (c === 0x3d) {
          i++;
          s = 'beforeValue';
        } else if (c === 0x3e) {
          finish(nameEnd);
          return i === end - 1 ? out : null;
        } else {
          finish(nameEnd);
          attrStart = i;
          name = src[i];
          i++;
          s = 'name';
        }
        break;
      case 'beforeValue':
        if (isWs(c)) i++;
        else if (c === 0x22) {
          i++;
          s = 'dq';
        } else if (c === 0x27) {
          i++;
          s = 'sq';
        } else if (c === 0x3e) {
          finish(i);
          return i === end - 1 ? out : null;
        } else s = 'unq';
        break;
      case 'dq':
      case 'sq':
        if (c === (s === 'dq' ? 0x22 : 0x27)) {
          i++;
          finish(i);
          s = 'afterQuoted';
        } else i++;
        break;
      case 'unq':
        if (isWs(c)) {
          finish(i);
          s = 'before';
        } else if (c === 0x3e) {
          finish(i);
          return i === end - 1 ? out : null;
        } else i++;
        break;
      case 'afterQuoted':
        if (isWs(c)) s = 'before';
        else if (c === 0x2f) {
          i++;
          s = 'self';
        } else if (c === 0x3e) return i === end - 1 ? out : null;
        else s = 'before';
        break;
      case 'self':
        if (c === 0x3e) return i === end - 1 ? out : null;
        s = 'before';
        break;
    }
  }
  return null; // ran past the tag: not the tag parse5 saw
}

/** Raw length of the tag name of the start tag at src[start] (`<` + name), or -1 if it is not one. */
function rawTagNameLength(src: string, start: number, end: number): number {
  if (src.charCodeAt(start) !== 0x3c) return -1;
  const first = src.charCodeAt(start + 1);
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) return -1;
  let i = start + 1;
  while (i < end) {
    const c = src.charCodeAt(i);
    // Tag name state ends at whitespace (CR is LF after preprocessing), `/` or `>`.
    if (c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d || c === 0x20 || c === 0x2f || c === 0x3e) break;
    i++;
  }
  return i < end ? i - start - 1 : -1;
}

/** How a NUL in this element's direct text decodes: U+FFFD in foreign content, dropped elsewhere. */
function nulMode(el: Element): 'drop' | 'replace' {
  if (el.namespaceURI === NS_SVG) {
    // HTML integration points take character tokens with the HTML rules.
    return el.tagName === 'foreignObject' || el.tagName === 'desc' || el.tagName === 'title' ? 'drop' : 'replace';
  }
  if (el.namespaceURI === NS_MATHML) {
    if (['mi', 'mo', 'mn', 'ms', 'mtext'].includes(el.tagName)) return 'drop'; // text integration points
    if (el.tagName === 'annotation-xml') {
      const enc = asciiLower(getAttr(el, 'encoding') ?? '');
      if (enc === 'text/html' || enc === 'application/xhtml+xml') return 'drop';
    }
    return 'replace';
  }
  return 'drop';
}

/** 'classic' | 'module' | 'json' | 'other', as HTML "prepare the script element" decides the type. */
function scriptKind(el: Element): { type: string; kind: ScriptInfo['kind'] } {
  const typeAttr = getAttr(el, 'type');
  const type = typeAttr === null ? '' : asciiLower(stripAsciiWs(typeAttr));
  // Script text in SVG or MathML is tokenized as markup (references decoded), so its raw text is not
  // what runs: Strategy 2 must not parse it.
  if (el.namespaceURI !== NS_HTML) return { type, kind: 'other' };
  // An empty type, or no type with no or an empty language, is classic. Otherwise the stripped type (or
  // text/<language>) must be a JavaScript MIME type essence: `type="  "` and parameters make a data block.
  const lang = getAttr(el, 'language');
  if (typeAttr === '' || (typeAttr === null && (lang === null || lang === ''))) return { type, kind: 'classic' };
  const typeString = typeAttr !== null ? type : asciiLower('text/' + lang);
  if (JS_MIME.has(typeString)) return { type, kind: 'classic' };
  if (typeString === 'module') return { type, kind: 'module' };
  if (typeString === 'application/json') return { type, kind: 'json' };
  return { type, kind: 'other' };
}

/** Rewrites a <link rel> value without resource hints; null if it has none. */
function relWithoutHints(value: string): string | null {
  const tokens = splitAsciiWs(value);
  const kept = tokens.filter((t) => !HINT_RELS.has(asciiLower(t)));
  if (kept.length === tokens.length) return null;
  return kept.join(' ');
}

/** A double-quoted attribute value in ASCII only (the served copy of a non-UTF-8 deck goes through latin1). */
function quoteAttrValue(v: string): string {
  let out = '"';
  for (const ch of v) {
    const cp = ch.codePointAt(0)!;
    if (ch === '&') out += '&amp;';
    else if (ch === '"') out += '&quot;';
    else if (cp < 0x20 || cp > 0x7e) out += '&#x' + cp.toString(16) + ';';
    else out += ch;
  }
  return out + '"';
}

interface Member {
  el: Element;
  texts: TextNode[];
}

interface Group {
  attrs: Attr[];
  members: Member[];
}

/**
 * The Strategy 1 walk over src (9.2). Offsets in the result index src; the notes block's range is removed
 * before parsing, so nothing at or after it is mapped and offsets before it are unchanged.
 */
export function mapHtmlText(src: string, opts: HtmlMapOptions): HtmlMapResult {
  // 9.2 rule 3: parse after the BOM, add it back to every offset. The notes block starts after the BOM.
  const base = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nb = opts.notesBlock;
  let parsed: ParseResult | null = null;
  if (nb === undefined) {
    parsed = instrumentedParse(base ? src.slice(1) : src);
    nb = findNotesBlockIn(parsed.doc, base);
    if (nb) parsed = null; // section 8: map the file with the block removed
  }
  const text = nb ? src.slice(0, nb.start) + src.slice(nb.end) : src;
  const nbStart = nb ? nb.start : Infinity;
  const nbLen = nb ? nb.end - nb.start : 0;
  if (parsed === null) parsed = instrumentedParse(base ? text.slice(1) : text);
  /** Parse offset → text offset. */
  const t = (o: number) => o + base;
  /** Text offset → src offset. */
  const s = (o: number) => (o < nbStart ? o : o + nbLen);

  const parseErrors = parsed.errors.map((e) => ({ code: e.code, offset: s(t(e.offset)) }));

  // ---------------------------------------------------------------- start tags: keys, strips, hints
  const keys: { value: string; attr: string; line: number }[] = [];
  const strip: { start: number; end: number }[] = [];
  const hints: { start: number; end: number; text: string }[] = [];
  for (const tag of parsed.tags) {
    const tagStart = t(tag.start);
    const tagEnd = t(tag.end);
    if (tagStart >= nbStart) continue; // nothing at or after the notes block is mapped
    for (const a of tag.attrs) {
      if (a.name === STAMP_ATTR || a.value === '') continue;
      // SVG's xlink:href is an href too.
      const name = a.name === 'xlink:href' ? 'href' : a.name;
      if (!KEY_ATTRS.has(name) && !name.startsWith('data-')) continue;
      const line = opts.lines.at(s(a.start >= 0 ? t(a.start) : tagStart)).line;
      keys.push({ value: a.value, attr: name, line });
      if (name === 'class') {
        for (const tok of splitAsciiWs(a.value)) if (tok !== a.value) keys.push({ value: tok, attr: name, line });
      }
    }
    // Every data-bl-e in the source goes, in every start tag, duplicates included (9.2 Strategy 1 step 3).
    if (/data-bl-e/i.test(text.slice(tagStart, tagEnd))) {
      const found = scanStartTagAttributes(text, tagStart, tagEnd);
      const ranges = (found ?? []).filter((a) => a.name === STAMP_ATTR);
      const first = tag.attrs.find((a) => a.name === STAMP_ATTR);
      if (first && first.start >= 0 && !ranges.some((r) => r.start === t(first.start))) {
        ranges.push({ name: STAMP_ATTR, start: t(first.start), end: t(first.end) });
      }
      for (const r of ranges) strip.push({ start: s(r.start), end: s(r.end) });
    }
    // 9.9: resource hints, removed in the Protected served copy.
    if (tag.tagName === 'link') {
      const rel = tag.attrs.find((a) => a.name === 'rel');
      const next = rel ? relWithoutHints(rel.value) : null;
      if (rel && next !== null && rel.start >= 0) {
        hints.push({ start: s(t(rel.start)), end: s(t(rel.end)), text: 'rel=' + quoteAttrValue(next) });
      }
    } else if (tag.tagName === 'meta') {
      const he = tag.attrs.find((a) => a.name === 'http-equiv');
      if (he && he.start >= 0 && asciiLower(stripAsciiWs(he.value)) === 'x-dns-prefetch-control') {
        hints.push({ start: s(t(he.start)), end: s(t(he.end)), text: '' });
      }
    }
  }
  const keyValues: string[] = [];
  const seenKeys = new Set<string>();
  for (const k of keys) {
    if (!seenKeys.has(k.value)) {
      seenKeys.add(k.value);
      keyValues.push(k.value);
    }
  }

  // ---------------------------------------------------------------- tree walk: scripts and text runs
  const scripts: ScriptInfo[] = [];
  const groups = new Map<Attr[], Group>();
  // Iterative pre-order walk: a hostile deck can nest deeply enough to exhaust the stack. `noText` marks
  // template content (inert, never stamped).
  const stack: { node: Node; noText: boolean }[] = [];
  const pushChildren = (nodes: Node[], noText: boolean) => {
    for (let k = nodes.length - 1; k >= 0; k--) stack.push({ node: nodes[k], noText });
  };
  pushChildren(parsed.doc.childNodes, false);
  const tags = parsed.tags;
  /** Parse offset after which parse5's tree may differ from Chromium's (see the header). */
  let taint = parsed.divergences.length > 0 ? Math.min(...parsed.divergences) : Infinity;
  /** True if a start tag other than SELECT_CONTENT lies inside this <select> (parse coordinates). */
  const selectDiffers = (el: Element): boolean => {
    const loc = el.sourceCodeLocation;
    if (!loc?.startTag || !loc.endTag) return true; // implicitly closed: what was inside is unclear
    const from = loc.startTag.endOffset;
    const to = loc.endTag.startOffset;
    let lo = 0;
    let hi = tags.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tags[mid].start < from) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < tags.length && tags[k].start < to; k++) if (!SELECT_CONTENT.has(tags[k].tagName)) return true;
    return false;
  };
  while (stack.length > 0) {
    const { node, noText } = stack.pop()!;
    if (!isElement(node)) continue;
    const el = node;
    const loc = el.sourceCodeLocation;
    if (el.tagName === 'select' && el.namespaceURI === NS_HTML && loc && selectDiffers(el)) taint = Math.min(taint, loc.startOffset);
    if (el.tagName === 'script' && loc && loc.startTag) {
      const start = t(loc.startOffset);
      if (start < nbStart) {
        const { type, kind } = scriptKind(el);
        const contentStart = t(loc.startTag.endOffset);
        // A script closed by EOF has no end tag, and parse5 leaves its endOffset unset (0): its text node
        // still has the right range, and the content runs to the end of it.
        let contentEnd = contentStart;
        if (loc.endTag) contentEnd = t(loc.endTag.startOffset);
        else for (const c of el.childNodes) if (c.sourceCodeLocation) contentEnd = Math.max(contentEnd, t(c.sourceCodeLocation.endOffset));
        const end = loc.endTag ? t(loc.endOffset) : contentEnd;
        scripts.push({
          index: scripts.length,
          start: s(start),
          end: s(end),
          contentStart: s(contentStart),
          contentEnd: s(contentEnd),
          type,
          hasSrc: getAttr(el, 'src') !== null,
          kind,
          parsed: false,
        });
      }
    }
    if (el.tagName === 'template' && el.namespaceURI === NS_HTML) {
      // Template content is inert and never stamped (9.2 Strategy 1 step 4); its scripts are still listed.
      pushChildren((el as Template).content.childNodes, true);
      continue;
    }
    if (!noText && !SKIP_TEXT.has(el.tagName)) {
      const texts: TextNode[] = [];
      for (const c of el.childNodes) if (isText(c) && !isWhitespaceOnly(c.value)) texts.push(c);
      if (texts.length > 0) {
        let g = groups.get(el.attrs);
        if (!g) {
          g = { attrs: el.attrs, members: [] };
          groups.set(el.attrs, g);
        }
        g.members.push({ el, texts });
      }
    }
    pushChildren(el.childNodes, noText);
  }

  // ---------------------------------------------------------------- stamps and runs
  const runs: HtmlRun[] = [];
  const stamps: { offset: number; stamp: string }[] = [];
  // Stripping a data-bl-e from an element Noah's Ark compares can change the served tree, and with it any
  // element's text: refuse every stamp (only a hand-made or hostile file has this).
  let noahStripped = false;
  for (const attrs of parsed.noahRisky) if (attrs.some((a) => a.name === STAMP_ATTR)) noahStripped = true;
  let n = 0;
  if (opts.utf8 && !noahStripped) {
    for (const g of groups.values()) {
      if (parsed.noahRisky.has(g.attrs)) continue;
      // The element the start tag made (and any reconstructed clone) has the tag's location; clones from
      // the adoption agency have none. The parser invented elements with no location at all.
      const located = g.members.filter((m) => m.el.sourceCodeLocation?.startTag);
      if (located.length === 0) continue;
      const tag = located[0].el.sourceCodeLocation!.startTag!;
      if (located.some((m) => m.el.sourceCodeLocation!.startTag!.startOffset !== tag.startOffset)) continue;
      const tagStart = t(tag.startOffset);
      const tagEnd = t(tag.endOffset);
      if (tagEnd > nbStart) continue;
      const nameLen = rawTagNameLength(text, tagStart, tagEnd);
      if (nameLen < 0) continue;
      // The insertion point is right after the raw tag name (an `<image>` token builds an <img>, and
      // foreign names are case-adjusted, so the raw spelling decides). Refuse if the name does not match.
      const rawName = asciiLower(text.slice(tagStart + 1, tagStart + 1 + nameLen));
      if (rawName !== asciiLower(located[0].el.tagName)) continue;
      // Collect texts by textIndex across the group; an index held by two elements is ambiguous.
      const byIndex = new Map<number, { m: Member; node: TextNode }[]>();
      for (const m of g.members) {
        m.texts.forEach((node, k) => {
          const list = byIndex.get(k);
          if (list) list.push({ m, node });
          else byIndex.set(k, [{ m, node }]);
        });
      }
      const pending: Omit<HtmlRun, 'id' | 'stamp'>[] = [];
      for (const k of [...byIndex.keys()].sort((a, b) => a - b)) {
        const list = byIndex.get(k)!;
        if (list.length !== 1) continue;
        const { m, node } = list[0];
        if (!m.el.sourceCodeLocation) continue; // parser-invented clone (9.2 Strategy 1 step 4)
        const run = makeRun(src, text, m.el, node, k, t, s, nbStart, nbLen, opts.lines, t(taint));
        if (run) pending.push(run);
      }
      if (pending.length === 0) continue;
      const stamp = `bl-${++n}`;
      stamps.push({ offset: s(tagStart + 1 + nameLen), stamp });
      for (const r of pending) runs.push({ ...r, id: `h:${stamp}:${r.textIndex}`, stamp });
    }
  }

  stamps.sort((a, b) => a.offset - b.offset);
  strip.sort((a, b) => a.start - b.start);
  hints.sort((a, b) => a.start - b.start);
  return {
    notesBlock: nb,
    runs,
    stampCount: n,
    scripts,
    keys,
    keyValues,
    parseErrors,
    served: { srcLength: src.length, stamps, strip: dedupeRanges(strip), hints },
  };
}

function dedupeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

function makeRun(
  src: string,
  text: string,
  el: Element,
  node: TextNode,
  textIndex: number,
  t: (o: number) => number,
  s: (o: number) => number,
  nbStart: number,
  nbLen: number,
  lines: LineIndex,
  taintFrom: number,
): Omit<HtmlRun, 'id' | 'stamp'> | null {
  const loc = node.sourceCodeLocation;
  if (!loc) return null;
  let a = t(loc.startOffset);
  const b = t(loc.endOffset);
  // parse5 8 reports a <pre>/<listing> text node's start one code unit late when the dropped leading newline
  // is followed by a character outside the BMP: the start lands on the low surrogate. A text node never
  // starts inside a surrogate pair, so step back onto the high surrogate; htmlTextTable below still checks
  // the slice against the node's value, so a wrong guess is refused, never misplaced (9.2 rule 2).
  if (a > 0 && a < b && isLowSurrogate(text.charCodeAt(a)) && isHighSurrogate(text.charCodeAt(a - 1))) a -= 1;
  if (a >= nbStart) return null; // nothing at or after the notes block is mapped
  const textOpts: HtmlTextOptions = {};
  const elLoc = el.sourceCodeLocation;
  if (
    el.namespaceURI === NS_HTML &&
    (el.tagName === 'pre' || el.tagName === 'listing') &&
    elLoc?.startTag &&
    loc.startOffset === elLoc.startTag.endOffset
  ) {
    textOpts.dropLeadingNewline = true;
  }
  const nul = nulMode(el);
  if (nul === 'replace') textOpts.nul = 'replace';
  // Text merged across the removed notes block (text right before it, whitespace after it) spans it in
  // src: it is kept for uniqueness but never written.
  const straddles = b > nbStart;
  // Text that reaches past a point where parse5 and Chromium build different trees: never written.
  const tainted = b > taintFrom;
  const table = straddles || tainted ? null : htmlTextTable(text.slice(a, b), node.value, textOpts);
  const start = s(a);
  const end = straddles ? b + nbLen : b;
  const where = lines.at(start + (table ? table.prefix : 0));
  const run: Omit<HtmlRun, 'id' | 'stamp'> = {
    strategy: 'html-text',
    tagName: el.tagName,
    textIndex,
    start,
    end,
    value: node.value,
    line: where.line,
    col: where.col,
    aligned: table !== null,
    usesNbspRef: table ? table.usesNbspRef : false,
  };
  if (textOpts.dropLeadingNewline || textOpts.nul) run.textOpts = textOpts;
  // Offsets before the notes block are the same in src and in the mapped text; a mismatch is a bug, so refuse.
  if (table && src.slice(start, end) !== text.slice(a, b)) {
    run.aligned = false;
    run.usesNbspRef = false;
  }
  return run;
}
