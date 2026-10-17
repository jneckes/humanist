# Proposed SPEC amendments

SPEC.md is Josh's document and is not edited by the build. Where Phase 0 found that the code must do something
the spec does not say, the code does it, and the wording is proposed here for Josh to accept or reject. The
patches apply in order:

```sh
git apply docs/spec-amendments/phase0-review1.patch
git apply docs/spec-amendments/phase0-real-decks.patch
```

## In the code, wording proposed

| Patch | What changes | Why |
|---|---|---|
| `phase0-review1.patch` | 9.1 `blueline-media` scheme; 9.2 shadow values, the number rule, object keys, the markup test, the own-stamp check; 9.9 the loopback-safe proxy and the layer switch; section 10 whole-page walks; section 11 `coverage.slides` | The review round (PHASE0-FINDINGS, Review round 1) |
| `phase0-real-decks.patch` | 6.7 a key that changes nothing is pressed again, and build steps are collected; section 10 probe batches and `--reduced-motion`; 9.2 script-changed nodes, split-text pieces and single characters | Josh's real decks (PHASE0-FINDINGS F25–F29) |

## Decided by Josh (2026-10-17), in the code, wording proposed

Josh accepted all three proposals below ("go with your recommendations"). The code does each; the SPEC.md
wording is proposed here and not applied, as with the patches.

### 1. Edit and Review with reduced motion for animated decks

Five of the twelve real decks animate with GSAP. With motion on they split headings into one span per word or
letter and scramble text, so most of their text is not `exact` (PHASE0-FINDINGS F27). With
`prefers-reduced-motion: reduce` every deck draws its final frame directly.

**In the code:** the deck view of Review and Edit emulates `prefers-reduced-motion: reduce` (Chromium's media
emulation, for that view only, `packages/app/src/main/motion.ts`); Read and Present keep motion as the deck sets
it. A deck whose inline script reads the setting is reloaded on the switch, keeping its URL hash. `blueline map
--reduced-motion` maps a deck as Edit shows it.

**Proposed wording**, a new first paragraph of 6.3 Edit mode, with a pointer from 6.4: "In Review and Edit the deck renders with
`prefers-reduced-motion: reduce`, as Chrome shows it to a viewer who asks for reduced motion; Read and Present
keep the deck's motion." Principle 2 still holds: these decks are built to look right that way.

### 2. An untouched stamped node takes precedence over an equal literal

9.2 says "A stamped run is never preferred over a literal with the same text", because a script may have
replaced the element's text with that literal. The preload records every text node a script changes (F28), so
for a node no script touched, the reason no longer applies.

Measured on the three real decks with the most `duplicate` nodes (labels as in PHASE0-FINDINGS F30), with the
probe on, on the build before the split and single-character rules (F29):

| Deck | 9.2 as written | Untouched own stamp first | New probe failures |
|---|---|---|---|
| D10 | 80.7% | 83.8% | 0 |
| D3 | 80.1% | 85.3% | 0 |
| D11 | 87.4% | 89.5% | 0 |

On the final build all twelve decks rose from 89.0% to 90.7% of all text, with no new probe failure.

**In the code:** `matcher.ts` step 1 drops equal literals from the doubt when the walk tracked script changes
(`DomTextNode.tracked`) and the node is not `touched`. Without tracking (a caller that does not run the
tracker), 9.2's rule stands.

