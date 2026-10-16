// Shared data model. Section 8 of SPEC.md, verbatim where the spec gives a type.
// Every offset is a UTF-16 code-unit index into the decoded file string (9.2), never a byte offset.

export type Status = 'draft' | 'open' | 'sent' | 'working' | 'done' | 'question' | 'accepted' | 'reopened';

export interface Person {
  id: string; // slug of name (a-z0-9-, max 35) + '-' + 4 random [a-z0-9]
  name: string;
  color: string; // ^#[0-9a-f]{6}$
}

export type SlideNavKind = 'hash' | 'reveal' | 'index' | 'scroll' | 'none';

export interface SlideRef {
  index: number | null; // position in the detected slide list
  id: string | null; // element id or hash, if any
  title: string | null; // first heading text, trimmed to 80 chars
  nav: { kind: SlideNavKind; value: string | number | [number, number] };
}

export type Selector =
  | { type: 'blueline:Stamp'; value: string; sha256: string } // deck version the stamp was issued on
  | { type: 'CssSelector'; value: string }
  | { type: 'TextQuoteSelector'; exact: string; prefix: string; suffix: string } // 32 chars each side
  | { type: 'TextPositionSelector'; start: number; end: number }; // over visible text nodes

export type Strategy = 'html-text' | 'script-literal' | 'json-literal' | 'agent';
export type Confidence = 'exact' | 'ambiguous' | 'none';

export interface SourceLoc {
  file: string; // relative to the deck's directory; v1: always the deck itself
  version: string; // sha256 of the file these offsets index
  start: number;
  end: number; // UTF-16 code-unit indices into the decoded file string; never byte offsets
  line: number;
  col: number; // both 1-based; col in UTF-16 code units
  strategy: Strategy;
  confidence: Confidence;
  candidates?: { start: number; end: number; line: number; context: string; keyWarning?: string }[];
}

export type TargetRole = 'heading' | 'paragraph' | 'list-item' | 'image' | 'chart' | 'card' | 'element';

export interface Target {
  ref: string; // 't1', 't2'… referenced by marks
  selectors: Selector[]; // tried in order when re-anchoring (9.3)
  pending?: boolean; // brought in from a received copy, not yet re-anchored
  state?: { click?: string[]; hover?: string }; // CSS selectors to click/hover to reveal it
  source?: SourceLoc;
  box: { x: number; y: number; w: number; h: number }; // mark's box relative to the target's bounding box (0..1)
  role: TargetRole | string;
  text?: string; // visible text, trimmed to 300 chars
  html?: string; // outerHTML, trimmed to 2 KB
}

export type MarkTool = 'pen' | 'highlighter' | 'arrow' | 'pin' | 'box';
export type MarkShape = 'ellipse' | 'freehand' | 'underline' | 'strike' | 'rect';

export interface Mark {
  n: number; // ①, ②… within the note
  tool: MarkTool;
  shape?: MarkShape;
  path?: string; // SVG path in page coordinates at creation (SvgSelector-compatible)
  targets: string[]; // Target.ref values; arrows: [tail, head]
  t?: number; // reserved for later deictic binding; unused in v1
}

export interface Recording {
  id: string;
  author: string; // speaker, Person.id
  source: 'attached' | 'recorded' | 'received';
  mime: string;
  file: string; // audio/<noteId>-r<k>.<ext> in the file's app-data folder
  durationMs: number;
  transcript?: string;
  words?: { w: string; start: number; end: number }[];
  stt?: { provider: string; model: string; at: string };
}

export type NoteKind = 'markup' | 'verbatim' | 'edit';

export interface Note {
  id: string; // 'n-0007', or 'anna-x7k2:n-0003' after bringing in
  kind: NoteKind;
  status: Status;
  author: string; // Person.id
  createdAt: string;
  updatedAt: string;
  pass: number | null;
  slide: SlideRef;
  targets: Target[];
  marks: Mark[];
  text: string; // what the author typed or dictated: the authority
  instruction?: string;
  verbatim?: { before: string; after: string };
  recordings: Recording[]; // always present, empty until Phase 5
  shots?: { slide: string; crop: string; approximate?: boolean };
  thread: { from: 'agent' | string; text: string; at: string }[];
  summary?: string;
}

