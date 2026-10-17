# Blueline

A free, open-source desktop app that reads and finishes HTML documents, especially the decks and
one-pagers that AI tools produce. Think Adobe Acrobat Reader, but for HTML.

- **Read:** open any `.html` file in a sandboxed, Chromium-exact view, with Protected view for files from others.
- **Review:** circle, highlight and pin; type, dictate or record notes that travel inside the file.
- **Edit:** click text and type; the change is written straight into the HTML, nothing else touched.
- **Hand off to Claude Code:** notes go to the agent as an anchored change list.

Status: **Phase 1 (Reader) built.** Its exit gate is measured in
[docs/PHASE1-RESULTS.md](docs/PHASE1-RESULTS.md); the criterion left is Josh's week of real use on a Mac build
(see [Dogfooding on a Mac](#dogfooding-on-a-mac)). See [SPEC.md](SPEC.md) for the build spec,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries,
[docs/PHASE0-FINDINGS.md](docs/PHASE0-FINDINGS.md) for what the spike settled,
[docs/spec-amendments/](docs/spec-amendments/README.md) for where the code differs from SPEC.md, and
[SECURITY.md](SECURITY.md) for the security model and its known limits.

## What the Reader does (Phase 1)

- **Opening files:** File › Open, Open Recent, Open in Protected View, Open in Browser, Reveal in Finder; drop a
  file on a window's toolbar or rails; `open-file`, the command line and a second launch all go to the running
  app, one window per file. A file that changes on disk reloads in place on the same slide (it waits while you
  type in a note card); a file that disappears leaves its window read-only until it comes back.
- **Views:** decks (reveal.js and other slide engines) render at their design size and Fit the window
  (Cmd+9), or show at 100% (Cmd+0) or Fill width, with a thumbnail rail; documents render at the window width,
  with an outline from `h1`–`h3` and View › Reading Width. The status bar shows the slide, the zoom, the trust
  state and the current task. PageUp and PageDown step any deck.
- **Present** (Cmd+Option+P): full screen, chrome hidden, every key but Esc to the deck.
- **Find** (Cmd+F) across every slide, shown or not, then the match highlighted on its slide.
- **Save as PDF** (Cmd+Shift+E, Share › Save as PDF, or `blueline pdf`) and **Print** (Cmd+P): print CSS when the
  deck has it, otherwise one lossless page per slide at the slide's aspect; documents on Letter or A4.
- **Protected view and trust:** the trust bar's Allow network and Enable editing are remembered per file until
  the file's internet marker changes; Settings › Trust holds trusted and untrusted folders, "Block all network
  in Protected view" and the CDN allowlist; Help › About Protected View says what it does and what it cannot.
- **First run:** a welcome window (Open a file, Make Blueline your HTML app, Try the sample deck, your name);
  Settings › General shows the default HTML app and offers the same button. Help › Install Command Line Tool
  links the `blueline` command.

Licensing is proposed and pending confirmation: see [LICENSING.md](LICENSING.md).
Never install or run Blueline through `npx blueline` (SPEC 9.5): that npm name belongs to an unrelated package.

## Build

Needs Node 22 or later. Dependencies, Electron 44.7.2 included, come from the workspace install.

```sh
npm install
npm run build              # every bundle, into packages/app/dist and packages/cli/dist
npm run build:reader-only  # Read and Review only: no packages/editor, no dist/editor.cjs (D11)
npm run typecheck          # tsc, strict, whole repo
npm run dist               # package the app into release/ (on a Mac: see Dogfooding on a Mac)
```

The reader-only build removes `dist/editor.cjs`; run `npm run build` again to get Edit back. The app finds
the Edit capability at startup by loading `dist/editor.cjs`, and nothing else imports `packages/editor`.

## Run

```sh
npm start                                     # no file: the welcome window (open a file, the sample deck)
npm start -- path/to/deck.html               # open a file
npm start -- --protected path/to/deck.html   # open it in Protected view
npm run dev                                   # rebuild on change and restart the app
```

On Linux without a display, `scripts/run-electron.mjs` (and the `blueline` command) starts the app under
`xvfb-run` with a 3840×2160 screen. As root it adds `--no-sandbox`, which turns the OS sandbox off; that is a
development convenience only. `BLUELINE_USER_DATA=<dir>` uses another app-data folder.

## The `blueline` command

In development the command is `node packages/cli/dist/blueline.cjs`. In the app, **Help › Install Command Line
Tool…** installs it as `blueline`: a link to the shim shipped inside the app (`Resources/cli/blueline`) in
`~/.local/bin`, or on macOS in `/usr/local/bin` when your login shell's PATH lacks `~/.local/bin` (with an
administrator prompt when that folder is not writable); on Windows a `blueline.cmd` in
`%LOCALAPPDATA%\Blueline\bin`, with the steps to put that folder on PATH. The shim needs Node 22 or later
(it looks in `BLUELINE_NODE`, PATH, Homebrew, nvm, Volta and fnm, and says how to get Node when there is none).
Never `npx blueline`.

```sh
blueline deck.html                      # open in Blueline
blueline open deck.html --protected     # open in Protected view
blueline map deck.html --report         # map the deck and probe every exact node (section 10)
blueline map deck.html --report --json  # the same as JSON: the coverage baseline format (section 11)
blueline map deck.html --min-coverage 0.95 # exit 1 below 95% of the wording (numbers and glyphs aside)
blueline map deck.html --reduced-motion # map it as prefers-reduced-motion: reduce shows it
blueline check                          # the Diagnostics window (guided steps + automatic checks)
blueline check --auto                   # automatic checks only; prints PASS/FAIL, writes check.json
blueline pdf deck.html                  # deck.pdf next to it, without opening a window
blueline pdf deck.html -o handout.pdf   # or a name (or a folder) of your choice; --json for the result
```

**`blueline pdf`** saves the file as Save as PDF does (6.9), headless, under the file's own trust state (its
marker decides, or `--protected`), and never over the file itself. It exits 0 when every slide has its page, 1
when some slide could not be shown (they are named), the file does not exist or the run failed, 2 for a usage
error, a file the app cannot open or an output it refuses, and 130/143/129 on Ctrl+C, SIGTERM and SIGHUP (no
PDF is left behind).

