# Phase 1 results (exit gate)

SPEC 10, Phase 1, names five exit criteria. This page reports the three that are measured by machine here:
render parity, PDF parity and first paint. Security has its own suite (`npm run test:security`); real use is
Josh's week with a Mac build.

The gate's figures (render parity, PDF parity, first paint), the suites, the coverage and the PDF cost sample
were measured in the Linux dev container on 2026-10-18, on the Phase 1 tree with review round 1's fixes (commit
64e645a; "Review round 1", below), built from a clean `dist`, with the harnesses this page describes; the gate's
runs were made one at a time, with the machine otherwise idle. Some figures come from earlier runs on other
trees, and each says so where it appears: from review round 1's fix round (2026-10-17, on f34b967 and on
trees with part of the fixes): the before-and-after table of the adaptive wait, first paint before the speed
fixes, and D2's and D12's unseeded figures; from the Phase 1 integration (2026-10-17, on f34b967): the D11
canvas repro, the charset experiment, the integration run's D5 PDF pages and the reader-only E2E result. The
machine-readable results are written by the scripts (paths under each section); they are not committed. Josh's
12 decks are called D1 to D12 only, as in docs/PHASE0-FINDINGS.md. The suites and the other checks are at the
end ("Integration").

| Criterion | Gate (SPEC 10) | Result here |
|---|---|---|
| Render parity, committed fixtures | every slide ≤ 0.5% of pixels different (per-channel tolerance 2) | **met**: 49 decks, 212 slides, each in both trust states: all 424 comparisons identical to the byte, and every slide's control render identical too (no slide nondeterministic) |
| Render parity, Josh's decks | as above | **met: all 12**, in both trust states: 370 of 386 comparisons identical to the byte. Worst: D11 slide 13, 0.343% (a canvas the plain render draws before its embedded font has loaded; deterministic: its control render is identical). D2 and D12, whose decoration is random, pass under the seeded `Math.random` (D2 worst 0.071%, D12 identical); two D5 slides in both trust states (slide 1, its ticker, and slide 7) and one D1 slide in Trusted view are flagged nondeterministic by the control render and are within the gate. D2's charset-decoding text differences are recorded, not a gate |
| PDF | right page count; each raster page ≤ 1% from Blueline's render of its slide, each page Chromium prints (print-CSS decks, documents) ≤ 1% from Chromium's own print of the file (decision D-6; spec-amendments) | **met**: 49 committed and 12 of Josh's decks, each in both trust states: 122 PDFs, 790 pages, every page count right, every printed page the size of Chromium's own print. Raster pages are identical to their slide renders except on `reveal-hash` (worst 0.032%: reveal.js's animated navigation arrows), the 2 MB deck (1 pixel by 1 level on 3 of its 30 pages), D5 (worst 0.687%, its ticker slide), D11 and D12 (under 0.001%); print-CSS and document pages are identical to Chromium's own print (0.000%) |
| Security | the suite passes in both trust states | **met**: 57 tests, 51 pass and 6 are the expected failures SECURITY.md describes: the two DNS channels, and the file-drop limits for a frame rewritten with `document.open()` or made `about:blank` inside a shadow root, each in both trust states (`npm run test:security`, as `bltest` with the OS sandbox on) |
| Speed | a 2 MB deck reaches first paint in < 1 s | **met here** (Linux, median of 5 counted runs, every run painted, the real-shaped 2 MB deck below): 430 ms (Trusted) and 413 ms (Protected) from the open request with the app running, 831 and 810 ms from a cold start; one of the ten cold starts took 1,014 ms; recheck on the Mac |

## Environment

- Linux container (a Firecracker VM), kernel 6.18, 4 CPUs, 15 GB, no GPU; Xvfb with a 3840×2160 screen (an
  offscreen window is clamped to the X screen, PHASE0-FINDINGS F4).
- Electron 44.7.2 (Chromium 152.0.7977.149, Node 24.21.0), the app built with `npm run build`. Timings are
  machine-dependent; compare figures within one run, and treat the Mac as the gate machine for Speed.
- As root with `--no-sandbox` (the OS sandbox is off; the in-process sandbox flags still apply). The security
  suite runs as `bltest` with the sandbox on; these harnesses do not need it.
- Offline: the harnesses run Electron without the proxy variables of the environment (see "Network" below).
- System fonts include Inter and the DejaVu and Liberation families; whatever a deck asks for and the
  machine lacks falls back the same way in both renders.

## Render parity

    npm run build
    node scripts/parity.mjs --committed --perf --trust both --pdf     # every committed fixture and the 2 MB deck
    node scripts/parity.mjs --local --trust both --pdf                # Josh's decks (fixtures/local, gitignored)
    npx playwright test -c test/parity/playwright.config.ts           # the committed check (fixtures and controls)

Results: `test-results/parity/parity.json` (or `--out`), diff images in `test-results/parity/run/diff/`.

### Method

SPEC asks for Blueline's render "at the design size" against "Chromium headless (same version, same
viewport)". Electron 44's own Chromium with nothing of Blueline's loaded is that (docs/PHASE1-PLAN.md), so the
renders are made in one Electron process by the harness (`test/parity/harness/main.ts`, its own Electron main,
so the app's entry point is untouched):

- **Blueline's render** is the render service exactly as thumbnails and PDF pages use it (6.7 Background
  renders, 9.1 Render service): the file opened by `loadDocument` in its own trust state and partition, with the
  session policy and the `blueline://` handler a document window installs, the served stamped copy (notes
  block removed; resource hints removed when Protected), the shipped deck preload in render mode, a hidden
  offscreen `BrowserWindow` from the document's render pool. `visitSlides` checks once per walk, right after the
  document loads and before the first slide, that render mode mounted no overlay, and refuses a view that shows
  one; in render mode the deck preload builds no UI (`preload/deck.ts`), so nothing can mount the overlay after
  that check. This is the render service's own view, which the thumbnails, Find and the PDF use, not the visible
  deck view the reader sees (which does mount the overlay host).
- **The plain render** is a hidden offscreen `BrowserWindow` of the same size and `deviceScaleFactor`, the same
  webPreferences minus the preload, a fresh partition with nothing installed (no handler, no policy), loading
  the original file's `file://` URL (`test/parity/harness/plain-view.ts`).
- **The control** is a second plain render of the same file, made the same way in a partition of its own.

Every render gets the same steps:

1. **Viewport.** The 6.9 design size from the slide index (reveal.js width and height, else the slide element's
   box at 1600×900, else 1600×900; documents 1600×900), at `deviceScaleFactor` 2: a 1600×900 slide is a
   3200×1800 capture.
2. **Randomness.** Every frame of every render (Blueline's render views for the index, the PDF and the parity
   walk; the plain render; its control; the plain print) gets the same seeded `Math.random` (`mulberry32`, seed
   `0x2f6b1d35`) before any page script, through `Page.addScriptToEvaluateOnNewDocument` on each window's own
   debugger. The harness installs it in its own process (it wraps `RenderView.load`); the app never does.
   `Date`, `performance.now` and `crypto.getRandomValues` are left alone: no committed fixture needs them fixed,
   and the control shows any deck that depends on them (step 10).
3. **Motion.** `prefers-reduced-motion: reduce` through each window's own debugger
   (`Emulation.setEmulatedMedia`, after an about:blank load), as background renders do (Josh's decision 1).
4. **Navigation**, by the same means in every render, in the order Blueline's walk reaches the slides
   (`slide-index.ts visitSlides`): reveal.js by `Reveal.slide(h, v)` in the page's world, then every fragment
   shown (`Reveal.slide(h, v, 1000000)`, as thumbnails and PDF pages show it); generic engines by the same
   trusted keys (`sendInputEvent` after `focus()`, Accelerator names, 1 s wait, the F25 patience of
   `pressPatiently`), the hash for slides keys do not reach; documents by scrolling the section's heading to the
   top. The plain windows know their current slide from the render agent's own 9.4 detection (`core/slides`),
   run in an isolated world (`plain-probe.ts`), never the page's world.
5. **Settle.** 6.7 step 3 (`document.fonts.ready`, two animation frames, up to 1.5 s for finite animations:
   `RenderView.waitStable`), then what the slide's scripts reveal (`RenderView.waitScripted`: at least 1.5 s on
   the slide, then 400 ms without a DOM change, at most 3 s), then step 3 again, then running animations paused
   (`pauseAnimations`). Blueline's walk does this as every still image does, with decision D-5's adaptive wait
   (a slide whose full wait saw no late change may get only the 400 ms quiet wait on a later walk of the same
   version). The plain render and its control get the very same methods (the plain windows borrow RenderView's
   probe methods), always with the full scripted wait, which is never shorter.
