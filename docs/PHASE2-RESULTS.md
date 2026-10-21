# Phase 2 results (exit gate)

SPEC 10, Phase 2, names four exit criteria: the fuzz test, the concurrency gate, the reader-only build and real use.
docs/PHASE2-PLAN.md fixes how each is measured (decisions P2-15 and P2-16, "Exit gate"). This page gives the method
and the results of each harness, what the runs found, what must be checked again on Josh's Mac, and Josh's
real-use checklist. Josh's 12 decks are called D1 to D12 only, as in docs/PHASE0-FINDINGS.md. The machine-readable
results are written by the scripts (paths under each section); they are not committed.

The gate item first ran its harnesses in the Linux dev container on 2026-10-19, while the other build items were
still at work in the tree (its sections below say what each run saw). The integration step then made the pieces
fit (the open contract requests, its fixes, the `@edit` tags) and ran everything again (commit 91b58dc). An
adversarial review of that tree confirmed 29 findings, and their fixes changed the write queue, main's edit
session, the overlay, the clean-up and both fuzz harnesses (section "The Phase 2 review"). Every harness and suite
then ran once more on the fixed tree, on 2026-10-20 ("The final runs"); the table and every result below come from
those runs, unless a section says it describes an earlier one.

| Criterion | Gate (SPEC 10 Phase 2) | Result here |
|---|---|---|
| Fuzz, committed fixtures | 1,000 seeded edits, the typed path, notes only by rule, every written edit through the checks and the mutation probe in Chromium, zero failures | **met**: 1,000 edits over the 47 UTF-8 committed decks: 903 written (90.3%), 72 notes by rule (7.2%), 25 no-ops (2.5%), **0 failures**; every written edit passed the mutation probe on the node the author typed in (none probed on its own, none unprobed); 19 min. The same 1,000 records as the gate item's and the integration's runs |
| Fuzz, Josh's decks | the extra run | **met**: 1,000 edits over D1–D12: 920 written (92.0%), 54 notes by rule (5.4%), 26 no-ops (2.6%), **0 failures**; every written edit passed the mutation probe on the author's node (1, on D5, probed on its own; none unprobed); 74 picked candidates (65 written); 102 stale-version requests, 95 written by position and none `ambiguous`; 29 min |
| Concurrency | an external write 50 ms before the commit: the edit lands on the right text or becomes a verbatim note; the external change survives | **met**: through the app, `test/e2e/edit-gate-concurrency.spec.ts` (an unrelated change, the same text rewritten, an element inserted before the target, a change while the field stays open, a write inside the atomic write before the re-hash): 5 of 5 in each of the two final E2E runs, and with the typed-edit spec 24 of 24 run three times; the inserted element's edit landed on its heading in all 5 runs; below the app, the queue's unit tests and the fuzz's external writes (none lost, every edit on its run or a note by rule). The window between the re-hash and the rename is the protocol's stated limit |
| Reader-only | `npm run test:reader-only` passes with `packages/editor` removed | **not met on this tree**, for one stale unit test: the copy without `packages/editor`, the reader-only build, the bundle check, tsc, the reader-only `map`, the E2E suite without `@edit` (168 tests, 1 the known note-card ordering limit, an expected failure) and the security suite without `@edit` (57 tests, 6 expected failures, the known limits) pass; vitest (96 files, 1,877 tests) fails on `env.test.ts`, whose expected list of input types predates the review's `deleteByDrag` (Open issues). `FAILED` in 17 min, for that reason alone in run 2 |
| Real use | Josh finishes 3 real decks using only Edit for text changes | **not started**: needs the Mac build; checklist below |

## The Phase 2 review

An adversarial review of the integrated tree (commit 91b58dc) confirmed 29 findings, each reproduced by a second
reviewer: 1 critical, 4 high, 13 medium and 11 low. Four could put an edit on the wrong text or undo the wrong edit
(findings 0, 1, 14, 22); others lost typed text, left Edit waiting for a reload that never came, or made the gate
weaker than this page said. SECURITY.md, docs/ARCHITECTURE.md ("What the Phase 2 review changed in the flows") and
docs/spec-amendments/README.md give the rules the fixes set and the code that holds them. Each fix has a regression
test that failed on the tree before it and passes after it (Files, below).

- **A stale edit is placed by position** (findings 0, 1, 22). When the file changed since the field's version, the
  queue maps the run's range through a diff of that version to the current bytes and writes only at exactly that
  range, on the same text, with no change overlapping it. The 32 characters of context never choose between copies:
  before, a repeated slide or label let them pick another copy, with no other program writing. A version the queue
  does not hold, a diff past its time limit or an overlapping change makes a verbatim note (`ambiguous` or `stale`).
  Main pins the version of every open field and of the page in the queue until the commit is answered, and the
  overlay opens no field on a version with an unanswered commit of its own: the press waits for the answer.
- **Typed text is never lost silently** (5, 19, 6, 7, 20, 16). Before a window closes (a D-1 reopen closes it too) or
  the app quits, and when a click in the shell takes focus from the deck, main asks the deck to commit its open field
  (before a close or a quit it waits, at most 3 s); the commit a deck makes as its view leaves Edit is still taken.
  The mode is checked when main accepts a commit, so a commit accepted in Edit is written after a switch to Read. A
  commit accepted from real input that cannot be written because the file moved, was deleted, stopped being UTF-8
  or became Protected is kept as a verbatim note with its exact texts.
- **Undo waits for the writes in flight** (14): Cmd+Z, Cmd+Shift+Z and the toast's Undo run in the document's lane,
  behind its commits, and act on the newest write that landed.
- **Edit authorisation expires** (4): a field's authorisation ends when it closes, when the view leaves Edit, or after
  10 minutes without trusted input in that view.
- **The Saved toast is the shell's** (8): "Saved · <file>:<line>", "· also changes N other places" and Undo survive the
  reload that follows a literal or picked write.
- **Own writes** (2, 3, 15, 17, 18): an own html-text write advances the page's version (no "Deck changed" state that
  never ends); after adopting an own write main re-hashes the file and treats other bytes as an external change, and
  `knownHash` never moves back; the content main knew advances after every own write, even one that lands after its
  window closed, so locks are transformed from the right text.
- **History** (21): one entry per write that landed, deduplicated by content; a requeued write adds none.
- **The overlay** (9, 10, 11, 12, 13): text under an empty element (a click-to-advance button) or in a
  `pointer-events: none` layer is found by its geometry and can be edited; a node a script rewrote (`touched`) offers
  no candidate and is not editable; the fit guard measures the text as it will render (`text-transform`,
  `font-variant-caps`); a space typed in a `<button>` or `<summary>` is inserted; dragging selected text inside a field
  moves it; a right-click on a misspelled word offers the dictionary's suggestions.
- **The clean-up** (23): the deck's own NBSPs, line breaks and straight quotes between two changes of one commit are
  kept (Integration, "Three fixes", item 1).
- **The gates** (24, 25, 26, 28, 27): the Chromium fuzz judges the node the author typed in, probes on its own an edit
  the walk does not show, and checks console errors and the slide count for every round that wrote; both fuzzes judge
  the clean-up with an oracle that shares no code with it; the Node fuzz requires a refusal after a conflicting write
  to leave exactly the external write's bytes; and this page quotes only the final runs.

### The final runs

Linux, Electron 44.7.2, 2026-10-20, on the tree with every fix of the review in it. `rm -rf packages/app/dist
packages/cli/dist`, then `npm run build`; every number on this page comes from these runs, whose logs and reports
are in `test-results/p2-final/` (not committed; `tree.txt` there fingerprints the tree they ran on).