**Proposed wording**, "Matching DOM to source at runtime": replace "A stamped run is never preferred over a
literal with the same text" with "A stamped run is preferred over a literal with the same text only when no
script has changed the node (it is the parser's own text node)". The tracker's limit: a script that sets
`node.data` while the page is still loading is not seen; the mutation probe still checks every such claim in
`map`.

### 3. The coverage gate measures wording

Of the text nodes that are not exact, about half are numbers, counters, dates and glyphs: slide numbers and
totals the engine writes, KPIs a script computes. 6.3 rarely offers them for editing.

**In the code:** `coverage.wording` counts the nodes whose text has two letters in a row (`hasWords`,
`packages/core/src/text.ts`); `blueline map --min-coverage N` gates on its share. The report still gives the
share of all text.

**Proposed wording**, section 10 Phase 0 exit gate, Coverage: replace "at least 95% of visible text nodes map
`exact` and pass the probe" with "at least 95% of the visible text nodes that hold words (two letters in a row)
map `exact` and pass the probe; the report also gives the share of all text nodes".

## Phase 1 (Reader): in the code, wording proposed

Where Phase 1's code had to do something SPEC.md does not say, or says otherwise, the code does it and the
wording is proposed here. None is applied to SPEC.md.

| Section | In the code | Why | Proposed wording |
|---|---|---|---|
| 6.9 Views, Deck view | Fit is `webContents.setZoomFactor` on the deck view, with `webPreferences.zoomMode: 'isolated'` | PHASE0-FINDINGS F5 (CSS `zoom` resolves `vw`, `vh` and media queries against the small window, 11.5% of pixels off); per-host zoom also zoomed the document's own render windows (Phase 1 correction to F5) | "Fit sets the deck view's zoom factor (`webContents.setZoomFactor`, zoom mode isolated, so the document's render windows stay at 1); the page keeps its design-size viewport." |
| 6.7 step 3 | Before a still image of a slide (thumbnail, raster PDF page, Print), the render stays at least 1.5 s on the slide, then until the DOM has had no change for 400 ms, at most 3 s (`RenderView.waitScripted`, `slide-index.ts SCRIPTED_SETTLE`), then settles again | D5's PDF missed content its script reveals 1.3 s after a slide arrives (`docs/PHASE1-RESULTS.md`, PDF); fonts, frames and animations do not cover a timer | add to step 3: "For a still image of a slide, also wait for what the slide's scripts reveal: at least 1.5 s on the slide, then 400 ms without a DOM change, at most 3 s." |
| 6.7 step 1 | Render products (index, thumbnails, PDF pages) render at the 6.9 design size (the index at 1600×900), 2x, not at the viewport the visible view last reported | The visible view's viewport is the window's, which Fit zooms; 6.9 defines PDF pages at the design size | "Thumbnails, the slide index and PDF pages render at the design size (the index at 1600×900) and 2x; agent renders use the viewport the visible view last reported." |
| 6.7, 6.9 Save as PDF | reveal.js slides are rendered with every fragment shown (`Reveal.slide(h, v, f)` past the last fragment) in thumbnails, PDF pages and Print, and the index holds fragment text for Find | A still image shows the slide's final state, as reduced motion does for animated decks | "A still image of a reveal.js slide shows all its fragments." |
| 6.9 Save as PDF | "A `@media print` that lays out each slide as a page" is decided by evidence: a print-media rule that forces a page break, and a `printToPDF` that gives one page per slide; reveal.js's built-in print sheet does not count | reveal.css always contains print rules that do not lay a deck out as pages unless `?print-pdf` is used | add: "reveal.js's own print sheet is not print CSS for this rule." |
| 6.9 Save as PDF | The output must be a `.pdf` path and never the document itself (by path, realpath or inode) | 9.9: when unsure, refuse | add: "It never writes over the document, and the output name ends in .pdf." |
| 6.9 Find | Matching ignores case and diacritics, and also treats curly and straight quotes, dashes and every kind of space alike | Decks use typographic punctuation the user does not type | add: "Find ignores case, accents and the difference between typographic and plain quotes, dashes and spaces." |
| 6.9 Navigation | PageUp and PageDown in Read: the deck has the key first; Blueline steps one slide only when the page did not handle it. Main honours a step only right after it saw that real key. View › Fit is Cmd+9 and 100% is Cmd+0 | A deck that uses PageDown itself must not move twice; the page cannot ask main to move | add the two accelerators and: "In Read, the deck gets PageUp and PageDown first." |
| 6.0 First run | The welcome window shows on every launch without a file (never when a file is given). It also asks once whether to send crash reports (9.9), stored and never sent in v1 | A launch with no file had nothing else to show; 9.9 asks the crash question at first run | "On a launch without a file, a welcome window offers …" and "It asks for the user's name and, once, whether to send crash reports." |
| 6.0 First run | The sample deck opens from a copy in `<userData>/sample`, not from the bundle | The bundle is read-only and may carry the download's quarantine marker, which would open it Protected with editing off | add: "The sample deck is copied to app data on first use, so it can be edited." |
| 6.1 Ways in, drag and drop | Files dropped on the shell's areas (toolbar, rails, status bar, welcome window) open; a file dropped on the deck view is refused in the deck preload, before the page sees it, with a notice | 9.1: a deck view never gives main a path | "Drag a file onto the Dock icon or onto a window's toolbar or rails." |
| 6.1 The command line tool | `~/.local/bin`; on macOS `/usr/local/bin` when the login shell's PATH lacks `~/.local/bin` (an administrator prompt when it is not writable). Windows: `%LOCALAPPDATA%\Blueline\bin\blueline.cmd`, and the user is told how to add it to PATH (never `setx`) | 6.1 does not say when to use `/usr/local/bin`; `setx` truncates PATH | as described |
| 6.10 When it applies | A file opened with `--protected` (or File › Open in Protected View) ignores remembered Allow network and Enable editing | The user asked for network and editing off | add: "A file opened in Protected view on request ignores remembered switches." |
| 6.10, 9.9 Derived files keep the marker | A copy of a Protected document that has no marker (`--protected`, an untrusted folder) gets a new marker naming the document; the `blueline map` probe copy and the PDF are marked too | A copy of a Protected document must not open Trusted (when unsure, refuse) | add: "A copy of a document that opened Protected without a marker gets one naming that document." |
| 9.2 Watcher | Further events restart the 150 ms settle for at most 1 s; after the two agreeing reads the path is checked once more; a file counts as gone only when missing on two looks 150 ms apart | Bursts of saves, and rename-replace saves that briefly leave no file | add these three to steps 2 and 4 |
| 9.6 `native/windows` | No Windows helper: main reads and writes `Zone.Identifier` with `fs`, opens Default Apps with `shell.openExternal`, and reads the registry with `reg.exe` | Node and Electron can do all three | "native/windows: nothing in v1; the installer (NSIS include) writes the registry entries." |
