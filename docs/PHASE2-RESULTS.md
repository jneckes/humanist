# Phase 2 results (exit gate)

SPEC 10, Phase 2, names four exit criteria: the fuzz test, the concurrency gate, the reader-only build and real use.
docs/PHASE2-PLAN.md fixes how each is measured (decisions P2-15 and P2-16, "Exit gate"). This page gives the method
and the results of each harness, what the runs found, what must be checked again on Josh's Mac, and Josh's
real-use checklist. Josh's 12 decks are called D1 to D12 only, as in docs/PHASE0-FINDINGS.md. The machine-readable
results are written by the scripts (paths under each section); they are not committed.

The gate item first ran its harnesses in the Linux dev container on 2026-10-19, while the other build items were
still at work in the tree (its sections below say what each run saw). The integration step then made the pieces
fit (the open contract requests, the fixes below, the `@edit` tags), and ran every harness and suite again on the
final tree on 2026-10-19 and 20: section "Integration" gives those numbers, and the table gives the final result.

| Criterion | Gate (SPEC 10 Phase 2) | Result here |
|---|---|---|
| Fuzz, committed fixtures | 1,000 seeded edits, the typed path, notes only by rule, every written edit through the checks and the mutation probe in Chromium, zero failures | **met**: 1,000 edits over the 47 UTF-8 committed decks: 903 written (90.3%), 72 notes by rule (7.2%), 25 no-ops (2.5%), **0 failures**; all 903 written edits passed the mutation probe on their new text (none unprobed); 18 min. The final tree's run repeats the gate item's runs record for record (1,000 of 1,000) |
| Fuzz, Josh's decks | the extra run | **met**: 1,000 edits over D1–D12: 894 written (89.4%), 77 notes by rule (7.7%), 29 no-ops (2.9%), **0 failures**; 892 written edits passed the mutation probe and 2 could not be probed (no visible node showed their run after the edit, both D5); 77 picked candidates (66 written); 28 min |
| Concurrency | an external write 50 ms before the commit: the edit lands on the right text or becomes a verbatim note; the external change survives | **met**: through the app, `test/e2e/edit-gate-concurrency.spec.ts` (an unrelated change, the same text rewritten, an element inserted before the target, a change while the field stays open, a write inside the atomic write before the re-hash): 5 of 5 in each of the final full E2E runs (one earlier run's failure was the test's own oracle, fixed: see Integration), and with the typed-edit spec 24 of 24 run three times; below the app, the queue's unit tests and the fuzz's external writes (none lost, every edit on its run or a note by rule). The window between the re-hash and the rename is the protocol's stated limit |
| Reader-only | `npm run test:reader-only` passes with `packages/editor` removed | **met**: the copy without `packages/editor`, the reader-only build, the bundle check, tsc, vitest (93 files, 1,818 tests), the reader-only `map`, the E2E suite without `@edit` (168 tests, 1 of them the known note-card ordering limit, an expected failure) and the security suite without `@edit` (57 tests, 6 expected failures, the known limits) all pass: `PASSED` in 27 min, twice |
| Real use | Josh finishes 3 real decks using only Edit for text changes | **not started**: needs the Mac build; checklist below |

## Integration (the final tree)

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
  introduced only when the region holds more of it than before (`keptAt`; unit tests in `edit-cleanup.test.ts`).
- **A picked run's write and its undo did not show truly on the page** (found by the hand-driven run on D3, below).
  The overlay put the written text into the node the author edited, and an undo patched the run's own parser node,
  which a picked node is not (a script drew it, or it is another place with the same text): after Cmd+Z the page
  still showed the undone text. Main now reloads the page after a picked write and after its undo or redo
  (`edit-session.ts`; unit test "a picked run (P2-8, P2-10)"), as it does for literals.
- The integration's own map check first copied `csp-nonce-strict-dynamic.html` without its sibling script; the check
  now copies it as `map.spec.ts` does (a harness slip, not a Blueline bug).

### The suites, from a clean build

Linux, Electron 44.7.2, 2026-10-20. `rm -rf packages/app/dist packages/cli/dist`, then `npm run build:reader-only`:
no `dist/editor.cjs`, and against that build the reader-side specs pass (`edit-gate-reader.spec.ts`,
`edit-main-reader.spec.ts`, `reader.spec.ts`: 4 of 4; Cmd/Ctrl+3, View › Edit and File › History say Edit is not
available, Cmd+Z has nothing to undo, a click opens no field); then `npm run build`.

