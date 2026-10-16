# Fixtures

| Folder | What | Committed |
|---|---|---|
| `decks/` | Synthetic and CSP fixture decks for Phase 0, and the reveal.js fixture (SPEC section 10, Corpus) | yes |
| `expected/` | Coverage baselines written by `blueline map --report --json` (SPEC section 11) | yes, for committed decks only |
| `input/` | Decks for the deck preload's input handling in the real app: key router, input guard, note card, ink (SPEC 6.2, 6.5; `input/README.md`) | yes |
| `local/` | Josh's real decks and their baselines (SPEC section 13, question 1) | no (gitignored) |
| `map/` | The review's walk and probe decks for `blueline map` (`test/e2e/map-walk.spec.ts`; see "Walk and probe decks" below) | yes |
| `matching/` | The review's matching decks: text from sources that are not runs, dropped Strategy 1 text, shifted text indexes, computed numbers, member keys, foster-parented runs (SPEC 9.2; `test/e2e/map-matching.spec.ts`; `matching/README.md`) | yes |
| `security/` | Security fixtures for the Protected-view suite (SPEC 9.9) | yes |
| `slides/` | Slide-detection decks (SPEC 9.4 step 2): `cards.html`, a generic deck whose hidden slides each hold four `<section class=card>`, and its `<div class=card>` control `cards-control.html` (`test/e2e/slides.spec.ts`, review finding 29). Both map as generic · 3 slides · index, 3 of 3 reached, 15 visible text nodes, all exact | yes |

The synthetic and CSP decks do not count toward the 95% coverage gate. Their confidences are checked by hand
against what each one is meant to test (SPEC section 10, Exit gate). Each `<name>.html` has a sibling
`<name>.expect.json` that states that intent.

## The decks

Every deck is a self-contained page in the style of a Claude-made deck: a 1600×900 design size, inline CSS,
system fonts and, where relevant, a small inline slide engine. Nothing loads from the network. Sibling files
(`*.js`, `reveal-hash/vendor/`) are served from the deck's folder, which Blueline serves from the second
`<docId>-files` origin (SPEC 9.1, Serving).

"Nodes" counts the visible text nodes of a section 10 step 3–4 walk at 1600×900, mapped with the core matcher
as `exact / ambiguous / none`. These are the counts at the time of writing; see "Validation" below.