export interface LockedSpan {
  start: number;
  end: number;
  text: string;
  noteId: string;
  state: 'ok' | 'violated';
  change?: { before: string; after: string };
}

export interface Session {
  version: 2;
  deck: { path: string; realpath: string; fileKey: string; sha256: string; title: string }; // sha256 excludes the notes block
  people: Person[];
  notes: Note[];
  locked: LockedSpan[];
  passes: { n: number; sentAt: string; acceptedAt?: string; commit?: string; snapshot: string }[];
  tombstones: string[];
  deckNav?: { forward: string; back: string };
  viewport?: { w: number; h: number; dpr: number };
  settings?: { inkFilter?: 'open' | 'all' | 'none'; smartPunctuation?: boolean; restatement?: boolean };
}

// ---------------------------------------------------------------------------------------------
// Source map (9.2). Built by the mapper in main (or the CLI) from the decoded file string.
// ---------------------------------------------------------------------------------------------

export type LineEnding = '\n' | '\r\n' | '\r';

/** Strategy 1 run: one non-whitespace direct child text node of a stamped element. */
export interface HtmlRun {
  /** `h:<stamp>:<textIndex>`, e.g. `h:bl-12:0`. Stable for a given file version. */
  id: string;
  strategy: 'html-text';
  /** `bl-<n>`: the stamp of the element that holds this text node as a direct child. */
  stamp: string;
  tagName: string;
  /** Index among the element's direct child text nodes that are not whitespace-only. */
  textIndex: number;
  /** Raw range in src (the text node's source range). */
  start: number;
  end: number;
  /** Decoded value: exactly what the DOM text node's `data` holds after parsing. */
  value: string;
  line: number;
  col: number;
  /** True when the decoded-to-raw table verified; false makes the run unmappable (`none`). */
  aligned: boolean;
  /** True when the raw run spells a U+00A0 as `&nbsp;` somewhere (encode rule, 9.2 Strategy 1 step 5). */
  usesNbspRef: boolean;
  /**
   * Added by core-mapper: how this run's raw text decodes, for rebuilding its decoded-to-raw table
   * (`htmlRunTable` in html-tables.ts). Absent fields take the defaults.
   */
  textOpts?: HtmlTextOptions;
}

/**
 * Added by core-mapper. The parse5 rules that make a text node's value differ from a plain decode of its
 * raw slice (9.2 rule 4, Strategy 1 step 5).
 */
export interface HtmlTextOptions {
  /**
   * The text node is the first child of a `<pre>` or `<listing>` and starts right after its start tag: the
   * parser drops one leading newline (LF, CR, CRLF or a reference to U+000A), which stays in the raw range.
   */
  dropLeadingNewline?: boolean;
  /**
   * A raw U+0000: dropped in HTML content (`'drop'`, the default), U+FFFD in SVG or MathML content
   * (`'replace'`).
   */
  nul?: 'drop' | 'replace';
}

/**
 * Added by core-mapper: everything buildServedCopy changes in src, computed by buildMap from the same
 * parse, so the served copy's stamps agree with the map's runs. All offsets index src.
 */
export interface ServedPlan {
  /** src.length when the plan was made (a guard against applying it to another string). */
  srcLength: number;
  /** ` data-bl-e="<stamp>"` goes at `offset`, right after the raw tag name (9.2 Strategy 1 step 3). Sorted. */
  stamps: { offset: number; stamp: string }[];
  /** Ranges of `data-bl-e` attributes already in the source, removed from every served copy. Sorted. */
  strip: { start: number; end: number }[];
  /**
   * Protected view only (9.9): attribute rewrites that remove `dns-prefetch`, `preconnect`, `prefetch` and
   * `prerender` from `<link rel>` and neutralise `<meta http-equiv="x-dns-prefetch-control">`. Sorted.
   */
  hints: { start: number; end: number; text: string }[];
}

