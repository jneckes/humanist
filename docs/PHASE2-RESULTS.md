# Phase 2 results (exit gate)

SPEC 10, Phase 2, names four exit criteria: the fuzz test, the concurrency gate, the reader-only build and real use.
docs/PHASE2-PLAN.md fixes how each is measured (decisions P2-15 and P2-16, "Exit gate"). This page gives the method
and the results of each harness, what the runs found, what must be checked again on Josh's Mac, and Josh's
real-use checklist. Josh's 12 decks are called D1 to D12 only, as in docs/PHASE0-FINDINGS.md. The machine-readable
results are written by the scripts (paths under each section); they are not committed.

The gate item first ran its harnesses in the Linux dev container on 2026-10-19, while the other build items were still
at work in the tree (its sections below say what each run saw). The integration step then made the pieces fit (the
open contract requests, its fixes, the `@edit` tags) and ran everything again (commit 91b58dc). An adversarial review
of that tree confirmed 29 findings, and their fixes changed the write queue, main's edit session, the overlay, the
clean-up and both fuzz harnesses (section "Review round 1"). A re-verification of those fixes found some incomplete
and some new problems, which a repair step fixed ("The re-verification and the repair"). A measurement step then added
two duplicated-text cases to the concurrency gate and ran every harness and suite once more on the repaired tree, from
a clean build, on 2026-10-21 ("The final runs"); every result below comes from those runs, unless a section says it
describes another one (the table gives the last runs, below). A hardening round then had three attackers look for
wrong-place writes in that build; it fixed all 13 they found and the two tests that failed by chance, and ran every
suite and harness again from a clean build ("The hardening round", below; its numbers are the ones that section gives,
and the second paragraph under the table sums them up). A second hardening round, three more attackers on that build,
fixed the 7 wrong-place writes and lost outputs they found and ran every suite and harness once more from a clean
build, on 2026-10-22 ("The second hardening round"; the third paragraph under the table). The lead's decision F-1 then
replaced telling copies apart after another program's change with not choosing among them ("The uniqueness rule"; the
fourth paragraph under the table). A third round attacked the rule's first implementation and fixed the nine ways to a
forbidden write it found ("The uniqueness rule, attacked"), and every suite and harness then ran once more from a
clean build, on 2026-10-22 ("The uniqueness rule's final runs"): **the table gives those runs**; the paragraphs
under it sum up the earlier ones (first the measurement step's, which the table showed before) and then these.

| Criterion | Gate (SPEC 10 Phase 2) | Result here (the uniqueness rule's final runs, 2026-10-22) |
|---|---|---|
| Fuzz, committed fixtures | 1,000 seeded edits, the typed path, notes only by rule, every written edit through the checks and the mutation probe in Chromium, zero failures | **met**: 1,000 edits over the 47 UTF-8 committed decks: 891 written (89.1%), 83 notes by rule (8.3%; 6 `ambiguous`, 10 `stale`), 26 no-ops (2.6%), **0 failures**; every written edit passed the mutation probe on the node the author typed in (891 probed, none on its own, none unprobed); 71 stale-version requests, 61 written; 18 min. The same 1,000 records as the first F-1 tree's run and the third round's |
| Fuzz, Josh's decks | the extra run | **1 failure, the probe's accepted reach limit; no wrong write**: 1,000 edits over D1–D12: 878 written and passed (87.8%), 92 notes by rule (9.2%; 36 `ambiguous`, the uniqueness rule's notes on repeated text after another program's change), 29 no-ops (2.9%), **1 failure**: a D11 edit written exactly, whose node, an item of the CSS marquee on D11's cover slide, held the new text and the sentinel but was out of view at every stop of the probe: the limit of the probe's reach that the lead accepted as a documented known limit for D5's ticker (Open issues), reported as that, not as a pass; 0 unprobed; 66 picked candidates (58 written); 98 stale-version requests, 83 written; 28 min |
| Concurrency | an external write 50 ms before the commit: the edit lands on the right text or becomes a verbatim note; the external change survives | **met**: through the app, `test/e2e/edit-gate-concurrency.spec.ts` (an unrelated change, the same text rewritten, an element inserted before the target, duplicated text whose neighbour changes on the edited copy, in two places, a change while the field stays open, a write inside the atomic write before the re-hash): 7 of 7 in each of the three E2E runs: the unrelated change, the change while the field stays open and the write inside the atomic write land on the heading with the external change kept, and the same text rewritten, the element inserted before the heading and both duplicated-text cases are verbatim notes in every run, as since the first hardening round's anchors (the duplicated text is in two places, which F-1 makes a note by rule; on commit 91b58dc both of those cases wrote into the other copy, 3 runs of 3); below the app, the queue's unit tests (stale requests next to moved and inserted copies, the uniqueness rule's cases among them) and the fuzz's external writes (87 that landed on the committed decks and 67 on Josh's: none lost, every edit on its run or a note by rule). The window between the re-hash and the rename is the protocol's stated limit |
| Reader-only | `npm run test:reader-only` passes with `packages/editor` removed | **met**: `PASSED` in 17 min (1,015 s): the copy without `packages/editor`, the reader-only build, the bundle check, tsc, vitest (96 files, 1,896 tests), the reader-only `map`, the E2E suite without `@edit` (173 tests, 1 the known note-card ordering limit, an expected failure) and the security suite without `@edit` (57 tests, 6 expected failures, the known limits) all pass |
| Real use | Josh finishes 3 real decks using only Edit for text changes | **pending**: Phase 2 is ready for it; needs the Mac build (README, Status, names the commit); checklist below |

At the measurement step (2026-10-21, "The final runs") the table read: on the committed decks 903 written, 72 notes by
rule, 25 no-ops, **0 failures**; on Josh's decks 917 written and passed, 55 notes, 26 no-ops and 2 failures, both D5's
ticker; the concurrency spec 7 of 7, and with the typed-edit spec 30 of 30 over three repeats, the inserted element's
edit and each duplicated-text edit landing on the heading and the copy the author typed in (on commit 91b58dc both
duplicated-text cases wrote into the other copy, 3 runs of 3); `npm run test:reader-only` PASSED in 951 s.

After the hardening round (its final runs, on the tree with every fix of the round): the fuzz gate on the committed
decks wrote 894 of its 1,000 edits with **0 failures** (81 notes by rule, 25 no-ops, every written edit probed); on
Josh's decks 915 were written and passed, with 58 notes, 26 no-ops and **1 failure**, again D5's ticker; the
typed-edit and concurrency specs passed 30 of 30 over three repeats; `npm run test:reader-only` PASSED in 944 s.

After the second hardening round (its final runs, on the tree with every fix of both rounds): the fuzz gate on the
committed decks gave every one of its 1,000 edits the outcome it had after the first round (894 written, 81 notes by
rule, 25 no-ops, **0 failures**, every written edit probed); on Josh's decks 913 were written and passed, with 58
notes, 28 no-ops and **1 failure**, D5's ticker again (one stale edit on D9 is a note now, by the round's rule on
Blueline's own writes, and D9's later edits differ from then on). The E2E suite (316 tests) ran three times with no
failure but its expected one, the security suite twice as expected, and `npm run test:reader-only` PASSED in 1,019 s.

After the uniqueness rule (lead decision F-1, 2026-10-22): a stale edit, an undo or a redo across another program's
change is written only when its text is in one place before and after; the attack suites of both rounds, re-run at
full size, write into another copy only where the other program's change left the bytes as they were (and one save
that replaced the author's slide by a byte-identical one at its place). The fuzz gate on the committed decks wrote 891
of its 1,000 edits with **0 failures** (83 notes by rule, 26 no-ops, every written edit probed); the Node fuzz writes
831 of 1,200 edits (912 before), and on copies of Josh's decks no stale edit of repeated text is written any more
(details and the suites in "The uniqueness rule").

After the third round, from a clean build (the uniqueness rule's final runs, the table): the fuzz gate on the
committed decks gave every one of its 1,000 edits the outcome it had on the first F-1 tree (891 written, **0
failures**); on Josh's decks, the rule's first run there, 878 written edits passed, 92 were notes by rule (36
`ambiguous`, where the second round's run had 1) and 29 no-ops, with **1 failure**, the probe's reach on an item of
D11's marquee; the Node fuzz wrote 818 of 1,200 edits. The E2E suite (316 tests) ran three times with no failure but
its expected one, and the security suite twice as expected; `npm run test:reader-only` PASSED in 1,015 s.

## Review round 1 (the Phase 2 review)

An adversarial review of the integrated tree (commit 91b58dc) confirmed 29 findings, each reproduced by a second
reviewer: 1 critical, 4 high, 13 medium and 11 low. Four could put an edit on the wrong text or undo the wrong edit
(findings 0, 1, 14, 22); others lost typed text, left Edit waiting for a reload that never came, or made the gate
weaker than this page said. The lead set the rules of the fixes (decisions E-1 to E-13); SECURITY.md,
docs/ARCHITECTURE.md ("What the Phase 2 review changed in the flows") and docs/spec-amendments/README.md give them
and the code that holds them. Every fix has a regression test that failed on the tree before it and passes after it
(Files, below).

### Found and fixed, by area

- **Where a stale edit lands** (0, 1, 22; E-1): the 32 characters of context chose another copy of repeated text,
  and a field open across 8 saves lost its version. Now the queue places the run by position through a diff,
  confirmed by the text around every copy (else a verbatim note); main pins every open field's version; and a field
  never opens on a version with an unanswered commit of its page.
- **Typed text lost** (5, 19, 6, 7, 20, 16; E-2): before a close, a quit or a click in the shell, main asks the deck
  to commit (waiting at most 3 s before a close or quit); the mode is checked when a commit is accepted, not at the
  write; a commit that can no longer be written (file moved, deleted, not UTF-8, Protected) is a verbatim note.
- **Undo during a write** (14; E-3): Cmd+Z, Cmd+Shift+Z and the toast's Undo wait behind the document's writes in
  flight and act on the newest write that landed. E-3 as amended in the hardening round, and accepted by the lead:
  Cmd+Z pressed while the newest commit is in flight is for that commit, and if it becomes a note nothing is undone.
- **Edit authorisation** (4; E-4): a field's authorisation now ends when it closes, when the view leaves Edit, or
  after 10 minutes without trusted input; only the one commit main asks for outlives the last two (5 s).
- **The Saved toast** (8; E-5): the shell shows it, its "· also changes N other places" and its Undo, so the reload
  after a literal or picked write no longer removes them.
- **Edit stuck on "Deck changed"** (2; E-6): an own html-text write advances the page's version; only an external,
  literal or picked write asks for a reload.
- **External changes around own writes** (3, 15; E-8): `knownHash` never moves back, and a read-back that finds other
  bytes makes the watcher look again.
- **Locks after a restart or reopen** (17, 18; E-7): the content main knew advances after every own write, even one
  that lands after its window closed, so locks transform from the right text.
- **The overlay** (9, 10, 11, 12, 13; E-9, E-10): text under an empty element or in a `pointer-events: none` layer is
  found by its geometry, and a node a script rewrote offers no candidate (only an exact script literal stays editable);
  the fit guard measures the rendered case;
  spaces in a `<button>` or `<summary>` are typed; a drag inside a field moves the text; a right-click on a misspelled
  word offers the dictionary's suggestions.
- **History** (21; E-11): one entry per write that landed, deduplicated by content; a requeued write adds none, so
  Restore's counts are exact.
- **The clean-up** (23): the deck's own NBSPs, line breaks and straight quotes between two changes of one commit are
  kept, by a character diff of the changed region instead of a count (Integration, "Three fixes", item 1).
- **The gates** (24, 25, 26, 27, 28; E-12): the Chromium fuzz judges the node the author typed in, probes on its own
  an edit the walk does not show, and checks console errors and the slide count for every round that wrote; both
  fuzzes judge the clean-up with an oracle that shares no code with it; the Node fuzz requires a refusal after a
  conflicting write to leave exactly the external write's bytes; this page quotes only the final runs.

### Duplicates

Four findings were another view of a defect the review also reported, and one fix closed each pair: 22 of 1 (a field
open across many external saves), 15 of 3 (an external change decided during an own write's last steps), 19 of 5
(text typed in a field when its window closes) and 20 of 7 (a commit refused because editing just became
unavailable). So the 29 findings are 25 defects.

### Deferred, and what remains

Nothing was deferred: every finding was fixed, and the re-verification's open points were fixed by the repair
(below). What remains, each in Open issues with its detail:

- **Limits the fixes set on purpose.** Cmd+Z pressed before the commit's message reaches main undoes the previous
  edit (main cannot reserve a slot for a commit it has not received); a deck that cannot answer within 3 s at close
  or quit has nothing written or kept (main keeps nothing it did not receive); a page holding a banked field gets the
  one commit main asks for at close, quit, leaving Edit or a shell click (that request is what keeps a real user's
  words after a pause).
- **Reach of the overlay.** 8 of 64 exact nodes under a cover on D1–D12 (slides 1–3) still get no field, and a
  `pointer-events: none` layer is seen through even where it paints: a stricter test risks hiding visible text under
  translucent layers.
- **Open, none a wrong write.** Since the gate judges every written edit (E-12), D5's ticker can fail the run on
  Josh's decks by chance, and it did in the final run (2 edits; a limit of the method; how to treat it is a lead
  decision). Not caused by the review, and fixed by the hardening round: the flood rate-limit test failed about one
  run in five, on 91b58dc as after the fixes, and a PDF cancelled by its document's close could give the wrong reason
  under load.
- **Not measured here.** Window-focus ordering, smart insert and delete on a drag, and the marker copy need the Mac;
  the hand-driven run on D3 and D10 was not repeated after the review; real use has not started.

### The re-verification and the repair

Putting the fixes together found two more. The drag-move fix allowed the deletion at a drag's source, and in an SVG
text field (the overlay's input) that held for any drop, so a drag into the page's own editable element took the word
out of the field and the blur wrote the deletion; the SVG field now confines the drop to itself as HTML fields do
(`edit-drag-move.spec.ts`). And a unit test (`test/unit/preload/env.test.ts`) still expected the input types from
before the drag-move fix, so `npx vitest run` and the reader-only gate's vitest step failed until it was updated.

Each fix was then checked again against its finding and against variants of it. Five findings (0, 3, 6, 11, 13)
were not fully resolved, and the checks found new problems, most of them in the fixes themselves. A repair step
fixed every one (commit 9a735aa holds most of it; this tree the rest), each with a regression test that fails on the
tree before it and passes after it:

- **Stale edits next to repeated copies** (finding 0 again). Placing by position alone wrote into another copy when
  another program moved a templated slide, or inserted one and changed text near the edited run: a minimal diff
  aligns the edited heading with another slide's, with no change overlapping it. Before the review such a request was
  a note. The queue now writes a stale edit only when the text around every copy confirms the diff's choice
  (`packages/editor/src/place.ts`, three rules); anything else is a verbatim note (`ambiguous`), never a guess
  (`test/unit/editor/queue-stale-copies.test.ts`, with a model fuzz of moves and inserted copies;
  `test/e2e/edit-fix-stale.spec.ts`).
- **Keys typed while a press waits** (the overlay half of finding 0). On a 2.2 MB deck a click from one field onto
  other text waits for the first field's commit; the keys typed meanwhile went nowhere, and the second commit wrote
  the text without them ("Quarterly resultsow"). The key router now holds those keys from the deck and the field
  types them when it opens (Escape drops the press; from a key that cannot be replayed on, the rest are dropped and a
  toast says to check the text).
- **An external change during the read-back of an own write** (finding 3): when another program restored the bytes
  the write replaced while the read-back ran, `knownHash` moved back and the change was never taken. Main now tells
  the watcher's decisions apart by count, not by hash (`test/unit/app/documents-knownhash-aba.edit.test.ts`).
- **A shell click that also brings the window back** (finding 6): on X11 the shell's focus event comes before the
  window's, so no commit was asked for and the field stayed open; the window's focus now asks when the shell holds
  focus (real XTEST clicks, `edit-fix-typed-text.spec.ts`).
- **Shift+Space in a button or summary** (finding 11) is inserted like Space.
- **Spelling suggestions in an SVG text field** (finding 13): the right-click reached the page's `contextmenu`
  listeners, and a deck that cancels them got no suggestions there; it no longer reaches them.
- **Text under a layer that paints** (finding 9, twice): the walk past empty elements looked only at an element's own
  background, so text hidden under a layer painted by a `::before` fill, an inset box-shadow, a thick border, an
  outline drawn inside the box or a shadow tree was outlined and opened a field on text no one could see, and the
  layer lost its click. Every way a box paints counts now, borders and inner outlines by where the point lies
  (`fixtures/edit/scrim.html`, `fixtures/edit/covers.html`, a pixel check in the test that the text is hidden). On
  copies of D1–D12 (slides 1–3) the stricter test opens the same 56 of 64 covered exact nodes as the looser one.
- **The failure toast** ("Not changed in place: … your text is kept as a note") is the shell's too, so the reload that
  follows a changed deck no longer removes it before it is read.
- **The close log** no longer says nothing was kept when main had taken and written the deck's commit.
- **The gate's sorted decks** (finding 25 again). Judging the node the author typed in failed a deck that sorts its
  labels (the edited label moves to another node) although the edit was right; the first fix took any render of the
  run with the new text as the moved node, so a deck that also lists the labels cut short elsewhere was judged on the
  other list. The moved node must now be in the author's own list, and the author's place must not still read its
  old text (`test/fuzz/selftest/decks/sorted.html` must pass, `sortrunc.html` must fail).
- **The late-write lock test** (finding 18) closed the window through File › Close, which now waits for the commit;
  it also runs with `BrowserWindow.destroy()`, which reaches the late path.
- **The bound on a page riding a real press** (findings 4 and 6 together): the commit main asks for when the user
  leaves Edit, closes the window, quits or clicks in the shell is taken for 5 s even from a field idle past the
  10-minute limit. SECURITY.md (Known limits) now says so, and `test/security/edit-expiry.spec.ts` pins it: that one
  commit, and a second one refused.

### The hardening round

**What the attackers tried.** Three attackers went after wrong-place writes in the repaired build (commit 79113e9),
each from one angle: the structure of a deck (serialisers, wrapped and re-formatted headings, tables and lists,
deleted, moved and inserted slides), data and literals (short records that hold the same text, undo and redo), and
timing in the real app (a press on uppercase text, keys typed while a press waits, a trust change or an undo while a
commit is in flight). Each wrote model fuzzers that put another program's change close to the edited run, at queue
level, and drove the built app.

**What they found.** 13 ways to write into another copy of the text than the one the author typed in, or into another
run of the element pressed: 5 in a deck's structure, 4 in data and undo, 4 of timing, each reproduced in the built app.
The lead's rule for the fixes (E-1): an edit is written only where the author's copy is identified with certainty;
anything uncertain is a verbatim note and the file is left as it is.

**What was fixed.** All 13, and the two tests that failed by chance (Open issues before the round):

- **Where a stale edit goes** (8 findings). Each of the repair's three rules was got past. Rule 1 accepted a place
  confirmed on ONE side, so a copy that slid next to the author's changed or deleted run took the edit (a table cell set
  to another value while a row ending in the old value was appended; a list item deleted and the one before it set to
  the same value; the author's slide deleted and the next templated slide's subtitle edited). Rule 2 compared copies
  only when their raw spelling was the same, so a serialiser that respelled the other copy (`&amp;`, `&nbsp;`, JS
  quotes) while removing the author's slide wrote into it. Rule 3 let a copy in "other markup" through, so the author's
  own heading wrapped in `<em>`, changed to `<h3>` or put on its own line by a formatter made a templated slide inserted
  before it take the edit. With one copy before and one after, no rule ran at all. And two short records with the same
  text swapped, or the edited one moved and rewritten, got past rule 2's stretches. The rules are replaced
  (`packages/editor/src/anchors.ts`, `place.ts`): the diff's place is written only when the text on BOTH sides of it is
  the run's old context, from its edge out to where that context is unique in the old version plus 32 characters, and at
  least 128 characters; that text occurs nowhere else in the current version; its distinguishing part occurs no more
  often than before; and no copy of the text the other program added carries more than 32 characters of the run's
  surroundings on both sides. One side is never enough: a place confirmed on one side cannot be told from the author's
  run being changed and a copy put beside that side. Between the request's version and the current one the run is
  carried through the changes the queue saw (`write-queue.ts` `carry`): Blueline's own writes, undos and redos move it
  exactly by their splices, and only another program's change is placed and confirmed as above, between the two versions
  around it (the queue keeps the versions around the last 3 such changes).
- **Undo and redo case 2** (2 findings). After a change within 32 characters of the edited copy, the record's context
  could stand only at a twin: Cmd+Z put a deleted "!" into another slide, and Cmd+Shift+Z wrote a heading edit into an
  identical templated slide. Case 2 is now placed by position from the version the write made (the queue's copy of it)
  and confirmed the same way; otherwise it is case 3, "Can't undo in place" with Make a note (`undo.ts` `planUndo`).
- **The caret on uppercase text** (2 findings). Source case (6.3) is applied inside the press, so the browser placed the
  caret in the narrower layout, in a later run: one click at the end of the first REVENUE of `Revenue <em>Revenue</em>`
  typed into the second, and keys held while a press waited were typed into the wrong line. The caret is now worked out
  from the press point in the layout the author pressed on (`edit-controller.ts` `pressCaret`, `correctCaret`); held
  keys are dropped, with the toast, when the pressed text changed meanwhile.
- **A marked download saved over the deck** (1 finding). A commit made while a D-1 reopen waited was written into the
  download. Every edit write now waits for the trust decisions already queued, and is a verbatim note while a trust
  change waits for its reopen or when the bytes it would replace are a version whose trust, decided again, differs from
  the window's (`window.ts` `writeTrust`).
- **Cmd+Z right after an Enter that became a note** (1 finding) undid the author's previous edit, on another slide.
  Cmd+Z pressed while the newest commit is in flight is now for that commit, and when it becomes a note nothing is
  undone ("Nothing undone: your last edit was kept as a note"; `undo-stack.ts`). This is E-3 as amended
  (docs/spec-amendments/README.md), which the lead accepted in the second hardening round.
- **The flood rate-limit test** (`forged-ipc.spec.ts`; 5 of 10 runs failed in the round's baseline). The deck router had
  one bucket of 1,000 messages a second per view, shared by every channel and refilled while main was busy, and each
  note create cost main more as the notes added up, so a flood could run to the 2,000-note cap. The buckets are now per
  document, view kind and channel, on a monotonic clock: note operations 50 a second with a burst of 100, every other
  deck channel 1,000 a second (SECURITY.md, Rate limits); main also sends the notes and the shell's state once per turn
  of its event loop, not once per message. A flood gets at most 100 plus 50 a second through, and the test now requires
  that bound.
- **A PDF cancelled by its document's close** (`render-products-pdf.spec.ts`; 7 of 20 runs failed in the round's
  baseline, 2 workers beside 4 CPU-bound processes) failed with "a render view showed the overlay": a check on the
  closed view answered with its fallback. Every path that meets a closed render view now ends the job as
  `RenderCancelled`, and a later stage of the job no longer starts a new renderer of the closed document
  (`render-service.ts`); the test requires `RenderCancelled`.

**Regression tests.** Each finding has one that fails on the tree before the round and passes on this one:
`test/unit/editor/queue-stale-anchors.test.ts` (31 cases for the findings, 28 of which fail on commit 79113e9's editor,
and 3 controls that pass on both; 10 more pin how a run is carried through Blueline's own writes), the note case of
`test/unit/app/edit-undo-inflight.edit.test.ts`, `test/unit/app/edit-trust-write.edit.test.ts`, and
`test/e2e/edit-fix-hardening.spec.ts` (11 cases in the built app, one or more per finding; all 11 fail on a build of the
tree before the round). The flakes have new unit tests that fail on the old code (`test/unit/app/ipc-guard.test.ts`, 4;
`render-service.test.ts`, 5, 4 of which fail on it). Tests that expected a stale edit written right next to another
program's change (finding 0's own cases: the edited slide's subtitle or kicker rewritten) expect a verbatim note now,
still never the other slide; tests about something else keep their purpose with 128 characters of unchanged text between
the run and the change.

**The attackers' property tests**, re-run at full size on this tree's editor and core, find no wrong write that text
could tell apart. The structural model fuzz (20,000 seeds, every operation): 1 of 18,210 cases where it found 61 of
18,313; the table and list fuzz (6,000 seeds): 0 of 5,411 where it found 23; every permutation of 3- and 4-record lists
in four formats: 0 where the swap gave 4 per format; the literal model fuzz (1,000 seeds in 15 formats): 0 of 13,512
where it found 51; the timing lens's sequence fuzz (4,000 sequences of 14 steps: edits, undos and redos among another
program's changes): 3 edits and 3 undos where it found 26 and 89. Those 7 are cases no text can tell apart: the file
left byte-identical to the version the write was made on (4), one of three byte-identical slides deleted (1), and the
author's slide deleted while a byte-identical copy of it stands where it was or one slide on (2). A sequence fuzz
written in this round (the page left on one version across several edits, so each edit is stale across the author's own
writes, their undos and redos, and other programs' changes; 10,000 sequences, 98,309 edits) wrote 53,202 and made 45,053
notes, with no wrong write text could tell apart: its 54 stops were all writes where a slide byte-identical to the
author's stood at the author's place, or into one of two identical slides that were swapped or moved.

**The round's final runs.** Linux, Electron 44.7.2, 2026-10-21, on the tree with every fix of the round, from a clean
build (`rm -rf packages/app/dist packages/cli/dist`, `npm run build:reader-only`, `npm run build`), each suite in turn
and the two fuzz runs side by side; logs and reports in `test-results/p2-harden-final/` (not committed; `tree.txt`
fingerprints the tree, Markdown aside).

| Suite | Result (`test-results/p2-harden-final/`) |
|---|---|
| `npm run build:reader-only`, then `npm run build` | both exit 0: no `dist/editor.cjs` after the first, `dist/editor.cjs` after the second |
| `npx tsc -p tsconfig.json --noEmit` | 0 errors; `tsconfig.reader.json` too |
| `npx vitest run` | 112 files, 2,100 tests, all pass, 79 s; the Node fuzz among them: 1,200 edits over 44 documents, 912 written (76.0%), 239 notes by rule (19.9%), 49 no-ops, **0 failures** |
| `vitest -c test/fuzz/vitest.config.mts` and `-c test/parity/vitest.config.mts` | 55 and 37 tests pass, 4 files each |
| `node scripts/fuzz-selftest.mjs` | all 14 cases as expected: the 11 it must fail fail, the 3 it must pass pass |
| `node packages/cli/dist/blueline.cjs check --auto` | 6 of 6 PASS |
| `npm run package:smoke` | 17 of 17 PASS, 0 FAIL |
| `node scripts/fuzz.mjs --committed` (the gate) | exit 0: 1,000 edits over the 47 UTF-8 committed decks, 894 written (89.4%), 81 notes by rule (10 `ambiguous`), 25 no-ops, **0 failures**, 894 probed (0 on their own, 0 unprobed); 78 stale-version requests, 69 written; 18 min (`fuzz.json`) |
| `node scripts/fuzz.mjs --local` (the extra run) | **exit 1**: 1,000 edits over D1–D12, 915 written and passed, 58 notes by rule (none `ambiguous`), 26 no-ops, **1 failure**: a D5 edit written exactly whose node, holding the new text and the sentinel, D5's ticker kept out of view at every stop (the known limit, a lead decision); 916 probed (1 on its own, the failure), 0 unprobed; 106 stale-version requests, 99 written; 28 min (`fuzz-local.json`). D1–D4 and D6–D12 gave the same counts, deck for deck, as the final runs before the round; only D5, whose ticker moves its nodes, differs |
| `npm run test:reader-only` | **PASSED** in 944 s: vitest 96 files, 1,892 tests; the E2E suite without `@edit`, 168 tests (1 the note-card ordering limit, an expected failure); the security suite without `@edit`, 57 tests (the 6 known limits, expected failures) |
| `npm run test:e2e`, three times | 301 tests, 11 of them new (`edit-fix-hardening.spec.ts`): the third run all as expected, 300 pass and 1 is the expected failure (the note-card ordering limit), 16.0 min; the first two each had one other test fail by chance, a different one each time, in code the round did not change (Open issues): `views-reload-twice.spec.ts` "two saves 300, 400 and 600 ms apart …" in the first (and the serial test after it did not run), `views-open.spec.ts` "File › Open Recent …" in the second (3 did not run); each passed in the other runs, and its file passed 40 of 40 tests when run ten times alone |
| `npm run test:security` | 65 tests: 59 pass and 6 are the expected failures (SECURITY.md), none unexpected, none flaky, 5.0 min; the flood test let 108 of 5,000 note creates through in 1.38 s |
| typed-edit and concurrency specs, `--repeat-each 3` | 30 of 30, 44 s (`gates-x3`) |
| `npx playwright test -c test/parity/playwright.config.ts` | 9 of 9, 8.8 min |
| the flood test, `--repeat-each 30` | 30 of 30, 106 to 109 note creates through in 1.32 to 1.39 s; with 4 CPU-bound processes beside it, 30 of 30, 104 to 110 in 1.24 to 1.49 s |
| the PDF close test, `--repeat-each 20`, 2 workers, 4 CPU-bound processes beside it | 20 of 20, every one `RenderCancelled: the render view was closed` |

**The cost** is in stale edits next to another program's change, which are notes now. The Node fuzz
(`test/unit/editor/fuzz.test.ts`, the same seed): 917 written (76.4%) before the round, 912 (76.0%) after; its
stale-version edits 83 of 118 written before, 85 of 121 after (an earlier outcome that changes shifts the seed's later
draws); undo case 2 188 restored before, 181 restored and 4 refused by rule (case 3) after, a change of another program
within the record's anchors; 0 failures. The fuzz gate in Chromium (the same seed and 1,000 edits a run as the final
runs below): on the committed decks 894 written where the final runs wrote 903, 81 notes by rule where they had 72 (10
now `ambiguous`, none then), stale-version requests 69 of 78 written where 71 were; on Josh's decks 915 where they wrote
917, and the 2 points are D5's, as is its 1 failure (the other 11 decks are unchanged deck for deck); stale-version
requests 99 of 106 written, 98 of 105 then. In the attackers' fuzzers, built to put another program's change close to
the edited run, the share written fell: the structural fuzz from 28.4% of its cases to 17.4%, the literal fuzz from
25.9% to 5.0% (compact records, where 128 characters hold several neighbours), the sequence fuzz's edits from 77.4% to
71.6% and its undos and redos from 75.5% to 50.8%; the table fuzz writes 8.4%. Some false notes went: a footer edit when
another program inserts or moves a slide elsewhere (10 slides: 28 of 41 written for an inserted copy, where 1 was
before, and 22 of 33 for a move, where none was), an unrelated slide inserted at the top or the end, the other copy
respelled, a re-serialised doctype. Still notes by rule: any change within the anchors (a whole-file CRLF conversion or
re-indent, the edited slide's own subtitle or kicker, the author's heading re-wrapped), another slide made identical to
the edited one, and an undo whose version the queue no longer holds.

### The second hardening round

**What the attackers tried.** Three attackers went after wrong-place writes in the build after the first hardening
round (commit 1b43e2d), each from one angle: real tools as the other program (deck generators run again, BeautifulSoup
and lxml scripts, formatters, sed, git, marp and pandoc, programs that write the deck in place), Josh's decks (36,832
stale edits, 22,166 undos and redos and 3,229 sequences on copies of D1–D12, with realistic changes near repeated text),
and the anchor rule itself (its edges, and what it is applied to: carried chains, undo case 2, restores).

**What they found.** 7 ways to write into another copy of the text than the one the author typed in, or to lose
another program's output, each reproduced in the built app:

1. A program that renumbers slides by position (a Jinja2 generator run again after its slide list changed, a
   BeautifulSoup script that moves a section and renumbers ids and page counters) gave the author's slide id and page
   counter to the slide now at the author's old position. The anchors end at the nearest difference between the copies
   (the id on the left, the counter on the right), so they stood, once, around the other slide: the stale edit was
   written there (Jinja2: 20 and 21 of 123 stale edits by template; BeautifulSoup: 14 of 60 per parser).
2. A program that writes the deck in place and pauses mid-file (a shell redirect, Python's `open('w')`, Jinja2's
   `TemplateStream.dump`): the queue read the half-written file, wrote the edit (or an undo or redo) on it and renamed
   it over the path; the rest of the other program's output went to the replaced file and was lost.
3. A new card, row or data record modelled on the author's, put beside it while the word right next to the author's
   label was renamed: the diff's common prefix or suffix ran through the new element, both anchors stood around it, and
   rule 2 (no added copy with more than 32 characters of the run's surroundings on both sides) did not fire. On Josh's
   decks: 38 of 744 targets (text-distinguishable copies) and 75 of 3,714 cases (exact copies, the inherent class).
4. Cmd+Z in the same shape after the edit was written: the undo removed the typed text from the new card.
5. Undo case 2 mapped the write's place from the version it made with one diff, blind to the author's later edits:
   after the twin got the same edit and the author's subtitle was edited, another program's swap sent Cmd+Z into the
   twin (123 of 3,000 biased fuzz seeds).
6. When carrying a stale edit through the queue's steps failed, one diff over the whole span placed it, blind to
   Blueline's own writes in between (reached with the toast's Undo while a field was open and the page busy).
7. A restore was carried as a splice (its common prefix and suffix trimmed), so a field on a slide the restore removed
   was written into the templated slide that took its place.

**What was fixed.**

- **The record rule** (findings 1, 3, 4; `packages/editor/src/records.ts`, rule 3 of `place.ts`). Besides its anchors,
  a place must agree with the author's RECORD: the largest element of the parse (or node of a script's syntax tree, for
  a literal) around the run that holds no other copy of its text, widened to the smallest element reaching past the
  anchors when the anchors already cover it. A stale edit (and each placed step of a carry, so an undo or redo too) is a
  note when another copy's record (one apart from the place's) holds what told the author's record apart from the other
  copies' records and the place's record does not; when a copy the other program added holds any of the author's record that the place lost,
  or half or more of what only the author's record held in the file; or when the place's record holds what only another
  copy's record held (the author's slide deleted and another renumbered into its place). A slide moved whole keeps its
  record, so a correct move or swap stays written; a neighbour's text is never taken for the author's.
- **Blueline's own writes are carried exactly, everything else is placed** (findings 5–7; `write-queue.ts`
  `carryRange`, `undo.ts` `planUndo` `place`). Undo and redo case 2 carry the write's range from the version it made
  through every change the queue saw, the author's later edits, undos and redos exactly by their splices; a restore is
  recorded as a whole other version and placed as another program's change; the queue keeps every route to a version
  (a redo is carried through the write it redoes and its undo); and the whole-span diff is used only when Blueline wrote
  nothing since the request's version.
- **A deck still being written** (finding 2; `write-queue.ts` `readWhole`). When the deck ended as a whole HTML document
  (`</html>`, then only white space and comments) and the file no longer does, the queue reads it again every 100 ms
  for up to 5 s and goes on with the version that ends whole; past that the operation is refused (`conflict`, a verbatim
  note for an edit) and nothing is written. A version that stays without its end for 30 s is written on as it is.

**Regression tests.** `test/unit/editor/queue-stale-round2.test.ts` (25 cases: 18 for the findings, every one of which
fails on the tree before the round, and 7 controls that pass on both: what is still written, and a case that was
already a note) and `test/e2e/edit-fix-hardening2.spec.ts` (9 cases in the built app, driven as the attackers found
them: a generator's renumbering swap and delete, the new card and its Cmd+Z, a Python and a shell in-place writer
pausing 3 s, Cmd+Z after later edits and a swap, the toast's Undo and a restore clicked while a field is open and the
page is in a long task; all 9 fail with the editor bundle built from the tree before the round, and pass).

**The attackers' property tests**, re-run at full size on this tree's editor and core, find no wrong write that text
could tell apart. The first round's: the structural model fuzz (20,000 seeds) 1 of 18,210 cases, the same
byte-identical one as after that round; the table fuzz (6,000 seeds) and the literal model fuzz (1,000 seeds in 15
formats) 0; the timing lens's sequence fuzz (4,000 sequences of 14 steps) 3 edits and 2 undos, all among that round's
byte-identical cases. This round's: every move, swap, insert and delete of the Jinja2 decks (123 stale edits each, two
templates) 0 wrong where they gave 20 and 21 (and 2 written where the author's slide was deleted); the BeautifulSoup
move with renumbering 0 of 60 per parser, where it gave 14; the template grid 0 of 360 where it gave 12; formatters,
sed, git and an agent's edits 0; marp and pandoc as before (marp's 4 are byte-identical divider slides); the exposure
scan of D1–D12 and the committed decks 0; the half-written file refuses the edit, the undo and the redo. On copies of
Josh's decks, the new-element campaign (6,564 cases): 0 text-distinguishable writes into the new element, where it
gave 38, and 40 of the exact copies, where it gave 75 (the new element byte for byte the author's old one, the
author's renamed: the bytes read the same as a changed copy put beside the untouched one, the documented limit). The
realistic campaigns, case for case against the attackers' runs: c1 (17,091 single realistic changes near repeated
text) and c2 (5,507: template inserts, duplicates, data arrays) 0 wrong, 0 bytes changed outside the typed run, 0
notes that changed the file, and c2's one write into a copy (the D12 row, an exact copy) is a note; the undo and redo
campaign (22,166) and the own-write sequences (3,229) 0 wrong. The anchors lens's sequence fuzz (11,000 sequences in
four variants): 7 wrong and 6 written where the author's slide was gone, where it gave 27 and 17, all byte-identical
(two identical slides swapped or moved, which no byte shows; the author's slide deleted while an identical copy stands
at its place; a slide duplicated and the original deleted); its biased undo fuzz (3,000 seeds) 0 where it gave 123;
its random undo fuzz (4,000 seeds) the same 6 byte-identical cases, and 987 undos done where 643 were (the author's
later writes are carried now, no longer a refusal).

