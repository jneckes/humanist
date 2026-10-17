# Render fixtures (Phase 1: render products)

Small synthetic documents for the slide index, thumbnails, Find, Save as PDF and Print (SPEC 6.7, 6.9; section
11 Render parity and PDF). Each is meant to show one rule; `test/e2e/render-products-*.spec.ts` and the unit
tests in `test/unit/app/{slide-index,thumbnails,find,pdf,print,args-pdf}.test.ts` use them. None holds client
text.

| File | Kind (9.4) | What it shows | Expected |
|---|---|---|---|
| `page-css.html` | generic, 3 slides, 1280×720 | 6.9 print CSS: an `@page { size: 1280px 720px }` rule and a `@media print` layout | Save as PDF uses printToPDF with `preferCSSPageSize`: 3 pages of 960 × 540 pt |
| `media-print.html` | generic, 4 slides | print CSS without `@page`: a `@media print` that puts each slide on its own page | printToPDF prints one page per slide, so print-css: 4 pages on the default paper |
| `media-print-flow.html` | generic, 4 slides | a `@media print` that breaks after every second slide (two slides a page) | not one page per slide, so raster: 4 pages at the slide's aspect |
| `linked-print.html`, `linked-print.css` | generic, 3 slides, 1600×900 | the `@page` rule and print layout live in a sibling sheet, served from the `-files` origin (cross-origin to the page) | detected through the render view's debugger: print-css, 3 pages of 1200 × 675 pt |
| `title-escape.html` | generic, 3 slides | a `<title>` with `&`, `<`, `>`, quotes, parentheses, a backslash, `½`, accented letters and an emoji | the PDF's title (and the print-only document's `<title>`) is that text exactly |
| `arrowdown.html` | generic, 4 slides | an engine that moves on ArrowDown and ArrowUp only (6.7 Index replay with `Session.deckNav`; PHASE0-FINDINGS Still open) | with deckNav `{forward: 'ArrowDown'}` every slide is indexed and rendered; without it only slide 1 |
| `builds-many.html` | generic, 3 slides | five key-gated build steps on slide 1 (opacity), more than the walk's three retries | a press that shows a build step uses up no retry (F25): every slide is reached for thumbnails and PDF pages |
| `motion-text.html` | generic, 3 slides | a deck that reads `prefers-reduced-motion` once at load | background renders emulate reduced motion: the index reads "Motion reduced" |
| `find-strip.html` | generic, 3 slides | a slider: every slide renders side by side and the strip moves, so findInPage also finds the slides off screen | Find lists `quartz` on slides 1 and 3; highlighting slide 3's second match reaches findInPage's third match, inside the view |
| `document.html` | single document | h1–h3 sections, text before the first heading, a hidden heading and paragraph, accented words, and a notes block | one index entry per rendered h1–h3 section plus the text before; PDF as a document (Letter or A4 by locale); the notes block's text never appears |
| `no-title-doc.html` | single document | no `<title>` | Chromium would title the PDF with the page's URL (which names the docId); Blueline's PDF has no title and no `blueline://` anywhere |

The committed decks in `fixtures/decks/` (reveal-hash, generic-index, generic-hash, report) are used as well.
