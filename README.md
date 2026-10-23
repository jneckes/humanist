# Blueline

A free, open-source desktop app that reads and finishes HTML documents, especially the decks and
one-pagers that AI tools produce. Think Adobe Acrobat Reader, but for HTML.

- **Read:** open any `.html` file in a sandboxed, Chromium-exact view, with Protected view for files from others.
- **Review:** circle, highlight and pin; type, dictate or record notes that travel inside the file.
- **Edit:** click text and type; the change is written straight into the HTML, nothing else touched.
- **Hand off to Claude Code:** notes go to the agent as an anchored change list.

Status: **Phase 2 (Edit) is ready for Josh's real use on the Mac.** Build from the commit that brings this status line
(the uniqueness rule's final runs, on top of 1554149), as in [Real use of Edit on a Mac](#real-use-of-edit-on-a-mac).
Its exit gate is measured in [docs/PHASE2-RESULTS.md](docs/PHASE2-RESULTS.md): the fuzz, concurrency and reader-only
criteria are met (the extra fuzz run on Josh's decks has 1 failure, from the known limit of the probe's reach on a CSS
marquee, which the lead accepted for D5's ticker and which this run met on D11's: not a wrong write, and not counted
as a pass); the one left is Josh finishing 3 real decks with Edit on a Mac build. Phase 1 (Reader) is measured in
[docs/PHASE1-RESULTS.md](docs/PHASE1-RESULTS.md); its week of real use is also Mac work (see [Dogfooding on a
Mac](#dogfooding-on-a-mac)). See [SPEC.md](SPEC.md) for the build spec, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for module boundaries, [docs/PHASE0-FINDINGS.md](docs/PHASE0-FINDINGS.md) for what the spike settled,
[docs/spec-amendments/](docs/spec-amendments/README.md) for where the code differs from SPEC.md, and
[SECURITY.md](SECURITY.md) for the security model and its known limits.

## What the Reader does (Phase 1)

- **Opening files:** File › Open, Open Recent, Open in Protected View, Open in Browser, Reveal in Finder; drop a
  file on a window's toolbar or rails; `open-file`, the command line and a second launch all go to the running
  app, one window per file. A file that changes on disk reloads in place on the same slide (it waits while you
  type in a note card); when the new file's trust differs (say, a new download saved over it), it opens again
  in its new trust state instead, and the trust bar says why. A file that disappears leaves its window
  read-only until it comes back.
- **Views:** decks (reveal.js and other slide engines) render at their design size and Fit the window
  (Cmd+9), or show at 100% (Cmd+0) or Fill width, with a thumbnail rail; documents render at the window width,
  with an outline from `h1`–`h3` and View › Reading Width. The status bar shows the slide, the zoom, the trust
  state and the current task. PageUp and PageDown step any deck.
- **Present** (Cmd+Option+P): full screen, chrome hidden, every key but Esc to the deck; it closes Find.
- **Find** (Cmd+F) across every slide, shown or not, then the match highlighted on its slide.
- **Save as PDF** (Cmd+Shift+E, Share › Save as PDF, or `blueline pdf`) and **Print** (Cmd+P): the deck's print
  CSS when Chromium's print of it gives one page per slide at the slide's aspect, otherwise one lossless page per
  slide at the slide's aspect, in slide order; documents on Letter or A4. Both wait for what the page's scripts
  draw first.
- **Protected view and trust:** the trust bar's Allow network and Enable editing are remembered per file until
  the file's internet marker changes (and, for a file with no marker and on Windows, until another file is
  saved at its path); Settings › Trust holds trusted and untrusted folders, "Block all network
  in Protected view" and the CDN allowlist; Help › About Protected View says what it does and what it cannot.
- **First run:** on the first launch without a file, a welcome window (Open a file, Make Blueline your HTML app,
  Try the sample deck, your name, the crash-report question); later launches without a file show a small Open
  window on Linux and Windows and nothing on macOS (the app stays in the Dock), and a second launch brings the
  open Blueline window forward. Settings › General shows the default HTML app and offers the same button. Help › Install Command Line Tool
  links the `blueline` command.
- **Default app on Windows:** the installer registers Blueline for `.html` and `.htm` (Open With and Default
  Apps) in the install mode's hive, never changes the extensions' own default (you choose Blueline in Default
  Apps), and removes exactly that on uninstall; a per-machine install also removes the per-user registration an
  earlier per-user install left. On macOS the app declares the file types itself.

## What Edit does (Phase 2)

- **Edit mode** (Cmd+3, or the mode switch): available when the build has the Edit capability and the file is
  Trusted or you pressed Enable editing in Protected view; otherwise the mode switch and Cmd+3 say why. Edit shows
  the deck with reduced motion and pauses its animations. Hover outlines show what you can edit: solid for text
  Blueline can place exactly, dashed for text it finds in several places. Press the text to place a caret (the press
  never reaches the deck, so it does not advance the slide or follow a link), type, and press Enter (Esc cancels;
  clicking elsewhere commits). Text under a transparent click-to-advance area, or in a label layer the deck makes
  click-through, can usually be pressed too. In the field, right-click a misspelled word for the dictionary's
  suggestions, and drag selected text to move it. Only that piece of text changes in the file: Blueline writes the smallest
  splice into the HTML text or the script or JSON string the page shows, with the file's own encoding, escapes and
  line endings, and verifies the new file before it replaces the old one. Pasted and dictated line breaks become
  spaces; smart punctuation (Settings › General, on by default) curls your quotes only where the text already uses
  curly ones.
  A badge warns when the edit adds a line, overflows its box or leaves a widow, and "Showing source case" when the
  deck shows the text in another case than the file stores.
- **Dashed text** opens a picker: each place the text appears, with ±40 characters of context and its line, and a
  warning when the deck also uses the text as a key. Text that is not editable (numbers a script computes, text
  the deck's script rewrote, unless Blueline finds that text in the script itself; text Blueline cannot place) says
  "Not editable".
- **When a write cannot be placed** (the file changed meanwhile and Blueline cannot be sure which copy of the text
  you edited, markup would be needed, the file was moved, deleted or became Protected, and the like), your exact
  words are kept as a `verbatim` note, and the file is left exactly as it was.
- **"Saved · deck.html:142"** with **Undo**, and "· also changes N other places" when one piece of text shows in
  several places; the toast stays when the deck reloads. Outside a text field, Cmd+Z and Cmd+Shift+Z undo and redo
  your edits byte for byte, newest first (an edit still being written counts as the newest), even after
  another program changed the file elsewhere; when the change touched your edit, Blueline says "Can't undo in
  place" and offers **Make a note**. Inside a field, Cmd+Z is the field's own undo.
- **History** (File › History): Blueline keeps the file as it was before each of its writes (the newest 100) and
  each external change it saw; **Restore** shows the diff and how many later edits and external changes it
  discards, and asks first.
- **Notes list** (the right panel in Review and Edit): each edit and verbatim note with before → after, its slide
  and line, and **Copy**. Each edit note locks its text; a later change by another program to that text is flagged.
- **External changes while you edit** (an agent saving the deck): the edit lands on its text or becomes a note, the
  other change is kept, and the page reloads once the field closes.
- **Closing with an open field:** closing the window, quitting, or clicking elsewhere in the window commits what you
  typed first. If the deck cannot answer within 3 s (a hung page), the window closes anyway and nothing is written or
  kept.
- **Your name** on notes: the name chip in the toolbar.

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
npm start                                     # no file: the welcome window on the first run, then the Open window
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
`%LOCALAPPDATA%\Blueline\bin`, with the steps to put that folder on PATH. On Linux, a `~/.local/bin` that the
install creates is on PATH after you log in again (the login shell adds it once it exists), and the install
says so. The shim needs Node 22 or later (it looks in `BLUELINE_NODE`, PATH, Homebrew, nvm, Volta and fnm, and
says how to get Node when there is none).
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

**`blueline pdf`** saves the file as Save as PDF does (6.9), headless, under the trust state the app would open
the file in (Settings › Trust: the trusted and untrusted folders, "Block all network in Protected view" and the
CDN allowlist; then its marker, or `--protected`; a decision remembered in the app never applies), and never over
the file itself. It exits 0 when every slide has its page, 1
when some slide could not be shown (they are named), the file does not exist or the run failed, 2 for a usage
error, a file the app cannot open or an output it refuses, and 130/143/129 on Ctrl+C, SIGTERM and SIGHUP (no
PDF is left behind).

**`blueline map`** launches the app headless, loads the deck in an offscreen view at 1600×900 under the trust
state the app would open it in (as for `blueline pdf`), walks every slide (reveal.js, generic key-driven decks, and scrolling documents and single pages
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

**Without building it yourself:** every push to this branch builds the app on a GitHub-hosted Apple silicon Mac
(`.github/workflows/mac-build.yml`): the repo's Actions tab › "Mac build" › the newest run › Artifacts ›
`Blueline-mac-arm64` (a zip holding `Blueline-0.0.0-arm64.dmg`). Open the dmg and drag Blueline to Applications.
Because the app is signed ad hoc, macOS refuses it the first time: open System Settings › Privacy & Security and
click **Open Anyway** next to Blueline (or run `xattr -dr com.apple.quarantine /Applications/Blueline.app` once).
The same job compiles the Swift helper into the app and runs `npm run package:smoke` on the packaged app on that
Mac (its layout, `blueline check --auto` with F3, F4 and F5, `blueline pdf`, the shell and the Protected-view trust
bar); the log is the `mac-smoke-results` artifact. First run, 2026-10-23 (run 39971521973): 17 of 17 PASS.

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
   **Make Blueline your HTML app** (also in Help › Welcome to Blueline, and in Settings › General, Cmd+,). Later
   launches without a file show nothing on a Mac: use Help › Welcome to Blueline.
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
   - **First paint:** `npm run build && npm run first-paint` (the gate: the generated 2 MB deck, made like your
     decks with fonts, inline library code, text and images (`fixtures/perf/README.md`), paints in under 1 s warm
     and cold, and every counted run paints), then `node scripts/first-paint.mjs --deck <a real deck> --trust
     trusted --no-profile` on two or three of your own decks (it prints each case's run count and main's share
     in ms per MB), and
     `npm run parity -- --committed --local --trust both --pdf` (needs `brew install poppler` for the printed
     pages); results in `test-results/parity/`. See docs/PHASE1-RESULTS.md, "What to recheck on Josh's Mac".
   - Present (Cmd+Option+P) on the real display, and Print to a real printer.

## Real use of Edit on a Mac

Phase 2's last exit criterion: Josh finishes 3 real decks using only Edit for text changes. Build and install from
the commit named in Status above, as in [Dogfooding on a Mac](#dogfooding-on-a-mac), then:

1. For each of the 3 decks, make every text change in Edit (Cmd+3, click the text, type, Enter): no text editor and
   no agent for text. Use the picker when it appears, and Cmd+Z outside a field.
2. Check what the Linux container could not: typing with press-and-hold accents and other input methods; Wispr Flow
   dictation into a field (line breaks become spaces); macOS text substitutions (smart quotes and dashes) against
   Settings › General › Smart punctuation; Cmd+Z inside a field and outside it; clicking away with the window active
   and inactive (a click elsewhere commits only while the window is active).
3. Edit a downloaded (quarantined) deck after Enable editing: `xattr -l` shows the same `com.apple.quarantine` value
   and any Finder tags after the write, and the deck opens again with its trust decision.
4. While a deck is open in Edit, have the agent (or another editor) change something else in it, then keep
   editing: the deck reloads after the field closes, and both changes are there. Also once in an iCloud Drive or
   Dropbox folder.
5. Once, restore a deck from File › History to an earlier time, and check the diff it shows.
6. After each deck: a diff against a copy shows only the edited text, and the deck renders in a browser as before.
7. Note per deck: the number of edits and of verbatim notes (the notes list), every "Not editable" text and every
   note's reason (counts and labels only when shared), any write to the wrong place (must be none), any external
   change lost (must be none), and the time from Enter to "Saved" on a large deck.

Pass: all 3 decks finished this way, no wrong-place write, no lost change. docs/PHASE2-RESULTS.md, "What to recheck
on Josh's Mac", lists the rest.

## Test

```sh
npm test                 # vitest: unit and fuzz tests (test/unit)
npm run test:e2e         # builds, then Playwright's Electron launcher (test/e2e)
npm run test:security    # builds, then the security suite in both trust states (test/security)
npm run test:parity      # builds, then the exit gate's committed check (test/parity: 3 fixtures, the seeded-random and delayed-build fixtures, the negative controls)
npm run parity -- --committed --perf --trust both --pdf   # render and PDF parity on every committed fixture (about an hour)
npm run first-paint      # first paint of the generated 2 MB deck, warm and cold
npm run package:smoke    # builds, packs an unpacked test build (local Electron), checks the shell, trust bar and check --auto on it
npm run test:reader-only # Phase 2 gate: a copy of the tree without packages/editor, built reader-only, its suites without @edit
npm run fuzz             # Phase 2 gate: 1,000 seeded edits in Chromium on the committed fixtures (about 18 min); --local for your decks
```

Tests that need the Edit capability carry `@edit` in their title (Playwright) or live in `test/unit/editor/` or a
`*.edit.test.ts` file (vitest), so the reader-only gate can leave them out.

The E2E and security suites start their own Xvfb displays on Linux, one per Playwright worker, so tests that
use the clipboard never share one. Run as root, the security suite runs the
app as the unprivileged user `bltest` with the OS sandbox on, in a private mount namespace whose DNS points at
the suite's own DNS server, so DNS leaks are observable; otherwise it says which mode it fell back to. The
E2E tests launch the app the same way (as `bltest`, sandbox on); those that run the `blueline` command start
it as root with `--no-sandbox`.
`test/e2e/map.spec.ts` also maps every committed fixture, compares it with its
`fixtures/decks/<name>.expect.json`, and fails when a deck's coverage drops more than 1 point below its
baseline in `fixtures/expected/`.

Phase 2 results (2026-10-21, Linux, Electron 44.7.2, from a clean build, after the Phase 2 review and its repair;
docs/PHASE2-RESULTS.md, logs in `test-results/p2-measure/`): all 2,042 unit tests pass (110 files, the Node fuzz's
1,200 edits among them, 0 failures); the fuzz and parity harnesses add 55 and 37 that pass; the E2E suite runs 290
tests, 289 pass and 1 is the expected failure for the note-card ordering limit; the security suite runs 65 tests, 59
pass and 6 are the expected failures listed in SECURITY.md (as in Phase 1); `blueline check --auto` passes 6 of 6 and
`npm run package:smoke` 17 of 17. The exit gate: the Chromium fuzz makes 1,000 seeded edits on the committed
fixtures with **0 failures** (903 written, every one through the mutation probe on the node the author typed in; 72
notes by rule; 25 no-ops); on Josh's 12 decks, the extra run, 917 written edits pass and 2 fail (55 notes, 26
no-ops): two D5 edits written exactly, whose text the probe found in the page but never in view, because D5's ticker
had carried it off screen at every stop, a limit of the method that awaits a decision, not a wrong write; the fuzz's
self-test fails each of the 11 cases it must fail and passes the 3 it must pass; the typed-edit and concurrency E2E
tests pass (30 of 30 over three repeats, two duplicated-text cases among them); `npm run test:reader-only` passes.
Coverage equals the baselines on all 19 committed fixtures, and holds on Josh's 12 decks (11 equal run for run;
D5's ticker moves a few nodes, as in Phase 1). Left: real use on a Mac, and a decision on how the probe treats
D5's ticker.

The Phase 2 hardening round (2026-10-21, after those runs; docs/PHASE2-RESULTS.md, "The hardening round"): three
attackers found 13 ways a write could land on another copy of the text than the one the author typed in, or in another
run of the element pressed. All are fixed: a stale edit, an undo and a redo are written only where the text on both
sides of the place confirms it (`packages/editor/src/anchors.ts`), the caret is placed as the text looked when the
author pressed, no write replaces bytes whose trust differs from the window's, and Cmd+Z right after an Enter that
became a note undoes nothing. Each finding has a regression test that fails before the round and passes after it, and
the attackers' property tests find no wrong write that the text could tell apart. A second round of three attackers
found 7 more (docs/PHASE2-RESULTS.md, "The second hardening round"): a generator that renumbers slides, a new card
modelled on the author's, a program writing the deck in place, and three ways Blueline's own writes were not seen when
placing a later write. All are fixed: a write must also agree with the author's slide or record (a rule the
uniqueness rule below has since replaced), Blueline's own writes are carried exactly and everything else placed, and a
deck still being written is waited for or left alone. The first round also fixed the two tests
that failed by chance: the flood rate limit (note operations are now limited to 50 a second per document, SECURITY.md)
and a PDF cancelled by its document's close. From a clean build after the round (logs in
`test-results/p2-harden-final/`): all 2,100 unit tests pass (112 files, the Node fuzz's 1,200 edits among them, 0
failures); the E2E suite runs 301 tests, and in the third of three runs all 300 pass and 1 is the expected failure
(each of the first two had one other test fail by chance, in code the round did not change; docs/PHASE2-RESULTS.md,
Open issues); the security suite runs 65 tests, 59 pass and 6 are the expected failures; `blueline check --auto`
passes 6 of 6, `npm run package:smoke` 17 of 17, the parity Playwright suite 9 of 9, the typed-edit and concurrency
tests 30 of 30 over three repeats, and `npm run test:reader-only` passes. The cost: a stale edit with another
program's change within about 128 characters of it is a verbatim note now. The fuzz gate in Chromium writes 894 of
1,000 edits on the committed decks with **0 failures** (903 before the round); on Josh's decks 915 written edits pass
(917 before) and 1 fails, again D5's ticker. From a clean build after the second round (2026-10-22, logs in
`test-results/p2-harden2-final/`): all 2,129 unit tests pass (113 files, the Node fuzz's 1,200 edits among them, 0
failures); the E2E suite runs 316 tests, and in each of three runs 315 pass and 1 is the expected failure; the
security suite, run twice, 65 tests, 59 pass and 6 are the expected failures; `blueline check --auto` passes 6 of 6,
`npm run package:smoke` 17 of 17, the parity Playwright suite 9 of 9, and `npm run test:reader-only` passes. The fuzz
gate in Chromium writes 894 of 1,000 edits on the committed decks with **0 failures**, every edit as after the first
round; on Josh's decks 913 written edits pass (one stale edit on D9 is a note now, by the round's rule on Blueline's
own writes) and 1 fails, D5's ticker again. The cost on copies of Josh's decks, case for case against the attackers'
runs: 2.0% fewer stale edits written (7,128 of 17,091 realistic changes near repeated text) and 2.7% fewer undos and
redos done (7,296 of 22,166).