6. **Dwell.** Every render stays on the slide for at least 2 s (`--dwell`) from its own arrival, the settle
   included, before anything is frozen or captured. The harness navigates the plain render only once Blueline's
   has arrived and settled, so without the dwell a script-timed reveal (a `setTimeout` build, a typewriter) could
   be further along in Blueline's capture than in the plain one; with it, every render shows at least the deck's
   first 2 s on the slide. Each slide records the dwell times.
7. **Freeze**: every animation or transition still present is finished (finite) or stopped at time 0
   (infinite), so an infinite animation shows the same frame in every render.
8. **Stable frame.** Captures (`capturePage`) repeat 120 ms apart until two consecutive ones are byte-identical,
   for up to 3 s; the result records whether each side became stable.
9. **Same slide.** For a deck, the plain render reaches each slide by the means Blueline's walk used
   (`Reveal.slide`, the same keys, the hash) and confirms it with the render agent's 9.4 detection; a slide it
   cannot reach fails. For a document, both renders scroll the section's heading to the top, and nothing more is
   confirmed. The visible-text signature (`RenderView.visibleTextSignature`), the scroll position and
   `document.characterSet` of both renders are recorded for every slide. Slides whose text or scroll position
   differ are listed per deck (`textDiffers`, `scrollDiffers`, and a line of the summary); they are not part of
   the verdict. The committed check (`parity.spec.ts`) requires them to agree on its fixtures.
10. **Control.** The control is compared with the plain render on every slide. A slide whose control differs at
    all is listed as **nondeterministic** (`nondeterministic`, and a line of the summary). The verdict does not
    change for it: over the gate it fails, because the control never excuses a difference; within the gate it
    passes and stays listed.
11. **Compare** the bitmaps of Blueline's and the plain render (`nativeImage.toBitmap()`, BGRA) pixel by pixel
    (`harness/compare.ts`): the share of pixels that differ at all ("exact") and the share whose largest channel
    difference is above the tolerance (the gate's figure), with a histogram of the differences, and the number
    of slides identical to the byte. A failing slide gets a diff picture (red over tolerance, amber within, the
    slide in grey) and both renders as PNG (and the control, when it differs).

Negative controls prove the comparison can fail (`test/parity/parity.spec.ts`, fixtures in
`test/parity/fixtures/`). `nondeterministic.html` paints a box on slide 1 in a colour from
`crypto.getRandomValues`, which the harness does not seed: slide 1 must fail (16% of its pixels) and be listed as
nondeterministic, and slides 2 and 3 must be identical. `shift6.html` and `shift8.html` raise every colour of
Blueline's render (never the plain one) by 6 and by 8 levels: every slide must fail (at the former tolerance of
8, both passed). `text-differs.html` shows `location.protocol` on slide 2: it is listed under `textDiffers` and
judged on its pixels. `page-size-diverge.html` is a print-CSS deck whose plain print has larger pages: its PDF
must fail on page sizes, with pdftoppm and with `--no-pdftoppm`. `seeded-random.html` draws with `Math.random`
and must be identical in all three renders and in its PDF. `delayed-build.html` reveals a panel 400 ms after each
slide arrives: its raster PDF pages must show it (PDF, below).

Three options diagnose a failure; the gate is never measured with them. `--unseeded` leaves each render's
`Math.random` as the page has it, which shows a deck's own randomness (D2's dash field, D12's grain).
`--no-pdftoppm` compares printed pages as a machine without poppler does. `--network` keeps the proxy variables
(see Network). `--seed-random` and `--self-check` are accepted and say that they are part of every run now.

### Tolerance

A pixel counts as different when one of its channels differs by **more than 2 of 255**. The gate is the share of
such pixels. The share of pixels that differ at all ("exact"), and the number of slides identical to the byte,
are reported beside it, and every result's histogram shows where the differences fall.

Why 2: two renders of the same page by the same Chromium on the same machine are byte-identical here: all 424
committed comparisons are identical, and so are their 424 control renders. The tolerance is only for rounding (a
colour-space conversion or a blend rounded the other way: one or two levels), as may happen on a Mac's GPU path.
2 levels is below what an eye can see on a flat area: a step of 3 to 4 levels on one channel is about one
just-noticeable difference (CIEDE2000 about 1), and +8 on every channel is 1.6 to 3.1. A change that moves every
pixel of Blueline's render by 3 levels or more fails every slide (`shift6.html`, `shift8.html`); the former
tolerance of 8 passed both, at 0.000% and 0.097% over it (in the parity fix of review round 1, with the
harness as it was). Antialiased glyph edges that move by a pixel differ by 40 to 250 levels and are counted at
any tolerance (D11's fallback fonts, below).

The tolerance hides little in these runs. D12's random grain, which a tolerance of 8 used to absorb, is
identical under the seeded `Math.random`; unseeded (`--unseeded`, diagnosis only), 15 of D12's 18 slides fail at
2 (worst 3.776%, largest channel difference 9; measured in the parity fix of review round 1). Read with no
tolerance at all, every committed slide would still pass, and so would every slide of Josh's decks but three:
D5's slide 1 in Protected view (0.756% of pixels differ at all, about as many as its own two plain loads differ
by: 43,519 and 43,572 pixels, the ticker) and D11's slide 13 in both trust states (0.649%: the font race,
below). SPEC does not say when a pixel counts as different; the reading used here is proposed in
`docs/spec-amendments/README.md`.

### Results: committed fixtures

49 decks: all of `fixtures/decks/*.html` (18), `decks/reveal-hash/index.html`, all of `fixtures/render/*.html`
(29: the set grew with the render, PDF and Find fixes of review round 1) and the generated 2 MB deck
(`perf/perf-2mb.html`). 212 slides, each rendered Protected and Trusted: **424 comparisons, all identical to the
byte**, and all 424 control renders identical to their plain renders (no slide nondeterministic). Every slide was
reached in both renders, with the same visible text, scroll position and `document.characterSet` (no
`textDiffers`, no `scrollDiffers`); every capture was stable; the difference histogram is empty. None of these
fixtures loads anything from the network. The run (`--committed --perf --trust both --pdf`) took 63.5 minutes.