| Suite | Result |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | 0 errors |
| `npx vitest run` (`npm test`) | 99 files, 1,943 tests pass, 80 s; the Node fuzz among them: 1,200 edits over 44 documents, 908 written (75.7%), 242 notes by rule (20.2%), 50 no-ops, **0 failures** |
| `vitest -c test/fuzz/vitest.config.mts` and `-c test/parity/vitest.config.mts` | 19 and 37 tests pass |
| `npm run test:e2e` | 228 tests: 227 pass and 1 is the expected failure (the note-card ordering limit, SECURITY.md), in two consecutive runs on the final tree, 14 min each (2 workers). On the way: one run had 226 of 227 (the concurrency test's oracle, fixed above), and two more passed 227 of 227 before the Smart punctuation test was added |
| `npm run test:security` | 60 tests: 54 pass and 6 are the expected failures (the two DNS channels, and the two drop limits in both trust states; SECURITY.md), 3.8 min; the same in two runs |
| `npx playwright test -c test/parity/playwright.config.ts` | 9 of 9, 8.9 min |
| `npm run package:smoke` | 17 of 17 |
| `node packages/cli/dist/blueline.cjs check --auto` | 6 of 6 PASS |
| typed-edit and concurrency specs, `--repeat-each 3` | 24 of 24 |
| `node scripts/fuzz.mjs` | 1,000 edits, 903 written, 72 notes by rule, 25 no-ops, **0 failures**, 903 probed; the same 1,000 records as the gate item's runs; 18 min |
| `node scripts/fuzz.mjs --local` | 1,000 edits, 894 written, 77 notes by rule, 29 no-ops, **0 failures**, 892 probed, 2 unprobed; 28 min |
| `npm run test:reader-only` | `PASSED` twice, the second time on the final tree alone (27 min): vitest 93 files, 1,818 tests; E2E without `@edit` 168 tests (1 expected failure); security without `@edit` 57 tests (6 expected failures); see Reader-only gate |
| `blueline map --report --json` | the 19 committed fixtures equal their baselines; Josh's 12 decks hold against theirs (Coverage, below) |

### Coverage (`blueline map --report --json`, on copies)

- **Committed fixtures** (the 19 baselines of `fixtures/expected/`, decks copied with their sibling scripts): all 19
  equal their baselines run for run (slide, text, strategy, confidence, offsets, probe), 423 of 423 exact nodes pass
  the mutation probe, every original untouched and every probe copy removed.
- **Josh's 12 decks, `--reduced-motion`** (copies, against `fixtures/local/expected/<deck>.reduced-motion.json`):
  every slide reached; 6,055 of 6,675 visible text nodes exact and probed (90.7%), against 6,058 of 6,678 in the
  baselines. Eleven decks equal their baselines run for run, D3 with its one known probe failure (Phase 0 F30: a label
  the deck also keeps in a hidden element on another slide). D5 differs only on its first and last slides, the ticker
  slides, as in Phase 1 (430 and 429 visible nodes in two runs here, 432 in the baseline); every one of its exact
  nodes passed the probe. 36 min.

### Edit by hand on two of Josh's decks

A scratch Playwright driver (not committed: it reads `fixtures/local`) opened copies of D3 and D10 in the app (as
`bltest`, sandbox on), pressed Cmd/Ctrl+3, and with real clicks and keys (`sendInputEvent`) edited five kinds of
text, then pressed Cmd/Ctrl+Z twice and Cmd/Ctrl+Shift+Z once, checking after each step the file's bytes (one splice
inside the edited run, covered by the new note's lock), the notes list, the history and the page. Both decks
passed every step on the final build:

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
the page shows the edit nowhere (Open issues).

### Open issues

Known after the integration run; none is a write to the wrong place or a lost change.

- **Real use has not started** (the fourth criterion): it needs the Mac build. The checklist is below and in the
  README.
- **A pick can name text the deck's script replaces.** On D10 the picker's only candidate for a slide title was the
  static text of the deck's chrome title, which the deck's script rewrites at load. The write is exact, noted, locked
  and undoable, but after the reload the page shows the edit nowhere. Whether the picker should hide a candidate whose
  node a script rewrote (the matcher marks it `touched`) is a product decision for Phase 3.
- **The caret can land in text Blueline cannot place.** A label whose element also holds an unmapped glyph (D3): End
  puts the caret after the glyph, and what is typed there lands outside every run, so it becomes a verbatim note by
  rule (the toast says so). Correct by rule, surprising in use.
- **A stale page on a real deck turns more edits into notes**: on Josh's decks 20 of 106 stale-version requests were
  ambiguous by rule (repeated text that 32 characters of context do not single out). Worth watching in real use.
- **`<pre>`, `<listing>` and `<textarea>` with a character reference right after the dropped leading newline**:
  parse5 8 places the text node late, so the mapper leaves the run unaligned (not editable) and the queue refuses to
  create that state (core-edit). A mapper fix would make such runs editable.
- **Linux tested no marker copy**: the atomic writer copies no extended attributes on Linux, so neither the fuzz nor
  the E2E suite exercised the marker copy of a write, and history snapshots on Linux carry no marker. Recheck on the
  Mac (below).
- **Smaller ones.** A verbatim note made from a field that holds a lone surrogate stores U+FFFD (a note cannot hold
  one). "Also changes N other places" counts only the other nodes the matcher places exactly. A drop rewritten for
  line breaks inserts at the selection, not at the drop point. If the history's `index.json` is damaged, the next
  load lists no history and the one after removes the old snapshot files (the deck is never touched). There is no
  per-document switch for smart punctuation yet (the session override is honoured). The quit wait for writes and
  history keeps Phase 1's 3 s cap; a write still running then is atomic (fully renamed or not at all).
- **Inherent in P2-7**: for 2 s after a real press in Edit, a compromised page can commit a change to one run or press
  the toast's Undo (SECURITY.md, Known limits added by Phase 2).

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
stdout, the bytes before any failed edit in `<work>/failures/`. Exit 0 when every edit passed and the requested
number was made, 1 otherwise, 2 on a harness error.

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
  (`know`, P2-3).
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
  edits produced is walked, and each edited run's nodes there (its exact nodes, and the nodes where the author saw it
  if they show its new text) go through `probe.ts probeTargets`, batched as `map` batches (24 runs per load, each run
  alone on doubt): a sentinel is appended to the run through the same queue, the copy is reloaded and each stop
  replayed, and every node must read **exactly** its new text plus its sentinel (`NodeCheck.expectData`), the sentinel
  must be in no other node except reported renders of the run, the page must log no console error the version
  before the edits did not log, and keep that version's slide count; the sentinels are undone and the copy must be
  byte-identical to the round's edits. A picked run is judged on everything but its own node (whether the node
  renders the run the author picked is the author's choice). A node that shows other text where the edit was made
  fails; a run no node shows any more is counted as not probed.
