# Render fixtures (Phase 1: render products)

Small synthetic documents for the slide index, thumbnails, Find, Save as PDF and Print (SPEC 6.7, 6.9; section
11 Render parity and PDF). Each is meant to show one rule; `test/e2e/render-products-*.spec.ts` and the unit
tests in `test/unit/app/{slide-index,thumbnails,find,pdf,print,args-pdf}.test.ts` use them. None holds client
text.

A deck prints its own print CSS only when Chromium's print of it is the deck as slide pages: one page per slide,
each the slide's aspect within 1% (decision D-6). Every print of a document or a print-CSS deck, and the slide
index's reading of each slide, waits for what scripts reveal first (the scripted settle, decision D-5).

| File | Kind (9.4) | What it shows | Expected |
|---|---|---|---|
| `page-css.html` | generic, 3 slides, 1280×720 | 6.9 print CSS: an `@page { size: 1280px 720px }` rule and a `@media print` layout | Save as PDF uses printToPDF with `preferCSSPageSize`: 3 pages of 960 × 540 pt |
| `media-print.html` | generic, 4 slides | print CSS without `@page`: a `@media print` that puts each slide on its own page of the default paper | one page per slide, but Letter pages are not the 16:9 slide's aspect (decision D-6), so raster: 4 pages at the slide's aspect |
| `media-print-flow.html` | generic, 4 slides | a `@media print` that breaks after every second slide (two slides a page) | not one page per slide, so raster: 4 pages at the slide's aspect |
| `linked-print.html`, `linked-print.css` | generic, 3 slides, 1600×900 | the `@page` rule and print layout live in a sibling sheet, served from the `-files` origin (cross-origin to the page) | detected through the render view's debugger: print-css, 3 pages of 1200 × 675 pt |
| `title-escape.html` | generic, 3 slides | a `<title>` with `&`, `<`, `>`, quotes, parentheses, a backslash, `½`, accented letters and an emoji | the PDF's title (and the print-only document's `<title>`) is that text exactly |
| `arrowdown.html` | generic, 4 slides | an engine that moves on ArrowDown and ArrowUp only (6.7 Index replay with `Session.deckNav`; PHASE0-FINDINGS Still open) | with deckNav `{forward: 'ArrowDown'}` every slide is indexed and rendered; without it only slide 1 |
| `builds-many.html` | generic, 3 slides | five key-gated build steps on slide 1 (opacity), more than the walk's three retries | a press that shows a build step uses up no retry (F25): every slide is reached for thumbnails and PDF pages |
| `motion-text.html` | generic, 3 slides | a deck that reads `prefers-reduced-motion` once at load | background renders emulate reduced motion: the index reads "Motion reduced" |
| `find-strip.html` | generic, 3 slides | a slider: every slide renders side by side and the strip moves, so findInPage also finds the slides off screen | Find lists `quartz` on slides 1 and 3; highlighting slide 3's second match reaches findInPage's third match, inside the view |
| `pagemargin.html` | generic, 4 slides, 1280×720 | only `@page { margin: 0 }`, no print layout; one slide shown at a time, in red, green, blue and yellow | Chromium prints the screen layout (slide 1 alone), not the deck as slide pages: raster, 4 pages of 960 × 540 pt in slide order (decision D-6) |
| `pagesize.html` | generic, 4 slides, 1280×720 | only `@page { size: 1280px 720px; margin: 0 }`, the slide's own size | as `pagemargin.html`: raster, 4 pages in slide order |
| `skip-deck.html` | generic, 5 slides, `#id` hash | ArrowRight and PageDown skip slide 3 (blue); a hashchange shows any slide, so the render walk reaches slide 3 by its hash, last | raster PDF and Print: 5 pages in slide order (red, green, blue, yellow, magenta) |
| `media-sheet.css` and `media-import.html`, `media-link.html`, `media-style.html`, `media-wrapper.html` (+ `media-wrapper.css`), `media-atmedia.html` | generic, 4 slides, 720×932 (Letter's aspect) | one print layout (every slide, one per page, no `@page` rule) behind `@import url(…) print`, `<link media="print">`, `<style media="print">`, a linked sheet that imports it with `print`, and `@media print` (the control) | each wiring is the deck's print CSS: print-css, 4 Letter pages, text selectable |
| `media-screen.html` (+ `media-screen.css`) | generic, 4 slides, 720×932 | the negative control: an `@page` rule and a print layout in a sheet linked with `media="screen"` | that sheet applies to no print: raster, 4 pages |
| `chart-doc.html` | single document | a canvas bar that `requestAnimationFrame` grows over 1000 ms (it writes BAR COMPLETE when done) and two paragraphs a timer fills at 300 and 800 ms | Save as PDF and Print run the scripted settle first (decision D-5): the bar whole, BAR COMPLETE and both timer texts in the PDF |
| `timer-print.html` | generic, 3 slides, 1280×720 | a print-CSS deck (an `@page` size matching its slides) whose slide text a 500 ms timer fills | print-css, 3 pages, each with TIMER FILLED n, never PENDING |
| `timer-deck.html` | generic, 3 slides | each slide's paragraph is written 600 ms after the slide becomes current | the slide index reads each slide after the scripted settle: Find `zebra` has a hit on every slide; the rail's thumbnails come from the same walk |
| `canvas-deck.html` | generic, 3 slides | each slide's bar is drawn on a canvas by `requestAnimationFrame`, growing for 1000 ms after the slide arrives, with no DOM change | the adaptive settle sees the picture still moving after the DOM went still and keeps the full wait: every raster page has its whole bar |
| `timer-doc.html` | single document | two paragraphs a timer fills 600 ms after load | Find `quokka` has both |
| `find-blocks.html` | single document | a heading "Growth" over "Plan ahead…", and two real "growth plan" paragraphs far below | Find `growth plan` lists the two real ones only (no match across a block boundary), and each highlights its own paragraph |
| `find-dashes.html` | generic, 3 slides | "2020–2021" (en dash) and "2020-2021" twice; "Bold`<b>`er`</b>` moves first." then "Then bolder moves win."; a heading over a paragraph | Find `2020-2021` lists all three and each highlights its own spelling (findInPage keeps dashes apart); `bolder moves` lists both; `growth plan` only the real one |
| `document.html` | single document | h1–h3 sections, text before the first heading, a hidden heading and paragraph, accented words, and a notes block | one index entry per rendered h1–h3 section plus the text before; PDF as a document (Letter or A4 by locale); the notes block's text never appears |
| `no-title-doc.html` | single document | no `<title>` | Chromium would title the PDF with the page's URL (which names the docId); Blueline's PDF has no title and no `blueline://` anywhere |

The committed decks in `fixtures/decks/` (reveal-hash, generic-index, generic-hash, report) are used as well,
and `test/parity/fixtures/delayed-build.html` (a panel a timer shows 400 ms after each slide arrives), whose raster
pages must keep their panel under the adaptive settle. A copy of `reveal-hash` with an `@page` rule added is made
by `test/e2e/render-products-pdf.spec.ts` itself: Chromium prints reveal.js's paper handout for it (9 pages for 8
slides), so it is rendered slide by slide.