/** Strategy 2 unit: one JS string literal, one untagged template literal, or one JSON string value. */
export interface LiteralUnit {
  index: number;
  kind: 'string' | 'template' | 'json-string';
  /** `'`, `"` or `` ` `` for JS; always `"` for JSON. */
  quote: "'" | '"' | '`';
  /** Raw range of the literal's content, inside the quotes (for templates: from after `` ` `` to before the closing `` ` ``). */
  start: number;
  end: number;
  /** Cooked value. Templates: quasis joined with U+E000 in place of each `${…}`. */
  cooked: string;
  /** Index into DeckMap.scripts of the <script> that holds this literal. */
  scriptIndex: number;
  /**
   * True if the cooked value holds markup: it contains `<` and its parse5 fragment parse is not one text node
   * equal to the whole value (an element, a character reference, a comment or another tag is in it). Its runs
   * are then the fragment's text nodes. A `<` that starts no markup ('Latency <5 ms') leaves the unit a plain
   * literal, which the page may show through textContent, so an edit that adds `<` or `&` to it is verbatim
   * (9.2 Strategy 2 step 5.1; review finding 5, decision D-d).
   */
  html: boolean;
  /** False if a cooked-to-raw table could not be built (then all its runs are `none`). */
  aligned: boolean;
  /**
   * Templates only (added by core-literals): raw ranges in src of each `${…}` substitution, from the `$`
   * to just after its `}`. Each is one atomic unit of the cooked-to-raw table that cooks to U+E000
   * (jsLiteralTable's `placeholders` option, relative to `start`).
   */
  placeholders?: { start: number; end: number }[];
}

/** Strategy 2 run: a whole non-HTML unit, or one text node of an HTML unit. */
export interface LiteralRun {
  /** `l:<unitIndex>:<runIndex>`. */
  id: string;
  strategy: 'script-literal' | 'json-literal';
  unit: number;
  runIndex: number;
  /** Raw range in src that holds this run (inside the literal). */
  start: number;
  end: number;
  /** The run's text as the page would show it (decoded text node value for HTML units, else cooked). */
  value: string;
  /** Contains the U+E000 placeholder: pin-only (section 7). */
  placeholder: boolean;
  html: boolean;
  line: number;
  col: number;
  /**
   * Added by core-literals. False when the run's raw mapping could not be built (its unit is unaligned,
   * or the HTML text table of an HTML run failed), and for a shadow run (the HTML-decoded text of a
   * literal without `<` that contains a character reference, as innerHTML would show it): the run still
   * counts for uniqueness but is never `exact`. extractLiterals always sets it; absent is read as true.
   */
  aligned?: boolean;
}

export interface ScriptInfo {
  index: number;
  /** Raw range of the whole <script>…</script> element. */
  start: number;
  end: number;
  /** Raw range of the script's text content. */
  contentStart: number;
  contentEnd: number;
  /** Lowercased type attribute, or '' when absent. */
  type: string;
  hasSrc: boolean;
  /** 'classic' | 'module' | 'json' | 'other' (other = data block that is neither JS nor JSON, ignored). */
  kind: 'classic' | 'module' | 'json' | 'other';
  /** False when acorn (or the JSON tokenizer) failed: every literal in it is `none`. */
  parsed: boolean;
}

export interface DeckMap {
  /** sha256 (hex) of the file bytes this map was built from. Supplied by the caller (core has no crypto). */
  version: string;
  /** False when the file failed the fatal UTF-8 decode: read-only, no stamps, every node `none` (`not-utf8`). */
  utf8: boolean;
  bom: boolean;
  lineEnding: LineEnding;
  /** The trailing notes block (section 8, Notes inside the file), or null. Removed before mapping. */
  notesBlock: { start: number; end: number } | null;
  stampCount: number;
  runs: HtmlRun[];
  units: LiteralUnit[];
  literals: LiteralRun[];
  scripts: ScriptInfo[];
  /**
   * Attribute values of id, class (whole value and each token), name, for, href and data-* attributes (9.2,
   * ambiguity by key), then object keys that are not units: JSON object keys, identifier keys of JS object
   * literals and class fields, non-computed member names (`o.X`, `o?.X`, `this.X`, read or written) and
   * identifier keys of object patterns (`const { X } = o`) (mapper-literals: a deck can render a key as text,
   * and code that reads a key by name breaks when it is renamed). Each value once.
   */
  keyValues: string[];
  /**
   * The same values with where they occur, for the key warning "also used as a key at deck.html:<line>".
   * `attr` is the attribute name, or 'json key' / 'object key' / 'member name' / 'destructuring key'.
   */
  keys: { value: string; attr: string; line: number }[];
  /** parse5 parse errors of the source (code and raw offset), for "no new parse errors" (9.2 Verify). */
  parseErrors: { code: string; offset: number }[];
  /** Added by core-mapper: the served copy's edits (stamps, stripped `data-bl-e`, resource hints). buildMap always sets it. */
  served?: ServedPlan;
  /**
   * Shadow values (review findings 0, 1 and 3, decision D-a): text the page may show that Blueline never
   * writes. A literal equal to one is not the only source of its text, so it is never `exact` (9.2 Strategy 2
   * step 3, "that run occurs once in the file"); shadows are never candidates and never written. In source
   * order where there is one; buildMap always sets it (empty for a deck that is not UTF-8). Never taken from
   * the notes block.
   */
  shadows?: ShadowValue[];
}

