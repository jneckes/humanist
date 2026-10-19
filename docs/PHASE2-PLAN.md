# Phase 2 build contract (Edit)

SPEC.md section 10, Phase 2, is the scope; this page fixes who builds what, the interfaces between the pieces,
and the decisions the lead made before the build, as docs/PHASE1-PLAN.md did for Phase 1. Where this page and
SPEC.md disagree, SPEC.md wins, except for Josh's decisions (docs/spec-amendments/README.md,
docs/PHASE1-PLAN.md) and the decisions below, each of which gets proposed SPEC wording in
docs/spec-amendments/README.md.

## Scope (SPEC 10, Phase 2)

| Area | SPEC | Work item |
|---|---|---|
| The commit path as pure code (clean-up, smart punctuation, run boundaries, picked candidates), locked-span transforms, the edit IPC types, the write queue's new options | 9.2 Committing an edit 3–4, Strategy 2 step 4, Write protocol, Undo; 8 Locked spans | core-edit |
| Edit and verbatim notes, the undo stack, history snapshots and their store, settings defaults (smart punctuation), identity (the name chip's main side) | 6.3, 6.6 (Edit notes, only what Phase 2 needs), 6.8 Identity, 8, 9.2 Undo 1–4, 9.7 | main-stores |
| Edit mode in the deck preload: outlines, the field, input filtering, source case, animation pause, fit guard, the picker, Not editable, the toast's Undo, busy reporting | 6.2, 6.3, 7, 9.1 Preload, 9.2 Matching and Committing an edit 1–5 | overlay |
| Wiring: one queue per file, own-write adoption, absorbed external changes, locked spans on every change, reload rules, undo/redo routing, toasts with actions, the notes list, the history list and Restore, Edit availability, the name chip | 6.0, 6.1, 6.3, 6.6, 9.1, 9.2 Write protocol 6, Watcher, Undo, 9.9 Writes, 10 Phase 2 | main-wiring |
| The exit-gate harnesses: the Chromium fuzz, the concurrency test, the reader-only gate, E2E typed edits; docs/PHASE2-RESULTS.md | 10 Phase 2 exit gate, 11 | gate |

## Decisions made before the build

- **P2-1 Verify before the rename.** The queue verifies the exact bytes it is about to rename in (parse errors,
  the run holds `afterText`, the Strategy 2 checks) and never renames bytes that fail; after the rename it reads
  the file back and checks its hash. This is stronger than 9.2 step 5's "re-parse the new file … restore the
  previous bytes", because a bad file never lands; the restore path stays for a read-back mismatch. Wording
  proposed in spec-amendments.
- **P2-2 Own writes are adopted, not re-read.** Before the rename main records the expected hash, so the watcher
  ignores the write even if the rename's fsync is slow; after it, `BlDocument.adoptOwnWrite(bytes, map)` swaps
  content, map, served copy, version and `knownHash` without another `buildMap`. The served copy of every later
  load is the written file. `knownHash` and the document's version never go back to an older version.
- **P2-3 One lane per file.** One write queue per realpath (a registry in main, shared by every window of the
  file and surviving a D-1 reopen), and one serial lane per document through which the watcher's external
  changes and the queue's own writes both pass, so their order is total. The queue is created and primed with
  the version the page holds at open and after every external change (`WriteQueue.know`), so the 32-character
  context rule works for stale edits.
- **P2-4 Absorbed external changes.** When the queue writes on top of a version other than the one main last
  took (`WriteOutcome.merged`, or `next.basedOn !== doc.version`), main first processes the external change as
  the watcher would (locked spans transformed from the last known content to the bytes the queue read, trust
  decided again per D-1), then adopts the own write, then reloads the page under the reload rules. If the trust
  decision changed, the own write still stands (it was allowed when it was made) and the window reopens per D-1.
- **P2-5 Stale pages.** A field records `{version, runId}` when it opens and its commit carries them. When a new
  map arrives for a version the page does not show (an external change waiting to reload), the open field may
  commit (the queue resolves it by `beforeText` and context), but no new field opens and outlines are off until
  the page reloads; the status bar says "Deck changed · reloads when you finish".
- **P2-6 Matching in Edit is the map's matching.** The deck preload runs a `ScriptTouchTracker` from preload
  start in deck mode, sets `tracked`, `touched` and `stampedAncestor` exactly as the render walk does, and
  exempts the overlay's own changes (`ownChanges(fn)`). Edit renders with reduced motion (Josh's decision 1). The
  overlay matches only against the map whose version is the page's (`DeckInit.pageVersion`, advanced by its own
  html-text writes), and only once the map is complete (D-9).
