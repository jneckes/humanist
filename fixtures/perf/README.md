# Performance fixtures (Phase 1 exit gate: Speed)

SPEC 10 Phase 1: "A 2 MB deck reaches first paint in under 1 s on an Apple-silicon Mac." The deck is generated,
not committed: 2 MB is too large for the repository, and the generator reproduces it byte for byte.

    node fixtures/perf/generate.mjs                # writes fixtures/perf/out/perf-2mb.html (gitignored)
    node fixtures/perf/generate.mjs --out x.html   # anywhere else

## What a real deck is made of

What it costs to open a deck depends on what the file holds, not only on its size: the map (9.2) parses all of
it and parses every inline script again with acorn, and the page compiles the scripts and decodes the fonts.
The first version of this deck was 98.8% base64 images (25 KB of markup, 1.5 KB of script), the cheapest kind of
2 MB file to open (review finding 31). The generator now follows the composition of Josh's twelve real decks
(fixtures/local, labels D1–D12; measured 2026-10-17, bytes of the file; data URLs counted with any MIME type,
`data:font/woff2` included):

| Part | D1–D12: range | D1–D12: median | This deck |
|---|---|---|---|
| File size | 84 KB – 1.15 MB | 467 KB | 2.00 MB (2,099,025 bytes) |
| Inline script (data URLs inside it not counted) | 1.3 – 43% of the file (3 – 193 KB) | 13% | 25% (513 KB) |
| Library code (inline blocks of 20 KB or more: GSAP and its plugins, and the like) | in 8 decks: 2 – 35% | 17% of those 8; D6–D9: 21 – 35% | 24.5% (502 KB in 6 blocks of 20 – 235 KB); with its seventh library block (10 KB), 25.0% (512 KB) |
| `@font-face` fonts, base64 woff2 | in 11 decks, 2 – 14 faces: 0 – 71% (0 – 679 KB) | 34% (142 KB, 5 faces) | 34.2% (701 KB, 12 faces) |
| Images, base64 | in 5 decks: 0 – 61% | 0% | 34.1% (698 KB, 10 PNGs) |
| CSS, fonts not counted | 23 – 122 KB | 55 KB | 58 KB |
| Markup (inline SVG included) | 29 – 93 KB | 50 KB | 79 KB |
| Elements | 705 – 2,061 | 944 | 1,801 |
| Visible text | 5 – 26 KB | 12 KB | 11 KB |
| Writes the slide into the URL hash on load | 10 of 12 | | yes (`#/1`) |

So: library code at the share of the decks that inline an animation library (more than the median of all
twelve, which makes this deck harder to open, not easier), fonts at the median share, CSS, markup and text at the
size of the larger real decks, and images for the rest. The real decks are all smaller than 2 MB; this is how one
of them would reach 2 MB.

## The deck

One self-contained HTML file with no external references:

| Part | What |
|---|---|
| Slides | 30 `section.slide` elements on a 1600×900 stage in 14 layouts: title, bullets, image and text, bar chart and line chart (inline SVG), table, quote, KPI tiles with sparklines, split, timeline, team, comparison, agenda, closing slide; a decorative inline SVG on each slide and SVG icons in the lists (about 130 inline SVGs) |
| Fonts | 12 `@font-face` faces in two families and a mono, `font-display: swap`, base64 woff2 in the head `<style>`: synthetic TrueType outlines (the text renders as shapes, not letters, once a face swaps in), 320 glyphs each (ASCII, Latin-1 and Latin Extended-A, and .notdef), packed with brotli |
| CSS | layout, type and a fade between slides that `prefers-reduced-motion` turns off, plus utility and theme rules a design tool emits (58 KB) |
| Library code | 7 inline `<script>` blocks at the end of the body, a UMD wrapper each, like a minified animation library and its plugins: small functions, prototype methods, object literals of defaults, string tables, easing maths, regular expressions, template literals, a few HTML strings. Each defines a global and does a little set-up work when it loads; nothing touches the page. Synthetic: no third-party code |
| Engine | one inline `<script>` (1.4 KB): ArrowRight/ArrowLeft, PageDown/PageUp, Space, Home, End; the slide in the hash (`#/1` … `#/30`), written on load as most real decks do; scaled to fit the window; a progress bar |
| Images | 10 distinct photo-like PNGs (gradient, soft discs, grain), one on each picture slide, inline as base64; their size is found by bisection so the file is at least 2 MiB (2,097,152 bytes) |
| Text | synthetic business wording from a fixed word list; no client text |

Deterministic: a seeded PRNG (mulberry32), no dates, no `Math.random`; the PNGs are deflated at level 9 and the
fonts compressed with brotli at quality 11. The generator checks that every library block is valid JavaScript
whose load-time code runs without an error (`node:vm`), and prints the size, the composition and the sha256.
Current output: 2,099,025 bytes, 193×121 images, sha256
`b5fa39a64964fb1bd53f1c9b3202ac14b3467308672e2c5e67f58f525152e490` (Node 22; zlib's level-9 and brotli's
quality-11 output are stable across Node releases in practice, but if a Node upgrade changes them, only the hash
changes, not the deck's shape or size class).

## Measuring

    npm run build
    node scripts/first-paint.mjs            # warm and cold, Trusted and Protected, 5 counted runs each

`scripts/first-paint.mjs` generates the deck if it is missing. It finds the deck view by its URL without the
fragment, counts a run that never paints as a failure (the gate is not met when any counted run failed), and
prints the main-process share in ms per MB next to its figure. Results and method: docs/PHASE1-RESULTS.md.
