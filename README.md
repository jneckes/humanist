# Blueline

A free, open-source desktop app that reads and finishes HTML documents, especially the decks and
one-pagers that AI tools produce. Think Adobe Acrobat Reader, but for HTML.

- **Read:** open any `.html` file in a sandboxed, Chromium-exact view, with Protected view for files from others.
- **Review:** circle, highlight and pin; type, dictate or record notes that travel inside the file.
- **Edit:** click text and type; the change is written straight into the HTML, nothing else touched.
- **Hand off to Claude Code:** notes go to the agent as an anchored change list.

Status: **Phase 0 (spike) complete.** See [SPEC.md](SPEC.md) for the build spec,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module boundaries,
[docs/PHASE0-FINDINGS.md](docs/PHASE0-FINDINGS.md) for what the spike settled, and
[SECURITY.md](SECURITY.md) for the security model and its known limits.

Licensing is proposed and pending confirmation: see [LICENSING.md](LICENSING.md).
Never install or run Blueline through `npx blueline` (SPEC 9.5): that npm name belongs to an unrelated package.

## Build

Needs Node 22 or later. Dependencies, Electron 44.7.2 included, come from the workspace install.

```sh
npm install
npm run build              # every bundle, into packages/app/dist and packages/cli/dist
npm run build:reader-only  # Read and Review only: no packages/editor, no dist/editor.cjs (D11)
npm run typecheck          # tsc, strict, whole repo
```

The reader-only build removes `dist/editor.cjs`; run `npm run build` again to get Edit back. The app finds
the Edit capability at startup by loading `dist/editor.cjs`, and nothing else imports `packages/editor`.

## Run

```sh
npm start -- path/to/deck.html               # open a file
npm start -- --protected path/to/deck.html   # open it in Protected view
npm run dev                                   # rebuild on change and restart the app
```

On Linux without a display, `scripts/run-electron.mjs` (and the `blueline` command) starts the app under
`xvfb-run` with a 3840×2160 screen. As root it adds `--no-sandbox`, which turns the OS sandbox off; that is a
development convenience only. `BLUELINE_USER_DATA=<dir>` uses another app-data folder.

## The `blueline` command

In development the command is `node packages/cli/dist/blueline.cjs` (Phase 1 installs it as `blueline`).

```sh
blueline deck.html                      # open in Blueline
blueline open deck.html --protected     # open in Protected view
blueline map deck.html --report         # map the deck and probe every exact node (section 10)
blueline map deck.html --report --json  # the same as JSON: the coverage baseline format (section 11)
blueline map deck.html --min-coverage 0.95
blueline map deck.html --reduced-motion # map it as prefers-reduced-motion: reduce shows it
blueline check                          # the Diagnostics window (guided steps + automatic checks)
blueline check --auto                   # automatic checks only; prints PASS/FAIL, writes check.json
```

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

## Test

```sh
npm test                 # vitest: unit and fuzz tests (test/unit)
npm run test:e2e         # builds, then Playwright's Electron launcher (test/e2e)
npm run test:security    # builds, then the security suite in both trust states (test/security)
npm run package:smoke    # builds, packs an unpacked test build (local Electron), checks the shell, trust bar and check --auto on it
```

The E2E and security suites start their own Xvfb display on Linux. Run as root, the security suite runs the
app as the unprivileged user `bltest` with the OS sandbox on, in a private mount namespace whose DNS points at
the suite's own DNS server, so DNS leaks are observable; otherwise it says which mode it fell back to. The
E2E tests launch the app the same way (as `bltest`, sandbox on); those that run the `blueline` command start
it as root with `--no-sandbox`.
`test/e2e/map.spec.ts` also maps every committed fixture, compares it with its
`fixtures/decks/<name>.expect.json`, and fails when a deck's coverage drops more than 1 point below its
baseline in `fixtures/expected/`.

Phase 0 results (2026-10-16, Linux, Electron 44.7.2): 1022 unit tests pass (56 files); 81 of 81 E2E tests
pass, of which 1 is an expected failure for the note-card ordering limit described in SECURITY.md; the security suite passes 45 of 45, of which 2 are expected failures for the two DNS channels
described in SECURITY.md; `blueline check --auto` passes all 6 checks, as root and as `bltest`; `npm run
package:smoke` passes; and across the 18 committed fixtures every `exact` node (411 of 411) passes the
mutation probe with byte-exact undo. On Josh's 12 real decks (kept local), every slide is reached and coverage
is 89.0% with reduced motion and 71.3% with motion as the decks set it, against the 95% gate
(`docs/PHASE0-FINDINGS.md`, F25–F30). What the review found and fixed: `docs/PHASE0-FINDINGS.md`, Review round 1.

## Fixtures

- `fixtures/decks/`: synthetic and CSP decks for Phase 0, each with a `.expect.json` that states what it tests
  ([fixtures/README.md](fixtures/README.md)).
- `fixtures/expected/`: coverage baselines, written by `blueline map <deck> --report --json`.
- `fixtures/security/`: the security fixtures ([fixtures/security/README.md](fixtures/security/README.md)).
- `fixtures/map/`, `fixtures/matching/`, `fixtures/input/`, `fixtures/slides/`: the review's reproduction decks
  for the walk and probe, matching, the deck preload's input handling, and slide detection (each folder's
  tests are named in [fixtures/README.md](fixtures/README.md)).
- `fixtures/local/`: your own decks and their baselines; gitignored.

To regenerate a baseline after a mapper change, in a commit that says why:

```sh
npm run build
node packages/cli/dist/blueline.cjs map fixtures/decks/entities.html --report --json > fixtures/expected/entities.json
```