| Suite | Result (`test-results/p2-final/`) |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | 0 errors (`tsc.log`) |
| `npx vitest run` (`npm test`) | 108 files, 2,021 tests: 2,020 pass and **1 fails**, `test/unit/preload/env.test.ts` "allows exactly the 9.2 input types" (its expected list predates the review's `deleteByDrag`: Open issues), 84 s (`vitest.log`); the Node fuzz among them: 1,200 edits over 44 documents, 911 written (75.9%), 240 notes by rule (20.0%), 49 no-ops, **0 failures** |
| `vitest -c test/fuzz/vitest.config.mts` and `-c test/parity/vitest.config.mts` | 51 and 37 tests pass (`vitest-fuzz.log`, `vitest-parity.log`) |
| `npx playwright test -c test/e2e/playwright.config.ts` (`npm run test:e2e` without its build step) | 271 tests: 270 pass and 1 is the expected failure (the note-card ordering limit, SECURITY.md), none skipped, in two consecutive runs, 15.5 min each (2 workers; `e2e-1`, `e2e-2`) |
| `npx playwright test -c test/security/playwright.config.ts` | 64 tests: 58 pass and 6 are the expected failures (the two DNS channels, and the two drop limits in both trust states; SECURITY.md), 4.9 min; the same in two consecutive runs (`security-1`, `security-2`) |
| typed-edit and concurrency specs, `--repeat-each 3` | 24 of 24, 37 s (`gates-x3`) |
| `npx playwright test -c test/parity/playwright.config.ts` | 9 of 9, 9.0 min (`parity-pw.log`) |
| `node scripts/package-smoke.mjs` (`npm run package:smoke` without its build step) | 17 of 17 (`package-smoke.log`) |
| `node packages/cli/dist/blueline.cjs check --auto` | 6 of 6 PASS (`check-auto.log`) |
| `node scripts/fuzz.mjs --committed` | 1,000 edits, 903 written, 72 notes by rule, 25 no-ops, **0 failures**, 903 probed (0 on their own, 0 unprobed); the same 1,000 records as the integration's run; 19 min (`fuzz.json`) |
| `node scripts/fuzz.mjs --local` | 1,000 edits, 920 written, 54 notes by rule, 26 no-ops, **0 failures**, 920 probed (1 on its own), 0 unprobed; 29 min (`fuzz-local.json`) |
| `node scripts/fuzz.mjs --negative-control` (5 decks, 150 edits) | 26 of 26 planted changes caught, nothing else failed, 100 s (`fuzz-negative.json`) |
| `node scripts/fuzz-selftest.mjs` | all 10 cases behaved as expected: the gate failed each of the 9 cases it must fail and passed the control, 37 s (`fuzz-selftest.log`) |
| `npm run test:reader-only` | `FAILED` twice, both times at vitest only for the test above (run 2: every other step passes; run 1, under the load of both fuzz runs, also had two load failures that passed in run 2); see Reader-only gate |
| `blueline map --report --json` | the 19 committed fixtures equal their baselines; Josh's 12 decks hold against theirs (Coverage, below) |

### Coverage (`blueline map --report --json`, on copies)

- **Committed fixtures** (the 19 baselines of `fixtures/expected/`, decks copied with their sibling scripts;
  `test-results/p2-final/map-committed.json`): all 19 equal their baselines run for run (slide, text, strategy,
  confidence, offsets, probe), 423 of 423 exact nodes pass the mutation probe, every original untouched.
- **Josh's 12 decks, `--reduced-motion`** (copies, against `fixtures/local/expected/<deck>.reduced-motion.json`;
  `map-local.json`, labels only): every slide reached; 6,053 of 6,673 visible text nodes exact and probed (90.7%;
  94.5% of the wording), against 6,058 of 6,678 in the baselines. Eleven decks equal their baselines run for run, D3
  with its one known probe failure (Phase 0 F30: a label the deck also keeps in a hidden element on another slide).
  D5 differs only on its first and last slides, the ticker slides, as in Phase 1 (427 visible nodes here, 432 in the
  baseline, 430 and 429 in the integration's runs); every one of its exact nodes passed the probe. 39 min.

### Open issues

Known after the final runs; none is a write to the wrong place or a lost change.

- **One unit test is stale, so the unit suite and the reader-only gate fail.** `test/unit/preload/env.test.ts`
  "allows exactly the 9.2 input types" (line 23) lists the input types an edit field allowed before the review; the
  drag-move fix (finding 12) added `deleteByDrag` to `ALLOWED_INPUT_TYPES` in `edit-input.ts`, so the test fails in
  `npx vitest run` and in the reader-only gate's vitest step (`npx vitest run test/unit/preload/env.test.ts`: 1
  failed, 4 passed). The fix is to add `deleteByDrag` to the test's expected list; the measurement step changes no
  test. Until it is made and the two suites run again, the reader-only criterion is not met.
- **A PDF cancelled by its document's close can give the wrong reason.** `RenderView.overlayMounted()` answers
  "mounted" when its check cannot run, so under load a PDF whose document closed mid-walk failed with "a render view
  showed the overlay" instead of "closed" (`render-products-pdf.spec.ts` "a PDF running when its document closes …",
  once, in reader-only run 1 beside two fuzz runs; it passed in every other run). A closed view should end the walk
  as cancelled.
- **Real use has not started** (the fourth criterion): it needs the Mac build. The checklist is below and in the
  README.
- **The caret can land in text Blueline cannot place.** A label whose element also holds an unmapped glyph (D3): End
  puts the caret after the glyph, and what is typed there lands outside every run, so it becomes a verbatim note by
  rule (the toast says so). Correct by rule, surprising in use.
- **Stale requests and notes.** A request on an older version is placed by position (9.2 Write protocol step 2 as
  amended); it becomes a verbatim note by rule when a change overlaps its run, its version is no longer known, or the
  diff runs past its time limit. In the final runs: on Josh's decks 102 stale-version requests, 95 written on their
  run, 7 notes by the escape rule, none `ambiguous` or `stale` (the integration's run, by the old context rule: 22 of
  111 ambiguous); in the Node fuzz 119 stale-version edits, 78 written, 22 `stale` and 4 `ambiguous` notes. A page
  left open while another program rewrites the text around a field is where such notes come from: worth watching in
  real use.
- **`<pre>`, `<listing>` and `<textarea>` with a character reference right after the dropped leading newline**:
  parse5 8 places the text node late, so the mapper leaves the run unaligned (not editable) and the queue refuses to
  create that state (core-edit). A mapper fix would make such runs editable.
- **The run on Josh's decks can fail on D5's ticker by chance.** An edit to an item of D5's CSS marquee, probed on
  its own, holds exactly the new text and its sentinel but can be out of view at every stop, and then fails
  (Limits, below). It did not happen in the final run; it is a property of the method, not a wrong write. Options:
  accept it as a known limit, pass such a node on its text and sentinel (counted apart), or pause animations for the
  probe's loads.
- **Linux tested no marker copy**: the atomic writer copies no extended attributes on Linux, so neither the fuzz nor
  the E2E suite exercised the marker copy of a write, and history snapshots on Linux carry no marker. Recheck on the
  Mac (below).
- **Text Edit still cannot reach.** On copies of D1, D3 and D6 (slides 1–3), 50 of 57 exact nodes that sit under an
  empty element or in a `pointer-events: none` layer now open a field (1 of 57 before the review); 7 get no outline
  (most of them `pointer-events: none` labels the overlay probably does not hold as exact, not investigated), and a
  press on one 4-character node under a D3 nav button still reaches the page. A node a script rewrote (`touched`) is
  now not editable and offers no candidate (`edit-fix-overlay.spec.ts`); that is the rule for D10's chrome title,
  whose only candidate was text the deck's script replaces at load, but D10 was not driven by hand again.