- **P2-7 Commits need real input.** Main accepts an edit commit only from the deck view's main frame, in Edit,
  with editing allowed and `capabilities.edit` on at that moment, and only when main itself saw trusted input in
  that view since the field opened (a mouse down that opened it, and key, IME or paste input after;
  `before-input-event` / `input-event`). The field has an input gate like the card's: its text is accepted only
  when a trusted `beforeinput` preceded the change, otherwise it is restored; capture listeners from preload start
  keep page listeners from seeing the field's input, paste and selection (as for cards, D-e). Undo records never
  come from the deck: the deck names a write token, main holds the records.
- **P2-8 The picker.** Main builds the candidates from the DeckMap of the field's version: ±40 characters of
  context, the line, and a key warning with its line (9.2 Strategy 2 step 3). Candidates whose reason is `split`
  or `short` are not offered (22 of 22 such matches were wrong-place writes on Josh's decks, F29): the node is
  shown as not editable. A picked equal run is written as is; a substring or whitespace/NFC-normalized
  candidate goes through `liftToRun`; anything that cannot be lifted becomes a verbatim note.
- **P2-9 Undo inside the field.** `historyUndo` and `historyRedo` are allowed only while the field has
  accepted steps of its own (a per-field counter), so native undo never reaches an earlier, already written
  edit; otherwise they are blocked. Composition input (`insertCompositionText`, not cancelable) is allowed and
  confined: the commit diff decides.
- **P2-10 App undo and redo.** Outside a text field Cmd+Z and Cmd+Shift+Z go to main's per-document undo stack of
  own writes (entries hold the original `WriteRecord`, the run, the decoded before and after texts, the note id).
  Redo always uses the original record (`swapRecord`). After an html-text undo or redo main tells the page the
  text to show (`{stamp, textIndex, text}`) or reloads it; literal writes reload once the field is closed. Case
  3 shows "Can't undo in place: the deck changed since this edit" with **Make a note**, which adds a verbatim
  note from the stored texts. Undoing an edit deletes its edit note (6.6) and tombstones the id; redo makes a new
  note. The stack lives in memory per document and is dropped on a D-1 reopen (the toast's Undo then fails
  cleanly).
- **P2-11 History.** Before every write of the deck (edit, undo, redo, restore) the bytes being replaced are
  snapshotted in the queue's `beforeWrite` hook (the probe passes none, so `blueline map` writes no history):
  `<userData>/files/<fileKey>/history/`, newest 100, deduplicated by sha256, files 0600, carrying the
  document's marker when it is Protected (9.9). The history list shows each snapshot's time and cause; "Restore
  deck to <time>" shows the diff and the number of later direct edits and external changes it discards, asks for
  confirmation, and writes through `WriteQueue.restore` (serialized with edits, conflict-checked).
- **P2-12 Locked spans.** Each edit note locks its span. External changes (watched or absorbed) transform every
  span with `diff_main` and `diff_xIndex` (no `diff_cleanupSemantic`; an insertion exactly at a span's start or
  end does not overlap it); own writes shift every span, and a write inside a span updates its text and offsets
  (8, rule 6). Rule 4 (a note sent in the same pass) has no sends before Phase 4. The last known content is
  persisted (its hash in session.json, its bytes in history), so locks transform across restarts and D-1 reopens.
  `diff_main` runs with a time limit and off the critical path of a reload; a timeout only over-reports.
- **P2-13 The notes list.** Until Phase 3 the right panel lists edit and verbatim notes (status, before → after,
  slide, line, a violated lock flag) with **Copy** (main writes the clipboard; the shell has no clipboard
  permission). In Edit, a click on text that is not editable shows "Not editable"; nothing else happens.
- **P2-14 Toasts with actions.** "Saved · deck.html:142" with **Undo**, plus "· also changes N other places"
  when the run feeds several visible nodes; failures say the text was kept as a note. A toast action names a
  token; main checks the token is still the document's latest undoable write.
- **P2-15 Reader-only, for real.** `npm run test:reader-only` builds from a copy of the tree without
  `packages/editor` into its own output folder (never the shared dist), checks the bundles contain no editor
  code, and runs the reader suites: vitest with a reader config (editor tests excluded) and Playwright with the
  `@edit` tests excluded. A reader-only app shows Edit as unavailable.
- **P2-16 The fuzz gate in Chromium.** An Electron harness draws edits from matcher-exact DOM nodes the walk
  found (and from picker candidates), builds each commit with `commitField`, writes it through the real queue and
  the app's DeckIO on a probe copy, then runs the mutation probe on the written text (batched as `map` does,
  singles on doubt), requiring the node to show the new text and nothing else to change. Edits that are notes by
  rule pass only with byte-identical files and exact before/after; refusals carry typed codes and no-ops are
  counted apart. Seeded; the report records the corpus hashes. The gate runs on the committed fixtures; Josh's
  decks are an extra run. The Node fuzz stays.