**The cost.** The Node fuzz (`test/unit/editor/fuzz.test.ts`, the same seed): 912 written (76.0%), as before the
round; its stale-version edits 85 of 121 written, as before; undo case 2 180 restored and 5 refused by rule, where 181
and 4 were. The first round's structural fuzz writes 3,128 of its 18,210 cases where it wrote 3,162; its table and
literal fuzzes write as many as before (457 and 669). On Josh's decks, case for case: c1 writes 7,128 of 17,091 where
it wrote 7,276 (2.0% fewer; 149 written cases became notes, 1 note was written), c2 758 of 5,507 where it wrote 788,
the sequences 1,498 of 3,229 where they wrote 1,539, and the undo and redo campaign does 7,296 of 22,166 where it did
7,499 (222 refused that were done, 19 done that were refused). The notes that were writes are mostly an insertion or a
card change in the author's record beyond its anchors (the record must keep what told it apart) and a copy the other
program added beside it. In c1 no deck lost more than 4% of its writes (D1 853 to 821, D11 732 to 707, D12 722 to
695, the rest fewer); the undo and redo campaign lost the most on D1 (1,044 to 933 of 2,384 cases, 11%), and c2 and the
sequences at most 9 and 11 writes on a deck (D12 115 to 106, D1 249 to 238). A stale edit of a repeated text now
parses both versions with parse5 (30 to 140 ms each on D1–D12, kept for the next placement). The fuzz gate in Chromium
(the same seed and 1,000 edits a run; the final runs below): on the committed decks every edit has the outcome it had
after the first round (894 written; 3 of the 10 `ambiguous` notes now give the new reason, Blueline's own writes and
another program's change both in the span); on Josh's decks 913 written where the first round's final run wrote 915.
One stale edit on D9 is a note now: its run could not be carried through the changes the queue saw, and Blueline had
written in between, so the one diff over the whole span that placed it after the first round (rightly, the probe
said) is no longer used (finding 6). D9's later edits then differ (82 written of 88, where 84 were); run alone
(`--decks D9`) it gives the same 88 outcomes. D1–D4, D6–D8 and D10–D12 have the same counts deck for deck, and D5
differs only through its ticker (70 written in both).

**What remains.** The byte-identical classes above. A deck that never ended with `</html>` is not waited for, so a
program writing it in place can still have its rest lost; a program that pauses longer than 5 s gets the author's edit
kept as a note (nothing written), and one that leaves the deck without its end for 30 s has it taken as the deck. An undo
of a write that emptied an element (no text left in it), after another program's change, is now "Can't undo in place"
(its place is carried by the run that holds it; there is none).

**The round's final runs.** Linux, Electron 44.7.2, 2026-10-22, on the tree with every fix of the round (with its fixes
of the two tests that failed by chance and the deck IPC budget, Open issues), from a clean build (`rm -rf packages/app/dist
packages/cli/dist`, `npm run build:reader-only`, `npm run build`), each suite in turn and the two fuzz runs side by
side; logs and reports in `test-results/p2-harden2-final/` (not committed; `tree.txt` fingerprints the tree, Markdown
aside, and it was the same after the runs). No run needed a fix.