| Fixture | Kind · slides · nav | What it exercises | Spec | Expected map behaviour | Nodes |
|---|---|---|---|---|---|
| `entities.html` | generic · 6 · index | Named, decimal and hex character references; legacy references without `;` (`&copy`, `&#169`, `&#xA9`); `&notit;` (decodes to `¬it;`); `&mdash` without `;` (not a reference); C1 numeric references (`&#150;` → `–`, `&#128;` → `€`); `&nbsp;` and a raw U+00A0; `&lt;` `&gt;`; a bare `&` | 9.2 Strategy 1 step 5; 11 (entity decode and encode) | Every parsed text node is `exact` `html-text`; references are atomic units; `&nbsp;` runs set `usesNbspRef` and the raw-NBSP run does not. The JS slide counter is `none` (`computed`). | 38 / 0 / 6 |
| `js-templates.html` | generic · 4 · index | Slides built by JS from an array of objects. String literals and template literals without `${…}` rendered with `textContent`; HTML literals set with `innerHTML`; items rendered through `` `<li>${b}</li>` ``; `a + ' of ' + b`; a template with `${…}`; `String.raw`; a duplicated label; quoted object keys; labels equal to a `data-*` value and an `id`; a metric label placed after a space by a template; a literal split in two at runtime; a literal with `&amp;` but no `<` set with `innerHTML` | 7; 9.2 Strategy 2 steps 1–3 | `exact`: plain literals, templates without placeholders, HTML-fragment runs, list items, JS escapes. `ambiguous`: `duplicate` (`On track`, `At risk`, `.`), `key` (`Northwind Health` = `data-client`, `Glossary` = `id`, `Decision` = an identifier key of `STATUS_COLOR`), `not-equal` (` net new ARR`), `substring` (the split halves), `shadow` (`14`, which also occurs in the CSS as `.14em`). `none`: `multi-literal` (`Part one of four`), `computed` (the `${…}` footer, `Slide 1 of 4`), `no-match` (`String.raw`), `unaligned` (the `&amp;` literal shown through `innerHTML`). | 30 / 19 / 14 |
| `json-data.html` | generic · 4 · index | Slide content in `<script type="application/json" id="deck-data">`, rendered by a `<script type="module">`: plain values, JSON escapes (`\u2014`, `\"`), HTML string values set with `innerHTML` (one with `&amp;`), a duplicated value, a value equal to a `data-client` attribute, metric labels rendered from object keys, and a key equal to a value | 7 rule 3; 9.2 Strategy 2 (JSON blocks) | `exact` `json-literal` for values and HTML-value runs; `duplicate` (`Research team`); `key` (`Harbor & Pine`); labels from object keys are `none` (`no-match`), because keys are not units; formatted numbers are `none` (`computed`). A footer literal from the module script is `exact` `script-literal`. **`Retention`** is both a key that is rendered and a value: `ambiguous` (`key`), see Open points. The eyebrow `Checkout redesign — results` is `ambiguous` (`shadow`): the `<title>` holds the same text. | 30 / 9 / 9 |
| `bom.html` | generic · 3 · index | File starts with `EF BB BF`; parsed text, a JS literal and a JSON value after it | 9.2 rule 3 | All `exact`; offsets shifted by the BOM; undo restores the BOM byte for byte | 12 / 0 / 0 |
| `crlf.html` | generic · 3 · index | CRLF on every line (89, no bare LF): a run that spans a CRLF, `<pre>` followed by CRLF, a string literal with a backslash-CRLF line continuation, a multi-line template literal, a CRLF-formatted JSON block | 9.2 rule 4 | All `exact`; tables drop the CRs; new line breaks would be written as CRLF | 11 / 0 / 0 |
| `unicode-edit-points.html` | generic · 3 · index | An em dash, curly quotes and an astral emoji right before the end of every run (where the probe appends): raw characters, `&#x1F680;`, JS `\u2014` `\u{1F389}` `\uD83D\uDD0D`, JSON surrogate-pair escapes, a ZWJ sequence, a flag, a variation selector, and a decomposed `é` (e + U+0301) | 9.2 rule 2; 11 (UTF-16 offsets with astral characters) | All `exact`; offsets are UTF-16, never bytes; exact equality applies no NFC | 14 / 0 / 0 |
| `windows-1252.html` | generic · 3 · index | Raw windows-1252 bytes with `<meta charset="windows-1252">`; 17 bytes in 0x80–0x9F (`“ ” ‘ ’ – — € • … ™`) plus `ü` (0xFC) | 9.2 rule 1; 9.1 Charset | Fails the fatal UTF-8 decode: opens read-only with "windows-1252.html is not UTF-8; direct edits are off", no stamps, every node `none` (`not-utf8`). Served with no charset, so the page renders through its own meta charset. | 0 / 0 / 9 |
| `reveal-hash/index.html` | reveal · 8 · reveal | reveal.js 6.0.2 with `hash: true`, `width: 1600, height: 900`: 5 horizontal slides, one a vertical stack of 4, section ids (`#/title` … `#/questions`), fragments, speaker notes, the white theme's uppercase headings. Also the **Diagnostics deck** (see below). | 9.4 step 1; 10 (Diagnostics window); 6.2 | Parsed text `exact`. Fragments are hidden until stepped, and speaker notes are never visible. reveal.js's `.aria-status` live region is clipped to a zero area and skipped by the walk (see Open points). | 27 / 0 / 0 |
| `generic-index.html` | generic · 6 · index | `<article data-slide>` slides hidden with opacity and visibility (non-zero boxes); an agenda list built by JS from the slide headings and a `data-title`; a slide with no heading (title from `data-title`) and one with neither (`Slide 6`); a zero-padded counter; a static label repeated three times; an inline SVG chart with `<text>` labels and a `<figcaption>` | 9.4 step 2; 9.2 Matching (JS-built contents list) | Parsed text `exact`, duplicates included. Agenda copies of headings are `ambiguous` (`stamp-other`); the `data-title` copy is `none` (`no-match`); the counter is `none` (`computed`). SVG `<text>` and the caption are `exact`. | 28 / 2 / 7 |
| `generic-hash.html` | generic · 5 · hash | The engine writes `location.hash = '#<slide id>'` on every move and renders from `hashchange`; it opens with no hash | 9.4 step 2 (hash) | All `exact`; navigate by hash (`#intro`, `#roles`, `#process`, `#budget`, `#ask`) | 28 / 0 / 0 |
| `keys-prevent-default.html` | generic · 4 · index | A window capture listener calls `preventDefault()` on every keydown, Cmd chords included, and still moves the deck on arrows; slides are `<div class="slide">` | 6.2 (App shortcuts are menu accelerators) | Mapping is plain (`exact`). The check: app chords still work (main takes them in `before-input-event`) and never reach the page; other chords and arrows do. | 14 / 0 / 0 |
| `inline-markup.html` | generic · 4 · index | Blocks split into runs by `b`, `strong`, `i`, `em`, `a`, `code`, `span`, `br`; nested inline elements; an NBSP-only node between inline elements; a repeated `<strong>Owner</strong>`; `text-transform: uppercase`; a link with an unquoted `href=…/>`; a `data-bl-e` already in the source | 6.3 (Inline markup is preserved, Source case); 10 step 5 (inline blocks) | Every run `exact`, including the NBSP-only node (NBSP is not whitespace). Every block with inline elements maps all its runs `exact`. The stamp goes after the tag name, never near `/>`, and the old `data-bl-e` is stripped (9.2 Strategy 1 step 3). | 48 / 0 / 0 |
| `notes-block.html` | generic · 3 · index | A valid notes block (`format: 'blueline-notes'`, `version: 1`, `baseSha`, 2 people, 2 notes, one note text containing `</script>` and `<!--` written as `\u003C`) as the last element of `<body>`; a decoy block of the same type and id inside a `<template>`, which the page clones into slide 3 | 8 (Notes inside the file); 11 (Notes block) | The real block is found and removed before mapping and serving; the decoy is page content (never read as notes). Deck text `exact`; text cloned from the template is `none` (`no-match`). | 9 / 0 / 1 |
| `report.html` | scroll · 5 · scroll | A report, not a deck: a masthead with contents links above five `section[id]` blocks, each tall enough that only one or two meet the viewport; `h1`–`h3`, a table, lists, a blockquote, inline markup | 9.4 step 3; 6.9 (Document view) | All `exact`. Detection must give `scroll`, not `generic`. Visibility in 9.4 is box, `visibility` and opacity, not viewport intersection. The masthead is only in view at the top of the page. Each node is counted on the block that contains it (the masthead on block 1). | 63 / 0 / 0 |
| `single.html` | single · 1 · none | A one-pager with no `section`, `.slide`, `[data-slide]` or `section[id]`; everything fits in 1600×900; a `<label>`, an `<input>` and a `<button>` | 9.4 step 4; 7 rule 1 | All `exact`; one pass | 21 / 0 / 0 |
| `csp-self-inline.html` (+ `csp-self-inline.js`) | generic · 3 · index | Meta CSP `script-src 'self' 'unsafe-inline'`; inline scripts render a timeline; a sibling `<script src>` | 10 (CSP fixtures, Exit gate › Scripts); 9.1 (Preload) | Inline scripts run. The sibling script is blocked: it is served from `<docId>-files`, which `'self'` does not match. Text `exact`. | 14 / 0 / 0 |
| `csp-nonce-strict-dynamic.html` (+ `csp-nonce-strict-dynamic.js`) | generic · 3 · index | Meta CSP `script-src 'nonce-x' 'strict-dynamic'; object-src 'none'; base-uri 'none'`; nonce'd scripts; a script they insert, which adds one line of text; an inline script without a nonce | 10 (CSP fixtures); 11 (the deck's own CSP is honoured) | Nonce'd and inserted scripts run; the script without a nonce is blocked. Inline-script text is `exact`; the line from the external script is `none` (`no-match`), because Strategy 2 parses only inline scripts. | 13 / 0 / 1 |
| `csp-default-none.html` | generic · 3 · index | Meta CSP `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'`; a `data:` image that the policy blocks | 10 (CSP fixtures); 9.1 (Preload: the page CSP applies to the isolated world) | Inline scripts run; the image is blocked. Text `exact`. The overlay must mount and work under this policy. **Not yet included:** 9.1 also wants a note card with a recording here; recordings arrive in Phase 5, which adds it. | 11 / 0 / 0 |