- **Report.** Seed, corpus labels with sha256, edits, the shares written, noted and no-op, notes by code and by
  reason, the SPEC inputs typed and written, per-deck figures and timings, every edit's kind, and each failure with a
  reproduction: the seed (the same seed and corpus replay the run), the request, and the probe copy's bytes before the
  edit, so the write alone can be replayed. For Josh's decks a failure carries lengths, never text.

### Results: committed fixtures

`node scripts/fuzz.mjs` (seed 1592598566, 1,000 edits, batch 24), 18 min wall time. It ran twice, before and after
main-wiring's code entered the tree (the second time on the build the E2E tests below used), and the two reports
agree edit for edit: the same 1,000 records (deck, round, kind, reason, strategy, pick, stale, merged, external,
probe verdict), the same totals.

| | |
|---|---|
| Edits | 1,000 over 47 decks (48 listed; windows-1252 takes none) |
| Written | 903 (90.3%): html-text 824, script-literal 52, json-literal 27 |
| Notes by rule | 72 (7.2%): markup 36 (`<` or `&` into a literal the page may set with innerHTML), escape 29 (15 with a character the HTML parser reports as an error, 13 where no raw splice of the HTML text decodes to the new text, such as NUL, 1 the same in an HTML literal), placeholder 4 (U+E000), commitField 3 (across-runs, boundary, invalid) |
| No-ops | 25 (2.5%) |
| Failures | **0** |
| Mutation probe | 903 edited runs in 166 probe loads, all passed; 0 unprobed |
| Picked candidates | 4 (3 written; 3 `equal`, 1 `normalized`): the committed fixtures have few ambiguous nodes |
| Stale and concurrent | 78 stale-version requests (71 written, merged on the right run; 7 notes by rule); 54 external writes just before an edit (47 written, 7 notes); 35 inside the atomic write before the re-hash (all 35 written after the requeue); 150 merged writes; the external change survived every one |
| Undo and redo | 224 written edits undone and redone, byte-exact both ways |
| Walks | 213 (167 rounds) |
| Time | walks 781 s, edits 13 s, probe 282 s |