/**
 * Where a shadow value comes from (DeckMap.shadows):
 *   - `template`: a text node of document `<template>` content (nested templates too);
 *   - `raw-text`: the text of a SKIP_TEXT element (title, textarea, style, noscript, xmp, iframe, noembed,
 *     noframes, plaintext; SVG/MathML title too) and, when it holds `<`, its fragment's text nodes;
 *   - `dropped-run`: Strategy 1 text the walk does not record as a run (a text index held by two parser
 *     clones, Noah's Ark groups, groups that cannot be stamped, every text of a deck with a stripped stamp on
 *     a Noah's Ark element, text after the notes block);
 *   - `invented-parent`: text directly under an element the parser invented (no location, 9.2 Strategy 1 step 4);
 *   - `script-data`: the text of an inline script that is neither JS nor JSON (text/x-template, text/babel,
 *     application/ld+json, SVG script, …), its fragment's text nodes when it holds `<`, and the strings and
 *     numbers in it when it parses as JS;
 *   - `tagged-template`: the quasis of a tagged template (cooked, and raw when different), and the pieces of
 *     its fragment's text nodes between substitutions when it holds `<`;
 *   - `attribute`: the value of every attribute of every element (not only key attributes), and the text
 *     nodes of its fragment parse when it holds `<` (iframe srcdoc, HTML tooltips);
 *   - `event-handler`: string literals and template quasis inside an inline `on*` attribute;
 *   - `number`: String(n), the negated form when written `-n`, and n.toLocaleString('en-US') of every numeric
 *     literal and numeric key in inline JS and event handlers, and of every number in JSON blocks;
 *   - `repeated-number`: the value of a literal run made only of digits and number punctuation that does not
 *     occur exactly once in the decoded file (notes block excluded): such text is exact only if the literal is
 *     the only place it occurs (review finding 3). It depends on the whole file, so verify ignores it.
 */
export type ShadowKind =
  | 'template'
  | 'raw-text'
  | 'dropped-run'
  | 'invented-parent'
  | 'script-data'
  | 'tagged-template'
  | 'attribute'
  | 'event-handler'
  | 'number'
  | 'repeated-number';

export interface ShadowValue {
  value: string;
  /** A ShadowKind. */
  kind: string;
  /** Raw offset in src where the text (or the attribute, script or literal that holds it) starts, when cheap. */
  start?: number;
  /** 1-based line of `start`. */
  line?: number;
}

/** What the overlay needs from the map (sent over IPC; 9.2 Matching DOM to source at runtime). */
export interface ClientMap {
  version: string;
  utf8: boolean;
  runs: Pick<HtmlRun, 'id' | 'stamp' | 'textIndex' | 'value' | 'aligned'>[];
  /**
   * `strategy` and `aligned` were added by core-literals so the overlay's matcher can report
   * `json-literal` and refuse unaligned runs; toClientMap should copy both. Absent strategy is read as
   * `script-literal`, absent aligned as true.
   */
  literals: (Pick<LiteralRun, 'id' | 'value' | 'placeholder' | 'html'> & Partial<Pick<LiteralRun, 'strategy' | 'aligned'>>)[];
  keyValues: string[];
  /**
   * DeckMap.shadows' values, each once (D-a): a literal equal to one is never `exact`. toClientMap always
   * sets it; absent is read as empty (hand-built maps).
   */
  shadowValues?: string[];
}

