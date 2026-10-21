# Edit fixtures

Decks for Edit mode in the deck view (SPEC 6.3; 9.2 "Matching DOM to source at runtime" and "Committing an edit"
1–5; Phase 2 decisions P2-5 to P2-9, P2-13, P2-14, P2-17). `test/e2e/edit-overlay-field.spec.ts` and
`test/e2e/edit-overlay-ui.spec.ts` copy a deck to a temp folder, open it in the app, switch to Edit, and drive the
deck preload against a stub main (`test/e2e/edit-overlay-harness.ts`). They are named `@edit`, so the reader-only
run (P2-15) leaves them out.

## `edit-overlay.html`

A single page (no slide engine) at the top of a 940×860 deck view. What each element is for:

| Element | Map (`exact / ambiguous / none`) | Used for |
|---|---|---|
| `#title` `Quarterly review` | `exact` `html-text` (own stamp; equal to a script literal, so `exact` only because the deck view tracks script changes, P2-6) | solid outline; click, type, Enter, the result, the Saved toast's Undo (the shell's toast since the Phase 2 review, E-5); native undo confined to the field (P2-9) |
| `#inline` `Hello <b>bold</b> world` | three `exact` runs | the input filter: a deletion across the `<b>` is blocked, one inside a run is committed |
| `#link` `Visit the site` | `exact` | a click opens a field and is never followed (P2-17) |
| `#upper` (CSS `text-transform: uppercase`) | `exact` | source case and its badge (6.3) |
| `#fit` in `#box` (260×50 px) | `exact` | the fit guard: `+1 line · widow`, then `+2 lines · overflows` (the box has a fixed height) |
| `#narrow` (320 px wide) | `exact` | the fit guard's widow |
| `#noselect` (`user-select: none`) | `exact` | user-select lifted while editing (P2-17) |
| `#spin`, `#still` | — | a running CSS animation (paused in Edit, resumed after) and one the page paused itself (left alone) |
| `#toc` (copied by script from `#title`) | `ambiguous` (`stamp-other`) | dashed outline; the picker with one candidate, chosen with the mouse |
| `#twin` (`'Twin text'`, two equal literals) | `ambiguous` (`duplicate`) | dashed outline; the picker with two candidates, chosen with the keys |
| `#rep1`, `#rep2` (one literal shown twice) | both `exact` `script-literal` | "· also changes 1 other place"; a field the page re-renders or removes becomes a verbatim note (P2-17); a literal write waits for the reload |
| `#count` (`'Slide ' + 1 + ' of ' + 5`) | `none` | no outline; "Not editable" (P2-13) |
| `#svgtext` (SVG `<text>`) | `exact` | the overlay input over SVG text (P2-17: `contenteditable` does nothing on SVG elements in Electron 44) |

The page's script counts, at window capture, the events that reach it (`data-seen-<type>` on the root element):
a press that opens a field, the field's keys, input and paste must never reach it. It also cancels
`selectstart`, as many decks do, which must not stop selecting text in a field.

## Phase 2 review fixes

Small synthetic decks for the review fixes. `test/e2e/edit-fix-*.spec.ts` (shared steps in
`test/e2e/edit-fix-helpers.ts`) copy one to a temp folder and drive the real app with real clicks and keys; every
title is `@edit`.

| File | What it holds | Used for |
|---|---|---|
| `dup-slides.html` | two slides with the same kicker, heading and subtitle; only the body differs | a stale edit is placed by position, never on the other copy (E-1, `edit-fix-stale.spec.ts`) |
| `shadow-number.html` | `#h` `Revenue grew`; `#k` set by script from the literal `'40%'`; `#m` whose `<span id="c">` the page resets when `contenteditable` comes off; `#p`, `#q` | an own html-text write advances the page version (E-6): typing ` 40%` repeats the literal, and the page touches `#m` right after the field closes |
| `nav-cover.html` | three absolutely placed slides; two empty, transparent nav buttons over the top 320 px; on slide 2 `#cov` and `#h1` under them, `#abv` above them, `#free` uncovered, `#pe` with `pointer-events: none` | hit testing by the text's geometry (E-9): outline, field, the slide stays; in Read the buttons still navigate |
| `scrim.html` | text under a layer whose `::before` paints an opaque white fill (`#scr`, invisible), and text under a layer whose `::before` is transparent (`#veiled`) | E-9: text hidden by a pseudo-element fill is not reachable in Edit, and the press goes to the page (finding 9 re-verification) |
| `pe-layer.html` | an opaque slide with a `pointer-events: none` tag `#lab2`, a transparent full-slide wrapper above it whose text is elsewhere, and a fixed `pointer-events: none` label layer `#lab` above both | hit testing reaches text in `pointer-events: none` layers without changing the page's styles (E-9) |
| `touched-title.html` | `#ttl` whose text a script copies from the list item `#n1` | a node a script rewrote: no outline and no picker (E-9) |
| `fit-case.html` | 400 px headings: `#up` uppercase, `#ctl` the same text in capitals in the source, `#sc` small caps; `#lab` uppercase in a 400×40 `overflow: hidden` box | the fit guard measures the rendered case (E-10): `+1 line` for `#up`, `overflows` for `#lab` |
| `button-space.html` | `<button>` and `<summary>` labels, a `<b>` inside a button, spans inside a button and a summary, a paragraph; the page records clicks and toggles in `data-ev` | Space types a space in a field on a button or summary, and no click or toggle reaches the page (E-10) |
| `spell.html` | a heading and a paragraph; the page counts the right-clicks it sees in `data-ctx` | the spelling suggestions menu (E-10); the test needs an `en-US-10-1.bdic` (`BL_TEST_SPELL_DICT`) and skips without one |
| `spell-block.html` | `spell.html` with an SVG `<text>`, and the page cancels every right-click it sees at window capture (counted in `data-ctx`) | spelling suggestions in an SVG text field: the page never sees a right-click in the field (finding 13, re-verification) |