The SPEC 10 Phase 2 inputs, typed into a field / reached the file in a written edit: `&` 134/106, `<` 164/134,
`>` 133/113, `"` 14/12, `'` 29/24, `\` 92/85, `` ` `` 26/22, `${` 42/39, `}` 35/32, `</script>` 27/23, `<!--` 25/22,
emoji 25/22, tab 22/21, NBSP 118/0, `\r\n` 166/0. NBSP and line breaks never reach the file by rule: the clean-up turns
an NBSP the edit introduced into a space (Chrome's trailing and double spaces, 9.2 step 3) and a pasted line break into
a space (step 2); an NBSP the run already had is kept, and the Node fuzz checks that.

### Results: Josh's decks

`node scripts/fuzz.mjs --local` (seed 1592598566, 1,000 edits, batch 24) on the final tree (the integration run of
2026-10-20), 28 min wall time, made while the reader-only gate ran on the same machine:

| | |
|---|---|
| Edits | 1,000 over D1–D12 (71 to 94 each) |
| Written | 894 (89.4%): html-text 854, script-literal 40 (no deck has a `json-literal` run) |
| Notes by rule | 77 (7.7%): escape 35 (20 characters the HTML parser reports as errors, 15 where no raw splice of the HTML text decodes to the new text), ambiguous 22 (a stale-version request whose text is in several places that the 32 characters of context did not tell apart, 19, or that is also text Blueline never writes, 3), markup 10, commitField 7 (across-runs 3, emptied 3, boundary 1), placeholder 2, a picked substring that cannot be lifted 1 |
| No-ops | 29 (2.9%) |
| Failures | **0** |
| Mutation probe | 892 edited runs in 47 probe loads, all passed; 2 not probed (both D5: the walk after the edit counted no visible node of the run, so there was nothing to probe; the checks in Node passed) |
| Picked candidates | 77 (66 written: 35 `equal`, 31 `substring`) |
| Stale and concurrent | 111 stale-version requests (84 written on the right run, 27 notes by rule); 31 external writes just before an edit (28 written, 3 notes); 42 inside the atomic write (40 landed before the re-hash and the edit was written after the requeue; 2 edits were notes by rule before the write); 144 merged writes; the external change survived every one |
| Undo and redo | 220, byte-exact both ways |
| Walks | 59 (47 rounds); every deck walked as a generic engine with key replay |
| Time | walks 788 s, edits 258 s (the queue maps decks of up to 1.2 MB on every write), probe 618 s |

The SPEC inputs, typed / written: `&` 121/107, `<` 153/140, `>` 123/108, `"` 22/21, `'` 18/14, `\` 93/88,
`` ` `` 15/11, `${` 46/41, `}` 42/38, `</script>` 20/18, `<!--` 23/23, emoji 24/23, tab 21/20, NBSP 120/0, `\r\n` 177/0.

The gate item's run on the tree before integration (the same seed) gave 897 written, 72 notes, 31 no-ops, 0 failures
and 1 unprobed edit. The two runs were not compared record by record (that report was overwritten); the small
difference can come from the code that changed in between (the clean-up fix below changes some commits, and with
them the draws after them) and from what a walk sees on a deck whose animation ends at another moment (D5's ticker).

Josh's decks are where the picker matters (77 picks against 4 on the committed fixtures) and where a stale request
meets repeated text: 22 of the 111 stale-version requests were refused as ambiguous, by rule, because their text
appears in several places and the queue could not single one out (9.2 Write protocol step 2). None was written in the
wrong place: every written edit landed on the run it was made on, and every probed node read the new text.

### The negative control

A gate that cannot fail proves nothing. `--negative-control` (never part of a gate run) changes the run once more
after every fifth written edit, behind the oracle's back (its text plus "X"), and passes only if the mutation probe
catches every such change. On 5 committed decks (entities, js-templates, json-data, single, inline-markup; 150 edits)
the probe caught **26 of 26** planted changes, each because its node did not read the edited text, and nothing else
failed. The oracle's own unit tests (`test/fuzz/unit/fuzz-core.test.ts`) show each check failing on a broken outcome:
a reference left literal, a write to another run, a parse error, a record that does not describe the file, a wrong
`merged`, a lost external change, a note that is not by rule or not byte-identical.

### What the runs found

No patcher or matcher bug. The first full run on the committed fixtures had 13 failures, all of them the harness's:

- **Scrolling documents after an edit** (11 of 13: `render/document.html`, `render/find-preline.html`): the probe
  replayed the walk's scroll offsets on the edited version, whose text, and so its layout, had changed; "could not go
  back to its slide". Fixed by probing each round's edits on a walk of the version they produced (its nodes, stops and
  replay), with the baseline (console errors, slide count) from the version before the edits, so an edit that breaks a
  script or the slide count still fails.
- **Text a timer writes** (2 of 13: `render/chart-doc.html`, which fills two paragraphs at 300 and 800 ms): a node the
  walk collected before the timer was the parser's text, exact; the probe's later load saw the timer's text. Fixed by
  the scripted settle above, as the render products wait (D-5).
- A third, found on the way: the edit generator appended the probe's own sentinel (`⟦bl⟧`, the Node fuzz emulates the
  probe's append), and a deck holding it fails the next probe by design. The Chromium fuzz appends `⟦fz⟧` instead.

### The Node half

`test/unit/editor/fuzz.test.ts` stays (P2-16): the same commit path and oracle in Node over an in-memory DeckIO, on the
committed decks, Josh's decks when present and 14 generated decks (BOM, CRLF, entities, `<pre>`, tables, SVG text, JS
string, template and HTML literals, a keyed object, a JSON block, a notes block). On this tree (seed 1592598566): 1,200
edits over 44 documents, 908 written (75.7%), 242 notes by rule (20.2%), 50 no-ops (4.2%), 65 picked candidates (52
written), 118 stale-version edits, 154 merged writes, 113 conflicting writes, 183 undos in a changed file (case 2),
**0 failures**, 75 s. It reaches what the Chromium half cannot draw from exact nodes (runs the overlay never offers:
placeholders, unaligned and shadow readings, picks on many duplicates); the Chromium half adds the real writer, the
field as the page has it, and the probe.

