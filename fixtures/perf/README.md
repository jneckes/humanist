# Performance fixtures (Phase 1 exit gate: Speed)

SPEC 10 Phase 1: "A 2 MB deck reaches first paint in under 1 s on an Apple-silicon Mac." The deck is generated,
not committed: 2 MB is too large for the repository, and the generator reproduces it byte for byte.

    node fixtures/perf/generate.mjs                # writes fixtures/perf/out/perf-2mb.html (gitignored)
    node fixtures/perf/generate.mjs --out x.html   # anywhere else

## The deck

Built like the real decks Blueline opens (docs/PHASE0-FINDINGS.md, Josh's real decks): one self-contained HTML
file with no external references.

| Part | What |
|---|---|
| Slides | 30 `section.slide` elements on a 1600×900 stage: title, bullets, image and text, bar chart (inline SVG), table, quote, KPI tiles, split layout, closing slide |
| CSS | one inline `<style>` (3.4 KB): layout, type, a fade between slides that `prefers-reduced-motion` turns off |
| Engine | one inline `<script>` (1.5 KB): ArrowRight/ArrowLeft, PageDown/PageUp, Space, Home, End; the slide in the hash (`#/1` … `#/30`); scaled to fit the window; a progress bar |
| Images | 14 distinct photo-like PNGs (gradient, soft discs, grain), one on each picture slide, inline as base64 `data:` URLs (2.08 MB of the file); their size is found by bisection so the file is at least 2 MiB (2,097,152 bytes) |
| Text | synthetic business wording from a fixed word list; no client text |

Deterministic: a seeded PRNG (mulberry32), no dates, no `Math.random`; the PNGs are deflated at level 9. The
generator prints the size and the sha256. Current output: 2,114,952 bytes, 284×178 images,
sha256 `d0ab43283b156549f88d05a47da4000f1340a84c2542ae3e71787dd5bde5f2ed` (Node 22; zlib's level-9 output
is stable across Node releases in practice, but if a Node upgrade changes it, only the hash changes, not the
deck's shape or size class).

## Measuring

    npm run build
    node scripts/first-paint.mjs            # warm and cold, Trusted and Protected, median of 5

`scripts/first-paint.mjs` generates the deck if it is missing. Results and method: docs/PHASE1-RESULTS.md.