## The `.expect.json` format

```jsonc
{
  "deck": "entities.html",          // the fixture, relative to this .expect.json
  "kind": "generic",                // 9.4 detection: reveal | generic | scroll | single (SlideState.kind)
  "slides": 6,                      // detected slide count (reveal.js: leaf slides, vertical ones included)
  "navKind": "index",               // reveal | hash | index | scroll | none (SlideRef.nav.kind)
  "titles": ["…"],                  // 9.4 titles: first h1–h3 textContent (whitespace collapsed, trimmed), else data-title, else "Slide N"
  "expect": [
    {
      "text": "Research & Development",   // the DOM text node's data, exactly (NBSP, LF and astral characters included)
      "confidence": "exact",              // exact | ambiguous | none, as SPEC 9.2 decides
      "strategy": "html-text",            // html-text | script-literal | json-literal when exact, else null
      "reason": "computed",               // MatchReason (core/types.ts) when not exact
      "why": "…",                         // what the case tests, with the spec reference
      "slide": 1,                         // optional: only nodes first counted on this slide (0-based, detected order)
      "candidates": 3,                    // optional: candidate count of an ambiguous match
      "hiddenUntil": "fragment"           // optional: not counted by the section 10 walk ('fragment', 'speaker-view', 'clipped')
    }
  ]
}
```