### Limits

- The same seed and corpus give the same edits as long as each walk sees the same nodes (the two committed runs did,
  record for record); a deck whose animation or timer ends at another moment could see another set, and would draw
  its targets from what it saw. The report records every deck's sha256 and every edit's kind, so two runs can be
  compared deck by deck.
- The fuzz writes through a bare queue, as the probe does: no history snapshots, no notes, no session (P2-11). The
  hooks main adds (`beforeWrite`, `afterWrite`) are the main-wiring item's and its tests'.
- Picks: the committed fixtures offer few ambiguous nodes (4 picks in 1,000 edits). The Node fuzz covers the lift
  (65 picks); Josh's decks offer more (75 picks, 64 written: 35 `equal`, 29 `substring`).
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

**Results: 9 of 9 pass** on the build with main-wiring's edit path, and 24 of 24 when the typed and concurrency specs
run three times over (`--repeat-each 3`). The element inserted before the heading 50 ms before the commit landed on
the heading every time: the queue found it by its text, since the request carried the version and run the field
opened on (P2-5), never the shifted stamp. The hook for the write inside the atomic write is main-wiring's
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

`npm run test:reader-only -- --workers 1` on the final tree, alone on the machine (27 min). It passed the same way
once before, 28 min while the committed fuzz ran beside it, on the tree before the last test hook was added:

| Step | Result |
|---|---|
| copy, `node_modules` links, isolation check | pass |
| build (`--reader-only`, the copy's own `dist`) | pass |
| bundles | pass: no `editor.cjs`, no editor or magic-string source in any source map, no editor function in any bundle |
| tsc (`tsconfig.reader.json`) | pass (2 s) |
| vitest (`vitest.reader.config.ts`) | pass: 93 files, 1,818 tests (23 s) |
| map (the copy's CLI on `single.html`) | pass |
| E2E, `--grep-invert @edit` | pass: 168 tests (1 the expected failure of the note-card ordering limit), 23.6 min, one worker |
| security, `--grep-invert @edit` | pass: 57 tests (6 the expected failures of the known limits), 3.4 min |

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
  only while the window has focus, P2-17).
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

- `scripts/fuzz.mjs`, `test/fuzz/harness/{bundle.mjs,main.ts,fuzz-core.ts,field-probe.ts,job.ts}`,
  `test/fuzz/unit/*.test.ts`, `test/fuzz/vitest.config.mts`: the Chromium fuzz gate.
- `packages/app/src/main/probe.ts`: `probeTargets` (explicit runs, the text the sentinel is appended to, the text the
  nodes must read), `NodeCheck.expectData` and `pickedRun`, `ProbeContext.queue`, `ProbeCopy.io(opts)` and
  `restore(bytes)`. `blueline map` sets none of them; `test/e2e/map*.spec.ts` pass unchanged (31 tests).
- `scripts/reader-only-check.mjs`, `tsconfig.reader.json`, `vitest.reader.config.ts`; `npm run test:reader-only`,
  `npm run fuzz`.
- `test/e2e/edit-gate-typed.spec.ts`, `edit-gate-concurrency.spec.ts`, `edit-gate-reader.spec.ts`.