The uniqueness rule (lead decision F-1, 2026-10-22; docs/PHASE2-RESULTS.md, "The uniqueness rule"): instead of
telling copies of a text apart after another program changed the deck, Blueline no longer chooses among them. A stale
edit, an undo or a redo across another program's change is written only when its text is in exactly one place before
and after (text Blueline never writes, such as the `<title>` or an attribute value, counts as a place), the run maps
exactly onto that place, and the text on both sides confirms it; anything else is a verbatim note (or "Can't undo in
place"). Blueline's own writes in between are still carried exactly. Re-run at full size, the attack suites of both
hardening rounds write into another copy only where the other program's change left the bytes exactly as they were
(identical slides swapped, or duplicated and deleted in one save), and in one structural case where a save replaced
the author's slide by a byte-identical one at the same place; the byte-identical classes the rounds had accepted
(identical slides swapped or moved, an identical copy at the author's deleted slide's place, a slide duplicated and
its original deleted, identical dividers) are notes. The cost: a stale edit, undo or redo of text in more than one place is a note across any change by another program, however
far away. The Node fuzz writes 831 of 1,200 edits (912 before); the fuzz gate in Chromium writes 891 of 1,000 on the
committed decks with **0 failures** (894 before); on copies of Josh's decks, whose campaigns target repeated text, no
stale edit of it is written (7,128 of 17,091 before), and undos of the author's own edits still are (4,798 of 10,830).
A third round attacked the rule's first implementation and found nine ways to a write it forbids (docs/PHASE2-RESULTS.md,
"The uniqueness rule, attacked"): external saves main took from the watcher did not count as changes, an undo was timed
by when its bytes were last made, and a deck still being written that paused after a `</html>` inside an iframe's
`srcdoc` passed for a whole one. All are fixed: main tells the queue every version it reads from the file, the queue
carries an edit along a log of what the file became, in order, an undo starts from the write it undoes, and the HTML
parser says where a deck ends. In every attack suite of the three rounds, the writes left on another copy are where the
other program's changes left the bytes exactly as Blueline last saw them, and the one save that replaced the author's
slide by a byte-identical slide at its place.