// ---------------------------------------------------------------------------------------------
// Matching (9.2 "Matching DOM to source at runtime", Strategy 2 "Matching").
// ---------------------------------------------------------------------------------------------

/** A DOM text node as the overlay or the walker describes it. */
export interface DomTextNode {
  /** `data-bl-e` of the node's parent element, or null. */
  stamp: string | null;
  /** Index among the parent's direct child text nodes that are not whitespace-only. */
  textIndex: number;
  /** The node's `data`. */
  data: string;
  /**
   * The `data` of every direct child text node of the node's parent element that is not whitespace-only (9.2
   * Strategy 1 step 2: U+0020, tab, LF, CR and FF; NBSP is not), in document order, as the DOM holds them now,
   * so `texts[textIndex] === data` (review finding 2, decision D-b). The matcher trusts the own stamped run
   * only while these agree with the stamp's source runs: a script that adds or removes a direct text node
   * shifts textIndex. Absent or malformed: the element cannot be checked, and matching falls through to the
   * candidate set (9.2 Matching DOM to source at runtime, step 2).
   */
  texts?: string[];
  /**
   * A script changed this node's data, or its parent's children, after the parser finished (the document
   * left readyState 'loading'). The node is then not the parser's text node for its stamp: a deck engine
   * that rewrites a slide counter or a section label on every slide leaves the source's first value in
   * place, equal by coincidence on slide 1 only. The matcher never takes the own stamped run for a touched
   * node (step 1 falls through to the candidate set); a literal can still match it.
   */
  touched?: boolean;
  /**
   * For a touched node: the stamp of its nearest ancestor element that has one (the parent included). A deck
   * that splits a heading into one span per word or letter leaves the heading stamped and its pieces
   * unstamped; a piece whose text is inside that heading's source text is a fragment, not a literal's text.
   */
  stampedAncestor?: string;
}

/**
 * Why a node is not `exact`. The first six are the spec's report reasons (section 10, Phase 0);
 * `duplicate` (several equal runs), `key` (text also used as a key) and `shadow` (the text equals a value
 * from a source Blueline never writes, DeckMap.shadows) are the remaining ambiguity reasons, and
 * `placeholder` marks template runs with `${…}` (pin-only).
 */
export type MatchReason =
  | 'computed'
  | 'multi-literal'
  | 'substring'
  | 'not-equal'
  | 'no-match'
  | 'not-utf8'
  | 'duplicate'
  | 'key'
  | 'shadow'
  | 'short'
  | 'split'
  | 'stamp-other'
  | 'unaligned'
  | 'placeholder';

export interface MatchCandidate {
  runId: string;
  strategy: Strategy;
  start: number;
  end: number;
  line: number;
  keyWarning?: string;
}

export interface MatchResult {
  confidence: Confidence;
  /** Set when confidence is `exact`. */
  runId: string | null;
  strategy: Strategy | null;
  /** All candidate runs when `ambiguous` (and the one run when `exact`). */
  candidates: MatchCandidate[];
  /** Set when confidence is not `exact`. */
  reason?: MatchReason;
}

// ---------------------------------------------------------------------------------------------
// Edits and the write protocol (9.2).
// ---------------------------------------------------------------------------------------------

export interface EditRequest {
  /** Map version (sha256) the overlay held when the edit started. */
  version: string;
  runId: string;
  /** The run's whole text before the edit (the DOM text node's data). */
  beforeText: string;
  /** The run's whole text after the edit, after the commit clean-up (core/edit-cleanup). */
  afterText: string;
}

/** One write's undo record (9.2 Undo and redo). All offsets index src; all slices are raw source. */
export interface WriteRecord {
  versionBefore: string;
  versionAfter: string;
  start: number;
  rawBefore: string;
  rawAfter: string;
  prefix: string; // 32 source characters before start
  suffix: string; // 32 source characters after start + rawBefore.length (before the write)
}

export type WriteOutcome =
  | { ok: true; record: WriteRecord; version: string; runId: string; line: number }
  | { ok: false; verbatim: { before: string; after: string }; why: string };