An entry applies to every visible node whose data equals `text` (and is on `slide`, when given). The list covers
the cases each deck exists for, not every node. Some decks add deck-level fields: `bom`, `lineEnding`, `utf8`,
`readOnly`, `hashes`, `revealIndices`, `designSize`, `deckNav`, `sections`, `inlineBlocks`, `notesBlock`,
`diagnostics`, `keys` and `csp`. Each one describes itself.

## Hooks the tests read

The decks record what they see as data attributes on `<html>`. These are part of the page, so the overlay never
writes them.

| Deck | Attribute | Meaning |
|---|---|---|
| `reveal-hash/index.html` | `data-bl-key-log` | `<seq>:<key>:<isTrusted>` of the last keydown the page's own capture listeners (on `window` and `document`) saw; `seq` counts events, not listener calls. The preload reads it inside and after its own capture listener. If the preload ran first, `seq` has not moved when it runs. If its `stopImmediatePropagation()` stops the page, `seq` never moves (6.2; 10, Diagnostics). |
| `reveal-hash/index.html` | `data-bl-key-trace` | The last 20 `<seq>:<window\|document>:<key>:<isTrusted>` entries, for debugging |
| `reveal-hash/index.html` | `h2#diag-heading[data-bl-diag="heading"]` | The heading Diagnostics makes `contenteditable="plaintext-only"` (text: "Strategy offsite, day one") |
| `keys-prevent-default.html` | `data-page-keys`, `data-page-key-count` | The last 50 chords the page received (`Meta+s`, `ArrowRight`, …) and how many keydowns reached it. An app chord must appear in neither. |
| `csp-*.html` | `data-scripts-ran="yes"` | The deck's own scripts ran (Exit gate › Scripts) |
| `csp-*.html` | `data-csp-violations` | Every `securitypolicyviolation` in the document as `<effectiveDirective> <blockedURI>`, joined by ` \| `. Only the deck's own expected violation may appear; one caused by the overlay is a failure (9.1 Preload). |
| `csp-self-inline.html` | `data-sibling-script-ran` | Set by `csp-self-inline.js` if `'self'` admitted it (it does not; see Open points) |
| `csp-nonce-strict-dynamic.html` | `data-dynamic-script-ran`, `data-unnonced-script-ran` | The inserted script ran (`yes`); the script without a nonce ran (must stay absent) |
| `csp-default-none.html` | `data-image-blocked` | `yes` when the deck's CSP blocked its `data:` logo |

## How the special files were made

Treat the decks as binary: editors that normalize line endings, strip a BOM or re-encode will break them.
`decks/.gitattributes` turns off git's line-ending conversion here.

- **`bom.html`**: written as UTF-8, then `EF BB BF` prepended. Every other deck has no BOM.
- **`crlf.html`**: every line ends in CRLF and there is no bare LF. Every other deck uses LF only.
- **`windows-1252.html`**: generated once from a UTF-8 source with the WHATWG windows-1252 index (Node's
  `TextDecoder('windows-1252')` behaves as latin1, so the table is explicit). Only the result is committed. It is
  invalid UTF-8.