| Suite | Result (`test-results/p2-harden2-final/`) |
|---|---|
| `npm run build:reader-only`, then `npm run build` | both exit 0: no `dist/editor.cjs` after the first, `dist/editor.cjs` after the second |
| `npx tsc -p tsconfig.json --noEmit` | 0 errors; `tsconfig.reader.json` too |
| `npx vitest run` | 113 files, 2,129 tests, all pass, 87 s; the Node fuzz among them: 1,200 edits over 44 documents, 912 written (76.0%), 239 notes by rule (19.9%), 49 no-ops, **0 failures**; 85 of its 121 stale-version edits written; undo case 2 180 restored and 5 refused by rule |
| `vitest -c test/fuzz/vitest.config.mts` and `-c test/parity/vitest.config.mts` | 55 and 37 tests pass, 4 files each |
| `node scripts/fuzz-selftest.mjs` | all 14 cases as expected: the 11 it must fail fail, the 3 it must pass pass |
| `node packages/cli/dist/blueline.cjs check --auto` | 6 of 6 PASS |
| `npm run package:smoke` | 17 of 17 PASS, 0 FAIL |
| `node scripts/fuzz.mjs --committed` (the gate) | exit 0: 1,000 edits over the 47 UTF-8 committed decks, 894 written (89.4%), 81 notes by rule (10 `ambiguous`), 25 no-ops, **0 failures**, 894 probed (0 on their own, 0 unprobed); 78 stale-version requests, 69 written; every edit's outcome as in the first round's final run; 18 min (`fuzz.json`) |
| `node scripts/fuzz.mjs --local` (the extra run) | **exit 1**: 1,000 edits over D1–D12, 913 written and passed, 58 notes by rule (1 `ambiguous`, the D9 edit above), 28 no-ops, **1 failure**: a D5 edit (360) written exactly whose node, holding the new text and the sentinel, D5's ticker kept out of view at every stop (the known limit, a lead decision); 914 probed (1 on its own, the failure), 0 unprobed; 107 stale-version requests, 98 written; 29 min (`fuzz-local.json`) |
| `npm run test:reader-only` | **PASSED** in 1,019 s: vitest 96 files, 1,896 tests; the E2E suite without `@edit`, 173 tests (1 the note-card ordering limit, an expected failure); the security suite without `@edit`, 57 tests (the 6 known limits, expected failures) |
| `npm run test:e2e`, three times | 316 tests (301 after the first round; the fixes of the tests that failed by chance added 6 in `views-reload-twice.spec.ts` and `ipc-legit-rates.spec.ts`, this round 9 in `edit-fix-hardening2.spec.ts`): in each run 315 pass and 1 is the expected failure (the note-card ordering limit), none unexpected, none flaky, none skipped; 18.0 min each |
| `npm run test:security`, twice | 65 tests: 59 pass and 6 are the expected failures (SECURITY.md), none unexpected, none flaky, 5.2 min each; the flood test admitted 454 and 443 of its 15,000 messages, by 0.58 and 0.62 s, and let 111 and 113 of its 5,000 note creates through, in 2.14 and 2.19 s |
| `npx playwright test -c test/parity/playwright.config.ts` | 9 of 9, 9.0 min |