| Deck | Kind | Slides | Worst slide, Protected | Worst slide, Trusted | PDF | Pages / expected | Worst page, P / T |
|---|---|---|---|---|---|---|---|
| `decks/bom.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/crlf.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/csp-default-none.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/csp-nonce-strict-dynamic.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/csp-self-inline.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/entities.html` | generic | 6 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 6 / 6 | 0.000% / 0.000% |
| `decks/generic-hash-writeonly.html` | generic | 6 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 6 / 6 | 0.000% / 0.000% |
| `decks/generic-hash.html` | generic | 5 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 5 / 5 | 0.000% / 0.000% |
| `decks/generic-index.html` | generic | 6 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 6 / 6 | 0.000% / 0.000% |
| `decks/inline-markup.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `decks/js-templates.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `decks/json-data.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `decks/keys-prevent-default.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `decks/notes-block.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/report.html` | scroll | 12 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 5 / 5 (plain print 5) | 0.000% / 0.000% |
| `decks/single.html` | single | 5 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 1 / 1 (plain print 1) | 0.000% / 0.000% |
| `decks/unicode-edit-points.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/windows-1252.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/reveal-hash/index.html` | reveal | 8 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 8 / 8 | 0.032% / 0.025% |
| `render/arrowdown.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `render/builds-many.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `render/canvas-deck.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `render/chart-below-doc.html` | single | 2 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 2 / 2 (plain print 2) | 0.000% / 0.000% |
| `render/chart-doc.html` | single | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 1 / 1 (plain print 1) | 0.000% / 0.000% |
| `render/document.html` | single | 5 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 2 / 2 (plain print 2) | 0.000% / 0.000% |
| `render/find-blocks.html` | single | 1 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 4 / 4 (plain print 4) | 0.000% / 0.000% |
| `render/find-dashes.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `render/find-preline.html` | scroll | 1 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 5 / 5 (plain print 5) | 0.000% / 0.000% |
| `render/find-strip.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `render/linked-print.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 3 / 3 (plain print 3) | 0.000% / 0.000% |
| `render/media-atmedia.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 4 / 4 (plain print 4) | 0.000% / 0.000% |
| `render/media-import.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 4 / 4 (plain print 4) | 0.000% / 0.000% |
| `render/media-link.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 4 / 4 (plain print 4) | 0.000% / 0.000% |
| `render/media-print-flow.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `render/media-print.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `render/media-screen.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `render/media-style.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 4 / 4 (plain print 4) | 0.000% / 0.000% |
| `render/media-wrapper.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 4 / 4 (plain print 4) | 0.000% / 0.000% |
| `render/motion-text.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `render/no-title-doc.html` | single | 1 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 1 / 1 (plain print 1) | 0.000% / 0.000% |
| `render/page-css.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 3 / 3 (plain print 3) | 0.000% / 0.000% |
| `render/pagemargin.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `render/pagesize.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `render/skip-deck.html` | generic | 5 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 5 / 5 | 0.000% / 0.000% |
| `render/timer-deck.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `render/timer-doc.html` | single | 2 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 1 / 1 (plain print 1) | 0.000% / 0.000% |
| `render/timer-print.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 3 / 3 (plain print 3) | 0.000% / 0.000% |
| `render/title-escape.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `perf/perf-2mb.html` | generic | 30 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 30 / 30 | 0.000% / 0.000% |

`render/arrowdown.html` is run with `Session.deckNav` set to ArrowDown, as the visible view would have recorded it
(fixtures/render/README.md); without it neither render goes past slide 1.

### Results: Josh's decks

Josh's 12 decks (`fixtures/local`, gitignored), 193 slides, each rendered Protected and Trusted: **386
comparisons, 370 identical to the byte, all within the gate: all 12 pass** in both trust states. All are generic
engines; every slide was reached by keys in both renders. The run (`--local --trust both --pdf`) took 66.2
minutes.

| Deck | Kind | Slides | Worst slide, Protected | Worst slide, Trusted | PDF | Pages / expected | Worst page, P / T |
|---|---|---|---|---|---|---|---|
| D1 | generic | 20 | 0.000% (exact 0.000%) | < 0.001% (exact 0.147%), slide 19 | raster | 20 / 20 | 0.000% / 0.000% |
| D2 | generic | 11 | 0.071% (exact 0.072%), slide 9 | 0.071% (exact 0.072%), slide 9 | raster | 11 / 11 | 0.000% / 0.000% |
| D3 | generic | 11 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 11 / 11 | 0.000% / 0.000% |
| D4 | generic | 16 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 16 / 16 | 0.000% / 0.000% |
| D5 | generic | 17 | 0.037% (exact 0.756%), slide 1 | 0.036% (exact 0.440%), slide 1 | raster | 17 / 17 | 0.687% / 0.686% |
| D6 | generic | 11 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 11 / 11 | 0.000% / 0.000% |
| D7 | generic | 16 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 16 / 16 | 0.000% / 0.000% |
| D8 | generic | 11 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 11 / 11 | 0.000% / 0.000% |
| D9 | generic | 17 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 17 / 17 | 0.000% / 0.000% |
| D10 | generic | 24 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 24 / 24 | 0.000% / 0.000% |
| D11 | generic | 21 | 0.343% (exact 0.649%), slide 13 | 0.343% (exact 0.649%), slide 13 | raster | 21 / 21 | < 0.001% / < 0.001% |
| D12 | generic | 18 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 18 / 18 | < 0.001% / < 0.001% |

Eight decks are identical to the byte on every slide in both trust states, D12 among them now that `Math.random`
is seeded. The 16 comparisons that are not identical are all within the gate, each cause understood:

- **D2: the deck's randomness, and its encoding.** The deck places a field of short dashes and scrambles a few
  labels with `Math.random()`. With the seeded `Math.random` every render uses (D-10) that field matches. What
  remains, on slides 1, 7, 8 and 9 (0.023–0.071% over the tolerance; the control render identical to the plain
  one on each), is a real difference in Blueline's favour, and the recorded visible-text difference on those
  slides: the file declares no charset and its first non-ASCII byte is at 706,401 of 977,650, so Chromium's
  `file://` load decodes it as windows-1252 (a middle dot shows as "Â·"; `document.characterSet` is
  `windows-1252` in the plain render and `UTF-8` in Blueline's), while Blueline serves a file that passes the
  UTF-8 check as `charset=utf-8` (9.1 Charset) and shows it as written. Chromium detects UTF-8 in an undeclared
  local file only when a non-ASCII byte appears in the first 256 KiB (tested at integration, on f34b967):
  `<title>t</title><style>/*` followed by 262,000 `x` and `*/</style><p>a · b</p>` decodes as UTF-8; with 263,000
  `x` it decodes as windows-1252. Chrome
  opening D2 from disk shows the same mojibake as the plain render. These are reported as `textDiffers`, not a
  gate. Unseeded (`--unseeded`, diagnosis only), D2 failed slides 1 and 11 (worst 1.165%) in the parity fix of
  review round 1.
- **D5: content that changes over time.** Slide 1 carries a ticker that runs forever (under reduced motion its
  animation cycles every millisecond): neither render's frame became stable within 3 s, and the control render
  differs from the plain render by as much as Blueline's does (0.039% against 0.037% over the tolerance,
  Protected), so the slide is listed as nondeterministic, and is within the gate. Slide 7 differs by about 20
  pixels in every render (largest channel difference 2 to 4; nondeterministic too), and slide 9 in Trusted view
  by 0.0002% (a 23×23 box, at most 5 levels).
- **D11: canvas text drawn before its font loaded, in the plain render.** Slide 13 draws a diagram's labels on
  a `<canvas>` with `@font-face` fonts embedded as `data:` URLs, from an inline script that does not wait for
  `document.fonts`. In Blueline's render the labels use the embedded fonts; in the plain render they fall back
  to the system's sans-serif and monospace (0.343%, exact 0.649%; deterministic: the control render is identical
  to the plain one, and seeding changes nothing). Repro: a page with `@font-face { font-family: Embed; src:
  url(data:font/ttf;base64,…) }` and an inline script that runs `ctx.font = '80px Embed, sans-serif';
  ctx.fillText(…)` while the page loads: 1.8% of the slide differs, the plain render showing the fallback font
  (measured at integration, on f34b967).
  The likely cause (not traced further): a local file is parsed in one go, so the script runs before the font
  has decoded, while Blueline's document arrives through `protocol.handle` in chunks and the font is ready by
  then. A race in the deck, not a change Blueline makes to it, and in Blueline's favour.
- **D1, slide 19, Trusted only**: the plain render differed from both Blueline's render and its own control by
  the same 0.147% of pixels (a 106×18 box, at most 18 levels; 0.0008% over the tolerance), so it is listed as
  nondeterministic: the plain render caught something on that slide in another state. Protected, and the fix
  round's run, were identical on every slide.
- **D12: random grain, now pinned.** A canvas overlays a random grain (`Math.random`), which used to make 50–57%
  of each slide's pixels differ between two loads (almost all by at most 8 levels), so the deck passed only on
  the old tolerance. With the seeded `Math.random`, all 18 slides are identical to the byte in both trust states.
  Unseeded (in the parity fix of review round 1), every slide's control differs and 15 of 18 slides fail at the
  tolerance of 2.