**`blueline map`** launches the app headless, loads the deck in an offscreen view at 1600×900 under its own
trust state, walks every slide (reveal.js, generic key-driven decks, and scrolling documents and single pages
down their whole height), and maps each visible text node to the source as `exact`, `ambiguous` or `none`.
For every `exact` node it runs the **mutation probe**: it writes a sentinel into a hidden copy next to the
deck (`.<name>.bl-probe.html`) through the real patcher, reloads, checks the sentinel shows up in that node
and nowhere else, undoes, and requires the copy's bytes to equal the original's (up to 24 runs share one load, each with its own
sentinel; anything a batch cannot settle is probed again on its own). The copy is removed when `map` ends or is interrupted,
and the deck itself is never written. Coverage counts only nodes that pass. `--report` lists each string that
is not `exact` with its slide and reason. The exit code is 0 on success, and 1 when a probe failed, the
original changed, the walk did not reach every detected slide (coverage `INCOMPLETE`), or `--min-coverage` was
given and not met (or could not be verified, as in a reader-only build, which has no patcher).

**`blueline check`** opens the Diagnostics window: a reveal.js deck with the real key router, note card,
ink and an editable heading, plus guided steps with Pass and Fail buttons (for Wispr Flow dictation). `Save`
writes `check.json` to app data (`~/Library/Application Support/Blueline/check.json` on macOS). `--auto`
runs only the automatic checks: key order and `stopImmediatePropagation` from the isolated world, app chords
on a page that swallows every key, keys to an offscreen deck, capture size at 2x, and Fit by CSS zoom versus
`setZoomFactor`.

`blueline open` returns once the app has started and exits 1 when it could not start. `map` and `check` exit
with the app's result. A SIGINT, SIGTERM or SIGHUP sent to the command (Ctrl+C, a CI timeout, a closed
terminal) stops the whole run with exit 130, 143 or 129 (`map` removes its probe copy first; an interrupted
`check` saves check.json if steps were recorded), and if the command itself is killed, the app notices within
a second and stops.

## Dogfooding on a Mac

Phase 1's last exit criterion is a week of real use: Blueline as the default HTML app on Josh's Mac. Local
builds are unsigned for distribution purposes: `npm run dist` without signing credentials signs the app ad hoc
(Apple silicon runs no unsigned code), without the hardened runtime, and does not notarize it
(`scripts/mac-signing.cjs`, used by `packages/app/electron-builder.config.cjs`). Developer ID signing and notarization are Phase 6.

On the Mac (Apple silicon, Node 22+, Xcode command line tools for the helper):

```sh
git clone <repo> blueline && cd blueline
npm ci
native/macos/build.sh        # the Swift helper: default app and quarantine (optional, but without it the
                             # welcome window cannot make Blueline the default app)
npm run dist                 # → release/Blueline-0.0.0-arm64.dmg and release/mac-arm64/Blueline.app
```

(`CSC_LINK`, `CSC_NAME` or `BLUELINE_SIGN=1` switch to release signing; leave them unset here.)

1. **Install:** open the dmg and drag Blueline to Applications. A build made on this Mac carries no
   quarantine, so it opens normally. A build copied from elsewhere (a download, AirDrop) does: Finder then
   refuses it; run `xattr -dr com.apple.quarantine /Applications/Blueline.app` once, or Control-click › Open.
2. **Make Blueline the default HTML app:** on the first launch without a file the welcome window offers
   **Make Blueline your HTML app** (also in Help › Welcome to Blueline, and in Settings › General, Cmd+,).
   From **macOS 26.4** the system asks you to confirm with *Use "Blueline"* or *Keep*; choose Use. Then
   double-click an `.html` file in Finder: it should open in Blueline. Without the helper: Finder › Get Info on
   an `.html` file › Open with › Blueline › Change All.
