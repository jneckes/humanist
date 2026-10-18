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
| 6.7 step 3 | Before a still image of a slide (thumbnail, raster PDF page, Print), before the slide index reads a slide's text, and before every `printToPDF` or print of a document or a print-CSS deck (once per document), the render waits for what the page's scripts reveal: at least 1.5 s, then 400 ms without a DOM change, at most 3 s (`RenderView.waitScripted`, `slide-index.ts SCRIPTED_SETTLE`), then settles again. The wait adapts per version of the file (`SettleMemory`, decision D-5): a slide whose full wait saw neither a DOM change after a 200 ms pause nor a change in the picture later gets only the 400 ms quiet wait; any such change seen later brings the full wait back for every slide. A document's page always gets the full wait (a canvas animated below the first screen is neither in the picture nor a DOM change). The index walk takes the rail's thumbnails in the same pass | D5's PDF missed content its script reveals 1.3 s after a slide arrives (`docs/PHASE1-RESULTS.md`, PDF); fonts, frames and animations do not cover a timer; documents, print-CSS decks and the slide index had no such wait (review findings 10, 11) | "Before a still image of a slide (thumbnail, raster PDF page, Print), before the slide index reads a slide's text, and before every printToPDF or print of a document or a print-CSS deck, also wait for what the page's scripts reveal: at least 1.5 s, then 400 ms without a DOM change, at most 3 s. A later render of the same version may wait only for the 400 ms on a slide where that full wait saw neither a DOM change after a 200 ms pause nor a change in the picture; any such change seen later brings the full wait back for every slide. A document always gets the full wait." |
| 6.7 step 1 | Render products (index, thumbnails, PDF pages) render at the 6.9 design size (the index at 1600×900), 2x, not at the viewport the visible view last reported | The visible view's viewport is the window's, which Fit zooms; 6.9 defines PDF pages at the design size | "Thumbnails, the slide index and PDF pages render at the design size (the index at 1600×900) and 2x; agent renders use the viewport the visible view last reported." |
| 6.7, 6.9 Save as PDF | reveal.js slides are rendered with every fragment shown (`Reveal.slide(h, v, f)` past the last fragment) in thumbnails, PDF pages and Print, and the index holds fragment text for Find | A still image shows the slide's final state, as reduced motion does for animated decks | "A still image of a reveal.js slide shows all its fragments." |
| 6.9 Save as PDF | "A `@media print` that lays out each slide as a page" is decided by evidence: a print-media rule that forces a page break, and a `printToPDF` that gives one page per slide; reveal.js's built-in print sheet does not count | reveal.css always contains print rules that do not lay a deck out as pages unless `?print-pdf` is used | add: "reveal.js's own print sheet is not print CSS for this rule." |
| 6.9 Save as PDF | The output must be a `.pdf` path and never the document itself (by path, realpath or inode) | 9.9: when unsure, refuse | add: "It never writes over the document, and the output name ends in .pdf." |
| 6.9 Find | Matching ignores case and diacritics, and also treats curly and straight quotes, dashes and every kind of space alike | Decks use typographic punctuation the user does not type | add: "Find ignores case, accents and the difference between typographic and plain quotes, dashes and spaces." |
| 6.9 Navigation | PageUp and PageDown in Read: the deck has the key first; Blueline steps one slide only when the page did not handle it. Main honours a step only right after it saw that real key. View › Fit is Cmd+9 and 100% is Cmd+0 | A deck that uses PageDown itself must not move twice; the page cannot ask main to move | add the two accelerators and: "In Read, the deck gets PageUp and PageDown first." |
| 6.0 First run | The first-run welcome shows on the first launch without a file only (config.json `seen.welcome`; never when a file is given). It also asks once whether to send crash reports (9.9), stored and never sent in v1. Later launches without a file show nothing on macOS (the app stays in the Dock; File › Open and Help › Welcome to Blueline are in the menu bar; a Dock click with no window open does the same) and a small Open window on Windows and Linux (Open a file, the default app, the sample deck; no questions). A second launch without a file brings the open Blueline window forward (decision D-12) | Windows and Linux have no other UI without a window; macOS keeps the app in the Dock; 9.9 asks the crash question once, at first run; a welcome on every launch asked the first-run questions again (review findings 24, 26, 34) | "On the first launch without a file, a welcome window offers …" and "It asks for the user's name and, once, whether to send crash reports. Later launches without a file open an Open window on Windows (macOS: none)." |
| 6.0 First run | The sample deck opens from a copy in `<userData>/sample`, not from the bundle | The bundle is read-only and may carry the download's quarantine marker, which would open it Protected with editing off | add: "The sample deck is copied to app data on first use, so it can be edited." |
| 6.1 Ways in, drag and drop; 9.1 Preload | Files dropped on the shell's areas (toolbar, rails, status bar, welcome window) open; a file dropped on the deck view is refused before the frame's page sees it, in every frame the deck preload reaches: the deck view sets `nodeIntegrationInSubFrames`, so the preload runs in every frame, and in a subframe it installs only the drop guard (no overlay, no IPC: main still answers only the main frame); the top frame also guards script-made `about:blank` frames and guards them again after `document.open()` (decision D-4). A notice for drops on the top frame. Two frames a deck can build are not reached: one it rewrites with `document.open()` and one it makes `about:blank` inside a shadow root (SECURITY.md, Known limits) | 9.1: a deck view never gives main a path, and a deck never reads a local file (review finding 2: an iframe could read a dropped file). Electron 44 gives main no way to cancel a drop before the renderer, and Chromium's drag interception holds only drags the page starts | "Drag a file onto the Dock icon or onto a window's toolbar or rails." and, in 9.1 Preload: "The preload also runs in every subframe of a deck view, where it only refuses dropped files." |
| 6.1 The command line tool | `~/.local/bin`; on macOS `/usr/local/bin` when the login shell's PATH lacks `~/.local/bin` (an administrator prompt when it is not writable). Windows: `%LOCALAPPDATA%\Blueline\bin\blueline.cmd`, and the user is told how to add it to PATH (never `setx`) | 6.1 does not say when to use `/usr/local/bin`; `setx` truncates PATH | as described |
| 6.10 When it applies | A file opened with `--protected` (or File › Open in Protected View) ignores remembered Allow network and Enable editing | The user asked for network and editing off | add: "A file opened in Protected view on request ignores remembered switches." |
| 6.10, 9.9 Derived files keep the marker | A copy of a Protected document that has no marker (`--protected`, an untrusted folder) gets a new marker naming the document; the `blueline map` probe copy and the PDF are marked too | A copy of a Protected document must not open Trusted (when unsure, refuse) | add: "A copy of a document that opened Protected without a marker gets one naming that document." |
| 9.2 Watcher | Further events restart the 150 ms settle for at most 1 s; after the two agreeing reads the path is checked once more; a file counts as gone only when missing on two looks 150 ms apart | Bursts of saves, and rename-replace saves that briefly leave no file | add these three to steps 2 and 4 |
| 9.6 `native/windows` | No Windows helper: main reads and writes `Zone.Identifier` with `fs`, opens Default Apps with `shell.openExternal`, and reads the registry with `reg.exe` | Node and Electron can do all three | "native/windows: nothing in v1; the installer (NSIS include) writes the registry entries." |
| 6.9 Save as PDF, decks with print CSS | A deck takes the print-CSS path only when Chromium's print of it gives one page per slide, each the slide's aspect within 1%; otherwise it is rasterised. A style sheet counts for print with its media list (`<link media>`, `<style media>`, `@import … <media>`). Raster pages are in slide order, whatever order the walk visited them (decision D-6) | An `@page` rule alone, or a `@media print` on default paper, gave PDFs whose pages are not the slides; raster pages came out in visit order (review findings 9, 13, 33, 35) | "(an @page rule, or a @media print that lays out each slide as a page), when Chromium's print of the deck is one page per slide, each the slide's aspect within 1%: printToPDF(...). Otherwise the deck is rendered as Other decks. A style sheet counts for print with its media list (<link media>, <style media>, @import ... <media>)." And for Other decks: "one PDF page per slide, in slide order". |
| 10 Phase 1 exit gate, PDF | Raster pages are compared with Blueline's render of their slide; pages Chromium prints (print-CSS decks, documents) with Chromium's own print of the file, page count and page sizes included (decision D-6) | A print-CSS page is not the screen render of its slide | "For 10 decks, the PDF has the right page count; each raster page matches Blueline's render of its slide, and each page Chromium prints (print-CSS decks, documents) matches Chromium's own print of the file, with at most 1% of pixels different." |
| 6.9 Find | A match never spans two blocks or a preserved line break (a `<pre>` block, `white-space: pre-line`), and choosing a result highlights that very match: the index holds one string per run of text in a block, split at each forced line break, and a result's occurrence counts only the earlier matches `findInPage` finds for the matched text | `findInPage` never matches across a block boundary or a forced line break, so such a hit had nothing to show, and the n-th hit could highlight another match (review finding 12) | add to the Find row: "A match never spans two blocks or a forced line break, and choosing a result highlights that very match." |
| 6.9 Reading, thumbnail rail | The rail's thumbnails and the slide index stay cached by `(sha256, slide index, width)`, and each index also records the network policy it was rendered under (whether the document had network, the strict option, the allowlist: `renderPolicyTag`). When a window's policy differs from the cached one (Allow network, a Settings › Trust change, a trust change at a later open or on reload), the index and that version's thumbnails are made again | A deck whose images or text come from the network showed the Protected render (no images, no fetched text) in the rail and in Find after Allow network, and across launches (review finding 15) | add to the rail row: "…cached by (sha256, slide index, width) and made again when the document's network policy changes." |
| 6.9 Navigation | A hash or reveal.js goto that has not moved the visible slide within 1.5 s puts the URL hash back (`replaceState`) and uses the deck's own keys (`Session.deckNav`, as the index walk does); the document then uses keys at once. A key replay or a load gives the keyboard back to whoever had it (the Find bar keeps it) (decision D-7) | 5 of Josh's 12 decks write their slide into the hash but never read it, so rail clicks, Find results and Review's PageUp/PageDown did not move them (review findings 17, 18) | add: "When a deck does not follow its URL hash, Blueline moves it with its own keys." |
| 6.10 What changes; 9.2 Watcher | On every external change, and when a file that went away comes back, 6.10 is decided again for the file on disk, as at an open, and the marker is read once more 500 ms later. If the decision differs in any way, the window does not reload in place: the file opens again with a fresh docId and the partition its trust needs, at the same place, with its view state, and the trust bar says why (decision D-1) | A new download saved over an open Trusted file ran in place under the old trust, and a persist: partition cannot be downgraded in place (review findings 0, 3, 16) | add to 6.10: "A file that changes on disk is decided again; when its trust changes, it opens again in its new state." |
| 6.10 What changes | On Windows a remembered decision is bound to the file's identity (device, file number and birth time) as well as the Zone.Identifier text; a file with no marker (one in an untrusted folder) is remembered with its identity too; Blueline's own writes re-bind it (decision D-2) | Zone.Identifier carries no time or id, so every download of the same link, and every Outlook attachment, carries the same text; an unmarked file has no marker to compare (review findings 5, 28) | replace "On Windows it is the contents of Zone.Identifier." with "On Windows it is the contents of Zone.Identifier, together with the file's identity (its file ID), because that text carries no time or id. A file with no marker (one in a folder the user marked as untrusted) is remembered with its identity too. Blueline's own writes re-bind it." and "A new download saved over the same path brings a new marker, or on Windows and for an unmarked file a new file, so it opens Protected again and the old decision is dropped. A program that writes into the existing file in place keeps the decision." |
| 6.1 `blueline pdf`; 10 `blueline map`; 6.10 | The commands decide trust as the app decides an open (`--protected`, the trusted and untrusted folders, the marker), with the user's strict option and CDN allowlist; they read config.json and never write it, and remembered decisions (trust.json) never apply to them (decision D-3) | A deck in an untrusted folder rendered Trusted from the command line, with network the user had blocked (review findings 1, 4) | add: "blueline pdf and blueline map open the file in the trust state the app would, without remembered decisions." |
| 6.1 File associations; 9.10 packaging | The `html`/`htm` Open With association is declared under `mac.fileAssociations` only; Windows file-type registration comes solely from the installer's NSIS include (a quoted command line, written in the hive that matches the install mode, removed on uninstall), as 6.1 Becoming the default app already describes (decision D-11) | A top-level `fileAssociations` makes electron-builder's NSIS target register the type on Windows too and overwrite `.html`/`.htm`'s default ProgID with an electron-builder stub, defeating the per-install-mode registration 6.1 specifies, and a per-user→per-machine switch left the per-user entries behind (files finding) | replace the top-level `fileAssociations: [...]` (6.1, 9.10) with `mac: { fileAssociations: [...] }`; on Windows the association is written only by the installer's NSIS include. |