- **P2-17 Fields on awkward text.** `user-select: none` is lifted on the active element while it is edited and
  restored after; blur commits only while the window has focus; if the page removes or re-renders the field,
  what was typed becomes a verbatim note. SVG `<text>`: verify in Electron 44 whether `contenteditable` works; if
  not, edit through an overlay input placed over the text, or mark SVG text not editable in v1 with proposed
  wording. Clicks that open a field never reach the page (no click-to-advance, no link).

## Ownership

Items edit only their files; a change needed elsewhere goes under contractRequests.

| Item | Owns |
|---|---|
| core-edit | `packages/core/src/{edit-commit,locked-spans,ipc-edit}.ts` (new), `capabilities.ts`, `types.ts` (additions), `dom-walk.ts` (`describeNode`, `ownChanges`), `packages/editor/src/**`, `test/unit/core/{edit-commit,locked-spans,dom-walk-own}.test.ts`, `test/unit/editor/**` |
| main-stores | `packages/app/src/main/{history,undo-stack}.ts` (new), `notes.ts`, `session-store.ts`, `config.ts`, `identity.ts`, `settings-window.ts`, `packages/app/src/shell/settings.*`, `packages/app/src/preload/settings.ts`, `test/unit/app/{history,undo-stack,notes,session-store,config,identity,settings}.test.ts` |
| overlay | `packages/app/src/preload/{edit-controller,edit-input,fit-guard,picker,animation-pause}.ts` (new), `deck-ui.ts`, `deck.ts`, `key-router.ts`, `input-guard.ts`, `overlay.ts`, `styles.ts`, `diagnostics-hooks.ts`, `render-agent.ts` (only to share the pause helper), `view-hooks.ts`, `test/unit/preload/**`, `test/e2e/edit-overlay-*.spec.ts`, fixtures under `fixtures/edit/` |
| main-wiring | `packages/app/src/main/{edit-session}.ts` (new), `window.ts`, `controller.ts`, `actions.ts`, `menu.ts`, `chords.ts`, `documents.ts`, `atomic-write.ts`, `channels.ts`, `ipc-guard.ts`, `view-state.ts`, `watcher.ts`, `index.ts`, `diagnostics.ts`, `motion.ts`, `packages/core/src/{ipc,ipc-views}.ts`, `packages/app/src/shell/{index.html,shell.ts,shell.css}`, `packages/app/src/preload/shell.ts`, `test/helpers/app.ts`, `test/unit/app/**` for these files, `test/e2e/edit-main-*.spec.ts`, `test/security/forged-ipc.spec.ts`, `test/security/edit-*.spec.ts` |
| gate | `test/fuzz/**`, `scripts/fuzz.mjs`, `packages/app/src/main/probe.ts` (generalise for edited text; `blueline map` unchanged), `scripts/reader-only-check.mjs`, `vitest.reader.config.ts`, `tsconfig.reader.json`, `package.json` (scripts only), `test/e2e/edit-gate-*.spec.ts` (typed edit with bytes asserted, external write during an edit, the concurrency gate), `docs/PHASE2-RESULTS.md` |

## Interfaces