A first run with the proxy variables set differed on D3 in Protected view only (see Network); offline it is
identical. An earlier version of the harness navigated the plain render after Blueline's had settled and
captured both at once, so a typewriter effect on D5's slide 5 was further along in Blueline's capture (4.1%);
the dwell step removed that asymmetry (now 0.000%).

### What was checked as a cause of difference

| Possible cause | What the runs show |
|---|---|
| Stamps (`data-bl-e`) and the served copy | No committed fixture and no real deck differs because of them. Every Blueline render is of the stamped copy; a deck would have to select on `data-bl-e` or count attributes for it to show. |
| Sibling files from the `-files` origin (fonts, styles, scripts, images) | `reveal-hash` loads reveal.js, its CSS and theme from sibling files, `linked-print`, `media-import`, `media-link`, `media-screen` and `media-wrapper` sibling style sheets (the other four `media-*` decks have none): identical renders. |
| The overlay host | Render mode mounts none: `visitSlides` checks once per walk, after the load, and the deck preload builds no UI in render mode, so nothing can mount it later. This is the render service's own view, not the visible deck view the reader sees. |
| Protocol headers (Protected CSP `connect-src 'none'`, `X-DNS-Prefetch-Control`, resource hints removed) | Protected and Trusted renders of every committed fixture are identical to the plain render. The `charset=utf-8` header is the one header that changed a render: D2 (above). |
| Fonts not loaded | `fonts.ready` is awaited in every render; the stable-frame wait covers late swaps. Network fonts: see Network. |
| Nondeterministic content | D2 and D12 (`Math.random`): equal under the seed; `--unseeded` shows their own variance. D5's slides 1 (content that changes over time) and 7, in both trust states, and one D1 slide in Trusted view: found by the control render, which every run makes, and within the gate. |
| Load timing | D11: a canvas drawn during load gets the embedded font in Blueline and the fallback in the plain render. |

### Network

The container reaches the internet only through an HTTP proxy named in `HTTPS_PROXY`. Chromium on Linux takes
its proxy from those variables, so a plain render and a Trusted render could load a deck's Google Fonts through
it, while a Protected render could not: Protected view's proxy is `fixed_servers` to a closed port with the CDN
allowlist sent DIRECT (network-policy.ts `protectedProxyConfig`, by design: "an upstream proxy from
`HTTPS_PROXY` is not used in Protected view"), and DIRECT connections fail here. A first run of Josh's decks with
the variables set showed exactly that on D3: Protected differed from the plain render on all 11 slides (the
deck's own Inter from Google Fonts replaced by the system's Inter, text one device pixel lower; 0.008% to 0.54%
of pixels, two slides over the gate), Trusted matched exactly. So the gate runs offline: the harness starts
Electron without the proxy variables, and every render sees the same (absent) network. `--network` keeps them,
for this diagnosis.

On Josh's Mac this matters in the other direction: on a network that needs a proxy (an office, a VPN with a PAC
file), a Protected deck cannot load fonts from the allowlist at all, where Chrome could. That is 9.9 as
written, but it is a visible difference; see "What to recheck on the Mac".

## PDF

    node scripts/parity.mjs --committed --perf --trust both --pdf

For each deck, `saveAsPdf` (pdf.ts) writes the PDF exactly as Save as PDF does (6.9), with the marker copy left
out (it is a no-op on Linux and not part of the measurement). Save as PDF takes the print-CSS path only when
Chromium's print of the deck gives one page per slide, each the slide's aspect within 1% (decision D-6); every
other deck is rasterised, one page per slide, in slide order. Then:

- **Raster pages**: the page count must equal the slide count. Each page's image XObject is read back from the
  PDF with pdf-lib and inflated (`harness/pdf-pages.ts`): those are the exact pixels Blueline stored, with no PDF
  renderer in between. Each is compared with Blueline's render of its slide from the parity walk (the gate), and
  with the plain render (reported too).
- **Pages Chromium prints** (print-CSS decks and documents): the plain window prints the original file with the
  same options (`preferCSSPageSize` and `printBackground` for print CSS; `printBackground` and the locale's page
  size for documents) at the same 1600×900 viewport. The page count must equal the slide count (print CSS) or
  the plain print's count (documents), and every page's size (MediaBox) must equal the plain print's within
  0.5 pt (Chromium prints 900 px as 675.12 pt); a size mismatch fails. Both PDFs are rasterised with poppler's
  `pdftoppm` at the page size in CSS pixels at 2x, and each page is compared with the plain print's page.
  Electron's PDF viewer cannot be captured, so pdftoppm (a system tool, not an npm dependency) does the
  rasterising; without it the pixels are not compared, and the result says so (`pdftoppm: false`, and each
  PDF's `compared` text).
- For print-CSS decks, the printed page is also compared with the slide's screen render, for information: print
  CSS may lay a slide out differently on paper.

Results, committed fixtures: **98 PDFs** (each deck in both trust states), 404 pages: 64 raster PDFs (302 pages),
16 print-CSS PDFs (58 pages) and 18 documents (44 pages). Every page count is right, every printed page has the
plain print's size, and every page passes. Raster pages are identical to their slide renders except on
`reveal-hash` (at most 0.032% Protected and 0.025% Trusted, on pages 4 and 5) and on the 2 MB deck: on
`reveal-hash` the difference is reveal.js's navigation arrows in the bottom-right corner (a box of at most
128×137 device pixels), which animate whatever the motion setting, so the PDF's walk and the parity walk catch
them at different moments; the 2 MB deck's pages 6, 10 and 18 each differ from their slide render by one pixel,
by one level (none over the tolerance), in both trust states. Every page Chromium
prints is identical to Chromium's own print (0.000%): the print-CSS decks (`page-css`, `linked-print`,
`timer-print`, and the `media-*` decks whose style sheets carry their print layout through `<link media>`,
`<style media>`, `@import … print` and `@media print`) and the documents. For information, print-CSS pages
against the screen render: `page-css` 0.41%, `linked-print` 0.33%, `timer-print` 0.44%, and 24.4% for the
`media-*` decks, whose 720×932 slides print a Letter layout. `media-print` lays each slide out as a
`@media print` block on default-size paper, so its printed pages are not the slide's 16:9 shape; under D-6 the
aspect check sends it to the raster path (identical to its slide renders). `pagesize` and `pagemargin` (an
`@page` rule and no print layout: Chromium prints one page for four slides) and `media-print-flow` (two slides a
page) are rasterised by the page-count check.

Josh's decks are all raster: 24 PDFs, 386 pages for 386 slides, every page count right, and all 12 decks pass
on every page in both trust states:

- **D5** (worst page 0.687% Protected, 0.686% Trusted, on slide 1, the ticker that never stands still; slide 7's
  page 0.029% / 0.039%). In the first run of integration its pages 4, 5 and 14 differed by 1.4–4.1%: the defect
  below.
- **D11 and D12**: under 0.001% on their worst page. Every other deck's pages are identical to their slide
  renders, D2's too: its page used to differ from the parity walk's render of its slide by about 1%, because the
  PDF is a separate load and the random dash field was drawn differently; seeded, both draw the same field.

### The defect the first run found, and the fix

**Raster pages missed content that a script reveals after the slide arrives.** On D5's failing pages, list
items and a typed paragraph were missing: the deck shows them from a timer (one 1.3 s after the slide becomes
current), and `visitSlides` (slide-index.ts) captured as soon as 6.7 step 3's settle returned (fonts, two
frames, finite CSS and Web Animations). A timer is none of those. Thumbnails and Print use the same capture path
and had the same exposure. Minimal repro (committed): `test/parity/fixtures/delayed-build.html`, a panel shown by
`setTimeout(…, 400)` on each slide: render parity 0.000% (both renders dwell 2 s), raster PDF 41.7% on every page.