The final runs of the uniqueness rule (2026-10-22, Linux, Electron 44.7.2, from a clean build, logs in
`test-results/p2-unique-final/`; docs/PHASE2-RESULTS.md, "The uniqueness rule's final runs"): all 2,202 unit tests
pass (116 files; the Node fuzz's 1,200 edits among them write 818, 0 failures); the fuzz and parity harnesses add 55
and 37 that pass; the E2E suite runs 316 tests, and in each of three runs 315 pass and 1 is the expected failure; the
security suite, run twice, 65 tests, 59 pass and 6 are the expected failures; `blueline check --auto` passes 6 of 6,
`npm run package:smoke` 17 of 17, the parity Playwright suite 9 of 9, and `npm run test:reader-only` passes (1,015 s).
The fuzz gate in Chromium writes 891 of 1,000 edits on the committed decks with **0 failures**, every edit as on the
first F-1 tree; on Josh's decks 878 written edits pass, 92 are notes by rule (36 of them the rule's own: repeated text
after another program's change, against 1 in the second round's run) and 1 fails: an item of D11's CSS marquee that
held its new text and the probe's sentinel but was out of view at every stop, the same limit of the probe's reach as
D5's ticker, which the lead accepted as a known limit (reported as that, not as a pass).

Phase 1 results (2026-10-18, Linux, Electron 44.7.2, from a clean build, after review round 1): 1,639 unit
tests pass (84 files; the exit-gate parity harness adds 37 more); the E2E suite runs 194 tests, 193 pass and 1 is
an expected failure for the note-card ordering limit described in SECURITY.md; the security suite runs 57 tests,
51 pass and 6 are expected failures (the two DNS channels, and the file-drop limits for a frame rewritten with
`document.open()` or made `about:blank` inside a shadow root, in both trust states; all in SECURITY.md);
`blueline check --auto` passes all 6 checks; `npm run package:smoke` passes 17 of 17. The exit gate
(docs/PHASE1-RESULTS.md), with the seeded `Math.random`, a control render per slide and a per-channel tolerance
of 2: render parity is exact on all 424 slide renders of the committed fixtures (49 decks, the 2 MB deck
included) and passes on all 12 of Josh's decks (370 of 386 renders identical; worst D11, 0.343%); all 122 PDFs
pass under the amended criterion (raster pages against Blueline's slide render, pages Chromium prints against
its own print); the real-shaped 2 MB deck paints in 430 ms (Trusted) and 413 ms (Protected) with the app
running and 831 and 810 ms from a cold start (medians of 5, every run painted; Linux, the gate is 1 s on the
Mac). Across the 19 committed fixtures every `exact` node (423 of 423) passes the mutation probe, and coverage
equals the baselines; on Josh's 12 decks every slide is reached and coverage holds against their local
baselines (90.7% of all text, 94.5% of the wording; D5's ticker moves its count by a few nodes from run to run).

Phase 0 results are in docs/PHASE0-FINDINGS.md (and this file's history).

## Fixtures

- `fixtures/decks/`: synthetic and CSP decks for Phase 0, each with a `.expect.json` that states what it tests
  ([fixtures/README.md](fixtures/README.md)).
- `fixtures/expected/`: coverage baselines, written by `blueline map <deck> --report --json`.
- `fixtures/security/`: the security fixtures ([fixtures/security/README.md](fixtures/security/README.md)).
- `fixtures/edit/`: the deck the Edit overlay's E2E tests drive ([fixtures/edit/README.md](fixtures/edit/README.md)).
- `fixtures/map/`, `fixtures/matching/`, `fixtures/input/`, `fixtures/slides/`: the review's reproduction decks
  for the walk and probe, matching, the deck preload's input handling, and slide detection (each folder's
  tests are named in [fixtures/README.md](fixtures/README.md)).
- `fixtures/render/`: the render products' decks (print CSS, documents, vertical keys, builds, titles;
  [fixtures/render/README.md](fixtures/render/README.md)); `fixtures/perf/`: the generator of the 2 MB first-paint
  deck; `test/parity/fixtures/`: the exit gate's negative controls, the seeded-random fixture and the delayed-build
  repro.
- `packages/app/assets/sample/`: the sample deck the welcome window opens.
- `fixtures/local/`: your own decks and their baselines; gitignored.

To regenerate a baseline after a mapper change, in a commit that says why:

```sh
npm run build
node packages/cli/dist/blueline.cjs map fixtures/decks/entities.html --report --json > fixtures/expected/entities.json
```