```ts
// core/edit-commit.ts (pure; the overlay and the fuzz both call it: "the same path as a typed edit")
interface FieldRun { runId: string; start: number; end: number; value: string }  // offsets in the field's pre-edit text
type CommitResult =
  | { kind: 'edit'; runId: string; beforeText: string; afterText: string }   // whole run before and after
  | { kind: 'verbatim'; before: string; after: string; why: VerbatimWhy }    // the field's text before and after
  | { kind: 'noop' };
function commitField(i: { before: string; after: string; runs: FieldRun[]; caretRunId: string | null },
                     opts: { smartPunctuation: boolean }): CommitResult;      // cleanupCommit → smartPunctuation → changedSpan → one run
function liftToRun(runValue: string, nodeBefore: string, nodeAfter: string,
                   how: 'substring' | 'normalized'): { beforeText: string; afterText: string } | null;

// core/locked-spans.ts (pure; diff-match-patch)
function transformLockedSpans(prev: string, cur: string, spans: LockedSpan[], opts?: { timeoutSec?: number }): LockedSpan[];
function applyOwnWrite(spans: LockedSpan[], w: { start: number; rawBefore: string; rawAfter: string }, opts?: { noteId?: string }): LockedSpan[];
function lockForRun(noteId: string, run: { start: number; end: number; value: string }): LockedSpan;

// core/capabilities.ts (changes)
interface WriteQueueOptions {
  afterWrite?(map: DeckMap, record: WriteRecord, next: { version: string; src: string; bytes: Uint8Array;
    basedOn: string /* hash the queue read in step 2 */; kind: 'edit' | 'undo' | 'redo' | 'restore';
    runId?: string; strategy?: 'html-text' | 'script-literal' | 'json-literal' }): Promise<void> | void;
  beforeWrite?(prev: { version: string; bytes: Uint8Array }, next: { version: string; kind: string }): Promise<void>;
  canWrite?(): boolean;            // checked at the moment of the write (9.1)
  onHookError?(e: unknown): void;
  maxRetries?: number;
}
interface WriteQueue {
  edit(r: EditRequest): Promise<WriteOutcome>;     // WriteOutcome ok gains merged: boolean; refusals gain code: RefusalCode
  undo(w: WriteRecord): Promise<UndoOutcome>; redo(w: WriteRecord): Promise<UndoOutcome>;
  restore(bytes: Uint8Array, expectVersion: string): Promise<{ ok: true; version: string } | { ok: false; why: string }>;
  know(version: string, src: string, map: DeckMap): void;
  currentMap(): Promise<DeckMap>; refresh(): Promise<void>;
}
// EditRequest gains pick?: { kind: 'equal' | 'substring' | 'normalized'; nodeBefore: string; nodeAfter: string }
// RefusalCode: 'noop' | 'not-utf8' | 'structural' | 'stale' | 'ambiguous' | 'placeholder' | 'markup' |
//   'escape' | 'unaligned' | 'conflict' | 'verify' | 'refused' | 'internal' (only 'noop' is not a note)

// core/ipc-edit.ts (channels; validators in main/ipc-guard.ts)
// deck → main
'bl:edit:begin'      { fieldId: number; version: string; runIds: string[] }          // a field opened (main checks trusted input)
'bl:edit:commit'     { fieldId: number; version: string; result: CommitResult; pick?: EditRequest['pick'];
                       target: { css: string; text: string; role: string; stamp: string | null }; slide: number | null;
                       alsoPlaces: number }
'bl:edit:candidates' { fieldId: number; version: string; runIds: string[] }
'bl:edit:undo'       { token: string }                                              // the toast's Undo
'bl:edit:busy'       { edit: boolean; committing: boolean }
// main → deck
'bl:edit:candidates' { fieldId: number; candidates: { runId: string; line: number; context: string; keyWarning?: string }[] }
'bl:edit:result'     { fieldId: number; outcome: 'written' | 'verbatim' | 'noop' | 'refused'; text?: string;
                       line?: number; strategy?: string; reload: boolean; noteId?: string; token?: string; why?: string }
'bl:edit:applied'    { stamp: string; textIndex: number; text: string } | { reload: true }   // after app undo/redo
// DeckInit gains fileName, pageVersion, settings: { smartPunctuation: boolean }

// main/history.ts
class HistoryStore { static forFile(userData: string, fileKey: string, opts): HistoryStore;
  snapshot(bytes: Uint8Array, m: { sha256: string; contentHash: string; cause: 'edit'|'undo'|'redo'|'restore'|'external'; noteId?: string; at: string; marker?: string | null }): Promise<string>;
  list(): HistoryEntry[]; read(id: string): Promise<Uint8Array>; countSince(id: string): { direct: number; external: number } }

// main/undo-stack.ts
interface UndoEntry { token: string; record: WriteRecord; runId: string; strategy: string; beforeText: string; afterText: string; noteId: string; line: number }
class UndoStack { push(e); undo(): UndoEntry | null; redo(): UndoEntry | null; latest(token): UndoEntry | null; clear() }

// main/notes.ts additions
NotesStore.addEdit({ before, after, runId, line, version, target, slide, lock }): Note        // kind edit, status done
NotesStore.addVerbatim({ before, after, target, slide, candidates?, why }): Note               // kind verbatim, status open
NotesStore.removeEdit(id, { tombstone: true }): void
```

## Exit gate (SPEC 10, Phase 2)

- **Fuzz:** 1,000 seeded edits across the committed fixtures in Chromium, zero failures; the report gives the
  share written and the share turned into notes by rule; Josh's decks as an extra run.
- **Concurrency:** an external write 50 ms before a direct edit commits: the edit lands on the right text or
  becomes a verbatim note, and the external change survives. Also the case inside the atomic write (just before
  the re-hash), stated as a limit for the window between the re-hash and the rename.
- **Reader-only:** `npm run test:reader-only` passes with `packages/editor` removed.
- **Real use:** Josh finishes 3 real decks using only Edit for text changes (Mac build).