**Fix (integration):** before every still image of a slide, `visitSlides` calls
`RenderView.waitScripted(SCRIPTED_SETTLE)` (render-service.ts, slide-index.ts): it stays at least 1.5 s on the
slide, then until the page's DOM has had no mutation for 400 ms (a `MutationObserver` in main's own isolated
world, which the page cannot see), never longer than 3 s (a ticker or a clock never goes quiet), and then settles
again (fonts, frames, the finite animations the reveal started) before pausing animations and capturing. After
it, `delayed-build.html`'s raster pages are identical to their slide renders (0.000%), D5 passes, and
`test/parity/parity.spec.ts` runs the repro as an ordinary test. Review round 1 extended the wait to the slide
index (before it reads a slide's text), to every print of a document or a print-CSS deck, and made it adapt per
version of the file (decision D-5, below). SPEC 6.7 step 3 does not name this wait; the wording is proposed in
`docs/spec-amendments/README.md`.

### What it costs, and the adaptive wait

The wait as integration first made it cost about 1.5 s on every slide. Decision D-5 made it adapt: the index
walk, which now also takes the rail's thumbnails in the same pass, gives each slide the full wait; a later
render of the same version (Save as PDF, Print) waits only for the 400 ms of quiet on a slide
where that full wait saw neither a DOM change after a 200 ms pause nor a change in the picture, and any such
change seen later brings the full wait back for every slide. A document's page always gets the full wait (a
canvas animated below the first screen is neither in the picture nor a DOM change; review round 1's repair).

Measured with `blueline pdf` and `BLUELINE_DEBUG=1` (the index time is the walk's own log line; a page's time
is the PDF's time without the index, divided by the pages), before and after the adaptive wait, in the fix
round of review round 1 (the committed tree, and the committed tree with only the render-products fix):

| | Before (f34b967: the full wait before every still image, none in the index) | After (the index waits and takes the thumbnails; later renders adapt) |
|---|---|---|
| D1–D12, raster PDF, per page (193 pages) | 2,466 ms | 1,325 ms |
| D1–D12, slide index (all 12 decks) | 131 s | 469 s (the index now waits on every slide and takes the thumbnails) |
| D1–D12, whole `blueline pdf` (index and pages) | 607 s | 725 s (+19%) |
| Committed fixtures, raster PDF, per page | 2,278 ms | 1,229 ms |
| A 3-slide fixture's slide index | 1.5 s | 6.7 s |

A sample re-measured in this step on the current build, per page (index; whole PDF): `decks/bom.html` 742 ms
(6.8 s; 9.1 s), `decks/generic-index.html` 945 ms (14.3 s; 20.0 s), `decks/reveal-hash/index.html` 3,527 ms
(36.5 s; 64.7 s), D1 1,774 ms (62.5 s; 98.0 s), D4 812 ms (35.3 s; 48.3 s), D10 1,154 ms (45.9 s; 73.6 s): each
within 8% of the fix round's "after" figure (764, 902, 3,418, 1,755, 828 and 1,246 ms), against 1,850, 2,230,
4,812, 3,182, 2,117 and 2,179 ms before. The print-CSS `render/page-css.html` prints in 626 ms a page after its index
(the fix round: 623 ms). A document now pays its full wait once more when it prints: `decks/report.html` 3.9 s
in all (index 1.9 s, print 1.9 s for 5 pages), against 2.7 s in the fix round, before the repair gave documents
the full wait. In the app the rail fills about when it did before (the index walk takes the thumbnails), while
the titles and Find are ready only when the slower index is (D10: 4 s before, 46 s now).

## First paint

    npm run build
    node scripts/first-paint.mjs            # 5 runs each: warm and cold, Trusted and Protected

Results: `test-results/parity/first-paint.json`.

### The deck

`fixtures/perf/generate.mjs` writes `fixtures/perf/out/perf-2mb.html` (gitignored; the generator reproduces it
byte for byte, regenerated for this run with the same sha256 `b5fa39a6…`): **2,099,025 bytes**, built to the
composition of Josh's twelve real decks, not just filled with images (review finding 31). It holds 25% inline
script (513 KB), nearly all of it library code in seven inline blocks (512 KB, 25.0% of the file, like the GSAP
five of Josh's decks inline; counted as `fixtures/perf/README.md` counts Josh's decks, blocks of 20 KB or more,
that is six blocks, 502 KB, 24.5%), 34.2% `@font-face` woff2 fonts (701 KB, 12 faces), 34.1% base64 images
(698 KB, 10 PNGs), 58 KB of CSS, 79 KB of markup (1,801 elements), and it writes its slide into the URL hash on
load, as ten of the twelve do.
`fixtures/perf/README.md` gives the full breakdown against D1–D12. The point of the change: what it costs to open
a deck is in parsing the markup and the inline script (the map runs parse5 over all of it and acorn over every
inline script) and compiling the script and decoding the fonts, not in base64 image bytes; the old deck was 98.8%
images (25 KB of markup, 1.5 KB of script), the cheapest 2 MB file to open, so "met" on it did not transfer to
real decks. Its render parity is exact; its raster PDF pages are identical to their slide renders but for
one pixel, by one level, on each of pages 6, 10 and 18 in both trust states (above).

### Method

- **Warm** (the app running with a window open): the app is started by Playwright's Electron launcher with
  `fixtures/decks/single.html` open, then a second launch of the app with a fresh copy of the deck hands the file
  over (`second-instance`, 6.1). Measured from the open request as main receives it (a `second-instance`
  listener prepended to the app's own) to the deck view's first contentful paint, and also from the second
  launch's start. The first open of a session is not counted; each warm run closes its window afterwards.
- **Cold** (app start): the app is spawned directly with the deck, as a double-click does, and measured from the
  spawn to the deck view's first contentful paint. Not through Playwright, whose loader holds `ready` until it
  attaches. One unmeasured start first creates the profile and warms the file cache.
- **First contentful paint** is the deck page's own `performance.getEntriesByType('paint')`, read in an isolated
  world (never the page's world), on the wall clock through `performance.timeOrigin`; main's marks use
  `performance.timeOrigin + performance.now()` too. Each run opens a new copy of the deck (one window per file,
  6.1), so every open builds a new document. The deck view is found by its URL without the fragment (the deck
  writes its slide into the hash), and only the page with the deck preload's overlay host is timed, never a
  render window (slide index, thumbnails) that loads the same `blueline://` URL.
- **Every counted run counts**: a run that does not paint within its deadline is a failure ("k of N runs
  failed"), and the gate is not met when any counted run failed.
- **Breakdown**: the deck page's Navigation Timing (protocol request to first byte, body, body end to paint);
  when main started the deck view's navigation; the main-process share timed with the app's own functions in
  the harness (`--bl-parity-job` bench: read, hash, decode, map, served copy, the protocol handler's response)
  and with core's (the map's first stage, which the served copy needs, and the rest); a plain `file://` window
  of the same size in the same running app as the baseline of what Chromium alone takes; an empty Electron
  main's start to `ready`; and one more cold start with the V8 CPU profiler on main (Node inspector,
  `--inspect-brk`) from main's first line to the first contentful paint.

### Results (median of 5, ms)

Measured 2026-10-18 on the current build, the deck above, with the machine otherwise idle. Opening a window
resolves the file's trust (marker, `trust.json`, folders), records it in Open Recent, starts the watcher, and,
once the deck view has loaded, the slide index and thumbnails in hidden render windows. Each case has 5 counted
runs, and every one painted (none failed); the range of the five is in brackets.

| Case | Trusted | Protected |
|---|---|---|
| **Warm: open request → first contentful paint** | **430** (389–458) | **413** (372–499) |
| Warm: second launch's start → first contentful paint (what a Linux user waits) | 604 (548–650) | 611 (541–668) |
| **Cold: app start → first contentful paint** | **831** (803–1,014) | **810** (782–831) |

The medians are under 1 s in every case, so the gate is met here. One of the ten cold starts took longer than
1 s: a Trusted start at 1,014 ms, whose deck view began to navigate 606 ms after the spawn and whose body took
288 ms (the medians: 527 and 193 ms). Every warm open, and the other nine cold starts (at most 898 ms), were
under 1 s. Before review round 1's speed fixes the same deck took 847 / 920 ms warm and 1,430 / 1,466 ms cold
(not met; measured in the fix round, with other test runs loading the machine).

Where the time goes (medians):

| Phase | Trusted warm | Trusted cold |
|---|---|---|
| Electron itself: process start to `ready` (empty main) | – | 153 |
| Main: open request (or app start) → deck view navigation starts | 132 | 527 |
| … of which the bench's `loadDocument` (read 8, hash 2, decode 10, **map 72**, encode 12) | 101 (50 ms/MB) | 101 + |
| Protocol: body (2.1 MB through `protocol.handle`) | 131 | 193 |
| Body end → first contentful paint (parse, style, layout, decode, paint) | 167 | 117 |
| Navigation start → first contentful paint | 288 | 312 |
| Plain `file://` window, navigation start → first contentful paint (baseline) | 248 | – |

- **The map does only its first stage before first paint (decision D-9).** `buildMap` has two strategies:
  Strategy 1 (parse5, the stamp sites the served copy needs) and Strategy 2 (acorn over every inline script, for
  Edit and Review). Main serves the deck as soon as Strategy 1 has stamped it (79 ms, 39 ms/MB, in core's bench)
  and runs Strategy 2 once the deck view reports its first contentful paint, or after 3 s at the latest (278 ms,
  139 ms/MB, off the first-paint path). The deck preload is sent the map only when it is complete
  (`DeckInit.mapPending`, then `MainToDeck.map`), so the deck view never holds a partial map; first paint does not
  wait for it. Main's share of the open is 120 ms (60 ms/MB: the harness's `loadDocument` 101 ms and the
  protocol response 19 ms), against 495 ms (247 ms/MB) on this deck when the whole map ran before serving.
- **The deck page itself** paints 288 ms after navigation (Trusted, warm), close to Chromium's own `file://` of
  the same file (248 ms); the difference is the body arriving through `protocol.handle` (131 ms, against 48 ms
  from disk).
- **Cold start** is Electron's own start to `ready` (153 ms) plus `main.cjs` compiling and the first
  `loadDocument`: in the profiled cold start main was busy 505 ms before first paint (Trusted; 480 ms
  Protected), 160 ms of it in `loadDocument` (`buildMap` 142 ms, parse5's tokenizer 96 ms; times under the
  profiler). `pdf.ts` loads pdf-lib on first use, so it is not on the startup path.

So the gate is met here on a deck built like the real ones, warm and cold, by the median of every counted run,
because Strategy 2 moved off the first-paint path (D-9); one cold start in ten was 14 ms over. If the Mac were
slower, the remaining levers are caching the map on disk by sha256 for reopens and moving Strategy 1 to a
worker.

## Integration

The last step of Phase 1 wired every item together, ran everything from a clean build, and fixed what broke
(2026-10-17); review round 1 then fixed what the review found (below).

### What integration fixed

- **Script-timed content in still images** (the D5 PDF defect above): `RenderView.waitScripted` and
  `slide-index.ts SCRIPTED_SETTLE`.
- **Render jobs cut off by a closing window now settle.** `disposeRenderer` closed the render windows, but a
  job waiting on `capturePage`, `printToPDF` or `loadURL` of a destroyed webContents never settled, and kept what
  it held. Those calls now race the view's own `closed` promise and reject with `RenderCancelled`; once a view is
  closing, nothing touches its webContents again (a navigation or a debugger command sent to a closing
  webContents took main down with it in one E2E run), and the isolated-world probes answer at once. New E2E test:
  a PDF running when its document closes settles at once and writes nothing.
- **Clipboard tests could race**: E2E workers shared one Xvfb display, so one X clipboard, and three specs write
  it and paste (card-input, preload-electron, diagnostics). Global setup now starts one display per worker and
  each worker takes its own when it loads the Playwright config (`test/helpers/display.ts useWorkerDisplay`).
- **The welcome window test** clicked Done, which closes the page it is on; under load the click could see its
  page close first. The test now accepts exactly that, then waits for the window to close.
- **The exit-gate harnesses**: the parity harness's borrowed probe methods needed the render view's new close
  tracking (`plain-view.ts borrowRenderProbes`), and `first-paint.mjs` now times only the deck view, never a
  render window on the same URL (First paint, above).
- **9.9 Derived files keep the marker** for the `blueline map` probe copy too (`probe.ts`, through
  `markers.markDerivedFile`), so a copy that an interrupted run leaves next to a marked deck never opens Trusted.
- **pdf-lib is loaded on first use** (`pdf.ts`), off the cold start.
- **Local unsigned macOS builds** (SPEC 10 Phase 1, Builds): without signing credentials `npm run dist` signs the
  app ad hoc, without the hardened runtime and without notarization (`scripts/mac-signing.cjs`); README.md,
  "Dogfooding on a Mac". `npm run package:smoke` now also checks the shims, the sample deck, the Settings and
  welcome pages and a packaged `blueline pdf`.
- `npm run test:parity`, `npm run parity` and `npm run first-paint`.

### Final run (2026-10-18, after review round 1, from a clean `dist`)

| Command | Result |
|---|---|
| `rm -rf packages/app/dist packages/cli/dist && npm run build:reader-only` | builds; no `editor.cjs` |
| `npm run build` | builds |
| `npx tsc -p tsconfig.json --noEmit` | 0 errors |
| `npx vitest run` | 84 files, 1,639 tests passed, 0 failed |
| `npx vitest run -c test/parity/vitest.config.mts` | 4 files, 37 passed |
| `npx playwright test -c test/e2e/playwright.config.ts` (what `npm run test:e2e` runs after the build) | 194 tests in 13.1 min: 193 passed and 1 expected failure (the note card's ordering limit after `document.open()`, SECURITY.md); 0 unexpected, 0 skipped, 0 flaky |
| `npx playwright test -c test/security/playwright.config.ts` (`npm run test:security`; as `bltest`, sandbox on, DNS observed in a private mount namespace) | 57 tests in 3.3 min: 51 passed and 6 expected failures (the two DNS channels; the drop limits for a `document.open()` frame and a shadow-root `about:blank` frame, each in both trust states); 0 skipped |
| `npx playwright test -c test/parity/playwright.config.ts` | 9 passed (8.7 min): 3 committed fixtures, the negative controls, the seeded-random, text-differs, page-size and delayed-build fixtures |
| `npx playwright test -c test/e2e/playwright.config.ts test/e2e/map.spec.ts` (with the new `generic-hash-writeonly` baseline) | 8 passed (2.1 min) |
| `npm run package:smoke` | 17 of 17 PASS |
| `node packages/cli/dist/blueline.cjs check --auto` | 6 of 6 PASS |
| `node scripts/parity.mjs --committed --perf --trust both --pdf` | 49 decks in both trust states: 98 of 98 pass, 424 of 424 comparisons identical to the byte, 98 of 98 PDFs pass (63.5 min) |
| `node scripts/parity.mjs --local --trust both --pdf` | 12 decks in both trust states: 24 of 24 pass, 370 of 386 comparisons identical, 24 of 24 PDFs pass (66.2 min) |
| `node scripts/first-paint.mjs` | gate met: 20 counted runs (5 per case), every one painted; medians 430 / 413 ms warm, 831 / 810 ms cold (Trusted / Protected) |

At integration (2026-10-17) the same commands gave 1,527 unit tests (78 files), 27 parity unit tests, 136 E2E
tests and 49 security tests; review round 1 added the regression tests.

### Coverage (`blueline map --report --json`, on copies)

- **Committed fixtures** (the 18 of `fixtures/decks` and reveal-hash): every slide reached; 423 nodes `exact`,
  and every one passes the mutation probe with the copy's bytes restored; for the 18 decks that had a baseline,
  the coverage and every run (slide, text, strategy, confidence, offsets, probe result) equal it (411 exact
  nodes). `generic-hash-writeonly.html`
  (review finding 17: it writes its hash and never reads it) is new: 12 of its 18 nodes exact, each passing the
  probe, on 6 of 6 slides; its baseline is `fixtures/expected/generic-hash-writeonly.json`, and `map.spec.ts`
  checks it with the others.
- **The render fixtures** (`fixtures/render/*.html`, 29 decks, no baselines): 194 of 196 nodes exact, and all
  194 pass the probe; every original untouched and every probe copy removed. Every slide is reached (85 of 88)
  except on `arrowdown.html`, whose engine moves only on ArrowDown, which `blueline map` does not press (the
  visible view records it for renders; 1 of 4 slides, exit 1 for an incomplete walk, as designed).
- **Josh's 12 decks, `--reduced-motion`**: every slide reached (193 of 193); 6,056 of 6,676 visible text nodes
  exact and probed (90.7%; 94.5% of the wording), against 6,058 of 6,678 in their baselines in
  `fixtures/local/expected/`. Eleven decks equal their baselines run for run. D3's one probe failure is the one
  Phase 0 recorded (a label the deck also keeps in a hidden element on another slide, so an edit would change
  both; the probe refuses it, as it should). D5 differs only on its first and last slides, which carry a ticker:
  which of its items are on screen when the walk reads the slide, and which of the ticker's two copies of the
  list they are in, changes from run to run (430 and 427 visible nodes in two runs of this step, 431 and 426 at
  integration, 432 in the baseline); no other run changed, every one of its exact nodes passed the probe, and its
  exact share stays 96.0–96.1% (96.1% in the baseline; the wording 100%).

### The command and the packaged app

- `node packages/cli/dist/blueline.cjs check --auto`: 6 of 6 PASS (key order, stopImmediatePropagation, app
  chords, offscreen keys, capture size 3200×1800, Fit by `setZoomFactor` 0.00% against CSS zoom 11.47%).
- `blueline pdf` through the real command: this step's sample (PDF, "What it costs") made raster, print-CSS and
  document PDFs, exit 0; `render-products-cli.spec.ts`, in the E2E run, checks the output path, the mode,
  `--protected`, the refusals (exit 2) and a signal (128 + n, no PDF left).
- `npx electron-builder --config packages/app/electron-builder.config.cjs --dir --linux` packs
  (`release/linux-unpacked`, in 19 s; run again on 2026-10-18 on the current tree and `dist`, since review round
  1 changed the config): the hook logs `[fuses] blueline: release fuses set`, and `npx @electron/fuses read` on
  the packed binary shows the release set (RunAsNode, inspect arguments, `NODE_OPTIONS` and file-protocol
  privileges off; asar integrity validation and only-load-from-asar on). The packed app was not started.
  `npm run package:smoke` (a test build with test fuses, packed into a temporary folder and started): 17 of 17
  PASS.
- `npm run build:reader-only` builds no `editor.cjs`, and the reader-only app starts and opens decks in Read and
  Review (at integration, 13 of 14 Read, Review and views E2E tests passed on it; the 14th switches to Edit,
  which a reader-only build does not have); `blueline map` on it reports without the probe and says so
  (`map.spec.ts`).

## Review round 1

An adversarial review of the Phase 1 commit (f34b967) confirmed 40 findings, each reproduced by a second,
sceptical reviewer: 35 distinct and 5 duplicates. All 35 were fixed, in six batches that followed the lead's
decisions D-1 to D-14, each with a regression test that fails on f34b967 and passes now, with two exceptions.
For the findings about this page, the page was rewritten. Finding 32 (and its duplicate 7) was about the tests
themselves: the features they cover worked on f34b967, so the new tests, which no longer skip, have nothing to
fail on there; they were shown to fail on copies of the pre-fix build with each feature removed (trust
decisions, the folder lists, the app's Settings window). A re-verification round then rechecked every fix with
new variants: 9 fixes were incomplete and 12 new problems were found, and a repair step fixed them. The
measurement step after it found one more problem, in the repair (the last line under Trust and security). Each
line gives the finding's index in the review, then what changed.

**Trust and security**

- 0 (3 and 16 are duplicates). A new download saved over an open Trusted file was reloaded in place and ran
  Trusted: every external change is now decided again as an open is, and a different decision opens the file
  again with a fresh docId and partition, except a change from one Trusted decision to another, which reloads
  in place, and the switches of a window opened Protected on request, which are not compared (SECURITY.md; D-1;
  `views-reload-trust.spec.ts`).
- 2. The file-drop guard covered only the main frame, so an iframe of a Protected deck could read a dropped
  file: the deck preload now runs in every frame and refuses file drops there (D-4; `drop-frames.spec.ts`).
  Two kinds of frame remain open (below).
- 4 (1 is a duplicate). `blueline pdf` and `blueline map` ignored the trusted and untrusted folders, the strict
  option and the allowlist: they now decide trust as the app does, without remembered decisions (D-3;
  `command-trust.spec.ts`).
- 5. A remembered switch on an unmarked file applied to any other file later saved at the path: the decision
  is bound to the file's identity (D-2; `trust-identity.spec.ts`).
- 28. Windows: a new download of the same link inherited the remembered switches (Zone.Identifier carries no
  time or id): the decision is bound to the file's identity on Windows too (D-2).
- 6. Open in Protected View on a file already open Trusted silently focused the Trusted window: the window is
  focused and says the file is already open in Trusted view (`views-open-protected.spec.ts`).
- 8. trust.json's 8 MB read cap was below what its 10,000-entry cap allowed: writes trim it to 7 MiB, oldest
  decisions first.
- 29. Windows: Save as PDF failed on a volume without named streams: the PDF is saved there without a
  Zone.Identifier; HTML copies are still refused.
- 30. Derived files were marked after they were in place: the PDF is marked on its temporary file before the
  rename, the probe copy before any byte of the deck is written.
- 32 (7 is a duplicate). Two trust security tests skipped themselves, and the Settings test could run against a
  test-installed window: no skips, and the test asserts the app's own Settings window (D-13).
- Found by the measurement step: the repair had turned on Chromium drag interception (`Input.setInterceptDrags`) on the
  deck view as a backstop for file drops. It holds only drags the page itself starts, never a drag from the
  desktop, so it guarded nothing, and a drag the deck started (an image, a link, a draggable card) was held and
  never finished (no `drop`, no `dragend`), after which the deck took no keys (clicks, and whether a reload
  recovers it, were not tested). Removed. `views-drag-inpage.spec.ts` checks that such a drag ends and that the
  deck takes two typed keys after it: with interception on it fails, on the missing `drop` and `dragend`; without
  it, it passes.

**Render products (thumbnails, index, Find, PDF, Print)**

- 10. Document and print-CSS PDFs and prints were made right after load, missing what scripts draw: the
  scripted settle now runs before every print, and a document's page always gets the full wait (D-5;
  `render-products-settle.spec.ts`).
- 11. The slide index read each slide before script-timed content appeared, so Find missed it: the index walk
  settles each slide, with a wait that adapts per version, and takes the rail's thumbnails in the same pass
  (D-5).
- 9. Any `@page` rule sent a deck to `printToPDF` with no page check: print CSS is used only when Chromium's
  print gives one page per slide at the slide's aspect (D-6).
- 33. Raster PDF pages were written in visit order: they are in slide order (D-6; `skip-deck.html`).
- 13. `@import url(x.css) print`, and a print sheet imported without a media list, were read as all-media
  sheets: media lists are read down the whole import chain (`media-*.html`).
- 12. Find's numbering did not match `findInPage`'s, so the wrong match was highlighted: the index holds one
  string per run of text in a block, split at forced line breaks, and the occurrence is counted as
  `findInPage` counts it (`render-products-find.spec.ts`).
- 14. A document's slide-index files of older versions were never pruned: they are deleted once the new
  version's index is complete.
- 15. Thumbnails and the index made under Protected view's policy were reused after Allow network: they are
  made again after Allow network, a Settings › Trust change, a trust reopen, and when a later launch's policy
  differs (each index records its policy; `views-products-policy.spec.ts`).

**Views**

- 17. Rail clicks, Find results and Review's PageUp/PageDown did not move 5 of Josh's 12 decks (they write the
  hash but never read it): a goto that does not move the deck falls back to the deck's own keys (D-7;
  `generic-hash-writeonly.html`, `views-hash-writeonly.spec.ts`).
- 18. The Find bar lost the keyboard to the deck after a result and after an auto-reload: focus goes back to
  whoever had it (`views-find-focus.spec.ts`).
- 20. Two external writes in quick succession (and, on re-verification, three) lost an index deck's slide: a
  reload never captures a page that is still restoring (D-8; `views-reload-twice.spec.ts`).
- 19. Present with the Find bar open kept the highlight and left a dead Find strip: Present closes Find
  (`views-present-find.spec.ts`).
- 21. Cmd+Z in the shell's Find field showed the Phase 2 toast: Blueline's own pages get native undo while a
  text field has focus, app undo otherwise (`views-undo-fields.spec.ts`).

**Files lifecycle**

- 34 (24 is a duplicate). The welcome window opened on every launch, and its tests ran a test-installed
  harness: the first-run welcome shows on the first launch only, then an Open window on Linux and Windows and
  nothing on macOS; the tests use the app's own startup path (D-12; `files-lifecycle-launch.spec.ts`).
- 26. A second launch without a file did nothing when only the welcome window was open: it brings forward
  whatever Blueline window is open (D-12).
- 22. A top-level `fileAssociations` made the Windows installer overwrite `.html`/`.htm`'s default ProgID: the
  associations are macOS-only, and Windows registration comes only from `installer.nsh` (D-11).
- 23. Switching from a per-user to a per-machine install left the per-user registration behind: a per-machine
  install removes it (D-11).
- 25. Install Command Line Tool read the login PATH before creating `~/.local/bin` (stock Ubuntu): it creates
  the folder first, on Linux only, and says the PATH applies after the next login.
- 27. The sample deck said notes are kept next to the file: it says Blueline keeps them.

**The exit gate (this page)**

- 31. The Speed gate's 2 MB deck was 98.8% base64 images: it is now made like Josh's decks, and the open path
  was made faster to meet the gate on it: the map's script scan runs after first paint (D-9).
- 36. `first-paint.mjs` could not time a deck that writes its slide into the hash, and dropped failed runs from
  its medians: both fixed, and warm runs now close their windows.
- 38. The tolerance's justification was wrong, and a tolerance of 8 would pass a uniform shift a person can
  see: the tolerance is 2, with a seeded `Math.random`, a control render per slide and shift controls (D-10).
- 37. Without pdftoppm the PDF check passed printed PDFs on page count alone: page sizes are compared too.
- 35. The PDF gate was said to compare every page with its slide render: the criterion is stated as measured
  (D-6), and media-print is now rasterised.
- 39. The Method overstated the overlay and same-slide checks: it states what they verify (D-10).

**Deferred, and what remains.** No finding was deferred. These remain, each stated where it applies:

- **File drops onto two kinds of frame.** A frame a deck rewrites with `document.open()`, and an `about:blank`
  frame it makes inside a closed shadow root, can take a file dropped on it, for a real drag from the desktop
  too: no renderer-side guard runs in either before the deck's own listener, and Electron 44 gives main no
  event to cancel a drop. With drag interception removed there is no browser-side backstop either (it never
  covered desktop drags). SECURITY.md, Known limits; expected failures in `drop-frames.spec.ts`. A file drop
  a subframe's own guard refuses (srcdoc, `data:`, `blob:`, same-origin) shows no notice; it just does nothing.
- **A marker written more than 500 ms after the rename** is not seen until the next change or open
  (SECURITY.md): Blueline reads it twice, not indefinitely.
- **Find with a same-origin `srcdoc` iframe before a matching paragraph on one slide**: the index lists the
  frame's match first, `findInPage` the page's, so the two results highlight each other's match. Already so on
  f34b967; it needs the index to walk frames in `findInPage`'s order.
- **After Find highlights a match inside a same-origin iframe**, the keyboard stays in the frame, so a later
  result on another slide does not move the deck. Already so on f34b967.
- **`blueline map` on a Windows volume without named streams**, for a deck that opens Protected without a
  marker: the probe copy cannot be marked, so the probe does not run and coverage is reported as not verified
  (by design, D-3 and D-14; SECURITY.md).
- **The reader-only build** cannot pass the E2E test that switches to Edit with Cmd/Ctrl+3; the suite has no
  reader-only variant.

## What to recheck on Josh's Mac

1. **First paint**: `npm run build && npm run first-paint` on the Apple-silicon Mac (SPEC names it), then
   `node scripts/first-paint.mjs --deck <a real deck> --trust trusted --no-profile` on two or three real decks.
   Cold start was 782–1,014 ms here: the medians (831 and 810 ms) are 169 and 190 ms under the gate, and the
   slowest run was 14 ms over it. macOS app start differs (code signing checks, Gatekeeper on a quarantined
   build, dyld). A packaged build (`npm run dist`) should be measured too: its `app.asar` changes how `main.cjs`
   is read. On macOS the open request arrives as `open-file` with no second process, so "warm, from open
   request" is what a double-click costs.
2. **Render parity on a Retina display**: rerun `node scripts/parity.mjs --committed --local --trust both
   --pdf`. Offscreen windows render at `deviceScaleFactor` 2 everywhere, but GPU rasterisation, font
   smoothing (no subpixel antialiasing in offscreen captures) and colour management differ on macOS. The
   tolerance is 2, so a colour-management shift of 3 levels or more on every pixel fails every slide; the exact
   count and the histogram show what lies within it.
3. **Fonts over the network in Protected view**: with direct internet, a Protected deck should load Google Fonts
   (allowlisted) and match the plain render; run once with `--network` and compare Protected with Trusted. Behind
   a proxy it cannot (see Network).
4. **pdftoppm**: `brew install poppler` for the printed pages' pixels. Without it, the PDF check still compares
   page counts and every page's size with Chromium's own print (within 0.5 pt) and fails a mismatch, but not the
   pixels; the result says so (`pdftoppm: false`, and each PDF's `compared`). `--no-pdftoppm` shows that mode on a
   machine that has poppler.
5. **Save as PDF and the rail on real decks**: about 1.3 s a page here once the slide index is built, and the
   index of one of Josh's decks takes 24–63 s (PDF, "What it costs"). If either is too slow in daily use on the Mac, say
   so.
6. **The Mac-only parts** that never ran here: the Swift helper (`native/macos/build.sh`), the default-app prompt
   on macOS 26.4 or later, quarantine markers on downloads and on Save as PDF output, `blueline check --auto` (F3,
   F4, F5), Present in native full screen, Print through the system dialog, and Help › Install Command Line Tool
   with its administrator prompt. README.md, "Dogfooding on a Mac", lists the steps.

## Files

- `scripts/parity.mjs`, `scripts/first-paint.mjs`: the entry points (they compile only the harness).
- `test/parity/harness/`: the harness (`main.ts`, `plain-view.ts`, `plain-probe.ts`, `compare.ts`,
  `pdf-pages.ts`, `decks.ts`, `job.ts`, `bundle.mjs`).
- `test/parity/parity.spec.ts` (+ `playwright.config.ts`, `fixtures/`: `nondeterministic.html`,
  `seeded-random.html`, `shift6.html`, `shift8.html`, `text-differs.html`, `page-size-diverge.html`,
  `delayed-build.html`): the committed check, 9 tests, about 9 minutes. `npm run test:parity` builds, then runs
  it and the harness's unit tests.
- `test/parity/*.test.ts` (`npx vitest run -c test/parity/vitest.config.mts`, 37 tests): the comparison, PDF
  read-back and page sizes, PPM parsing, pdftoppm, deck labels and redaction, the seeded `Math.random` and the
  freeze step.
- `fixtures/perf/`: the generator and its README.