3. **Install the command:** Help › Install Command Line Tool…, then `blueline --version` in a new terminal.
4. **Check on the Mac** what the Linux container could not:
   - `blueline check --auto`: F3 (keys reach an offscreen deck while you work in another window), F4 (Retina
     capture: a 1600×900 render is 3200×1800 pixels) and F5 (Fit by `setZoomFactor` matches the design-size
     render) must all PASS; it writes `~/Library/Application Support/Blueline/check.json`.
   - **Quarantine markers:** download a deck with Safari or Chrome and open it: the trust bar must say it came
     from the internet (Protected view). `xattr -p com.apple.quarantine <file>` shows the marker. Save as PDF
     from it, and check the PDF carries the same marker (`xattr -l deck.pdf`).
   - **The default-app prompt** on macOS 26.4 or later: Use makes Blueline the default; Keep leaves the old one
     and the welcome window says "Not now".
   - **Retina capture:** thumbnails in the rail and Save as PDF pages should be sharp at 2x.
   - **First paint:** `npm run build && npm run first-paint` (the gate: a 2 MB deck paints in under 1 s), and
     `npm run parity -- --committed --local --trust both --pdf` (needs `brew install poppler` for the printed
     pages); results in `test-results/parity/`. See docs/PHASE1-RESULTS.md, "What to recheck on Josh's Mac".
   - Present (Cmd+Option+P) on the real display, and Print to a real printer.

## Test

```sh
npm test                 # vitest: unit and fuzz tests (test/unit)
npm run test:e2e         # builds, then Playwright's Electron launcher (test/e2e)
npm run test:security    # builds, then the security suite in both trust states (test/security)
npm run test:parity      # builds, then the exit gate's committed check (test/parity: 3 fixtures, a control, the delayed build)
npm run parity -- --committed --perf --trust both --pdf   # render and PDF parity on every committed fixture (about 35 min)
npm run first-paint      # first paint of the generated 2 MB deck, warm and cold
npm run package:smoke    # builds, packs an unpacked test build (local Electron), checks the shell, trust bar and check --auto on it
```

The E2E and security suites start their own Xvfb displays on Linux, one per Playwright worker, so tests that
use the clipboard never share one. Run as root, the security suite runs the
app as the unprivileged user `bltest` with the OS sandbox on, in a private mount namespace whose DNS points at
the suite's own DNS server, so DNS leaks are observable; otherwise it says which mode it fell back to. The
E2E tests launch the app the same way (as `bltest`, sandbox on); those that run the `blueline` command start
it as root with `--no-sandbox`.
`test/e2e/map.spec.ts` also maps every committed fixture, compares it with its
`fixtures/decks/<name>.expect.json`, and fails when a deck's coverage drops more than 1 point below its
baseline in `fixtures/expected/`.

Phase 1 results (2026-10-17, Linux, Electron 44.7.2, from a clean build): 1,527 unit tests pass (78 files; the
exit-gate harness adds 27 more); 136 of 136 E2E tests pass, of which 1 is an expected failure for the note-card
ordering limit described in SECURITY.md; the security suite passes 49 of 49, of which 2 are expected failures
for the two DNS channels described in SECURITY.md; `blueline check --auto` passes all 6 checks;
`npm run package:smoke` passes 17 of 17. The exit gate (docs/PHASE1-RESULTS.md): render parity is exact on all
296 slide renders of the committed fixtures and passes on 11 of Josh's 12 decks (D2 draws a random decoration);
PDFs pass on 41 of 42 decks (83 of 84 in both trust states); a 2 MB deck paints in 500 ms with the app running
and 854 ms from a cold start (Linux; the gate is 1 s on the Mac). Across the 18 committed fixtures every `exact`
node (411 of 411) passes the mutation probe, and coverage equals the baselines; on Josh's 12 decks every slide
is reached and coverage holds against their local baselines (90.7% of all text, 94.5% of the wording).

Phase 0 results are in docs/PHASE0-FINDINGS.md (and this file's history).

## Fixtures

- `fixtures/decks/`: synthetic and CSP decks for Phase 0, each with a `.expect.json` that states what it tests
  ([fixtures/README.md](fixtures/README.md)).
- `fixtures/expected/`: coverage baselines, written by `blueline map <deck> --report --json`.
- `fixtures/security/`: the security fixtures ([fixtures/security/README.md](fixtures/security/README.md)).
- `fixtures/map/`, `fixtures/matching/`, `fixtures/input/`, `fixtures/slides/`: the review's reproduction decks
  for the walk and probe, matching, the deck preload's input handling, and slide detection (each folder's
  tests are named in [fixtures/README.md](fixtures/README.md)).
- `fixtures/render/`: the render products' decks (print CSS, documents, vertical keys, builds, titles;
  [fixtures/render/README.md](fixtures/render/README.md)); `fixtures/perf/`: the generator of the 2 MB first-paint
  deck; `test/parity/fixtures/`: the exit gate's negative control and the delayed-build repro.
- `packages/app/assets/sample/`: the sample deck the welcome window opens.
- `fixtures/local/`: your own decks and their baselines; gitignored.

To regenerate a baseline after a mapper change, in a commit that says why:

```sh
npm run build
node packages/cli/dist/blueline.cjs map fixtures/decks/entities.html --report --json > fixtures/expected/entities.json
```
