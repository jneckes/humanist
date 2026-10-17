# Phase 1 results (exit gate)

SPEC 10, Phase 1, names five exit criteria. This page reports the three that are measured by machine here:
render parity, PDF parity and first paint. Security has its own suite (`npm run test:security`); real use is
Josh's week with a Mac build.

Every number below was measured in the Linux dev container on 2026-10-17, after integration (every Phase 1
item wired into the app), with the harnesses this page describes. The machine-readable results are written by
the scripts (paths under each section); they are not committed. Josh's 12 decks are called D1 to D12 only, as in
docs/PHASE0-FINDINGS.md. The suites and the other integration checks are at the end ("Integration").

| Criterion | Gate (SPEC 10) | Result here |
|---|---|---|
| Render parity, committed fixtures | every slide ≤ 0.5% of pixels different | **met**: 30 decks, 148 slides, each in both trust states: all 296 comparisons identical to the byte |
| Render parity, Josh's decks | as above | **met by 11 of 12**: D2 fails on 2 of its 11 slides (1.05% and 0.93% Protected, 1.10% and 0.94% Trusted) because the deck draws a random decoration; with the same seeded `Math.random` in both renders it passes (worst 0.067%) |
| PDF | right page count; every page ≤ 1% different from its slide render | **met by 41 of 42 decks** (30 committed and 12 of Josh's, each in both trust states: 83 of 84 PDFs): every page count right; D2's Trusted PDF misses by its randomness (1.031%; Protected 0.980%). **D5 now passes** (0.53% worst): the defect the first measurement found, raster pages captured before a script revealed the slide's content, is fixed (PDF, below) |
| Security | the suite passes in both trust states | **met**: 49 of 49 (`npm run test:security`; the two known DNS channels are expected failures, SECURITY.md) |
| Speed | a 2 MB deck reaches first paint in < 1 s | **met here** (Linux, median of 5): 500 ms (Trusted) and 526 ms (Protected) from the open request with the app running, 854 and 877 ms from a cold start; recheck on the Mac |

## Environment

- Linux container (a Firecracker VM), kernel 6.18, 4 CPUs, 15 GB, no GPU; Xvfb with a 3840×2160 screen (an
  offscreen window is clamped to the X screen, PHASE0-FINDINGS F4).
- Electron 44.7.2 (Chromium 152.0.7977.149, Node 24.21.0), the app built with `npm run build` from commit
  `df58f35` plus the whole uncommitted Phase 1 work, integrated. Render and PDF parity ran from 08:34 to 10:04
  UTC (committed fixtures 35 min, Josh's decks 55 min), first paint at 10:13 UTC, each with the machine
  otherwise idle.
- The machine was slower than during the first measurement (04:55 to 05:47 UTC, before integration): the same
  plain `file://` page took 300 ms from navigation to first paint instead of 192, and the main-process bench
  (pure functions, the same code) 202 ms instead of 167 for `loadDocument`. Compare figures within one run.
- As root with `--no-sandbox` (the OS sandbox is off; the in-process sandbox flags still apply). The security
  suite runs as `bltest` with the sandbox on; these harnesses do not need it.
- Offline: the harnesses run Electron without the proxy variables of the environment (see "Network" below).
- System fonts include Inter and the DejaVu and Liberation families; whatever a deck asks for and the
  machine lacks falls back the same way in both renders.

## Render parity

    npm run build
    node scripts/parity.mjs --committed --perf --trust both --pdf     # every committed fixture
    node scripts/parity.mjs --local --trust both --pdf                # Josh's decks (fixtures/local, gitignored)
    npx playwright test -c test/parity/playwright.config.ts           # the committed check (3 fixtures + a control)

Results: `test-results/parity/parity.json` (or `--out`), diff images in `test-results/parity/run/diff/`.

### Method

SPEC asks for Blueline's render "at the design size" against "Chromium headless (same version, same
viewport)". Electron 44's own Chromium with nothing of Blueline's loaded is that (docs/PHASE1-PLAN.md), so both
renders are made in one Electron process by the harness (`test/parity/harness/main.ts`, its own Electron main,
so the app's entry point is untouched):

- **Blueline's render** is the render service exactly as thumbnails and PDF pages use it (6.7 Background
  renders, 9.1 Render service): the file opened by `loadDocument` in its own trust state and partition, with the
  session policy and the `blueline://` handler a document window installs, the served stamped copy (notes
  block removed; resource hints removed when Protected), the shipped deck preload in render mode, a hidden
  offscreen `BrowserWindow` from the document's render pool. Before each capture the harness checks that render
  mode mounted no overlay (`visitSlides` refuses a view that shows one).
- **The plain render** is a hidden offscreen `BrowserWindow` of the same size and `deviceScaleFactor`, the same
  webPreferences minus the preload, a fresh partition with nothing installed (no handler, no policy), loading
  the original file's `file://` URL (`test/parity/harness/plain-view.ts`).

Both renders get the same steps:

1. **Viewport.** The 6.9 design size from the slide index (reveal.js width and height, else the slide element's
   box at 1600×900, else 1600×900; documents 1600×900), at `deviceScaleFactor` 2: a 1600×900 slide is a
   3200×1800 capture.
2. **Motion.** `prefers-reduced-motion: reduce` through each window's own debugger
   (`Emulation.setEmulatedMedia`, after an about:blank load), as background renders do (Josh's decision 1).
3. **Navigation**, by the same means in both, in the order Blueline's walk reaches the slides
   (`slide-index.ts visitSlides`): reveal.js by `Reveal.slide(h, v)` in the page's world, then every fragment
   shown (`Reveal.slide(h, v, 1000000)`, as thumbnails and PDF pages show it); generic engines by the same
   trusted keys (`sendInputEvent` after `focus()`, Accelerator names, 1 s wait, the F25 patience of
   `pressPatiently`), the hash for slides keys do not reach; documents by scrolling the section's heading to the
   top. The plain window knows its current slide from the render agent's own 9.4 detection (`core/slides`),
   run in an isolated world (`plain-probe.ts`), never the page's world.
4. **Settle** (6.7 step 3): `document.fonts.ready`, two animation frames, up to 1.5 s for finite animations,
   then running animations paused: `RenderView.waitStable` and `pauseAnimations`, the very same methods on both
   windows (the plain window borrows RenderView's probe methods). Since integration, Blueline's walk
   (`visitSlides`) also waits for what the slide's scripts reveal before it hands a slide over
   (`RenderView.waitScripted`: at least 1.5 s on the slide, then 400 ms without a DOM change, at most 3 s; see
   PDF), so Blueline's render has been on its slide 1.5 s or more longer than the plain one when both are
   captured. No committed fixture or real deck changed between 2 s and 3.5 s on a slide (the comparisons below
   are the same as before, or closer).
5. **Dwell.** Both renders then stay on the slide for at least 2 s (`--dwell`) before anything is captured.
   The harness navigates the plain render only once Blueline's has arrived, so without the dwell a script-timed
   reveal (a `setTimeout` build, a typewriter) would be further along in Blueline's capture than in the plain
   one; with it, both show whatever the deck reveals in its first 2 s on the slide. Each slide records both
   dwell times.
6. **Freeze** on both: every animation or transition still present is finished (finite) or stopped at time 0
   (infinite), so an infinite animation shows the same frame in both.
7. **Stable frame.** Captures (`capturePage`) repeat 120 ms apart until two consecutive ones are byte-identical,
   for up to 3 s; the result records whether each side became stable.
8. **Checks before comparing**: the visible-text signature of both (`RenderView.visibleTextSignature`) and the
   scroll position must agree, so a slide is never compared with another one; disagreements are recorded, as is
   each render's `document.characterSet`.
9. **Compare** the two bitmaps (`nativeImage.toBitmap()`, BGRA) pixel by pixel (`harness/compare.ts`): the
   share of pixels that differ at all ("exact") and the share whose largest channel difference is above the
   tolerance (the gate's figure), with a histogram of the differences. A failing slide gets a diff picture (red
   over tolerance, amber within, the slide in grey) and both renders as PNG.

A negative control proves the comparison can fail: `test/parity/fixtures/nondeterministic.html` paints a box in
a random colour on slide 1. The committed check requires slide 1 to fail (16% of its pixels differ) and slides 2
and 3 to match exactly.

Three options diagnose a failure; the gate is never measured with them. `--seed-random` gives the page's world
of both renders (and of the views the index and the PDF use) the same seeded `Math.random` before any page
script (`Page.addScriptToEvaluateOnNewDocument` through each view's own debugger), so a deck's random decoration
cannot be what differs. `--self-check` walks a second plain render and compares the two plain renders: the
deck's own variance between two loads. `--network` keeps the proxy variables (see Network).

### Tolerance

A pixel counts as different when one of its channels differs by **more than 8 of 255** (3%). The gate is the
share of such pixels; the share of pixels that differ at all is reported next to it.

Why 8: two renders of the same page by the same Chromium on the same machine should be byte-identical, and here
they nearly always are (of 296 committed slides, one pixel of one slide differs, by one level). The tolerance
exists for what is not a layout or content difference: gradient dithering and image decoding that can vary
between raster paths, and colour-space rounding (one or two levels per channel) when a capture goes through a
different compositor path, as it may on a Mac with GPU rasterisation. 8 levels (3%) is about the smallest step
an eye can see on a flat area, so anything above it is a difference a person could notice; antialiased glyph
edges that move by a pixel produce differences of 40–250 and are not hidden by it (D3's one-pixel text shift
and D11's fallback fonts below counted in full). The histogram in every result shows where differing pixels
fall. In these runs the tolerance changed one verdict: D12, whose random canvas grain differs between any two
loads by up to 8 levels on half of every slide (below).

### Results: committed fixtures

30 decks (all of `fixtures/decks/*.html`, `decks/reveal-hash/index.html`, all of `fixtures/render/*.html`, and
the generated 2 MB deck), 148 slides, each rendered Protected and Trusted: 296 comparisons. **All 296 are
identical to the byte** (in the first, pre-integration run one pixel of `decks/json-data.html` slide 3 differed
by one level). Every slide reached the same place in both renders (same visible text, same scroll offset, same
`document.characterSet`), both captures were stable, and no slide needed the hash fallback. The whole run took
35 minutes (21 before integration: Blueline's walk now also waits for script-timed content, about 1.5 s per
slide, in both the parity walk and the PDF; see PDF). None of these fixtures loads anything from the network.

| Deck | Kind | Slides | Worst slide, Protected | Worst slide, Trusted | PDF | Pages / expected | Worst page, P / T |
|---|---|---|---|---|---|---|---|
| `decks/bom.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/crlf.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/csp-default-none.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/csp-nonce-strict-dynamic.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/csp-self-inline.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `decks/entities.html` | generic | 6 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 6 / 6 | 0.000% / 0.000% |
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
| `decks/reveal-hash/index.html` | reveal | 8 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 8 / 8 | 0.027% / 0.027% |
| `render/arrowdown.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `render/builds-many.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `render/document.html` | single | 5 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 2 / 2 (plain print 2) | 0.000% / 0.000% |
| `render/find-strip.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `render/linked-print.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 3 / 3 (plain print 3) | 0.000% / 0.000% |
| `render/media-print-flow.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 4 / 4 | 0.000% / 0.000% |
| `render/media-print.html` | generic | 4 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 4 / 4 (plain print 4) | 0.000% / 0.000% |
| `render/motion-text.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `render/no-title-doc.html` | single | 1 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | document | 1 / 1 (plain print 1) | 0.000% / 0.000% |
| `render/page-css.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | print-css | 3 / 3 (plain print 3) | 0.000% / 0.000% |
| `render/title-escape.html` | generic | 3 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 3 / 3 | 0.000% / 0.000% |
| `perf/perf-2mb.html` | generic | 30 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 30 / 30 | 0.000% / 0.000% |

`render/arrowdown.html` was run with `Session.deckNav` set to ArrowDown, as the visible view would have
recorded it (fixtures/render/README.md); without it neither render goes past slide 1.

### Results: Josh's decks

Josh's 12 decks (`fixtures/local`, gitignored), 193 slides, each rendered Protected and Trusted: 386
comparisons in 55 minutes. All are generic engines; every slide was reached by keys in both renders, with the
same visible text except where noted. The results are those of the first, pre-integration run to within a few
hundredths of a percentage point (D2's random decoration varies most).

| Deck | Kind | Slides | Worst slide, Protected | Worst slide, Trusted | PDF | Pages / expected | Worst page, P / T |
|---|---|---|---|---|---|---|---|
| D1 | generic | 20 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 20 / 20 | 0.000% / < 0.001% |
| D2 | generic | 11 | **1.049% (exact 1.206%)**, slide 1 | **1.103% (exact 1.260%)**, slide 1 | raster | 11 / 11 | 0.980% / **1.031%** |
| D3 | generic | 11 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 11 / 11 | 0.000% / 0.000% |
| D4 | generic | 16 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 16 / 16 | 0.000% / 0.000% |
| D5 | generic | 17 | 0.026% (exact 0.680%) | 0.028% (exact 0.906%) | raster | 17 / 17 | 0.528% / 0.515% |
| D6 | generic | 11 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 11 / 11 | 0.000% / 0.000% |
| D7 | generic | 16 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 16 / 16 | 0.000% / 0.000% |
| D8 | generic | 11 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 11 / 11 | 0.000% / 0.000% |
| D9 | generic | 17 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 17 / 17 | 0.000% / 0.000% |
| D10 | generic | 24 | 0.000% (exact 0.000%) | 0.000% (exact 0.000%) | raster | 24 / 24 | 0.000% / 0.000% |
| D11 | generic | 21 | 0.311% (exact 0.649%) | 0.311% (exact 0.649%) | raster | 21 / 21 | 0.000% / 0.000% |
| D12 | generic | 18 | 0.000% (exact 56.772%) | < 0.001% (exact 56.840%) | raster | 18 / 18 | < 0.001% / < 0.001% |

Eight decks are identical to the byte on every slide. The four others, with each cause checked by a diagnosis
run:

- **D2: the deck's randomness, and its encoding.** The deck places a field of short dashes and scrambles a few
  labels with `Math.random()`, so two loads never match: slides 1 and 11 differ by about 1%. With
  `--seed-random` both renders draw the same field and every slide passes (worst 0.067%); the PDF passes too
  (0.000%). What remains, on slides 1, 7, 8 and 9 (0.02–0.07%), is a real difference in Blueline's favour: the
  file declares no charset and its first non-ASCII byte is at 706,401 of 977,650, so Chromium's `file://` load
  decodes it as windows-1252 (a middle dot shows as "Â·"), while Blueline serves a file that passes the UTF-8
  check as `charset=utf-8` (9.1 Charset) and shows it as written. Chromium detects UTF-8 in an undeclared local
  file only when a non-ASCII byte appears in the first 256 KiB: `<title>t</title><style>/*` followed by 262,000
  `x` and `*/</style><p>a · b</p>` decodes as UTF-8; with 263,000 `x` it decodes as windows-1252. Chrome opening
  D2 from disk shows the same mojibake as the plain render.
- **D5: content that changes over time.** Something on slide 1 keeps changing (a ticker that runs forever;
  under reduced motion its animation cycles every millisecond): neither render's frame became stable within
  3 s, and a second plain render differs from the first by about as much (`--self-check`: 0.013% against
  0.025%). Within the gate. Its PDF failed in the first run because of a Blueline defect, now fixed: see PDF.
- **D11: canvas text drawn before its font loaded, in the plain render.** Slide 13 draws a diagram's labels on
  a `<canvas>` with `@font-face` fonts embedded as `data:` URLs, from an inline script that does not wait for
  `document.fonts`. In Blueline's render the labels use the embedded fonts; in the plain render they fall back
  to the system's sans-serif and monospace (0.311%, deterministic: two plain renders are identical, and seeding
  changes nothing). Repro: a page with `@font-face { font-family: Embed; src: url(data:font/ttf;base64,…) }`
  and an inline script that runs `ctx.font = '80px Embed, sans-serif'; ctx.fillText(…)` while the page loads:
  1.8% of the slide differs, the plain render showing the fallback font. The likely cause (not traced further):
  a local file is parsed in one go, so the script runs before the font has decoded, while Blueline's document
  arrives through `protocol.handle` in chunks and the font is ready by then. A race in the deck, not a change
  Blueline makes to it, and in Blueline's favour.
- **D12: random grain under the tolerance.** A canvas overlays a random grain (`Math.random`), so 50–57% of each
  slide's pixels differ between any two loads, almost all by at most 8 levels (the largest difference is 17).
  Over the tolerance: under 0.001%. With `--seed-random` every slide is identical to the byte. This is the one
  deck where the tolerance decides the verdict, and what it hides is the deck's own noise.

A first run with the proxy variables set differed on D3 in Protected view only (see Network); offline it is
identical. An earlier version of the harness navigated the plain render after Blueline's had settled and
captured both at once, so a typewriter effect on D5's slide 5 was further along in Blueline's capture (4.1%);
the dwell step removed that asymmetry (now 0.000%).

### What was checked as a cause of difference

| Possible cause | What the runs show |
|---|---|
| Stamps (`data-bl-e`) and the served copy | No committed fixture and no real deck differs because of them. Every Blueline render is of the stamped copy; a deck would have to select on `data-bl-e` or count attributes for it to show. |
| Sibling files from the `-files` origin (fonts, styles, scripts, images) | `reveal-hash` loads reveal.js, its CSS and theme from sibling files, `linked-print` a sibling style sheet: identical renders. |
| The overlay host | Render mode mounts none; checked before every capture. |
| Protocol headers (Protected CSP `connect-src 'none'`, `X-DNS-Prefetch-Control`, resource hints removed) | Protected and Trusted renders of every committed fixture are identical to the plain render. The `charset=utf-8` header is the one header that changed a render: D2 (above). |
| Fonts not loaded | `fonts.ready` is awaited in both; the stable-frame wait covers late swaps. Network fonts: see Network. |
| Nondeterministic content | D2 and D12 (`Math.random`), D5 (content that changes over time): found by `--seed-random` and `--self-check`, each cause confirmed by the diagnosis run passing or by two plain renders differing as much. |
| Load timing | D11: a canvas drawn during load gets the embedded font in Blueline and the fallback in the plain render. |

### Network

The container reaches the internet only through an HTTP proxy named in `HTTPS_PROXY`. Chromium on Linux takes
its proxy from those variables, so a plain render and a Trusted render could load a deck's Google Fonts through
it, while a Protected render could not: Protected view's proxy is `fixed_servers` to a closed port with the CDN
allowlist sent DIRECT (network-policy.ts `protectedProxyConfig`, by design: "an upstream proxy from
`HTTPS_PROXY` is not used in Protected view"), and DIRECT connections fail here. A first run of Josh's decks with
the variables set showed exactly that on D3: Protected differed from the plain render on all 11 slides (the
deck's own Inter from Google Fonts replaced by the system's Inter, text one device pixel lower; 0.008% to 0.54%
of pixels, two slides over the gate), Trusted matched exactly. So the gate runs offline: the harness starts Electron without the proxy
variables, and every render sees the same (absent) network. `--network` keeps them, for this diagnosis.

On Josh's Mac this matters in the other direction: on a network that needs a proxy (an office, a VPN with a PAC
file), a Protected deck cannot load fonts from the allowlist at all, where Chrome could. That is 9.9 as
written, but it is a visible difference; see "What to recheck on the Mac".

## PDF

    node scripts/parity.mjs --committed --perf --trust both --pdf

For each deck, `saveAsPdf` (pdf.ts) writes the PDF exactly as Save as PDF does (6.9), with the marker copy left
out (it is a no-op on Linux and not part of the measurement). Then:

- **Raster pages** (decks without print CSS): the page count must equal the slide count. Each page's image
  XObject is read back from the PDF with pdf-lib and inflated (`harness/pdf-pages.ts`): those are the exact
  pixels Blueline stored, with no PDF renderer in between. Each is compared with Blueline's render of its slide
  from the parity walk (the gate), and with the plain render (reported too).
- **printToPDF pages** (print-CSS decks and documents): the plain window prints the original file with the same
  options (`preferCSSPageSize` and `printBackground` for print CSS; `printBackground` and the locale's page size
  for documents) at the same 1600×900 viewport. The page count must equal the slide count (print CSS) or the
  plain print's count (documents). Both PDFs are rasterised with poppler's `pdftoppm` at the page size in CSS
  pixels at 2x, and each page is compared with the plain print's page. Electron's PDF viewer cannot be
  captured, so pdftoppm (a system tool, not an npm dependency) does the rasterising; without it only page counts
  and sizes are compared, and the result says so.
- For print-CSS decks, the printed page is also compared with the slide's screen render, for information: print
  CSS may lay a slide out differently on paper.

Results, committed fixtures: every one of the 60 PDFs (30 decks, both trust states; 46 raster, 6 print CSS, 8
documents; 268 pages) has the right page count, and every page passes: raster pages are identical to their
slide renders except on `reveal-hash` (at most 0.027%: reveal.js's slide transitions ignore reduced motion, and
the PDF's walk and the parity walk capture at different moments of them), and every printed page is identical
to the plain print's page. For information, the print-CSS decks' pages against their screen renders: `page-css`
0.38%, `linked-print` 0.33% (print CSS moves a few elements), `media-print` 60% (it prints on paper of the
default size, so the page is not the slide's shape).

Josh's decks are all raster: 193 pages for 193 slides in each trust state, every page count right. Eleven decks
pass on every page in both trust states; D2's Protected PDF passes too (0.980%), its Trusted one does not:

- **D2**: page 1 differs from the parity walk's render of slide 1 by 0.98% (Protected) and 1.03% (Trusted). The
  PDF is a separate load, so its random dash field is drawn differently; with `--seed-random` every page is
  identical to its slide render. Whether a page passes is chance.
- **D5 passes** (worst page 0.53% Protected, 0.52% Trusted, on its first and last slides, which carry the ticker
  that never stands still). In the first run its pages 4, 5 and 14 differed by 1.4–4.1%.

### The defect the first run found, and the fix

**Raster pages missed content that a script reveals after the slide arrives.** On D5's failing pages, list
items and a typed paragraph were missing: the deck shows them from a timer (one 1.3 s after the slide becomes
current), and `visitSlides` (slide-index.ts) captured as soon as 6.7 step 3's settle returned (fonts, two
frames, finite CSS and Web Animations). A timer is none of those. Thumbnails and Print use the same capture path
and had the same exposure. Minimal repro (committed): `test/parity/fixtures/delayed-build.html`, a panel shown by
`setTimeout(…, 400)` on each slide: render parity 0.000% (both renders dwell 2 s), raster PDF 41.7% on every page.

**Fix (integration):** before every still image of a slide, `visitSlides` now calls
`RenderView.waitScripted(SCRIPTED_SETTLE)` (render-service.ts, slide-index.ts): it stays at least 1.5 s on the
slide, then until the page's DOM has had no mutation for 400 ms (a `MutationObserver` in main's own isolated
world, which the page cannot see), never longer than 3 s (a ticker or a clock never goes quiet), and then settles
again (fonts, frames, the finite animations the reveal started) before pausing animations and capturing. After
it, `delayed-build.html`'s raster pages are identical to their slide renders (0.000%), D5 passes, and
`test/parity/parity.spec.ts` runs the repro as an ordinary test (it was a `test.fail()`). SPEC 6.7 step 3 does not
name this wait; the wording is proposed in `docs/spec-amendments/README.md`.

**What it costs:** about 1.5 s per slide in background renders. A raster PDF of Josh's decks took 0.9 s per page
before and 2.4 s after (whole decks 22–63 s instead of 6–33 s); the committed fixtures' 230 raster pages 2.1 s
instead of 0.5 s. Thumbnails fill the rail at the same pace, in the background, after the deck has painted.

## First paint

    npm run build
    node scripts/first-paint.mjs            # 5 runs each: warm and cold, Trusted and Protected

Results: `test-results/parity/first-paint.json`.

### The deck

`fixtures/perf/generate.mjs` writes `fixtures/perf/out/perf-2mb.html` (gitignored; the generator reproduces it
byte for byte): 2,114,952 bytes, 30 slides on a 1600×900 stage in nine layouts, 3.4 KB of inline CSS, a 1.5 KB
inline slide engine (keys, `#/n` hash routing, scale to fit, progress bar), inline SVG charts, and 14 distinct
photo-like PNGs inline as base64 (2.08 MB of the file). It is built like Josh's real decks, which are 86 KB to
1.2 MB. Its render parity is exact (above).

### Method

- **Warm** (the app running with a window open): the app is started by Playwright's Electron launcher with
  `fixtures/decks/single.html` open, then a second launch of the app with a fresh copy of the deck hands the file
  over (`second-instance`, 6.1). Measured from the open request as main receives it (a `second-instance`
  listener prepended to the app's own) to the deck view's first contentful paint, and also from the second
  launch's start. The first open of a session is not counted.
- **Cold** (app start): the app is spawned directly with the deck, as a double-click does, and measured from the
  spawn to the deck view's first contentful paint. Not through Playwright, whose loader holds `ready` until it
  attaches. One unmeasured start first creates the profile and warms the file cache.
- **First contentful paint** is the deck page's own `performance.getEntriesByType('paint')`, read in an isolated
  world (never the page's world), on the wall clock through `performance.timeOrigin`; main's marks use
  `performance.timeOrigin + performance.now()` too. Each run opens a new copy of the deck (one window per file,
  6.1), so every open builds a new document.
- **Breakdown**: the deck page's Navigation Timing (protocol request to first byte, body, body end to paint);
  when main started the deck view's navigation; the main-process share timed with the app's own functions in
  the harness (`--bl-parity-job` bench: read, hash, decode, map, served copy, the protocol handler's response);
  a plain `file://` window of the same size in the same running app as the baseline of what Chromium alone
  takes; an empty Electron main's start to `ready`; and one more cold start with the V8 CPU profiler on main
  (Node inspector, `--inspect-brk`) from main's first line to the first contentful paint.

### Results (median of 5, ms)

Measured at 10:13 UTC on the integrated build: opening a window now also resolves the file's trust (marker,
`trust.json`, folders), records it in Open Recent, starts the watcher, and, once the deck view has loaded, the
slide index and thumbnails in hidden render windows.

| Case | Trusted | Protected |
|---|---|---|
| **Warm: open request → first contentful paint** | **500** | **526** |
| Warm: second launch's start → first contentful paint (what a Linux user waits) | 663 | 707 |
| **Cold: app start → first contentful paint** | **854** | **877** |

Runs: warm Trusted 504, 500, 432, 579, 436; warm Protected 655, 562, 526, 447, 492; cold Trusted 1003, 973, 854,
825, 846; cold Protected 935, 882, 877, 853, 852. Ten more cold starts each, just before (10:10 UTC): median 870
(Trusted) and 839 (Protected), the slowest 967 and 920.

Where the time goes (medians, Trusted; Protected within 30 ms of each):

| Phase | Warm | Cold |
|---|---|---|
| Electron itself: process start to `ready` (empty main) | – | 149 |
| Second launch to `second-instance` in the running app | 179 (not in the 500) | – |
| Main: open request (or app start) → deck view navigation starts | 244 | 662 |
| … of which `loadDocument` in the bench (read 3, hash 2, decode 9, **map 165**) | 202 | 202 + |
| Protocol: request → first byte | 0 | 0 |
| Protocol: body (2.1 MB through `protocol.handle`) | 167 | 99 |
| Body end → first contentful paint (parse, style, layout, decode, paint) | 65 | 88 |
| Navigation start → first contentful paint | 236 | 192 |
| Plain `file://` window, navigation start → first contentful paint (baseline) | 308 | – |

- **Compared with the pre-integration run** (04:55 UTC: warm 403/412, cold 845/854), warm opens are about
  100 ms slower and cold starts about the same. Most of it is the machine: the plain `file://` baseline went from
  192 to 308 ms and the bench's `loadDocument` (the same code) from 167 to 202 ms. Main's share from the open
  request to the deck's navigation went from 199 to 244 ms (`loadDocument` +35 in the bench, so about 10 ms is
  integration: the trust decision, Open Recent, the watcher). The deck page itself is still as fast as
  Chromium's own file load: 236 ms from navigation to first paint against 308 ms for `file://`.
- **The map is still most of main's share**: `buildMap` takes 165 ms of the 244.
- **Cold start** profile (main busy 735 ms before first paint, under the profiler): `loadDocument` 279 ms
  (`buildMap` 261), compiling `main.cjs` 64 ms, garbage collection 109 ms, creating the window 60 ms, loading the
  editor bundle 24 ms. pdf-lib's module initialisation (28 ms before) no longer runs at startup: `pdf.ts` loads
  pdf-lib on first use since integration.
- **A measurement bug found and fixed during integration.** A document's render windows (slide index,
  thumbnails) load the same `blueline://` URL as its deck view. The first integrated cold runs sometimes timed a
  render window's paint instead, which added 350–460 ms to a third of the runs (a cold median of 999 ms in one
  run). Main's own trace showed the deck view navigating 40 ms after the shell every time.
  `scripts/first-paint.mjs` now times only the page that has the deck preload's overlay host (`deckView`), which
  render windows never mount.

What would buy time if the Mac misses the gate: serve the deck before the full map (the served copy needs only
the stamp sites of Strategy 1; Strategy 2's literal scan could run after first paint). Nothing is needed to meet
the gate on this machine.

## Integration

The last step of Phase 1 wired every item together, ran everything from a clean build, and fixed what broke.

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
  Four full E2E runs since: every clipboard test passed.
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

### Final run (2026-10-17, 10:15–10:40 UTC, from a clean `dist`)

| Command | Result |
|---|---|
| `rm -rf packages/app/dist packages/cli/dist && npm run build:reader-only` | builds; no `editor.cjs` |
| `npm run build` | builds |
| `npx tsc -p tsconfig.json --noEmit` | 0 errors |
| `npx vitest run` | 78 files, 1,527 tests passed, 0 failed |
| `npx vitest run -c test/parity/vitest.config.mts` | 4 files, 27 passed |
| `npx playwright test -c test/e2e/playwright.config.ts` (what `npm run test:e2e` runs after the build) | 136 passed in 7.4 min, 0 failed, 0 skipped, 0 flaky; one of the 136 is the expected failure that SECURITY.md describes (the note card's ordering limit after `document.open()`) |
| `npx playwright test -c test/security/playwright.config.ts` (`npm run test:security`; as `bltest`, sandbox on, DNS observed) | 49 passed in 2.8 min, 0 skipped; two of the 49 are the expected failures for the two DNS channels (SECURITY.md) |
| `npx playwright test -c test/parity/playwright.config.ts` | 2 passed (4.4 min): 3 committed fixtures, the negative control, the delayed build |
| `npm run package:smoke` | 17 of 17 PASS |
| `node packages/cli/dist/blueline.cjs check --auto` | 6 of 6 PASS |

The full E2E suite ran four times during integration (135, 132 + 2 failures that led to the closing-view fix
above, 136, 136); the security suite three times plus this one, all 49.

### Coverage (`blueline map --report --json`, on copies)

- **Committed fixtures** (the 18 of `fixtures/decks`, reveal-hash included): every slide reached; 411 nodes
  `exact`, and every one passes the mutation probe with the copy's bytes restored; each deck's coverage equals
  its baseline in `fixtures/expected/` (no drop at all).
- **Josh's 12 decks, `--reduced-motion`**: every slide reached (193 of 193); 6,057 of 6,677 visible text nodes
  exact and probed (90.7%), the same as their baselines in `fixtures/local/expected/` (94.5% of the wording).
  Two notes: D3's one probe failure is the one Phase 0 recorded (a label the deck also keeps in a hidden element
  on another slide, so an edit would change both; the probe refuses it, as it should); D5's count of visible
  nodes changes from run to run (431 and 426 nodes in two runs against 432 in the baseline), because its first
  and last slides carry a ticker whose position under reduced motion is arbitrary; its exact share stays
  96.0–96.1% (96.1% in the baseline).

### The command and the packaged app

- `node packages/cli/dist/blueline.cjs check --auto`: 6 of 6 PASS (key order, stopImmediatePropagation, app
  chords, offscreen keys, capture size 3200×1800, Fit by `setZoomFactor` 0.00% against CSS zoom 11.47%).
- `blueline pdf` through the real command: `generic-index.html` 6 pages (raster, 1200 × 675 pt), `report.html` 5
  pages (document, Letter), `reveal-hash/index.html` 8 pages (raster), each with its `<title>`; exit 0. An output
  in a folder that does not exist: exit 2, nothing written.
- `npx electron-builder --config packages/app/electron-builder.config.cjs --dir --linux` packs
  (`release/linux-unpacked`, release fuses set). `npm run package:smoke`: 17 of 17 PASS.
- `npm run build:reader-only` builds no `editor.cjs`, and the reader-only app starts and opens decks in Read and
  Review (13 of 14 Read, Review and views E2E tests pass on it; the 14th switches to Edit, which a reader-only
  build does not have).

## What to recheck on Josh's Mac

1. **First paint**: `npm run build && npm run first-paint` on the Apple-silicon Mac (SPEC names it).
   Cold start was 854–877 ms here, within 150 ms of the gate; macOS app start differs (code signing checks,
   Gatekeeper on a quarantined build, dyld). A packaged build (`npm run dist`) should be measured too: its
   `app.asar` changes how `main.cjs` is read. On macOS the open request arrives as `open-file` with no second
   process, so "warm, from open request" is what a double-click costs.
2. **Render parity on a Retina display**: rerun `node scripts/parity.mjs --committed --local --trust both
   --pdf`. Offscreen windows render at `deviceScaleFactor` 2 everywhere, but GPU rasterisation, font
   smoothing (no subpixel antialiasing in offscreen captures) and colour management differ on macOS. The
   histogram in the result shows whether differences stay within the tolerance.
3. **Fonts over the network in Protected view**: with direct internet, a Protected deck should load Google Fonts
   (allowlisted) and match the plain render; run once with `--network` and compare Protected with Trusted. Behind
   a proxy it cannot (see Network).
4. **pdftoppm**: `brew install poppler` for the printed-page comparison; without it the PDF check compares page
   counts and sizes only, and says so.
5. **Save as PDF and the rail on real decks**: about 2.4 s per slide here since the script-timed wait (PDF). If
   that is too slow in daily use on the Mac, say so: the wait can learn per deck whether its slides change after
   they arrive.
6. **The Mac-only parts** that never ran here: the Swift helper (`native/macos/build.sh`), the default-app prompt
   on macOS 26.4 or later, quarantine markers on downloads and on Save as PDF output, `blueline check --auto` (F3,
   F4, F5), Present in native full screen, Print through the system dialog, and Help › Install Command Line Tool
   with its administrator prompt. README.md, "Dogfooding on a Mac", lists the steps.

## Files

- `scripts/parity.mjs`, `scripts/first-paint.mjs`: the entry points (they compile only the harness).
- `test/parity/harness/`: the harness (`main.ts`, `plain-view.ts`, `plain-probe.ts`, `compare.ts`,
  `pdf-pages.ts`, `decks.ts`, `job.ts`, `bundle.mjs`).
- `test/parity/parity.spec.ts` (+ `playwright.config.ts`, `fixtures/nondeterministic.html`,
  `fixtures/delayed-build.html`): the committed check, 3 fixtures, the negative control and the delayed-build
  repro (an ordinary test since the fix), about 4 minutes. `npm run test:parity` builds, then runs it and the
  harness's unit tests.
- `test/parity/*.test.ts` (`npx vitest run -c test/parity/vitest.config.mts`): the comparison, PDF read-back,
  PPM parsing, pdftoppm, deck labels and redaction, the seeded `Math.random` and the freeze step.
- `fixtures/perf/`: the generator and its README.