- **Small windows the review left.** Cmd+Z pressed before the commit's message reaches main undoes the previous edit
  (the commit's undo slot is reserved only when main accepts it). While a press waits for the answer to the commit it
  triggered (at most the commit timeout), no field is open, so keys typed in that moment go to the deck as in Edit
  with no field. Dragging text out of an SVG text field into the page's own editable element moves it out of the
  field, and the blur then commits the deletion (HTML fields confine the drop to the field; the SVG field's input does
  not yet).
- **A deck that cannot answer before close or quit.** Before a window closes or the app quits, main asks the deck to
  commit its open field and waits at most 3 s. If the deck cannot answer (a hung page), the window closes anyway:
  nothing is written, and main keeps nothing it did not receive (SECURITY.md, Known limits added by Phase 2).
- **Smaller ones.** A verbatim note made from a field that holds a lone surrogate stores U+FFFD (a note cannot hold
  one). "· also changes N other places" (in the shell's Saved toast since the review) counts only the other nodes the
  matcher places exactly. A drop rewritten for line breaks inserts at the selection, not at the drop point. If the
  history's `index.json` is damaged, the next load lists no history and the one after removes the old snapshot files
  (the deck is never touched). There is no per-document switch for smart punctuation yet (the session override is
  honoured). The quit asks each deck to commit first (at most 3 s, above), then waits for writes and history with
  Phase 1's 3 s cap; a write still running then is atomic (fully renamed or not at all).
- **Inherent in P2-7**: a compromised page can open a field within 2 s of a real press in Edit, or press the toast's
  Undo then. It can commit a change to one run while that field stays authorised: until a newer field begins, the
  deck reports no field open, the view leaves Edit (main still takes the commit it asks for then, for 5 s), or 10
  minutes pass without trusted input in that view (SECURITY.md, Known limits added by Phase 2). Before the review a
  field never expired (finding 4).

## Integration (before the review)

### What the integration step changed

The open contract requests and wiring notes of the five build items:

- **Settings › General › Smart punctuation in the Settings contract** (`core/ipc-trust.ts`): `SettingsToMain.setSmartPunctuation`,
  `SettingsState.smartPunctuation` and `SettingsApi.setSmartPunctuation`; `settings-window.ts`, the Settings preload and
  page use them. `trust-native-settings.spec.ts` and `trust-ipc.spec.ts` list the new function, `trust-ipc.spec.ts`
  forges the new channel from a Protected deck and a render view (refused; config.json byte-identical), and the
  Settings E2E now toggles the box with main's `general` wired and checks config.json's `defaults`.
- **`VerbatimWhy` gains `page-changed`** (the page re-rendered or removed the open field, P2-17), with its sentence in
  the toast; the overlay sends it instead of `invalid`.
- **The deck follows `MainToDeck.settings` and `MainToDeck.userName`** after its init (smart punctuation from the next
  commit; the note card's name). `edit-main-flow.spec.ts` checks both: Settings › General › Smart punctuation turned
  off while a deck is open in Edit makes the next quote typed into a curly-quoted heading straight, with no reload
  (the test fails when the deck ignores the message), and the name chip's new name reaches the open deck.
- **The overlay's toasts name the real file** (`DeckInit.fileName`): the two overlay E2E tests expected the fallback
  `deck.html`.
- **`@edit` tags and two-build tests** (P2-15): the `map`, `map-walk`, `map-matching` and `cli` tests that assert
  mutation-probe results carry `@edit` (16 titles, 27 tests); `reader.spec.ts` (Cmd/Ctrl+1/2/3), `views-reload.spec.ts`
  (a file that goes away and comes back) and the first `trust-identity.spec.ts` test (another program's file saved
  over the path) now run in both builds and check the reader-only behaviour there (`test/helpers/app.ts EDIT_BUILD`:
  Edit refused, no Enable editing); its control test (Blueline's own atomic write keeps both switches) is `@edit`,
  since a reader-only build never writes a deck and refuses the write. The probe's unit cases that drive the real
  write queue moved to `test/unit/app/probe.edit.test.ts` and `report-probe.edit.test.ts`, so the reader-only unit
  suite keeps the rest of `probe.test.ts` and `report.test.ts` (no file is excluded by name any more).
- **Two test oracles that raced the app under load.** `edit-gate-concurrency.spec.ts` judged the file once it had
  not changed for 500 ms; in one full-suite run the requeued write of "a write inside the atomic write" landed later
  than that, so the oracle saw only the external bytes and waited in vain for a note. It now waits for the edit's
  own outcome (the file holds the edit, or the exact verbatim note exists), then for the file to settle, and prints
  main's log if neither comes. (Under four busy CPUs the requeued write landed 20 to 240 ms after the external one
  in 12 of 12 runs.) `views-zoom.spec.ts` read session.json inside `expect.poll`, which does not retry a callback
  that throws, before the first save had created the file (main-wiring's open issue); an absent file now reads as
  "not yet".
- **`preload-electron.spec.ts`**: "render agent: detection matches every fixture" failed at the Phase 1 commit too
  (checked on a `git archive` of it): the harness has no main, and `generic-hash-writeonly.html` reads its hash only
  at load, so a hash goto never moves it. The harness now does what main does there (decision D-7: the deck's own
  key) and checks that only that deck needs it, on every move. "Ctrl+V sent with no gap" failed once under the full
  suite's load: its reports come from a timer after each key, and a fixed 400 ms wait could end first; it now waits
  for the four reports (up to 3 s).

Three fixes the runs led to:

- **Two changes in one run kept a line break or NBSP between them only by position** (core-edit's open issue,
  `core/edit-cleanup.ts`). One commit that changed a run in two places made the untouched text between them part of
  the changed region, so a line break the run already had there became a space (a visible change in a `<pre>`) and an
  `&nbsp;` became a space. A line break, NBSP, U+200B, U+FEFF or straight quote in the changed region now counts as
  the run's own when it is at the same position relative to the unchanged prefix or suffix, or when a character diff
  of the changed region pairs it with one of the old text's (a longest common subsequence computed in
  `core/edit-cleanup.ts` in a widening diagonal band, deterministic, no time limit; past about 2,000 × 2,000 changed
  characters every class the old region held is kept). Only the others are cleaned. The integration's first fix
  counted occurrences instead, which still rewrote the deck's own between two changes whenever the same commit added
  one more (Phase 2 review finding 23: a pasted NBSP turned the deck's `&nbsp;` into a space, a typed `"c"` curled the
  run's own `"b"`). Unit tests in `edit-cleanup.test.ts` and `edit-cleanup-two-changes.test.ts`, the write path in
  `cleanup-write.test.ts`, the app in `edit-cleanup-two-changes.spec.ts`.
- **A picked run's write and its undo did not show truly on the page** (found by the hand-driven run on D3, below).
  The overlay put the written text into the node the author edited, and an undo patched the run's own parser node,
  which a picked node is not (a script drew it, or it is another place with the same text): after Cmd+Z the page
  still showed the undone text. Main now reloads the page after a picked write and after its undo or redo
  (`edit-session.ts`; unit test "a picked run (P2-8, P2-10)"), as it does for literals.
- The integration's own map check first copied `csp-nonce-strict-dynamic.html` without its sibling script; the check
  now copies it as `map.spec.ts` does (a harness slip, not a Blueline bug).

### Edit by hand on two of Josh's decks

A scratch Playwright driver (not committed: it reads `fixtures/local`) opened copies of D3 and D10 in the app (as
`bltest`, sandbox on), pressed Cmd/Ctrl+3, and with real clicks and keys (`sendInputEvent`) edited five kinds of
text, then pressed Cmd/Ctrl+Z twice and Cmd/Ctrl+Shift+Z once, checking after each step the file's bytes (one splice
inside the edited run, covered by the new note's lock), the notes list, the history and the page. Both decks
passed every step on the integration build (before the Phase 2 review; the decks were not driven by hand again
after it, and the "Saved" toast is now the shell's):

| Step | D3 | D10 |
|---|---|---|
| An HTML heading (`html-text`) | `h1`, two runs in the field; written in place, no reload, "Saved · D3.html:<line>" | `h2`, two runs; written in place, no reload |
| A JS-literal label (`script-literal`) | a `span` whose field also holds unmapped text: written, the page reloads and shows it | SVG `<text>` (the overlay's input over it, P2-17): written, the page reloads and shows it |
| A JSON value | none in either deck (no `json-literal` run in any of the 12) | none |
| An ambiguous label through the picker | `duplicate`, 2 candidates, the first chosen with the mouse: written; the page reloads | `stamp-other`, 1 candidate: written; the page reloads (see below) |
| A computed number | "Not editable"; no field, no note, file unchanged | the same |
| Undo, undo, redo | bytes exact each time; the undone notes deleted, the redo's note new; the page shows exactly the writes in force | the same |

What the runs found: the picked-write display bug above (fixed); and two things a user would notice. A click at the
end of a label whose element also holds text Blueline cannot place (D3's label has a glyph after it) puts the caret
there if the user presses End: the edit then lands outside the run and becomes a verbatim note, by rule, with the
toast saying so. And on D10 the only candidate the picker offered for a slide title was the static text of the
deck's chrome title, which the deck's script rewrites at load: the write is exact and undoable, but after the reload
the page shows the edit nowhere. Since the review such a node offers no candidate and is not editable (Open issues).

## Environment

- Linux container (a Firecracker VM), kernel 6.18, 4 CPUs, 15 GB, no GPU; Xvfb with a 3840×2160 screen.
- Electron 44.7.2 (Chromium 152.0.7977.149, Node 24), the app built with `npm run build`; Node 22 for the scripts.
- The fuzz harness runs Electron as root with `--no-sandbox` (the OS sandbox is off; the in-process sandbox flags
  still apply) and offline (without the proxy variables), as the Phase 1 parity harness does. The E2E and security
  suites run the app as `bltest` with the OS sandbox on (test/helpers/app.ts).
- On Linux the atomic writer copies no extended attributes (`atomic-write.ts xattrCopierFor` is a no-op there): the
  fuzz exercises the writer's temp file, mode bits, fsync, re-hash and rename, not the marker copy. Recheck on the
  Mac (below).

## Fuzz gate

    npm run build
    node scripts/fuzz.mjs                       # the gate: 1,000 edits on the committed fixtures, seed 0x5eed2026
    node scripts/fuzz.mjs --local               # the extra run on Josh's decks (fixtures/local, labels only)
    node scripts/fuzz.mjs --negative-control --edits 150 --decks decks/entities.html,…   # shows the probe can fail
    node scripts/fuzz.mjs --summarize test-results/fuzz/fuzz.json
    npx vitest run -c test/fuzz/vitest.config.mts                                      # the harness's own unit tests

Options: `--seed n` (default 1592598566, the Node fuzz's), `--edits n` (1,000), `--batch n` (24: edits per round
and the probe's batch), `--committed`, `--local`, `--decks <label|path>,…`, `--out`, `--work`, `--verbose`, `--negative-control` (never a
gate run, below). `npm run
fuzz` builds first. Results: `test-results/fuzz/fuzz.json` (`fuzz-local.json` for `--local`), the text summary on
stdout, the bytes before any failed edit in `<work>/failures/`. Exit 0 when every edit passed, every written edit
was probed and the requested number was made, 1 otherwise, 2 on a harness error.

### Method

The harness (`test/fuzz/harness/main.ts`, bundled by `test/fuzz/harness/bundle.mjs`) is an Electron main of its own,
like the parity harness: it imports the app's main modules from source (documents, protocol, trust hooks, the render
service, `map-command`'s walker, the probe) and uses the built deck preload. The Edit capability is not bundled: the
harness loads the shipped `packages/app/dist/editor.cjs` through `editor-loader.ts`, as main does (the capability
seam), and its build fails on any import of `@blueline/editor`.

- **Corpus.** `--committed` is every committed fixture deck, as the Phase 1 harnesses take them
  (`fixtures/decks/*.html`, `decks/reveal-hash`, `fixtures/render/*.html`: 48 decks). `windows-1252.html` is not UTF-8,
  so Edit is off for it (9.2 rule 1) and it takes no edit; its share goes to the next deck. Each deck is copied into
  the work folder (a committed deck with its folder, one of Josh's decks as `<label>.html`), and the fuzz writes only
  to a hidden probe copy next to that copy (`probe.ts ProbeCopy`, served under the deck's trust state, a fresh origin
  per load). At the end the deck's own copy must be byte-identical to the corpus deck. The edits are spread over the
  decks by the seed; each deck draws from a seed of its own (seed and label), so one deck's walk never changes another
  deck's edits.
- **One walk per version.** Each round walks the probe copy as `blueline map --reduced-motion` walks a deck
  (`DeckWalker`, an offscreen render view, Chromium's `force-prefers-reduced-motion` as in Edit) and matches every
  visible node with the shared matcher against the copy's current map. While the walk collects a node, the harness
  reads its edit field in the page (`field-probe.ts`, in an isolated world of its own): the innermost element that
  holds the node, its `textContent`, and every text node in it with its offset, exactly what the overlay records when
  the author clicks the node (9.2 Committing an edit step 1). The walk waits for what the deck's scripts reveal
  (`RenderView.waitScripted`): the full scripted settle after a load while the deck is known to reveal text late
  (decision D-5's memory), else 400 ms without a DOM change, and 400 ms after every move.
- **Targets.** Up to 24 per round: matcher-exact nodes, and with a share of 10% an ambiguous node whose candidate the
  author picks (P2-8; reasons `duplicate`, `stamp-other`, `not-equal` and `substring`; `split` and `short` are never
  offered; `key` and `shadow` are offered with a warning that the deck uses the text elsewhere, so a random author who
  ignores it tests the deck, not the writer). No two targets of a round share a run, so every edit is made on the text
  the walk saw.
- **The edit, as typed.** The "author" changes the field: inside the clicked node with the caret there (85%), or
  anywhere in the field (a selection across runs, unmapped text, the caret elsewhere): insertions, deletions,
  replacements, a retyped text, a trailing NBSP as Chrome types it, a dictated sentence pasted with a CRLF, from the
  SPEC's inputs (`` & < > " ' \ ` ${ } ``, `</script>`, `<!--`, emoji including ZWJ sequences and flags, NBSP, tabs,
  `\r\n`) and more (character references spelled as text, U+200B, U+FEFF, U+2028, NUL, BEL, U+E000). The commit is
  `core/edit-commit commitField` (clean-up, smart punctuation on 80% of edits, the run boundary and caret rule), then
  `liftPick` for a picked substring or normalized candidate, then `EditRequest` as main builds it, then
  `WriteQueue.edit` of the shipped editor over the app's DeckIO (`atomic-write.ts createDeckIO`: temp file in the same
  folder, mode bits, extended attributes, fsync, re-hash, rename). The queue is told the version the page holds
  (`know`, P2-3), pinned for the round (each walk's version is pinned and released when the round's edits end, as
  main pins an open field's version since the Phase 2 review).
- **Concurrency inside the fuzz.** 10% of requests name the version the walk saw although the deck has moved on (the
  stale-version path); 4% follow an external write (an HTML comment at the end of the body, which moves no stamp);
  4% have that write land inside the atomic write, after the temp file and before the re-hash (`prepareTemp`). The
  external change must survive every outcome.
- **The oracle** (`fuzz-core.ts`, the Node fuzz's checks taken over one by one). A no-op is counted apart. A note
  passes only BY RULE (commitField's typed reasons, a liftPick refusal, or a queue code among not-utf8, structural,
  stale, ambiguous, placeholder, markup, escape and unaligned; internal, conflict, verify and refused are failures),
  with the exact before and after text and a byte-identical file (or exactly the external write that raced it). A
  written edit must: decode; have the outcome's version as its hash; be exactly the record's splice, inside the target
  run's range, planned on the file as it was; re-map to the new text at that run with every other run unchanged; add
  no parse5 error code; keep the external change; land on the run it was made on; and report `merged` exactly when
  it wrote on another version than the request's. A quarter of the written edits are undone and redone through the
  queue, with the bytes compared exactly both times.
- **The mutation probe on the new text** (P2-16, SPEC 10 Phase 0 probe steps 1–5): after a round, the version its
  edits produced is walked, and the nodes to judge are chosen there (`probe-select.ts`). The node the author typed in
  (the clicked node when the commit landed on its run, else the field's node of the commit's run; the picked node for
  a pick), found by its locator, is always judged: it must read exactly the new text plus its sentinel whatever the
  run's other renders show, and otherwise the edit fails (`[render]`). The run's other renders (its exact nodes, and
  the nodes where the walk before the edits saw it that now read the new text) are judged with it. They go through
  `probe.ts probeTargets`, batched as `map` batches (24 runs per load, each run alone on doubt): a sentinel is
  appended to the run through the same queue, the copy is reloaded and each stop replayed, and every node must read
  **exactly** its new text plus its sentinel (`NodeCheck.expectData`), the sentinel must be in no other node except
  reported renders of the run, the page must log no console error the version before the edits did not log, and keep
  that version's slide count; the sentinels are undone and the copy must be byte-identical to the round's edits. A
  picked run is judged on everything but its own node (whether the node renders the run the author picked is the
  author's choice). An edit whose node the walk does not show is probed on its own: a load with its sentinel alone,
  every stop of the walk replayed and settled as the walk settles; it fails when no stop shows it (`[probe] the edit
  shows nowhere`). For every round that wrote anything, the walk of the new version must log no console error the walk
  before did not and keep its slide count, whether or not a node is left to probe. "Not probed" now means only that
  the walk after the edits failed, and `scripts/fuzz.mjs` exits 1 on it as on a failure. (Before the Phase 2 review the
  gate judged a run on its other renders, so a write that showed elsewhere passed, and an edit no node showed was
  counted as not probed and skipped the console and slide checks: findings 25 and 26.)
- **Report.** Seed, corpus labels with sha256, edits, the shares written, noted and no-op, notes by code and by
  reason, the SPEC inputs typed and written, per-deck figures and timings, every edit's kind, and each failure with a
  reproduction: the seed (the same seed and corpus replay the run), the request, and the probe copy's bytes before the
  edit, so the write alone can be replayed. For Josh's decks a failure carries lengths, never text.

### Results: committed fixtures

`node scripts/fuzz.mjs --seed 1592598566 --edits 1000 --committed` (batch 24) on the final tree, after the Phase 2
review (`test-results/p2-final/fuzz.json`, `fuzz.log`), 19 min wall time, beside the run on Josh's decks and the
reader-only gate. Its report agrees edit for edit with the gate item's and the integration's runs: the same 1,000
records (deck, round, kind, reason, strategy, pick, stale, merged, external, probe verdict), the same totals. What the
Phase 2 review changed here is how each written edit is judged (Method), and every one passed that too.

| | |
|---|---|
| Edits | 1,000 over 47 decks (48 listed; windows-1252 takes none) |
| Written | 903 (90.3%): html-text 824, script-literal 52, json-literal 27 |
| Notes by rule | 72 (7.2%): markup 36 (`<` or `&` into a literal the page may set with innerHTML), escape 29 (15 with a character the HTML parser reports as an error, 13 where no raw splice of the HTML text decodes to the new text, such as NUL, 1 the same in an HTML literal), placeholder 4 (U+E000), commitField 3 (across-runs, boundary, invalid) |
| No-ops | 25 (2.5%) |
| Failures | **0** |
| Mutation probe | 903 edited runs in 166 probe loads, all passed: the author's node of every written edit read its new text; 0 probed on their own, 0 unprobed |
| Picked candidates | 4 (3 `equal`, 1 `normalized`; 3 written): the committed fixtures have few ambiguous nodes |
| Stale and concurrent | 78 stale-version requests (71 written, merged on the right run; 7 notes by rule); 54 external writes just before an edit (47 written, 7 notes); 35 inside the atomic write before the re-hash (all 35 written after the requeue); 150 merged writes; the external change survived every one |
| Undo and redo | 224 written edits undone and redone, byte-exact both ways |
| Walks | 213 (167 rounds) |
| Time | walks 792 s, edits 22 s, probe 297 s |

The SPEC 10 Phase 2 inputs, typed into a field / reached the file in a written edit: `&` 134/106, `<` 164/134,
`>` 133/113, `"` 14/12, `'` 29/24, `\` 92/85, `` ` `` 26/22, `${` 42/39, `}` 35/32, `</script>` 27/23, `<!--` 25/22,
emoji 25/22, tab 22/21, NBSP 118/0, `\r\n` 166/0. NBSP and line breaks never reach the file by rule: the clean-up turns
an NBSP the edit introduced into a space (Chrome's trailing and double spaces, 9.2 step 3) and a pasted line break into
a space (step 2); an NBSP the run already had is kept. Both fuzzes check that with an oracle that shares no code
with the clean-up (`test/fuzz/harness/cleanup-oracle.ts`): it re-derives 9.2 step 3, and a commit passes only when one
longest common subsequence of the changed region pairs every NBSP, line break, zero-width space and straight quote
the commit kept (unless the position rule kept it) and leaves out every one it cleaned. Before the Phase 2 review
both fuzzes took their expectation from `cleanupCommit` itself, so a clean-up that dropped the deck's own NBSPs
passed them (finding 24).

### Results: Josh's decks

`node scripts/fuzz.mjs --seed 1592598566 --edits 1000 --local` (batch 24) on the final tree, after the Phase 2 review
(`test-results/p2-final/fuzz-local.json`, `fuzz-local.log`; labels only), 29 min wall time, beside the committed run,
the reader-only gate's first run and, for its last 10 minutes, the map of Josh's decks:

| | |
|---|---|
| Edits | 1,000 over D1–D12 (71 to 94 each) |
| Written | 920 (92.0%): html-text 880, script-literal 40 (no deck has a `json-literal` run) |
| Notes by rule | 54 (5.4%): escape 35 (19 characters the HTML parser reports as errors, 16 where no raw splice of the HTML text decodes to the new text), markup 13, commitField 4 (emptied 3, across-runs 1), placeholder 2 |
| No-ops | 26 (2.6%) |
| Failures | **0** |
| Mutation probe | 920 edited runs in 48 probe loads, all passed: the author's node of every written edit read its new text; 1 edit (D5) whose node the walk after the round did not show was probed on its own and passed; 0 unprobed |
| Picked candidates | 74 (65 written: 39 `equal`, 26 `substring`) |
| Stale and concurrent | 102 stale-version requests (95 written on the right run, placed by position; 7 notes by rule, all escape; none `ambiguous` or `stale`); 30 external writes just before an edit (28 written, 2 notes); 33 inside the atomic write (31 landed before the re-hash and the edit was written after the requeue; 2 edits were notes by rule before the write); 151 merged writes; the external change survived every one |
| Undo and redo | 242, byte-exact both ways |
| Walks | 59 (47 rounds); every deck walked as a generic engine with key replay |
| Time | walks 790 s, edits 290 s (the queue maps decks of up to 1.2 MB on every write), probe 675 s |

The SPEC inputs, typed / written: `&` 112/102, `<` 156/138, `>` 119/107, `"` 22/20, `'` 20/17, `\` 91/84,
`` ` `` 17/14, `${` 46/41, `}` 47/43, `</script>` 24/21, `<!--` 26/24, emoji 29/27, tab 19/18, NBSP 109/0, `\r\n` 182/0.

Against the integration's run of the same seed on the same 12 files (`test-results/fuzz/fuzz-local.json`: 894
written, 77 notes, 29 no-ops, 0 failures, 2 unprobed), 756 of the 1,000 records are the same. D4, D8 and D9 repeat
it record for record. In the eight decks D1, D2, D3, D6, D7, D10, D11 and D12 the records are the same up to the
first stale-version request that the old rule refused as `ambiguous` (its text in several places that 32 characters
of context did not tell apart); the queue now places it by position: 7 of the 8 were written on their run (merged,
probe passed), D1's became an escape note by rule, and the deck's later draws differ from there. D5 differs from its
third edit on (a no-op where the integration's run wrote); D5's walks differ between runs (its ticker), and so can
its draws.

Josh's decks are where the picker matters (74 picks against 4 on the committed fixtures) and where a stale request
meets repeated text. None was written in the wrong place: every written edit landed on the run it was made on, and
the node the author typed in read the new text every time.

### The negative control

A gate that cannot fail proves nothing. `--negative-control` (never part of a gate run) changes the run once more
after every fifth written edit, behind the oracle's back (its text plus "X"), and passes only if the mutation probe
catches every such change. On 5 committed decks (entities, js-templates, json-data, single, inline-markup; 150 edits;
`test-results/p2-final/fuzz-negative.json`) the probe caught **26 of 26** planted changes, each because its node did
not read the edited text, and nothing else failed. The self-test (`node scripts/fuzz-selftest.mjs`,
`test/fuzz/selftest/README.md`) runs the gate in 9 cases on 6 synthetic decks that it must fail, each with a seed the
gate before the Phase 2 review passed with 0 failures: a write that shows in another node than the author's
(`[render]`), a round whose edits break the page's script (a new console error, nothing left to probe), and edits the
page shows nowhere; and on one control deck it must pass. In the final run all 10 cases behaved as expected
(`test-results/p2-final/fuzz-selftest.log`). The oracle's own unit tests (`test/fuzz/unit/fuzz-core.test.ts`) show
each check failing on a broken outcome: a reference left literal, a write to another run, a parse error, a record that
does not describe the file, a wrong `merged`, a lost external change, a note that is not by rule or not
byte-identical.

### What the runs found

No patcher or matcher bug. The first full run on the committed fixtures had 13 failures, all of them the harness's:

- **Scrolling documents after an edit** (11 of 13: `render/document.html`, `render/find-preline.html`): the probe
  replayed the walk's scroll offsets on the edited version, whose text, and so its layout, had changed; "could not go
  back to its slide". Fixed by probing each round's edits on a walk of the version they produced (its nodes, stops and
  replay), with the baseline (console errors, slide count) from the version before the edits, so an edit that breaks a
  script or the slide count still fails. Since the Phase 2 review that holds for every round that wrote anything,
  also when no node of its edits is left to probe (finding 26).
- **Text a timer writes** (2 of 13: `render/chart-doc.html`, which fills two paragraphs at 300 and 800 ms): a node the
  walk collected before the timer was the parser's text, exact; the probe's later load saw the timer's text. Fixed by
  the scripted settle above, as the render products wait (D-5).
- A third, found on the way: the edit generator appended the probe's own sentinel (`⟦bl⟧`, the Node fuzz emulates the
  probe's append), and a deck holding it fails the next probe by design. The Chromium fuzz appends `⟦fz⟧` instead.

### The Node half

`test/unit/editor/fuzz.test.ts` stays (P2-16): the same commit path and oracle in Node over an in-memory DeckIO, on the
committed decks, Josh's decks when present and 14 generated decks (BOM, CRLF, entities, `<pre>`, tables, SVG text, JS
string, template and HTML literals, a keyed object, a JSON block, a notes block). On the final tree (seed
1592598566, inside `npx vitest run`, `test-results/p2-final/vitest.log`): 1,200 edits over 44 documents, 911 written
(75.9%), 240 notes by rule (20.0%), 49 no-ops (4.1%), 65 picked candidates (57 written), 119 stale-version edits (78
written; 22 became `stale` notes and 4 `ambiguous` notes, by rule), 155 merged writes, 110 conflicting writes, 183
undos in a changed file (case 2), **0 failures**. Its clean-up oracle is the shared one above, computed without
`cleanupCommit` (finding 24), and a refusal after a conflicting write passes only when the file holds exactly the
bytes the external write left, nothing else (finding 28; before, a file that still held the external marker was
enough). It reaches what the Chromium half cannot draw from exact nodes (runs the overlay never offers: placeholders,
unaligned and shadow readings, picks on many duplicates); the Chromium half adds the real writer, the field as the
page has it, and the probe.

### Limits

- The same seed and corpus give the same edits as long as each walk sees the same nodes and each outcome is the same
  (the committed runs did, record for record, before and after the review); a deck whose animation or timer ends at
  another moment could see another set, and would draw its targets from what it saw, and a changed outcome (a stale
  request now written where it was a note) changes that deck's later draws. The report records every deck's sha256 and
  every edit's kind, so two runs can be compared deck by deck.
- The fuzz writes through a bare queue, as the probe does: no history snapshots, no notes, no session (P2-11). The
  hooks main adds (`beforeWrite`, `afterWrite`) are the main-wiring item's and its tests'.
- Picks: the committed fixtures offer few ambiguous nodes (4 picks in 1,000 edits). The Node fuzz covers the lift
  (65 picks, 57 written); Josh's decks offer more (74 picks, 65 written: 39 `equal`, 26 `substring`). These are the
  final runs' figures; the page quoted an earlier run's here before the Phase 2 review (finding 27).
- A node that moves out of view. Since the review an edit whose node the walk after its round does not show is probed
  on its own and fails when no stop shows it. A node that holds exactly the new text and its sentinel but sits outside
  the viewport at every stop of its slide, such as an item of D5's CSS marquee (cover and closing slides), therefore
  fails or passes by where the ticker is at each stop: in runs of D5 alone with other seeds while the review's fixes
  were made, such items failed in some runs and not in others. In the final run the one D5 edit probed on its own
  passed. Whether such a node should pass on its text and sentinel, or animations be paused for the probe's loads, is
  open (Open issues).
- Every committed deck opens Trusted from the work folder; Protected view changes the served copy and the network,
  not the write path.

## Typed edits and the concurrency gate, through the app

SPEC 11 lists two E2E tests for Phase 2: "open a fixture, enter Edit mode, type into a heading, and assert the file
bytes" and "external write during an edit"; SPEC 10's concurrency gate is the second one at 50 ms. They are written
with real input (a real click opens the field, keys go through `sendInputEvent`, so main sees them in
`before-input-event` as P2-7 requires, Enter commits) and the file on disk as the oracle, each titled `@edit`:

- `test/e2e/edit-gate-typed.spec.ts`: typing ` & <b>` into `single.html`'s heading writes exactly
  `<h1>… &amp; &lt;b></h1>` and nothing else, and the page shows the text without a reload; a heading with `&amp;` in
  `entities.html` keeps the reference's spelling, and app undo (Cmd/Ctrl+Z outside the field) and redo restore the
  bytes exactly; Esc leaves the file byte-identical.
- `test/e2e/edit-gate-concurrency.spec.ts`, each with the heading's field open and typed into, then another program
  saving the deck (a temp file renamed over it): an unrelated change 50 ms before Enter (the edit lands on its heading,
  the change survives, the page then shows both); the same heading rewritten 50 ms before (the file is exactly the
  external write and a verbatim note in session.json holds the exact before and after); an element inserted before
  the heading 50 ms before (every stamp after it shifts: the edit lands on the heading or becomes a note, never another
  element); a change while the field stays open 1.5 s (the reload waits for the field, then both changes are on disk
  and on the page); and a write landing inside the atomic write before the re-hash (main's one-shot test hook,
  `__blTest.onceBeforeRehash(docId, base64)`).
- `test/e2e/edit-gate-reader.spec.ts` (no `@edit`: it runs in both builds): Cmd/Ctrl+3 enters Edit in a full build;
  in a reader-only build it is refused with "Edit is not available", the deck stays in Read, a click opens no field and
  the file is never written.

    npx playwright test -c test/e2e/playwright.config.ts test/e2e/edit-gate-typed.spec.ts test/e2e/edit-gate-concurrency.spec.ts test/e2e/edit-gate-reader.spec.ts

**Results: 9 of 9 pass** in each of the two final E2E runs, and 24 of 24 when the typed and concurrency specs run
three times over (`--repeat-each 3`; `test-results/p2-final/gates-x3.results.json`). The element inserted before the
heading 50 ms before the commit landed on the heading in all 5 of those runs (the test records its outcome): the
request carries the version and run the field opened on (P2-5), and since the Phase 2 review the queue places the run
by position, through a diff of that version to the bytes on disk (9.2 Write protocol step 2 as amended), never by the
shifted stamp and never by its text alone. The hook for the write inside the atomic write is main-wiring's
(`__blTest.onceBeforeRehash`, `BlDocument.armTestWriteInside`: a rename-replace in `prepareTemp`). One thing found
while writing them: in a `contenteditable` heading that wraps, End moves the caret only to the end of the visual line,
so the tests click at the end of the text instead (in view pixels: the page's CSS pixels times the deck view's zoom,
which Fit sets on a deck).

Below the app, the concurrency gate is also met by the queue's own unit tests (`test/unit/editor/write-queue.test.ts`
"concurrency gate", MemIO and a real-file IO; `queue-phase2.test.ts`), and in the fuzz above through the app's
atomic writer, 54 external writes just before an edit and 35 inside the atomic write, all kept.

**The stated limit** (9.2 Atomic write steps 3–4): the writer re-hashes the deck and then renames the temp file over
it. An external write that lands between the re-hash and the rename is replaced by Blueline's write and lost; a write
anywhere before the re-hash is caught, requeued and merged (the fuzz's 35, the E2E's last test). The window is the
time to hash the file once and rename the temp file, a few milliseconds at most for a 2 MB deck on a local disk.
`atomicWriteFile` has a test-only hook in that window (`beforeRename`); nothing in the protocol can see a write there,
so the gate states it as a limit rather than testing for its loss (docs/PHASE2-PLAN.md, Exit gate).

## Reader-only gate

    npm run test:reader-only
    node scripts/reader-only-check.mjs [--steps build,bundles,tsc,vitest,map,e2e,security] [--workers n] [--dir <copy>] [--keep]

### Method

`scripts/reader-only-check.mjs` never touches the shared `packages/app/dist`:

1. **A copy of the tree without the editor.** The working tree without `.git`, `node_modules`, any `dist`,
   `test-results`, `fixtures/local` and `packages/editor`, into `.<repo>-reader-only` next to the repository: outside
   it, so Node's upward module search never reaches the repository's `node_modules` (and its `@blueline/editor`), and
   not under a temporary folder, which unit tests of Settings › Trust rely on (every temporary folder is refused as a
   trusted folder). Readable by `bltest`, the user the E2E suites run the app as.
2. **`node_modules` without network.** The copy gets a `node_modules` of its own whose entries are symbolic links to
   the repository's installed packages, except `@blueline`, a folder of its own linking `app`, `cli` and `core` to the
   copy's packages: there is no `@blueline/editor` anywhere the copy can resolve, and the script checks that before
   anything runs (`require.resolve('@blueline/editor')` from the copy must fail, and no folder above it may hold one).
   `npm ci` is not run: it needs the network, and removing a workspace breaks the lock file.
3. **Build:** `node scripts/build.mjs --reader-only` in the copy (its own `dist`).
4. **Bundles:** no `editor.cjs`; no source map names an editor or magic-string source; no bundle holds one of the
   editor's own functions (`planEdit`, `verifyEdit`, `planUndo`, `makeRecord`, `MagicString`).
5. **tsc** `-p tsconfig.reader.json`: every package but the editor, every test but the editor's.
6. **vitest** `-c vitest.reader.config.ts`: the unit suite without the editor's tests, with the fuzz harness's own.
7. **map:** the copy's CLI maps `single.html` and must say the probe did not run because the build is reader-only.
8. **E2E** and 9. **security**: Playwright with `--grep-invert @edit` against the copy's build.

Tests that need the editor are left out by convention: unit tests in `test/unit/editor/` (except
`mapper-findings.test.ts`, which imports core only) or named `*.edit.test.ts` (the probe's cases that drive the real
queue are in `test/unit/app/probe.edit.test.ts` and `report-probe.edit.test.ts`); Playwright tests with `@edit` in the
title. Tests that run in both builds and check each build's behaviour read `test/helpers/app.ts EDIT_BUILD`.

The gate catches what it exists to catch: with `import { createWriteQueue } from '@blueline/editor'` added to a main
module of the copy, the reader-only build fails ("reader-only build: … imports @blueline/editor") and so does tsc
("Cannot find module '@blueline/editor'"), and `@blueline/editor` does not resolve from the copy.

### Results on the final tree

`npm run test:reader-only -- --keep` (default workers; `--keep` only keeps the copy, so its Playwright reports could
be read) on the final tree, twice. Run 2 (`test-results/p2-final/reader-only-2.log`, 16.5 min) ran beside the map of
Josh's decks only; run 1 (`reader-only-1.log`, 16.7 min) ran beside both Chromium fuzz runs and the negative control
(load average 4 to 5 on 4 CPUs):

| Step | Run 2 | Run 1 |
|---|---|---|
| copy, `node_modules` links, isolation check | pass | pass |
| build (`--reader-only`, the copy's own `dist`) | pass | pass |
| bundles | pass: no `editor.cjs`, no editor or magic-string source in any source map, no editor function in any bundle | pass |
| tsc (`tsconfig.reader.json`) | pass (2 s) | pass (2 s) |
| vitest (`vitest.reader.config.ts`) | **FAIL**: 96 files, 1,877 tests, 1,876 pass, 1 fails: `test/unit/preload/env.test.ts` "allows exactly the 9.2 input types", whose expected list predates `deleteByDrag` (the review's fix of finding 12 allows it in `edit-input.ts`) | the same |
| map (the copy's CLI on `single.html`) | pass | pass |
| E2E, `--grep-invert @edit` | pass: 168 tests, 167 pass and 1 is the expected failure of the note-card ordering limit, 12.4 min | **FAIL**: 166 pass, the expected failure, and `render-products-pdf.spec.ts` "a PDF running when its document closes …" (below) |
| security, `--grep-invert @edit` | pass: 57 tests, 51 pass and 6 are the expected failures of the known limits, 3.6 min | **FAIL**: `forged-ipc.spec.ts` "a flood is rate-limited …" failed and the 2 serial tests after it did not run |
| verdict | `FAILED` (vitest) | `FAILED` |

So the gate is **not met on this tree** for one reason only: a unit test's expected list that the review's drag-move
fix made stale; the same test fails in the full build's `npx vitest run`. Both run 1 failures passed in run 2, beside
a lighter load. The flood test failed this way under load before (the gate item's run, below, and during the review's
fixes) and passes alone. The PDF test's failure shows a race: `RenderView.overlayMounted()` answers "mounted" when its
check cannot run (the view closed, was destroyed, or did not answer in 2 s), so a walk that reached that check just
after the document closed ended with "a render view showed the overlay" instead of "closed" (`render-service.ts` and
the test are unchanged by the review). It is in Open issues.

The first integration run of the gate found one more test that needs the Edit capability: the control of
`trust-identity.spec.ts` ("Blueline's own atomic write keeps both switches") calls an own write, which a reader-only
build refuses (it never writes a deck). It is `@edit` now; every other reader-side test passed.

### Results of the gate item's run (before integration)

`node scripts/reader-only-check.mjs --workers 1` on the tree as it was before main-wiring's code entered it (33 min;
the Josh's-decks fuzz ran at the same time for its first 25 min):

| Step | Result |
|---|---|
| copy, `node_modules` links, isolation check | pass (under 1 s) |
| build (`--reader-only`, the copy's own `dist`) | pass (under 1 s) |
| bundles | pass: no `editor.cjs`, no editor or magic-string source in any source map, no editor function in any bundle |
| tsc (`tsconfig.reader.json`) | pass (2 s) |
| vitest (`vitest.reader.config.ts`) | pass: 90 files, 1,718 tests (24 s) |
| map (the copy's CLI on `single.html`) | pass: "reader-only build: no patcher …, so coverage is not verified" |
| E2E, `--grep-invert @edit` | 159 passed, **32 failed**, 4 did not run (29 min, one worker) |
| security, `--grep-invert @edit` | 51 passed (the known-gap tests fail as expected), **2 failed**, 4 did not run (3.4 min) |

On the tree with main-wiring's code in it, the steps before the Playwright suites passed again
(`--steps build,bundles,tsc,vitest,map`, 30 s; vitest 91 files, 1,766 tests): the new main code imports no editor
code.

`test/e2e/edit-gate-reader.spec.ts` passed in the reader-only build: Cmd/Ctrl+3 is refused with "Edit is not
available in this version of Blueline.", the deck stays in Read, a click opens no field and the file is not written.

The E2E failures, each checked again in the full build:

- **30 need the Edit capability** and pass in the full build; they are not tagged `@edit` yet (requested from the
  integration step): every `map` test that asserts probe results (`map.spec.ts`: 6, `map-walk.spec.ts`: 11,
  `map-matching.spec.ts`: the 9 cases of its one table-driven test; `cli.spec.ts` "SIGTERM to `blueline map` alone
  during the probe"), and three that assert Edit itself: `reader.spec.ts` "Cmd/Ctrl+1/2/3 switch modes …",
  `views-reload.spec.ts` "… it comes back, and so does Edit", `trust-identity.spec.ts` "untrusted folder, no marker …"
  (it clicks Enable editing, which a reader-only build hides; the serial test after it did not run). The `map` tests
  could instead assert the probe only when the build has `dist/editor.cjs`, which keeps their walk and matching
  assertions in the reader-only run.
- **2 fail in the full build too**, from work in progress elsewhere in the tree: `trust-native-settings.spec.ts`
  (the Settings API now has `setSmartPunctuation`, and the test lists the old API) and `preload-electron.spec.ts`
  "render agent: detection matches every fixture …" (`generic-hash-writeonly.html`: a hash goto reports
  `navigated: false`; the overlay item was changing the deck preload at the time).

The security failures: `trust-ipc.spec.ts` "the Settings page has only the named Settings functions …" fails in the
full build as well (the same `setSmartPunctuation`); `forged-ipc.spec.ts` "a flood is rate-limited …" failed once in
the suite run (2,000 notes reached the cap) and passed twice when run alone in the same reader-only build, and in the
full build: a flake under load, to watch in the integration run.

So the gate's own machinery worked; it passed once those tests carried `@edit` and the in-progress failures were
fixed (Results on the final tree, above).

## What to recheck on Josh's Mac

- **Extended attributes through an edit.** Edit a downloaded (quarantined) deck: after the write, `xattr -l` shows the
  same `com.apple.quarantine` value and any Finder tags and comments; the deck still opens with its trust decision
  (`rebindAfterOwnWrite`). Linux copies none, so nothing here tested the marker copy of a write.
- **The concurrency E2E on APFS** (`test/e2e/edit-gate-concurrency.spec.ts`): the watcher's `fs.watch` is FSEvents
  there, and rename and fsync timings differ. Also a deck in an iCloud Drive or Dropbox folder: an edit while the sync
  client writes the file.
- **Input in the edit field:** real typing; press-and-hold accents and other IME input (`insertCompositionText`);
  Wispr Flow dictation into a field (a paste with line breaks becomes spaces); macOS text substitutions (smart quotes
  and dashes, text replacements) in a field, against Blueline's own smart punctuation setting; Cmd+Z inside a field
  (native) and outside it (app undo); Esc and Enter; clicking away with the window active and inactive (blur commits
  only while the window has focus, P2-17). Since the Phase 2 review: Cmd+W, Cmd+Q and a click on the toolbar or the
  notes panel with a field open write what was typed first; a right-click on a misspelled word offers the macOS
  dictionary's suggestions; dragging selected text inside a field moves it (Chromium's smart insert and delete is on
  for macOS, so a space may move with a double-clicked word: measured on Linux only).
- **SVG text** (the overlay input placed over it) and a heading with `user-select: none`.
- **The fuzz on the Mac,** optionally: `npm run fuzz` (the same Chromium, the writer on APFS; the harness does not
  start the native helper the app configures at startup, so it says nothing about the marker copy).
- **Speed:** the time from Enter to "Saved" on a 2 MB deck on Apple silicon (the queue re-reads, re-hashes, plans,
  verifies, writes and reads back; Strategy 2 completes the map).
- **The reader-only build** is a Linux check here; `npm run build:reader-only` on the Mac should behave alike.

## Real use: Josh's checklist (3 decks)

The gate: Josh finishes 3 real decks using only Edit for text changes (Mac build, `npm run dist`).

1. Build and install from the branch: `npm run dist` on the Mac; open each deck from Finder.
2. For each of the 3 decks, make every text change in Edit (Cmd+3, click the text, type, Enter): no text editor and
   no agent for text. Use smart punctuation as set in Settings, the picker when it appears, Cmd+Z outside a field.
3. While one deck is open in Edit, have the agent (or another editor) change something else in it, then keep editing:
   the deck reloads after the field closes, and both changes are there.
4. Once, restore a deck from its history to an earlier time, and check the diff it shows.
5. After each deck: `git diff` (or a diff against a copy) shows only the edited text; the deck renders in a browser as
   before apart from the edits.
6. Note, per deck: the number of edits and of verbatim notes (the notes list; `<userData>/files/*/session.json`
   holds both), every "Not editable" text and every note's reason (labels and counts only, no text, when shared), any
   write to the wrong place (must be none), any external change lost (must be none), and anything that felt slow.
7. Pass: all 3 decks finished this way, no wrong-place write, no lost change.

## Files

- `scripts/fuzz.mjs`,
  `test/fuzz/harness/{bundle.mjs,main.ts,fuzz-core.ts,field-probe.ts,job.ts,probe-select.ts,cleanup-oracle.ts}`,
  `test/fuzz/unit/*.test.ts`, `test/fuzz/vitest.config.mts`: the Chromium fuzz gate. `scripts/fuzz-selftest.mjs` and
  `test/fuzz/selftest/` (synthetic decks, each with the seed that makes the gate fail it): the gate's own self-test.
- `packages/app/src/main/probe.ts`: `probeTargets` (explicit runs, the text the sentinel is appended to, the text the
  nodes must read), `NodeCheck.expectData` and `pickedRun`, `ProbeContext.queue`, `ProbeCopy.io(opts)` and
  `restore(bytes)`. `blueline map` sets none of them; `test/e2e/map*.spec.ts` pass unchanged (31 tests).
- `scripts/reader-only-check.mjs`, `tsconfig.reader.json`, `vitest.reader.config.ts`; `npm run test:reader-only`,
  `npm run fuzz`.
- `test/e2e/edit-gate-typed.spec.ts`, `edit-gate-concurrency.spec.ts`, `edit-gate-reader.spec.ts`.
- The Phase 2 review's regression tests: `test/unit/editor/queue-stale-position.test.ts`, `cleanup-write.test.ts`;
  `test/unit/core/edit-cleanup-two-changes.test.ts`;
  `test/unit/app/{edit-lane-pins,edit-commit-rules,edit-undo-inflight,edit-known-content,edit-history-requeue,documents-knownhash}.edit.test.ts`;
  `test/fuzz/unit/{probe-written,cleanup-oracle}.test.ts`;
  `test/e2e/edit-fix-{stale,typed-text,undo-toast,locks,overlay}.spec.ts`, `edit-cleanup-two-changes.spec.ts`,
  `edit-drag-move.spec.ts`; `test/security/edit-expiry.spec.ts`; and their decks in `fixtures/edit/`
  (fixtures/edit/README.md, "Phase 2 review fixes").