- **`notes-block.html`**: the trailing block was generated. `JSON.stringify` of the notes, then every `<` written
  as `\u003C`. `baseSha` is the sha256 of the file with the block's `<script>` element removed. The targets'
  `blueline:Stamp` selectors (`bl-4`, `bl-9`) are the stamps `buildMap` assigns at that version. **If you edit
  this deck, regenerate the block:** `baseSha` and the stamps change.
- **`reveal-hash/vendor/`**: reveal.js **6.0.2** from npm (`npm pack reveal.js@6.0.2`, integrity
  `sha512-JYIg5D9aoxoaLeb84O+OvAwsKWdIavVgEDScxtYEXFCT6t6TQrhNtSgogcjdCpdLsWglhJn3zyE3fUOwiH5KEg==`), MIT
  (`vendor/LICENSE`). Files: `dist/reveal.js` (the UMD build, which defines `window.Reveal`), `dist/reveal.css`,
  `dist/reset.css` and `dist/theme/white.css` (its fonts are embedded as `data:` URLs), unmodified. They are
  served as sibling files, never from a CDN. `scripts/build.mjs` copies `reveal-hash/` into the app bundle as the
  Diagnostics deck.
- In JS and JSON sources, escapes such as `\u201c` are deliberate. A tool that decodes them breaks what the
  deck tests. Check with `grep -n '\\u' decks/*.html` after editing.

## Validation

At the time of writing, each deck was checked as follows:

- every inline classic or module script passes `node --check`; every JSON and notes block passes `JSON.parse`;
  every `src` resolves to a file in the folder; parse5 reports no parse errors except the deliberate ones in
  `entities.html` (`missing-semicolon-after-character-reference`, `control-character-reference`);
- each deck was loaded in Electron 44.7.2 as its served copy (`buildMap`, then `buildServedCopy`), from a
  custom scheme that redirects sibling files to a `-files` host as 9.1 does. Its slides were walked as section 10
  step 3 describes, its visible text nodes collected as step 4 describes, and each node mapped with
  `createMatcher`. Every `expect` entry matched, except `Retention` in `json-data.html` (Open points);
- integration (Phase 0 close, and again after review round 1): every deck was mapped with the real `blueline
  map --report --json` and every `expect` entry compared with the result. All 18 agree, every `exact` node
  passes the real mutation probe (write through the patcher, reload, sentinel only in its node, undo restores
  the bytes exactly), and the output equals the baselines in `expected/` byte for byte;
- an approximate mutation probe was run: a distinct sentinel was appended to the raw end of every run that some
  node maps `exact`, then each deck was reloaded and walked again. Every sentinel appeared in its own node. The
  exceptions are the open points below and the JS-built agenda copies in `generic-index.html`, which section 10
  allows as reported renders of the same run.

## Open points

- **`json-data.html`, `Retention`. Resolved.** One `Retention` node is the `focus` value on slide 4; the other is a
  metric label on slide 3, rendered from a JSON object key. The mapper used to report both `exact`, and the probe
  showed that an edit of the label was written into the `focus` value: a write to the wrong place. JSON object
  keys (and identifier keys of JS object literals and class fields) now count as keys, like `id` or `data-*`
  values (9.2 Strategy 2 step 3: the deck may use the text as a key), so both nodes are `ambiguous` (`key`). JSON
  keys are still not units, so a label rendered only from a key stays `none`. The same rule makes `Decision` in
  `js-templates.html` `ambiguous`: the deck indexes `STATUS_COLOR` with it.
- **reveal.js `.aria-status`. Resolved.** reveal.js keeps a 1×1 px live region clipped to a zero area at (0, 0)
  that repeats the current slide's text. A literal reading of step 4 counts it (its rect is non-zero), and every
  probe sentinel also shows up in it. The walk skips text in absolutely positioned elements clipped to a zero
  area (`core/dom-walk.ts`, `skipClipped`), and the probe ignores a sentinel copy only in such a clipped node
  that the walk never counted (`find` reports `clipped`; `probe.ts`, `judgeNode`). Any other copy the report
  does not count fails the node, hidden or not (`map/hiddendup.html`, `map/reveal-fragment.html`).
- **reveal.js fragments.** `.fragment` items stay at opacity 0 after `Reveal.slide(h, v)`, so the step-3 walk
  never counts them. A run that is also shown in a fragment therefore fails the probe: an edit would change
  the fragment unseen (`map/reveal-fragment.html`).