### The uniqueness rule (lead decision F-1)

**Why.** Two hardening rounds found 13 and then 7 ways for a stale edit, or an undo or redo case 2, to land on another
copy of the same text when another program had changed the file, and each was fixed by one more placement heuristic
(the both-sided anchors, the record rule). Each round also left a class that no byte tells apart: identical slides
swapped or moved, an identical copy at the place of the author's deleted slide, a slide duplicated and its original
deleted, identical divider slides. The lead's decision F-1 replaces telling copies apart with not choosing among them.

**The rule.** When every change between the edit's version V (the field's version; for undo and redo, the version
the write made) and the current file C is one of Blueline's own recorded writes, the run is carried exactly by their
splices, as before. Otherwise another program changed the file, and the edit is written only when all of these hold
(`packages/editor/src/place.ts`, `write-queue.ts`):

- (a) beforeText is the decoded value of exactly one place in V and exactly one in C: one run, HTML text or a script
  literal (a literal's shadow run too), and no shadow value. Text the page may show that Blueline never writes (the
  `<title>`, an attribute value, a `<template>`'s text, a number in a script) counts as a copy, as the matcher counts
  copies (D-a). It must also be in at most one place in every version another program made in between (the run's
  value at that version).
- (b) The run, carried along what happened (Blueline's own writes exactly; each other program's change placed by this
  same rule, with the run's value at that step, between the two versions around it) or, when the queue does not hold
  the versions around those changes (or more than 3 lie between) and Blueline wrote nothing in that time, mapped
  through one diff of V to C, lands exactly on that one run of C, of the same kind, with no change over it.
- (c) The checks that only turn writes into notes do not object: the text on both sides of the place (`anchors.ts`),
  the wait for a program still writing the deck, and the trust check at the write.

Anything else is a verbatim note: `ambiguous` when the text is in more than one place in V or in C, `stale` when it
is in one place and the mapping or the anchors fail. A carry that a step refuses is a note; it is never placed again
by one diff over the whole span, which cannot see a copy the queue saw on the way. Undo and redo case 2 follow the same
rule for the run that holds the text they replace (its value in one place in the version the write made, in C and in
every version another program made in between, the place in that run at the same offset), and the needle (prefix,
rawAfter, suffix) must still occur once in C, exactly there; otherwise case 3. A picked candidate follows the rule on
its run's value.

Whether another program changed the file is judged by what happened, in order, not by the bytes: the queue keeps a
log of what the file became (`write-queue.ts`, `log`): each version it read, each of its own writes, and each version
main read itself (main tells the queue the version it opened and every external change it takes from the watcher,
`know` with `onDisk`; `EditLane.attach` and `takeExternal`). A stale edit is carried along that log from where the
file was V when its client began to hold it (the oldest hold of V that main has not let go: main holds a version while
a page shows it and while a field is open on it) to C; an undo or redo from the entry that made the write (the write
itself, or a redo or undo of it in case 1). Every change in that span counts, even when the bytes came back to V, when
the queue never read a version in it, or when Blueline's own write later made the same bytes again. Without that, a
slide duplicated and its original deleted left the very bytes of V, or a route of own writes, and the edit was carried
onto the copy. Undo case 1 (the hash says the file is the version the write made) follows the rule too when another
program's change came and went in between.

**What went.** The record rule (`records.ts`, the second hardening round's rule 3) and the repair's rule 2 (copies the
other program added) decided only among copies; under (a) there is never more than one, so both are removed with their
parse5 and acorn parses (a stale edit no longer parses both versions). `planUndo` no longer has its own diff path:
case 2 needs the queue's carried place. The anchors stay, as clause (c): with the text in one place, a minimal diff can
still line the author's run up with a run another program changed to hold its text (a list item deleted and the one
before it set to the same value), and both sides tell those apart.

**Tests.** `test/unit/editor/queue-unique.test.ts` (30 cases): each clause, shadow values as copies, HTML text against
a script literal, picked candidates, own writes only (copies or not), the byte-identical classes (identical slides
swapped and moved, the author's slide deleted while an identical one stands at its place, identical dividers, a slide
duplicated and its original deleted with the queue reading the deck in between, the same with the bytes coming back,
and with a field held open across it), undo and redo (case 2 and the formerly accepted twins, case 1 after a change
that came and went), and a restore in between; 16 of the 30 fail on the editor of commit c8e2445 (written there, or
another note code), the rest are controls that pass on both. Every regression test of both hardening rounds still
passes; the ones that asserted a WRITE among copies under another program's change now assert the note, each with a
control whose text is in one place so the intent (placed by position, carried through own writes, the version held)
is still tested:

- `write-queue.test.ts`: two copies of "Owner" with a change far away (both copies were written); copies with
  different context (written); a literal whose text a `<template>` added also shows (a shadow value; written). Two
  code checks are `stale` now, not `ambiguous`: the text in one place with a change next to it, and a run rewritten
  while its text stands elsewhere once.
- `queue-phase2.test.ts`: a version told with `know` placed by position (the copies of "Owner" are a note; the case is
  kept with unique text); the fixture undo test (a redo across another program's change of a title-slide heading that
  is also the `<title>`, a shadow value, is case 3 now); the refusal-code test gains an `ambiguous` case.
- `queue-stale-anchors.test.ts`: "what is still written" (two "Key takeaways" slides with a change far away, and a
  slide inserted far before: written into the right copy) and the undo case 2 control (the edit made the heading
  equal its twin's); the three "own writes and another program's change" tests run with the text in one place
  (written) and in two (a note).
- `queue-stale-copies.test.ts`: a change two slides away, the same words pasted into a new paragraph, the two list
  copies with an unrelated change; the model fuzz now mixes shared and own headings and fails on any write among copies
  (1,500 seeds per id mode).
- `queue-stale-position.test.ts`: either copy written after a far change; the pin and diff-timeout tests use text in
  one place (their subject is the pin and the time limit, not copies).
- `queue-stale-round2.test.ts`: its three controls (a slide appended; a card with the same label inserted below; an own
  write elsewhere and a far change) wrote into one of two copies; each is a note now, with a one-place control.
- `test/unit/app/edit-lane-pins.edit.test.ts`: "9 external saves elsewhere" wrote card one's "Owner" while card two
  also said "Owner"; it now runs with card two saying "Lead" (written) and "Owner" (a note).
- `test/unit/editor/fuzz.test.ts` (the Node fuzz): an undo case 2 refused far from the change is allowed when the text
  is in more than one place.

**The attack suites, re-run at full size** on the final editor (a snapshot of `packages/core` and `packages/editor`,
the attackers' scripts unchanged; before: the second round's final runs on commit c8e2445's editor):

| Suite | Before (wrong writes) | After |
|---|---|---|
| Round 1, structural model fuzz (20,000 seeds, 18,210 cases) | 1 (seed 11375), and 3 writes the fuzz accepts as twins; 3,128 written | **1** (seed 11375, below); 447 written, 17,762 notes |
| Round 1, table and list fuzz (6,000 seeds) | 0; 457 written | 0; 0 written (every case has the cell text in several places) |
| Round 1, literal model fuzz (1,000 seeds × 15 formats) | 0; 669 written | 0; 117 written |
| Round 1, the repro tests (structural, literals, timing) | 2 (E4n, two identical records) | 0; nothing written (156 notes; `b9-w4` runs without its trace helper, which no longer loads, as before) |
| Round 1, timing sequence fuzz (4,000 × 14 steps) | 53 edits + 8 undos into another slide | 43 edits + 9 undos (below: the file never changed) |
| Round 2, anchors sequence fuzz (11,000 sequences, 4 variants) | 48 | 22 (below: no change the queue saw) |
| Round 2, biased undo fuzz (3,000 seeds) | 0 (2,677 refused) | 0 (2,677 refused) |
| Round 2, random undo fuzz (4,000 seeds) | 6 | 5 (below: case 1, the file never changed) |
| Round 2, tools (Jinja2, BeautifulSoup, grid, formatters, sed, git, agent, marp, pandoc, exposure) | marp's 4 identical dividers | 0; nothing written (2,708 notes): every target is a text in several places; the half-written file still refuses the edit, the undo and the redo |
| Round 2, decks p4 (new element, 6,564 cases) | 40 (exact copies) | **0**; 6,564 notes |
| Round 2, decks c1, c2, u1, s1 | 0 | 0 in all 47,993 cases; no write changed a byte outside the typed run and no note changed the file |

What is left is outside any rule on the file:

- **The file never changed.** In the timing sequence fuzz (43 edits, 9 undos and redos), the anchors fuzz (22) and
  the random undo fuzz (5), every remaining write happened where the other program's changes left the bytes exactly as
  they were: two identical slides swapped or moved, or a slide duplicated and its original deleted in the same save.
  The queue read the same hash (or, between two versions it saw, only Blueline's own writes), so to Blueline nothing
  changed; the write lands on the bytes the author typed in, which are byte for byte the bytes it would land on had
  the other program done nothing. Traced case by case (`classify.txt` in the run folders): same version, undo case 1,
  or a route of own writes, each with no change by another program seen since the version was held or the write made.
  With the page held from the start as main holds it (the anchors fuzz's own harness does not hold the first page),
  15 such cases remain, all of the same kind.
- **Structural seed 11375.** One save deletes the author's slide and inserts a byte-identical slide at the same
  place, while it also changes another slide. The author's slide's bytes and everything around them are unchanged,
  the text is in one place before and after, and the diff maps the run onto itself: all three clauses hold and the
  edit is written where the author typed, which no reading of the bytes can tell from the other slide.

**The cost.** Every stale edit, undo or redo of text that is in more than one place is a note once another program has
changed the file, however far away, and so is text equal to a shadow value (on the committed decks 61 of 673 editable
runs whose text is in one run are also a shadow value, 49 of them an attribute and 11 the `<title>`; on D1–D12 420 of
8,326, 360 of them attributes).

- Node fuzz (`test/unit/editor/fuzz.test.ts`, the same seed): 831 written of 1,200 (69.3%) where it wrote 912
  (76.0%); stale-version edits 49 of 127 written where 85 of 121 were; undo case 2 177 restored and 6 refused by
  rule, where 180 and 5 were; 0 failures. Without the shadow-value clause (a measurement build only) it writes 836.
- Chromium fuzz gate on the committed decks (`node scripts/fuzz.mjs --committed`, the same seed and 1,000 edits):
  891 written (89.1%) where the second round's final run wrote 894, 83 notes by rule where it had 81 (6 `ambiguous` and
  10 `stale` where it had 10 `ambiguous`), 26 no-ops (25), **0 failures**, every written edit probed (891; 0 on its own,
  0 unprobed); stale-version requests 61 of 71 written where 69 of 78 were. 983 of the 1,000 edits have the outcome they
  had; 8 written edits are notes now and, as the seed's later draws shift, 6 notes are written and 3 edits move between
  written and no-op. 19 min, beside two campaign processes (`scripts/fuzz.mjs`'s `fuzz.json`).
- On copies of Josh's decks, case for case against the second round's final runs (every target of c1, c2, u1 and s1
  is a text in several places, chosen to be): c1 writes none of its 17,091 stale edits (7,128 before), c2 none of its
  5,507 (758), and the own-write sequences s1 none of 3,229 (1,498). The undo and redo campaign u1 still does 4,798 of
  its 10,830 undos (4,880 before: after the author's edit the run's text is usually in one place) and none of its 11,336
  redos (2,416 before: a redo puts back text that is in several places). The new-element campaign p4 makes all 6,564
  cases notes, where 40 were written into the copy. No case of any campaign wrote into another copy.
- The attackers' fuzzers, built to put another program's change near repeated text, write far less: the structural
  fuzz 447 of 18,210 cases (3,128 before), the literal fuzz 117 (669), the table fuzz none (457), the sequence fuzzes'
  edits 27,108 of 45,568 (32,055 of 44,725) and 8,273 of 18,188 (10,234 of 18,163, variant A).

**Suites.** `npx vitest run`: 114 files, 2,169 tests, all pass, 95 s (the Node fuzz among them, above); `vitest -c
test/fuzz/vitest.config.mts`: 55 tests pass; `npx tsc -p tsconfig.json --noEmit` and `tsconfig.reader.json`: 0 errors;
`npm run build`: exit 0 (`dist/editor.cjs` holds no record rule); `npx playwright test -c test/e2e/playwright.config.ts
test/e2e/edit-`: the 16 `edit-*.spec.ts` files, 116 tests, all pass, 3.7 min (the concurrency gate's inserted-element
and duplicated-text cases are notes, as they were since the first hardening round's anchors); `npm run test:security`:
65 tests, 59 pass and 6 are the expected failures (SECURITY.md), none unexpected, 5.1 min. Logs, run folders (with
`classify.txt` for each remaining case) and the snapshot the suites ran on are in the build's scratch folder, not
committed; the editor in the tree is that snapshot's, comments aside.

### The uniqueness rule, attacked (the third round)

An attacker (the built app and the queue) and a reviewer (the code and the docs) went at the first F-1 implementation
(the tree above). They found nine ways to a write the rule forbids, from five causes; each is fixed at its cause, with
a regression test that fails on that tree and passes now. When in doubt the rule wins: a note.

1. **Main's sightings were not changes** (the attack's findings 1 and 2, the review's C4). The queue judged "another
   program changed the file" only from the versions it read itself; main takes every external save from the watcher
   (`EditLane.takeExternal`) and told the queue with `know`, which counted for nothing. In the built app a field held
   open while another program duplicated the author's slide and then deleted the original (two saves the watcher
   took) was written into the copy; with two identical dividers, one deleted and an identical one put back, the edit
   was written into one of two copies, against F-1's letter (text in two places in V and C); and Cmd+Z after either
   said "Undone". The attack's app-mode sequence fuzz (each external save told as main tells it) found 35 writes among
   copies in 4,000 sequences, 213 with reverts. **Fix:** main tells the queue every version it reads from the file,
   at open and from the watcher, a deck that is not UTF-8 too (`know(…, { onDisk: true })`), and the queue keeps one
   log, in order, of what the file became (`write-queue.ts` `log`): the versions it read, its own writes, and main's
   sightings. A version that is not the one seen last and that the queue did not write is another program's change.
2. **One diff over the whole span skipped the copies seen on the way** (finding 3, C1). With more than 3 changes by
   another program between V and C, or with V not where the queue saw the file, one diff placed the edit checking V and
   C only: a slide duplicated (read), two saves far away (read) and the original deleted wrote into the copy, where one
   save far away gave a note. **Fix:** that path needs the text in at most one place in every version another program
   made in the span too (`onTheWay`); each log entry keeps the texts in more than one place in its version (`copies`,
   a small set), so the check holds after the version itself was evicted.
3. **An undo was timed by its bytes** (finding 4, C2). An undo's "since when" was when any own write last made the
   bytes its write made: an own edit elsewhere and its undo, a redo cycle, the undo of a later write (plain Cmd+Z
   order), or the author fixing a far heading back, moved it past another program's change, and an evicted version
   met again took the time of that meeting. Case 1 was then written into a copy, and case 2 with the text in two places
   in the version the write made and now (F-1's letter). **Fix:** an undo or redo is carried along the log from the
   entry that made the write (the write itself, or a redo or undo of it in case 1; `lastMade`), never from when the
   bytes were last made; when another program changed the file in that span, case 1 by the hash follows case 2's rules
   (`planUndo` `byHash: false`).
4. **beforeText instead of the run's value on the way** (C3). The versions another program made were checked for
   beforeText, which missed copies of the run's value when Blueline's own writes had renamed it in between (two fields
   on one run). **Fix:** the carry walks the log in order, so each other program's change is placed with the run's
   value at that step.
5. **A `</html>` that is not the end** (the attack's finding 5). The wait for a program writing the deck in place took a
   prefix that stopped right after a `</html>` inside an iframe's `srcdoc`, a script string or a comment for a whole
   deck: in the built app the edit was written on 886 of 1,764 bytes and the rest of the other program's output was
   lost. **Fix:** a deck ends whole when only white space and comments follow the last `</html>` that the HTML
   parser reads as an end tag, not as text in an attribute value, a script or a comment (`endsWhole`), parsed once
   per version (an own splice keeps its parent's answer).

**What the log replaces.** The route search over recorded steps (`chain`: the shortest route, newest step first), the
time stamps on byte-versions (`madeAt`, `toldAt`, `ownAt`), `foreignLog`, `foreignSince`, `CHAIN_MAX` and `STEPS_KEPT`
are gone. The carry walks what happened, in order (`carryAlong`), so it can no longer take an own step for another
program's change that made the same bytes, skip a version on the way, or start an undo from the wrong write. A stale
edit starts where the file was V when its client began to hold it (`startOf`: the last entry of V at or before the
oldest pin of V); a version no client pins (main pins every version a page or field holds) is taken to have been held
since the queue first met it, the earliest time, as nothing says otherwise.

**Found on the way.** The Node fuzz's random stream shifted with the queue's outcomes and reached a `<pre>` whose text
follows the dropped leading newline: an edit that made it start with a space was planned, and verify refused it
(parse5 starts the text node at the newline when white space follows it). `plan.ts` now refuses that by rule
(`escape`), as it did the character-reference case; nothing was ever written.

**Tests.** `test/unit/editor/queue-unique-log.test.ts` (25 cases: main's sightings, with the dup-and-delete,
identical-divider, undo and not-UTF-8 cases; the whole-span path with 1, 2, 3 and 6 saves far away and a version told
only with `know`; undo after an own edit and its undo, a redo cycle, the plain Cmd+Z order, a fixed far heading, an
evicted version; the run's value on the way; the nested `</html>` in a srcdoc, a script and a comment, and
`endsWhole`'s cases; with controls): 21 fail on the first F-1 tree, the 4 controls pass on both.
`test/unit/app/edit-lane-sightings.edit.test.ts` (7 cases through main's real wiring: a `BlDocument` on a real file,
`EditLane.takeExternal`, `EditSession` commits and `appUndo`): the 5 bug cases fail on the first F-1 tree, the 2
controls pass on both. `queue-stale-position.test.ts` now tells the queue its external saves as main does
(`onDisk`). The attack's and the review's repros, with main's calls as main makes them now: every one a note, "Can't
undo in place" or a `conflict`; the implementer's 30 `queue-unique` cases with main's call in place of the queue's
reads: 30 pass (5 failed before).

**The re-runs**, at full size, on the fixed editor (a snapshot of `packages/core` and `packages/editor` equal to the
tree; the attackers' scripts unchanged, except that this round's app-mode harness tells external saves to the queue as
main now does), against the first F-1 tree's runs above:

| Suite | First F-1 tree (wrong writes) | Fixed |
|---|---|---|
| This round, built app (`e1-dup-delete`, `e2-copies-back`, `e3-cut-srcdoc`: 7 tests) | 7 (written into the copy, among copies, "Undone", half a deck lost) | **0**: 5 notes or "Can't undo in place"; the half-written deck waited for, then the edit written on the whole deck, nothing lost |
| This round, queue repros (attack 21, review 17) | 9 kinds of write the rule forbids | 0: notes, case 3 or `conflict`; 12 far saves with the bytes back is written now (it was an `ambiguous` note with no copy anywhere) |
| This round, app-mode sequence fuzz (4,000 × 16 steps; every external save told as main tells it) | 35 writes among copies after another program's change (213 with reverts) | **0** (0); identity: 5 writes on a byte-identical twin; with reverts 5 and one where two identical slides were swapped and an own write then changed one (seed 1740) |
| Round 1, structural model fuzz (20,000 seeds) | 1 (seed 11375) | 1 (seed 11375, unchanged: one save replaced the author's slide by a byte-identical one at its place, above); 447 written |
| Round 1, table, literal fuzz, repro tests | 0 | 0; 0, 117 and 0 written |
| Round 1, timing sequence fuzz (4,000 × 14) | 43 edits + 9 undos | 42 edits + 9 undos and redos |
| Round 2, anchors sequence fuzz (11,000 sequences, 4 variants) | 22 | 14 |
| Round 2, biased and random undo fuzz | 0 and 5 | 0 (2,677 refused) and 5 |
| Round 2, tools (Jinja2, BeautifulSoup, grid, formatters, sed, git, agent, marp, pandoc, exposure) | 0; nothing written | 0; nothing written, the same 971 notes; the half-written file still refuses the edit, the undo and the redo |
| Round 2, decks p4, c1, c2, u1, s1 (copies of D1–D12) | 0 | 0 in all 54,557 cases, each with the outcome it had on the first F-1 tree: no stale edit of repeated text written, 4,798 of 10,830 undos done (5 undos on D5 and D11 whose diff ran out of time while the fuzz gate ran beside them were case 3, and were undone as before when run again alone) |

Every write left in the sequence fuzzes (this round's three, the timing fuzz, the anchors fuzz, the undo fuzz) was
traced (`classify.txt` in the run folders): the span the queue carried had no change by another program in it, own
writes only or nothing; the other program's changes left the bytes exactly as Blueline last saw them (identical slides
swapped or moved), so to Blueline nothing changed. This round's fuzz without main's sightings (the queue reading 60% of
the external saves, as no app does) still writes 36 times among copies after a change it never saw (317 on the first
F-1 tree), the same class.

**The cost.** The Node fuzz (`test/unit/editor/fuzz.test.ts`, the same seed; its stream follows the outcomes) writes
818 of 1,200 edits (68.2%; 831 on the first F-1 tree), stale-version edits 55 of 129 (49 of 127), undo case 2 168 with
7 refused by rule (177 and 6), 0 failures. The Chromium fuzz gate on the committed decks (`node scripts/fuzz.mjs
--committed`, the same seed and 1,000 edits): 891 written, 83 notes by rule (6 `ambiguous`, 10 `stale`), 26 no-ops,
**0 failures**, all 891 written edits probed, the same totals as on the first F-1 tree (18 min, beside two campaign
processes). In the attackers' sequence fuzzes the own writes from a "fresh page" are notes more often (seq2-A: 1,374
of 11,114, 118 before): that page tells its version without a pin, which now counts from when the queue first met
those bytes; main pins every page and field, so the app never meets it.

**Suites** (the final tree): `npx vitest run`: 116 files, 2,202 tests, all pass, 99 s (the Node fuzz among them);
`vitest -c test/fuzz/vitest.config.mts`: 55 pass; `npx tsc -p tsconfig.json --noEmit` and `tsconfig.reader.json`: 0
errors; `npm run build`: exit 0; `npx playwright test -c test/e2e/playwright.config.ts test/e2e/edit-`: the 16
`edit-*.spec.ts` files, 116 tests, all pass, 4.1 min; the security suite: 65 tests, 59 pass and 6 are the expected
failures (SECURITY.md), none unexpected, 5.5 min; this round's three built-app attack specs: 7 of 7 pass. Logs, run
folders (with `classify.txt`) and the snapshot the suites ran on are in the build's scratch folder, not committed.

### The uniqueness rule's final runs

Linux, Electron 44.7.2, 2026-10-22, on the tree with every fix of the third round (commit 1554149 and the round's
changes on top of it), from a clean build (`rm -rf packages/app/dist packages/cli/dist`, `npm run build:reader-only`,
`npm run build`), each suite in turn and the two fuzz runs side by side; logs and reports in
`test-results/p2-unique-final/` (not committed; `tree.txt` fingerprints the tree, Markdown aside, and `tree-after.txt`
is the same). The exit-gate table at the top of this page gives these runs. No run needed a fix; the one failure, on
D11 (below), was traced to its cause.

| Suite | Result (`test-results/p2-unique-final/`) |
|---|---|
| `npm run build:reader-only`, then `npm run build` | both exit 0: no `dist/editor.cjs` after the first, `dist/editor.cjs` after the second |
| `npx tsc -p tsconfig.json --noEmit` | 0 errors; `tsconfig.reader.json` too |
| `npx vitest run` | 116 files, 2,202 tests, all pass, 81 s; the Node fuzz among them: 1,200 edits over 44 documents, 818 written (68.2%), 338 notes by rule (28.2%), 44 no-ops (3.7%), **0 failures**; 55 of its 129 stale-version edits written; 75 picked candidates, 55 written; undo case 2 168 restored and 7 refused by rule (as in the third round's run) |
| `vitest -c test/fuzz/vitest.config.mts` and `-c test/parity/vitest.config.mts` | 55 and 37 tests pass, 4 files each |
| `node scripts/fuzz-selftest.mjs` | all 14 cases as expected: the 11 it must fail fail, the 3 it must pass pass |
| `node packages/cli/dist/blueline.cjs check --auto` | 6 of 6 PASS |
| `npm run package:smoke` | 17 of 17 PASS, 0 FAIL |
| `node scripts/fuzz.mjs --committed` (the gate) | exit 0: 1,000 edits over the 47 UTF-8 committed decks, 891 written (89.1%), 83 notes by rule (8.3%: markup 33, escape 28, `stale` 10, `ambiguous` 6, placeholder 3, commitField 3), 26 no-ops (2.6%), **0 failures**, 891 probed in 163 probe loads (0 on their own, 0 unprobed); 71 stale-version requests, 61 written; 52 external writes just before an edit and 35 inside the atomic write (all 35 landed before the re-hash), the external change kept every time; 217 written edits undone and redone byte for byte; the same 1,000 records as the first F-1 tree's run and the third round's; 18 min (1,086 s; `fuzz.json`) |
| `node scripts/fuzz.mjs --local` (the extra run) | **exit 1**: 1,000 edits over D1–D12, 879 written: 878 passed (87.8%), 1 failed the probe; 92 notes by rule (9.2%: `ambiguous` 36, escape 33, markup 8, commitField 12, placeholder 2, a pick that could not be lifted 1), 29 no-ops (2.9%); **1 failure**, D11 edit 869, the probe's reach on D11's marquee (below), not a wrong write and not a pass; 879 probed in 49 probe loads (2 on their own: a D5 edit, which passed, and the failure), 0 unprobed; 98 stale-version requests, 83 written; 66 picked candidates, 58 written; 33 external writes just before an edit and 36 inside the atomic write (34 landed), the external change kept every time; 28 min (1,683 s; `fuzz-local.json`) |
| `npm run test:reader-only` | **PASSED** in 1,015 s: vitest 96 files, 1,896 tests; the E2E suite without `@edit`, 173 tests (1 the note-card ordering limit, an expected failure), 13.0 min; the security suite without `@edit`, 57 tests (the 6 known limits, expected failures), 3.4 min |
| `npm run test:e2e`, three times | 316 tests, as after the second round: in each run 315 pass and 1 is the expected failure (the note-card ordering limit), none unexpected, none flaky, none skipped; 17.9, 17.8 and 17.7 min. The concurrency spec's 7 tests pass in each run: the unrelated change, the change while the field stays open and the write inside the atomic write land on the heading with the external change kept; the same text rewritten, the element inserted before the heading and both duplicated-text cases are verbatim notes |
| `npm run test:security`, twice | 65 tests: 59 pass and 6 are the expected failures (SECURITY.md), none unexpected, none flaky, 5.1 min each; the flood test admitted 408 and 452 of its 15,000 messages, by 0.56 and 0.57 s, and let 112 and 111 of its 5,000 note creates through, in 2.12 and 2.13 s |
| `npx playwright test -c test/parity/playwright.config.ts` | 9 of 9, 8.9 min |

**The fuzz gate on Josh's decks under the rule.** This is the rule's first run there. Against the second round's final
run of the same seed (`test-results/p2-harden2-final/fuzz-local.json`: 913 written and passed, 58 notes by rule with 1
`ambiguous`, 28 no-ops, 1 failure on D5's ticker), 770 of the 1,000 records are the same. In ten decks the records are
the same up to the first edit the rule made an `ambiguous` note (written then, on its run: repeated text after another
program's change), and the deck's later draws differ from there; D6's records are the same throughout, and D5's differ
from its first edit (332) on, as in every run: its ticker changes what its walks see (411 exact nodes then, 415 now).
The 36 `ambiguous` notes are the rule's cost: each is text in more than one place after another program changed the
deck, 11 stale-version requests, 16 edits after one of the fuzz's external writes (6 just before the edit, 10 inside
its atomic write) and 9 later edits of a round in which an earlier edit's external write had changed the deck. Written
per deck, then and now: D1 83 and 80, D2 79 and 75, D3 68 and 68, D4 71 and 64, D5 70 and 69, D6 75 and 75, D7 65 and
63, D8 76 and 77, D9 82 and 76, D10 79 and 76, D11 86 and 78 (and the failure), D12 79 and 77. Every written edit
landed on the run it was made on.

**D11's failure.** The run the edit wrote is a `<span>` in the first track of the marquee on D11's cover slide (its
closing slide has another), a CSS animation that the deck does not stop for reduced motion: the same kind as D5's
ticker. Probed on its own (the walk after its round did not show the node), the node held exactly the new text and its
sentinel, laid out, but the track had carried it out of the viewport at every stop of its slide. Every check of the
bytes passed. No D11 edit was probed on its own in the second round's run; the rule's notes shift D11's draws from
edit 825 on, and this one, in round 3, was. It is the limit the lead accepted for D5's ticker (Open issues), counted
here as a failure, not as a pass. Run alone (`node scripts/fuzz.mjs --decks D11 --edits 91`, the same seed), D11 gives
the same 91 outcomes, this failure included (the same run, written exactly, out of view at every stop), in 126 s.

### The final runs

Linux, Electron 44.7.2, 2026-10-21, on the tree with every fix of the review and of the repair in it (commit 9a735aa,
the repair's last changes, and the two duplicated-text cases this measurement step added to the concurrency gate).
`rm -rf packages/app/dist packages/cli/dist`, then `npm run build:reader-only` and `npm run build`, then every suite
and harness in turn, the two fuzz runs side by side and the Playwright suites alone; every number on this page comes
from these runs unless a section says it describes an earlier one. Their logs and reports are in
`test-results/p2-measure/` (not committed; `tree.txt` there fingerprints the tree they ran on, Markdown files aside,
since these pages were written while they ran). The repair's runs (`test-results/p2-repair/`) and the review's
(`test-results/p2-final/`) are kept for comparison.

| Suite | Result (`test-results/p2-measure/`) |
|---|---|
| `npm run build:reader-only`, then `npm run build` | both exit 0: no `dist/editor.cjs` after the first, `dist/editor.cjs` after the second (`build-reader-only.log`, `build.log`) |
| `npx tsc -p tsconfig.json --noEmit` | 0 errors (`tsc.log`); `tsconfig.reader.json` too (`tsc-reader.log`) |
| `npx vitest run` (`npm test`) | 110 files, 2,042 tests, all pass, 74 s (`vitest.log`); the Node fuzz among them: 1,200 edits over 44 documents, 917 written (76.4%), 235 notes by rule (19.6%), 48 no-ops, **0 failures** |
| `vitest -c test/fuzz/vitest.config.mts` and `-c test/parity/vitest.config.mts` | 55 and 37 tests pass, 4 files each (`vitest-fuzz.log`, `vitest-parity.log`) |
| `npm run test:e2e` | 290 tests: 289 pass and 1 is the expected failure (the note-card ordering limit, SECURITY.md), none skipped, none flaky, 15.9 min (2 workers; `e2e-1`) |
| `npm run test:security` | 65 tests: 59 pass and 6 are the expected failures (the two DNS channels, and the two drop limits in both trust states; SECURITY.md), none unexpected, 5.0 min (`security-1`). The flood rate-limit test passed this time (Open issues) |
| typed-edit and concurrency specs, `--repeat-each 3` | 30 of 30, 45 s (`gates-x3`) |
| `npx playwright test -c test/parity/playwright.config.ts` | 9 of 9, 8.9 min (`parity-pw.log`) |
| `npm run package:smoke` | 17 of 17 PASS, 0 FAIL (`package-smoke.log`) |
| `node packages/cli/dist/blueline.cjs check --auto` | 6 of 6 PASS (`check-auto.log`) |
| `node scripts/fuzz.mjs --committed` (the gate) | exit 0: 1,000 edits, 903 written, 72 notes by rule, 25 no-ops, **0 failures**, 903 probed (0 on their own, 0 unprobed); the same 1,000 records as the integration's, the review's and the repair's runs; 18 min (`fuzz.json`) |
| `node scripts/fuzz.mjs --local` (the extra run) | **exit 1**: 1,000 edits, 917 written and passed, 55 notes by rule, 26 no-ops, **2 failures**: two D5 edits written exactly whose node, holding the new text and the sentinel, D5's CSS marquee kept out of view at every stop (Results: Josh's decks); 919 probed (3 on their own: 1 passed, the 2 failures), 0 unprobed; 28 min (`fuzz-local.json`) |
| `node scripts/fuzz.mjs --negative-control` (5 decks, 150 edits) | 26 of 26 planted changes caught, nothing else failed, 91 s (`fuzz-negative.json`) |
| `node scripts/fuzz-selftest.mjs` | all 14 cases behaved as expected: the gate failed each of the 11 cases it must fail and passed the 3 it must pass, 60 s (`fuzz-selftest.log`) |
| `npm run test:reader-only` | **PASSED** in 951 s, alone (`reader-only.log`; Reader-only gate) |
| `blueline map --report --json` | the 19 committed fixtures equal their baselines (423 of 423 exact nodes pass the probe); Josh's 12 decks hold against theirs, 11 equal and D5's ticker slides apart (Coverage, below) |

### Coverage (`blueline map --report --json`, on copies)

- **Committed fixtures** (the 19 baselines of `fixtures/expected/`, decks copied with their sibling scripts;
  `test-results/p2-measure/map-committed.json`): all 19 equal their baselines run for run (slide, text, strategy,
  confidence, offsets, probe), 423 of 423 exact nodes pass the mutation probe, every original untouched; 1.3 min.
- **Josh's 12 decks, `--reduced-motion`** (copies, against `fixtures/local/expected/<deck>.reduced-motion.json`;
  `map-local.json`, labels only): every slide reached; 6,050 of 6,670 visible text nodes exact and probed (90.7%;
  94.5% of the wording), against 6,058 of 6,678 in the baselines. Eleven decks equal their baselines run for run, D3
  with its one known probe failure (Phase 0 F30: a label the deck also keeps in a hidden element on another slide).
  D5 differs only on its first and last slides, the ticker slides, as in Phase 1 (424 visible nodes here, 432 in the
  baseline, 430 in the repair's run and 427 in the review's final run); every one of its 407 exact nodes passed the
  probe, and every other slide equals the baseline run for run. 37 min, alone. Every original was left untouched and
  every probe copy removed.

### Open issues

Known after the final runs; none is a write to the wrong place or a lost change.

- **Deck IPC limits: closed by the second hardening round.** The first round's buckets per document, view kind and
  channel (note operations 50 a second with a burst of 100, every other deck channel 1,000 a second with a burst of
  1,000) let a view's 20 deck channels together pass many times 9.1's example of 1,000 messages a second per sender.
  Every deck message now also takes a token from one budget per document and view kind for all its channels together,
  checked first: 1,000 a second with a burst of 1,000 (`ipc-guard.ts` `DECK_SENDER_RATE`; SECURITY.md, Rate limits;
  docs/spec-amendments/README.md, 9.1). The busiest second of what a person does, measured in the app
  (`ipc-legit-rates.spec.ts`), is 61 messages (a wheel pan, one a frame); drawing, typing in a card or an edit field
  and stepping through slides 30 ms apart take 5 or 6. Only the note operations' pushes to the deck and the shell are
  coalesced: other deck handlers still push the shell's state once per accepted message, so a flood of slide reports
  costs main one push per message, now at most 1,000 a second after a burst of 1,000 for all channels together.
  `forged-ipc.spec.ts`, whose flood now sends 15,000 messages on four channels and requires at most 1,000 plus 1,000
  a second of the time main took to be admitted, passed 50 of 50 tests run 10 times, alone and beside 4 CPU-bound
  processes (363 to 499 messages admitted, by 0.46 to 0.67 s; 109 to 114 of the 5,000 note creates).
- **Two E2E tests that failed by chance in the hardening round's final runs: both explained by the second round.**
  `views-reload-twice.spec.ts` "two saves 300, 400 and 600 ms apart …" saw one reload for two saves 400 ms apart.
  That is correct: when main is about 200 ms late (a loaded machine), the watcher's settled reads (9.2 Watcher step 2)
  see only the second save, and one reload shows it with the saved view state; no save is missed (the watcher reads
  again whenever its two reads disagree or the path changed after them, and polls every second). The test now waits
  for the outcome (the page shows the version on disk, with its slide) and allows one to two reloads for two saves; a
  new test holds main's event loop across both saves and requires exactly one reload, on the second version, on the
  slide. Running the file 30 times beside 4 CPU-bound processes then found a real loss, in 2 of 144 tests: the page
  ended on slide 1 of 6 instead of 5. A reload that starts while the reload before it still restores sends the same
  view state again, and main decided whether to replay an index deck's slide from the last slide report, which was
  the replaced page's first one: generic-index.html first reports a scroll page (its slides are still fading in),
  and the late-deck test's page a single one. Main now takes the deck's kind from the page the state was taken from
  (`window.ts` `capturedNav`), and starts the replay at once when the new page already reported itself. The new
  late-deck test (an index deck that shows its slides 1.5 s after it loads) failed 10 of 10 runs before the fix and
  passes after it. `views-open.spec.ts` "File › Open Recent …" read `recent.json` once, while the coalesced atomic
  write of the second open had not landed; the menu never depended on the file (`recent.ts` rebuilds it from the list
  in memory before scheduling the write; a unit test holds the write and checks the menu), and the test now polls the
  file. After the fixes, both files 30 times beside 4 CPU-bound processes (2 workers): 300 of 300 tests pass, 180 of
  `views-reload-twice.spec.ts` and 120 of `views-open.spec.ts`, 27 min; once two saves 400 ms apart were shown by one
  reload, on the slide.
- **A PDF whose document closes between two stages of its job** (after one stage ends, before the next asks for a
  renderer) ends as `RenderCancelled` in a unit test only: in the stressed E2E runs every close landed on a busy view.
- **Real use is pending** (the fourth criterion): Phase 2 is ready for it, and it needs the Mac build (README,
  Status, names the commit to build). The checklist is below and in the README.
- **The caret can land in text Blueline cannot place.** A label whose element also holds an unmapped glyph (D3): End
  puts the caret after the glyph, and what is typed there lands outside every run, so it becomes a verbatim note by
  rule (the toast says so). Correct by rule, surprising in use.
- **Stale requests and notes.** A request on an older version is carried exactly through Blueline's own writes;
  across another program's change it is written only by the uniqueness rule (F-1, "The uniqueness rule" above): its
  text in one place before, after and in between, the run mapped exactly onto that place, and the text on both sides
  confirming it. It becomes a verbatim note when its text is in two places (a shadow value, such as the `<title>` or
  an attribute, counts), a change overlaps its run or comes within its anchors (at least 128 characters on each side),
  its version is no longer known, or the diff runs past its time limit. So a page left open while another program
  changes the deck gives a note for any repeated text, however far the change: worth watching in real use (the fuzz on
  Josh's decks: 36 `ambiguous` notes in 1,000 edits, where the second round's run had 1; "The uniqueness rule's final
  runs"). The numbers before the hardening rounds (Josh's decks: 105 stale-version requests, 98 written) are in
  Results, below; the rounds' and F-1's are in their sections above.
- **`<pre>`, `<listing>` and `<textarea>` with a character reference right after the dropped leading newline**:
  parse5 8 places the text node late, so the mapper leaves the run unaligned (not editable) and the queue refuses to
  create that state (core-edit). A mapper fix would make such runs editable. Likewise parse5 starts the text node at
  the dropped newline itself when white space follows it, and after it otherwise, so an edit that changes whether the
  text after that newline starts with white space is refused by rule (`escape`; the third F-1 round, where the Node
  fuzz reached it once its random stream shifted: verify had caught it, so nothing was written).
- **Left by the third F-1 round, for the lead.** (1) Shadow values count as copies for an HTML run too, where the
  matcher applies them to a lone literal only: a heading equal to the `<title>`, a caption equal to an image's `alt`,
  button text equal to its `aria-label` is a note after any change by another program (61 of 673 editable runs on the
  committed decks, 420 of 8,326 on D1–D12; F-1's "treating shadow values as copies, as the matcher does" reads either
  way). (2) A literal equal to a JSON key: keys are a matcher ambiguity reason, not shadow values, so an equal pick of
  it is written after a far change, into the literal the author picked. (3) Before F-1 and unchanged: when the atomic
  write rejects after its rename and the read-back read itself fails, the commit is an `internal` note although the
  file holds the edit (no record joins the undo stack). None writes into another copy.
- **The probe's reach on a CSS marquee: a known limit, accepted by the lead.** An edit to an item of a deck's CSS
  marquee, probed on its own (the walk after its round did not show its node), holds exactly the new text and its
  sentinel but can be out of view at every stop, and then fails (Limits, below). The lead accepted this for D5's
  ticker as a documented known limit of the probe's reach (2026-10-22): such a failure is reported as that limit,
  never counted as a pass, and it is not a wrong write (every check of the bytes passed). The run on Josh's decks
  therefore exits 1 whenever it probes such an item on its own and the track is elsewhere at every stop: the
  measurement step's final run on 2 D5 edits (348 and 368), both hardening rounds' final runs on one D5 edit each
  (336, 360); the repair's and the review's runs passed by chance. The uniqueness rule's final run failed on one
  **D11** edit (869) instead, and its one D5 edit probed on its own passed: D11's cover and closing slides carry a
  marquee of the same kind (a CSS animation that moves the track and that the deck does not stop for reduced motion),
  which none of the earlier runs kept in `test-results/` had probed on its own. It is the same limit on another deck,
  and the lead's acceptance covers it: any CSS marquee or ticker the deck keeps moving under reduced motion, on any
  deck (D5's ticker, D11's cover and closing marquees), is the probe's reach limit, reported as such, never as a pass.
- **Linux tested no marker copy**: the atomic writer copies no extended attributes on Linux, so neither the fuzz nor
  the E2E suite exercised the marker copy of a write, and history snapshots on Linux carry no marker. Recheck on the
  Mac (below).
- **Text Edit still cannot reach.** On copies of D1–D12 (slides 1–3), 56 of 64 exact nodes that sit under an empty
  element or in a `pointer-events: none` layer open a field (D1 22 of 24, D2 4 of 4, D3 15 of 19, D6 13 of 14, D9 1 of
  2, D12 1 of 1; the other six decks have none there; a hover, a real press and Escape on each, at most 12 per slide;
  `test-results/p2-measure/reach-local.log`, counts only; the same counts as the repair's run); on D1, D3 and D6, 1
  of 57 opened before the review. The 8
  left get no outline (most of them `pointer-events: none` labels the overlay probably does not hold as exact, and one
  D9 node under an element that paints; not investigated further), and a press on one of them, a 4-character node
  under a D3 nav button, still reaches the page. A layer the page made `pointer-events: none` is seen through even
  where it paints, as hit testing sees through it: text under an opaque one is reached, as text right under such a
  layer was before the review. A node a script rewrote (`touched`) offers no candidate and is not editable unless
  the matcher places it exactly, as a script literal (`edit-fix-overlay.spec.ts`); that is the rule for D10's chrome
  title, whose only candidate was text the deck's script replaces at load, but D10 was not driven by hand again.
- **Small windows the review left.** Cmd+Z pressed before the commit's message reaches main undoes the previous edit
  (the commit's undo slot is reserved only when main accepts it); once main has it, Cmd+Z is for that commit, and does
  nothing when it becomes a note (E-3 as amended in the hardening round, accepted by the lead). While a press waits
  for the answer to the commit it triggered (at most the commit timeout), the keys typed are held and typed into the
  field when it opens; from a key that cannot be replayed (a shortcut, an arrow, a composition) on, the rest are
  dropped, and a toast says to check the text.
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
  deck reports no field open, the view leaves Edit, or 10 minutes pass without trusted input in that view. Such a
  field, idle past that limit or not, also gets the one commit main asks for when the user leaves Edit, closes the
  window, quits or clicks in the shell (taken for 5 s after the request): one commit per request, in Edit, to one
  run, recorded and undoable (SECURITY.md, Known limits added by Phase 2). Before the review a field never expired
  (finding 4).

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
  run's other renders show, and otherwise the edit fails (`[render]`). A deck that sorts what it renders moves an
  edited label to another node of the same list (its locator differs in one `:nth-of-type` index): when the author's
  place then reads another run's current text exactly, not its own old text, the node of that list that reads the new
  text exactly is the author's; a render in another list never stands in for it. The run's other renders (its exact
  nodes, and the nodes where the walk before the edits saw it that now read the new text) are judged with it. They go
  through `probe.ts probeTargets`, batched as `map` batches (24 runs per load, each run alone on doubt): a sentinel is
  appended to the run through the same queue, the copy is reloaded and each stop replayed, and every node must read
  **exactly** its new text plus its sentinel (`NodeCheck.expectData`), the sentinel must be in no other node except
  reported renders of the run, the page must log no console error the version before the edits did not log, and keep
  that version's slide count; the sentinels are undone and the copy must be byte-identical to the round's edits. A
  picked run is judged on everything but its own node (whether the node renders the run the author picked is the
  author's choice). An edit whose node the walk does not show is probed on its own: a load with its sentinel alone,
  every stop of the walk replayed and settled as the walk settles; it fails when no stop shows it (`[probe] the edit
  shows nowhere`). For every round that wrote anything, the walk of the new version must log no console error the walk
  before did not and keep its slide count, whether or not a node is left to probe. "Not probed" now means only that
  the walk after the edits failed, and `scripts/fuzz.mjs` exits 1 on it as on a failure. (Before the Phase 2 review
  the gate judged a run on its other renders, so a write that showed elsewhere passed, and an edit no node showed was
  counted as not probed and skipped the console and slide checks: findings 25 and 26.)
- **Report.** Seed, corpus labels with sha256, edits, the shares written, noted and no-op, notes by code and by
  reason, the SPEC inputs typed and written, per-deck figures and timings, every edit's kind, and each failure with a
  reproduction: the seed (the same seed and corpus replay the run), the request, and the probe copy's bytes before the
  edit, so the write alone can be replayed. For Josh's decks a failure carries lengths, never text.

### Results: committed fixtures

`node scripts/fuzz.mjs --seed 1592598566 --edits 1000 --committed` (batch 24) on the final tree, after the Phase 2
review and the repair (`test-results/p2-measure/fuzz.json`, `fuzz.log`), 18 min wall time (1,083 s), beside the run
on Josh's decks. Its report agrees edit for edit with the gate item's, the integration's, the review's and the
repair's runs: the same 1,000 records (deck, round, kind, reason, strategy, pick, stale, merged, external, probe
verdict; against the repair's run every field of every record), the same totals. What the Phase 2 review changed
here is how each written edit is judged (Method), and every one passed that too.

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
| Time | walks 782 s, edits 15 s, probe 283 s |

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
and the repair (`test-results/p2-measure/fuzz-local.json`, `fuzz-local.log`; labels only), 28 min wall time (1,655 s),
beside the committed run for its first 18 minutes. It exited 1: two edits on D5 failed the probe, both items of D5's
CSS marquee (below). Neither is a wrong write.

| | |
|---|---|
| Edits | 1,000 over D1–D12 (71 to 94 each) |
| Written | 919 written edits (html-text 879, script-literal 40; no deck has a `json-literal` run): 917 (91.7%) passed every check, 2 failed the probe |
| Notes by rule | 55 (5.5%): escape 36 (20 characters the HTML parser reports as errors, 16 where no raw splice of the HTML text decodes to the new text), markup 13, commitField 4 (emptied 3, across-runs 1), placeholder 2 |
| No-ops | 26 (2.6%) |
| Failures | **2**, D5 edits 348 and 368: "[probe] the edit shows nowhere … it is in the page with the new text and the sentinel, laid out but outside the viewport at every stop that shows its slide" |
| Mutation probe | 919 edited runs in 50 probe loads: on every other written edit the node the author typed in read its new text; 3 D5 edits were probed on their own (their node was not in the round's walk): 1 passed, 2 failed as above; 0 unprobed |
| Picked candidates | 74 (64 written: 39 `equal`, 25 `substring`) |
| Stale and concurrent | 105 stale-version requests (98 written on the right run, placed by position with every copy confirmed; 7 notes by rule, all escape; none `ambiguous` or `stale`); 30 external writes just before an edit (28 written, 2 notes); 35 inside the atomic write (33 landed before the re-hash and the edit was written after the requeue; 2 edits were notes by rule before the write); 155 merged writes; the external change survived every one |
| Undo and redo | 247, byte-exact both ways (one of them on failed edit 348) |
| Walks | 59 (47 rounds); every deck walked as a generic engine with key replay |
| Time | walks 756 s, edits 249 s (the queue maps decks of up to 1.2 MB on every write), probe 642 s |

The SPEC inputs, typed / written: `&` 110/99, `<` 153/136, `>` 117/106, `"` 21/19, `'` 19/16, `\` 90/83,
`` ` `` 17/14, `${` 44/39, `}` 46/42, `</script>` 24/22, `<!--` 27/25, emoji 29/27, tab 21/20, NBSP 109/0, `\r\n` 183/0.

**The two failures** are the method's known limit on D5 (Limits; Open issues), not a wrong write: each edit passed
every check of the oracle (the exact splice in its run, the re-map, no new parse error; edit 348 also its undo and
redo byte for byte), and on the probe's load its node held exactly the new text and the sentinel, laid out, but D5's
ticker (a CSS marquee on the cover and closing slides) had carried it out of the viewport at every stop. The rule
since the review (E-12) is that an edit no stop shows fails; whether to pass such a node on its text and sentinel, or
pause animations for the probe's loads, was then the lead's decision (since accepted as a known limit of the probe's
reach, reported as such and not as a pass: Open issues). The repair's run of the same seed probed no
D5 edit on its own and the review's final run one (it passed), so those runs passed by chance where this one did
not.

Against the repair's run (`test-results/p2-repair/fuzz-local.json`: 917 written, 56 notes, 27 no-ops, 0 failures)
and the review's final run before the repair (`test-results/p2-final/fuzz-local.json`: 920 written, 54 notes, 26
no-ops, 0 failures), the 11 decks other than D5 repeat their records exactly: the repair's stricter placement turned
none of their stale-version requests into a note (each was written on its run as before). D5 differs from its second
edit on (from the review's run, its third): its walks differ between runs (its ticker), and so do its draws. Against
the integration's run of the same seed on the same 12 files (`test-results/fuzz/fuzz-local.json`: 894 written, 77
notes, 29 no-ops, 0 failures, 2 unprobed), 756 of the 1,000 records were the same in the review's final run. D4, D8
and D9 repeat it record for record. In the eight decks D1, D2, D3, D6, D7, D10, D11 and D12 the records are the same
up to the first stale-version request that the old rule refused as `ambiguous` (its text in several places that 32
characters of context did not tell apart); the queue now places it by position: 7 of the 8 were written on their
run (merged, probe passed), D1's became an escape note by rule, and the deck's later draws differ from there.

Josh's decks are where the picker matters (74 picks against 4 on the committed fixtures) and where a stale request
meets repeated text. None was written in the wrong place: every written edit landed on the run it was made on, and
wherever a stop showed the node the author typed in, it read the new text.

### The negative control

A gate that cannot fail proves nothing. `--negative-control` (never part of a gate run) changes the run once more
after every fifth written edit, behind the oracle's back (its text plus "X"), and passes only if the mutation probe
catches every such change. On 5 committed decks (entities, js-templates, json-data, single, inline-markup; 150 edits;
`test-results/p2-measure/fuzz-negative.json`, 91 s) the probe caught **26 of 26** planted changes, each because its
node did not read the edited text, and nothing else failed. The self-test (`node scripts/fuzz-selftest.mjs`,
`test/fuzz/selftest/README.md`) runs the gate in 11 cases on 7 synthetic decks that it must fail, each with a seed
the gate before the fix it tests passed or failed for another reason only: a write that shows in another node than
the author's (`[render]`, also when the deck lists the label again, cut short, in another list), a round whose edits
break the page's script (a new console error, nothing left to probe), and edits the page shows nowhere. It must pass
3: a deck that sorts its labels (an edited label moves to another node and shows there) and a control deck. In the
final run all 14 cases behaved as expected, 60 s (`test-results/p2-measure/fuzz-selftest.log`). The oracle's own
unit tests (`test/fuzz/unit/fuzz-core.test.ts`) show each check failing on a broken outcome: a reference left
literal, a write to another run, a parse error, a record that does not describe the file, a wrong `merged`, a lost
external change, a note that is not by rule or not byte-identical.

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
1592598566, inside `npx vitest run`, `test-results/p2-measure/vitest.log`): 1,200 edits over 44 documents, 917 written
(76.4%), 235 notes by rule (19.6%), 48 no-ops (4.0%), 61 picked candidates (52 written), 118 stale-version edits (83
written), 152 merged writes, 106 conflicting writes, 188 undos in a changed file (case 2), **0 failures**; among the
notes 17 `stale` and 9 `ambiguous` (6 where the text moved, 3 where the deck has another copy with the same
surroundings), all by rule. Its clean-up oracle is the shared one above, computed without
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
  (61 picks, 52 written); Josh's decks offer more (74 picks, 64 written: 39 `equal`, 25 `substring`). These are the
  final runs' figures; the page quoted an earlier run's here before the Phase 2 review (finding 27).
- A node that moves out of view. Since the review an edit whose node the walk after its round does not show is probed
  on its own and fails when no stop shows it. A node that holds exactly the new text and its sentinel but sits outside
  the viewport at every stop of its slide, such as an item of D5's CSS marquee (cover and closing slides), therefore
  fails or passes by where the ticker is at each stop: in runs of D5 alone with other seeds while the review's fixes
  were made, such items failed in some runs and not in others. The review's final run probed one D5 edit on its own
  (it passed) and the repair's none; the final run probed three and two of them failed this way, so the run on
  Josh's decks exits 1 (Results: Josh's decks). The lead has since accepted this as a known limit of the probe's
  reach (Open issues): such a failure is reported as that limit, not as a pass. D11's cover and closing slides carry a
  marquee of the same kind, which the uniqueness rule's final run met (edit 869).
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
  element); duplicated text whose neighbour changes 50 ms before (two slides of `fixtures/edit/dup-slides.html` hold the
  same kicker, heading and subtitle; another program rewrites the subtitle after the first slide's heading, or the
  kicker before the second's, while the author edits that heading, so the edit's 32 characters of context now match
  only the other copy: the file must be exactly the edit on the copy the author typed in, or exactly the external
  write with a verbatim note, and the page must then show the same; added by the measurement step for E-1); a change
  while the field stays open 1.5 s (the reload waits for the field, then both changes are on disk and on the page);
  and a write landing inside the atomic write before the re-hash (main's one-shot test hook,
  `__blTest.onceBeforeRehash(docId, base64)`).
- `test/e2e/edit-gate-reader.spec.ts` (no `@edit`: it runs in both builds): Cmd/Ctrl+3 enters Edit in a full build;
  in a reader-only build it is refused with "Edit is not available", the deck stays in Read, a click opens no field and
  the file is never written.

    npx playwright test -c test/e2e/playwright.config.ts test/e2e/edit-gate-typed.spec.ts test/e2e/edit-gate-concurrency.spec.ts test/e2e/edit-gate-reader.spec.ts

**Results: 11 of 11 pass** in the final E2E run, and 30 of 30 when the typed and concurrency specs run three times
over (`--repeat-each 3`, 45 s; `test-results/p2-measure/gates-x3.results.json`). The element inserted before the
heading 50 ms before the commit landed on the heading in all 4 of those runs (the test records its outcome): the
request carries the version and run the field opened on (P2-5), and since the Phase 2 review the queue places the run
by position, through a diff of that version to the bytes on disk (9.2 Write protocol step 2 as amended), never by the
shifted stamp and never by its text alone; the heading's text is in one place, so no other copy needs telling apart.
In both duplicated-text cases the edit landed on the copy the author typed in, in all 4 runs each: the queue placed
it by position, and the text the diff left unchanged around the two copies (their slides' ids and bodies) still
told them apart. The same two tests, run
against a build of commit 91b58dc (before the review), failed 3 runs of 3 each: the queue chose the copy whose 32
characters of context still matched, and wrote the edit into the other slide.
The hook for the write inside the atomic write is main-wiring's (`__blTest.onceBeforeRehash`,
`BlDocument.armTestWriteInside`: a rename-replace in `prepareTemp`). One thing found while writing them: in a
`contenteditable` heading that wraps, End moves the caret only to the end of the visual line, so the tests click at
the end of the text instead (in view pixels: the page's CSS pixels times the deck view's zoom, which Fit sets on a
deck).

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

`npm run test:reader-only` on the final tree, after the Phase 2 review and the repair
(`test-results/p2-measure/reader-only.log`), alone on the machine: **PASSED in 951 s** (16 min).

| Step | Result |
|---|---|
| copy, `node_modules` links, isolation check | pass (under 1 s) |
| build (`--reader-only`, the copy's own `dist`) | pass (under 1 s) |
| bundles | pass: no `editor.cjs`, no editor or magic-string source in any source map, no editor function in any bundle |
| tsc (`tsconfig.reader.json`) | pass (2 s) |
| vitest (`vitest.reader.config.ts`) | pass: 96 files, 1,883 tests (24 s) |
| map (the copy's CLI on `single.html`) | pass (1 s) |
| E2E, `--grep-invert @edit` | pass: 168 tests, every one as expected (the note-card ordering limit among them, an expected failure), 12.0 min |
| security, `--grep-invert @edit` | pass: 57 tests, every one as expected (the 6 known limits among them, expected failures), 3.3 min |
| verdict | `PASSED` |

The review's final runs (`test-results/p2-final/reader-only-{1,2}.log`) failed this gate at vitest only, on
`test/unit/preload/env.test.ts`, whose expected list of input types predated the drag-move fix's `deleteByDrag`; that
list now holds it, and the test passes in both builds. Run 1 of those, beside both fuzz runs, also failed one PDF test
and the security flood test under load; both passed in run 2, in the repair's run and here. The hardening round
fixed the PDF test's race and the flood test (The hardening round).

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
- `test/e2e/edit-gate-typed.spec.ts`, `edit-gate-concurrency.spec.ts` (its duplicated-text cases use
  `fixtures/edit/dup-slides.html`), `edit-gate-reader.spec.ts`.
- The Phase 2 review's regression tests: `test/unit/editor/queue-stale-position.test.ts`, `cleanup-write.test.ts`;
  `test/unit/core/edit-cleanup-two-changes.test.ts`;
  `test/unit/app/{edit-lane-pins,edit-commit-rules,edit-undo-inflight,edit-known-content,edit-history-requeue,documents-knownhash}.edit.test.ts`;
  `test/fuzz/unit/{probe-written,cleanup-oracle}.test.ts`;
  `test/e2e/edit-fix-{stale,typed-text,undo-toast,locks,overlay}.spec.ts`, `edit-cleanup-two-changes.spec.ts`,
  `edit-drag-move.spec.ts`; `test/security/edit-expiry.spec.ts`; and their decks in `fixtures/edit/`
  (fixtures/edit/README.md, "Phase 2 review fixes").
- The repair's: `test/unit/editor/queue-stale-copies.test.ts` (and the placement cases of `write-queue.test.ts`),
  `test/unit/app/documents-knownhash-aba.edit.test.ts`, the pending-key and Shift+Space cases of
  `test/unit/preload/key-router.test.ts`, the waited-press case of `test/unit/app/edit-session.test.ts`
  (TrustedInput), the `sameList` and moved-node cases of `test/fuzz/unit/probe-written.test.ts`; the new cases of
  `test/e2e/edit-fix-{stale,typed-text,overlay,undo-toast,locks}.spec.ts` and of `test/security/edit-expiry.spec.ts`
  (V-close); `test/helpers/xclick.{c,ts}` (real XTEST clicks); the self-test cases `sorted-*` and `sortrunc-*`; their
  decks `fixtures/edit/{scrim,covers,spell-block}.html` and `test/fuzz/selftest/decks/{sorted,sortrunc}.html`.
- The hardening round's: `packages/editor/src/anchors.ts`; `test/unit/editor/queue-stale-anchors.test.ts`,
  `test/unit/app/edit-trust-write.edit.test.ts`, the note case of `test/unit/app/edit-undo-inflight.edit.test.ts`,
  `test/e2e/edit-fix-hardening.spec.ts`; and the tests it changed (`write-queue`, `queue-phase2`, `queue-stale-copies`,
  `queue-stale-position`, `undo` and `fuzz` in `test/unit/editor/`, `edit-history-requeue`, `edit-lane-pins` and
  `edit-lane` in `test/unit/app/`, `test/e2e/edit-fix-stale.spec.ts`); for the two flaky tests, the new cases of
  `test/unit/app/ipc-guard.test.ts` and `render-service.test.ts`, and the tightened `test/security/forged-ipc.spec.ts`
  (flood) and `test/e2e/render-products-pdf.spec.ts` (a PDF running when its document closes).
- The second hardening round's: `packages/editor/src/records.ts` (removed by the uniqueness rule) and the changes to
  `place.ts`, `write-queue.ts` and `undo.ts`; `test/unit/editor/queue-stale-round2.test.ts`, `test/e2e/edit-fix-hardening2.spec.ts`; for the two tests
  that failed by chance and the deck IPC budget (`window.ts` `capturedNav`, `ipc-guard.ts` `DECK_SENDER_RATE`), the
  new cases of `test/e2e/views-reload-twice.spec.ts`, `test/unit/app/recent.test.ts` and `ipc-guard.test.ts`,
  `test/e2e/ipc-legit-rates.spec.ts`, the polling `views-open.spec.ts` and the rewritten flood of
  `test/security/forged-ipc.spec.ts`.
- The uniqueness rule's (F-1): `packages/editor/src/place.ts` (rewritten: `placesOf`, `runsHolding`, `placeStale`),
  `write-queue.ts` (`holderOf`, `undoPlace`; its `carryRange`, `foreignLog`/`foreignSince`/`oneOnTheWay` and hold
  times gave way to the third round's log, below), `undo.ts` (`planUndo` takes only the queue's place), `anchors.ts` (comment), `index.ts` (exports
  `placesOf`, `runsHolding`); `test/unit/editor/queue-unique.test.ts`; and the tests it changed (`write-queue`,
  `queue-phase2`, `queue-stale-anchors`, `queue-stale-copies`, `queue-stale-position`, `queue-stale-round2`, `undo`
  and `fuzz` in `test/unit/editor/`, `edit-lane-pins` in `test/unit/app/`).
- The uniqueness rule's third round: `packages/editor/src/write-queue.ts` (the log: `Seen`, `sawOnDisk`, `sawOwn`,
  `startOf`, `lastMade`, `carryAlong`, `onTheWay`; `endsWhole` by the parser; `know` with `onDisk`), `place.ts`
  (`copiesOf`), `undo.ts` (`planUndo` `byHash`), `plan.ts` (the `<pre>` white-space rule),
  `packages/core/src/capabilities.ts` (`know`'s `onDisk`), `packages/app/src/main/edit-session.ts` (`attach` and
  `takeExternal` tell the queue with `onDisk`, for every version); `test/unit/editor/queue-unique-log.test.ts`,
  `test/unit/app/edit-lane-sightings.edit.test.ts`, and `queue-stale-position.test.ts` (main's call).