- **Scrolling documents. Resolved.** Calling `scrollIntoView` on each block never shows content above the first
  block (a masthead or contents list), so the walk also collects at the top of the page. It then steps down
  each block, and the rest of the page, one viewport height at a time until the bottom has been in view, so
  text below a block's first viewport is counted too (`map/longscroll.html`). A single page is walked the same
  way (`map/longsingle.html`). A block counts as reached when its box meets the viewport at a stop, and each
  node is counted on the block that contains it (`map/shortend.html`, `map/manyshort.html`). The steps scroll
  the window: a document that scrolls inside its own container is walked only as far as `scrollIntoView` on
  its blocks takes it.
- **`script-src 'self'` and sibling files.** Sibling files come from `<docId>-files`, which `'self'` does not
  match, so a deck that loads its own scripts or styles under a `'self'` policy loses them in Blueline. Served
  from one web origin together with its files, the same deck would load them. `csp-self-inline.html` records
  this. Chrome's behaviour for `file://` was not checked.
- **`unaligned` for a literal shown through `innerHTML`.** `js-templates.html` sets a literal that has `&amp;` but no
  `<` with `innerHTML`. In a literal reading of 9.2 its one run is the cooked text, which the DOM does not show, so the
  node is `none` (`no-match`). The mapper also records the decoded text as a shadow run that is never `exact`, so it
  reports `unaligned`. Both readings give `none`, and that confidence is what the fixture checks.
- **CSP recording card.** 9.1 wants the `default-src 'none'` fixture to include a note card with a recording.
  That belongs to Phase 5 (recordings) and is not here yet.

## Walk and probe decks (`map/`)

The reproduction decks of the review's findings on the walk and the probe (SPEC section 10, map steps 3-5, the
mutation probe and the exit gate). `test/e2e/map-walk.spec.ts` maps a temp copy of each. They are small pages,
not Claude-style decks, and have no baselines in `expected/`.

| Deck | What it shows | Expected `blueline map` result |
|---|---|---|
| `builds.html` | generic, 5 slides; ArrowRight first reveals build steps on slide 1, so the deck does not move | The walk reaches 1 of 5 slides: coverage is `INCOMPLETE`, `--min-coverage` is `NOT met`, exit 1 (finding 28) |
| `resume.html` | generic, 4 slides; stores the current slide in `localStorage` and reopens there | Every probe load is a fresh origin, brought back to slide 1: 8 of 8 pass, exit 0 (finding 30) |
| `firstvisit.html` | a page whose second load in the same tab throws (a `sessionStorage` flag) | 3 of 3 pass, no new console error, exit 0 (finding 30) |
| `hiddendup.html` | one JSON literal shown in a visible `<h1>` and in a `display: none` copy | The heading fails the probe (the sentinel lands in a node the report does not count), exit 1 (finding 31) |
| `reveal-fragment.html` | reveal.js (uses `decks/reveal-hash/vendor/`, copied next to it by the test); a heading literal repeated in an opacity-0 `.fragment` | The heading fails the probe as above, exit 1; `decks/reveal-hash` still passes (F17) |
| `shadow.html` | a `<stat-card>` with an open shadow root (3 text nodes) and a `srcdoc` frame (2 paragraphs) | 7 nodes: 2 `exact`, 5 `none` (`subdocument`), never probed, exit 0 (finding 32) |
| `sentinel-shadow.html`, `sentinel-frame.html` | a literal shown in the light DOM and, extended, in an open shadow root or an `about:blank` frame | The light-DOM node fails the probe (the sentinel is in a shadow root, a frame), exit 1 (finding 32) |
| `crossframe.html` | a visible and a hidden `data:` frame (opaque origin) | `Uncounted visible content: 1 cross-origin frame`, exit 0 (finding 32) |
| `stopimm.html` | generic, 5 slides; a window capture listener calls `stopImmediatePropagation()` on every keydown and acts on trusted keys only | 5 of 5 reached with trusted keys, 5 of 5 pass, exit 0 (finding 33) |
| `longscroll.html`, `longsingle.html` | a scrolling report (two 41-node sections and a footer) and a single page of 81 lines, both many viewports tall | 83 and 81 nodes counted once, all `exact` and passing, exit 0 (finding 34) |
| `shortend.html`, `manyshort.html` | a tall first block then four short ones; twelve 150 px blocks | Every block reached, 2 nodes on each, exit 0 (finding 35) |
