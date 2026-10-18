# Blueline architecture (Phase 0 build contract, and what Phase 1 added)

SPEC.md is the source of truth. This page fixes the module boundaries, file ownership and cross-module
interfaces that SPEC.md leaves to the implementation, so that the pieces of Phase 0 can be built in
parallel and fit together. Where this page and SPEC.md disagree, SPEC.md wins; fix this page.

## Conventions

- TypeScript, `strict`. Plain functions and small classes; no frameworks (9.6 Overlay).
- **Offsets.** Every stored or computed offset is a UTF-16 index into the decoded file string `src` (9.2 rule 2).
  Never index a `Buffer` with one.
- **`packages/core` is environment-neutral.** No `node:*` imports, no Electron. DOM code is allowed only
  in modules that only the preload uses (`slides.ts`, `dom-walk.ts`). Hashing is done by the caller and
  passed in as `version`.
- **Workspace imports.** `@blueline/core` resolves to `packages/core/src/index.ts`; `@blueline/core/<file>`
  to `packages/core/src/<file>.ts` (vitest alias, esbuild plugin, tsconfig paths). **The preloads and the
  shell import core by subpath** (`@blueline/core/matcher`, `@blueline/core/ipc`), never the barrel, so
  parse5 and acorn stay out of the preload bundle.
- **The capability seam (D11).** Nothing outside `packages/editor` imports `@blueline/editor`. The build
  fails if it does. Main loads `dist/editor.cjs` at runtime (`packages/app/src/main/editor-loader.ts`)
  and codes against `EditorModule` in `packages/core/src/capabilities.ts`.
- **Shell rule (9.1).** No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or data in style strings, anywhere
  in `packages/app/src/shell` or `packages/app/src/preload`. Build DOM with `createElement` and `textContent`.
- **Overlay rule (9.1 Preload).** The deck overlay loads nothing by URL, runs no inline code, uses no
  `<style>` elements or `style` attributes (use CSSOM property writes, `el.style.setProperty` is fine since
  it is a CSSOM write, and constructable stylesheets), no `blob:`/`data:` URLs, no `eval`/`new Function`.
- Unit tests: `test/unit/<package>/<topic>.test.ts` (vitest). E2E: `test/e2e/`. Security: `test/security/`.
- Comments explain why, and cite the spec section (`// 9.2 Strategy 1 step 3`).

## Repository map and ownership

| Path | What | Built by |
|---|---|---|
| `packages/core/src/types.ts` | Data model (section 8) and map/match/edit types | contract (edit only to add fields) |
| `packages/core/src/ipc.ts` | IPC channel names and payload types | contract (edit only to add) |
| `packages/core/src/capabilities.ts` | `EditorModule`, `WriteQueue`, `DeckIO` | contract |
| `packages/core/src/text.ts` | decode/encode, whitespace, line endings, `LineIndex` | contract |
| `packages/core/src/notes-block.ts` | find and remove the trailing notes block (section 8) | core-mapper |
| `packages/core/src/offset-table.ts` | `OffsetTable` interface + helpers | core-mapper |
| `packages/core/src/html-tables.ts` | decoded-to-raw tables for HTML text; `encodeHtmlText` | core-mapper |
| `packages/core/src/mapper-html.ts` | Strategy 1 walk: stamps, runs, scripts, key values, parse errors, shadow values | core-mapper |
| `packages/core/src/served.ts` | the served (stamped) copy | core-mapper |
| `packages/core/src/mapper.ts` | `buildMap`, `toClientMap` | core-mapper |
| `packages/core/src/js-literals.ts` | cooked-to-raw tables for JS strings/templates/JSON strings; escaping | core-literals |
| `packages/core/src/mapper-literals.ts` | Strategy 2: acorn walk, units, HTML-fragment runs, JSON tokenizer | core-literals |
| `packages/core/src/matcher.ts` | the shared matcher (9.2 Matching DOM to source at runtime) | core-literals |
| `packages/core/src/edit-cleanup.ts` | commit clean-up and changed-span diff (9.2 Committing an edit, 3–4) | editor |
| `packages/core/src/slides.ts` | slide detection (9.4), DOM | preload |
| `packages/core/src/dom-walk.ts` | visible-text walk (the document, its open shadow roots and same-origin frames), locators, CSS paths, `DomTextNode.texts` (section 10 step 4), DOM | preload |
| `packages/core/src/index.ts` | barrel | contract |
| `packages/editor/src/*` | patcher: plan, encode, splice, verify, undo/redo, write queue | editor |
| `packages/app/src/main/protocol.ts`, `confine.ts`, `network-policy.ts`, `trust-hooks.ts`, `ipc-guard.ts`, `markers.ts` | protocol, confinement, trust hooks, IPC validation, internet markers | app-security |
| `packages/app/src/preload/*` (except `shell.ts`) | deck preload: overlay, key router, input guard, card, ink, render agent, diagnostics hooks | preload |
| `packages/app/src/main/*` (other files), `packages/app/src/preload/shell.ts`, `packages/app/src/shell/shell.*`, `packages/app/assets/`, `packages/cli/src/*` | app skeleton, windows, shell UI, menu, key chords, documents, sessions, atomic writer, editor loader, CLI | app-shell |
| `packages/app/src/main/render-service.ts`, `map-command.ts`, `probe.ts`, `diagnostics.ts`, `packages/app/src/shell/diagnostics.*` | render service, `blueline map` + mutation probe, Diagnostics window + `check` | app-render |
| `fixtures/decks/*`, `fixtures/README.md` | synthetic and CSP fixtures, reveal.js fixture | fixtures |
| `fixtures/security/*`, `test/security/*`, `test/e2e/*` | security fixtures and suite, E2E | security-suite |

## Cross-module interfaces

### core (pure)

```ts
// text.ts (exists)
decodeDeck(bytes: Uint8Array): DecodedDeck            // {utf8, src, bom, lineEnding}
encodeDeck(src: string): Uint8Array
isWhitespaceOnly(s: string): boolean                  // U+0020, tab, LF, CR, FF only
looksComputed(data: string): boolean                   // digits and number punctuation only (section 7; review finding 3)
class LineIndex { at(offset): {line, col}; lineStart(line) }

// offset-table.ts
interface OffsetTable {
  readonly length: number;                            // length of the decoded/cooked string
  toRaw(i: number): number;                           // raw offset (relative to the raw slice) where index i starts; toRaw(length) === raw.length
  widen(start: number, end: number): { start: number; end: number };  // so neither end is inside an atomic unit
}

// notes-block.ts
findNotesBlock(src: string): { start: number; end: number } | null   // the <script …>…</script> element range only

// html-tables.ts
htmlTextTable(raw: string, decoded: string, opts?: { dropLeadingNewline?: boolean }): OffsetTable | null  // null = cannot align → run is `none`
encodeHtmlText(text: string, opts: { nbspAsRef: boolean }): string  // & → &amp;, < → &lt;, U+00A0 → &nbsp; when nbspAsRef

// mapper-literals.ts
extractLiterals(src: string, scripts: ScriptInfo[], lines: LineIndex): { units: LiteralUnit[]; literals: LiteralRun[]; scripts: ScriptInfo[]; keys: { value: string; attr: string; line: number }[]; shadows: FoundShadow[] }
// keys: JSON object keys, identifier keys of JS object literals and class fields, non-computed member names and
// object-pattern keys; buildMap merges them into DeckMap.keys/keyValues, so a literal with the same text is
// ambiguous (`key`) (PHASE0-FINDINGS F15, F22)
// shadows: tagged-template text and numbers; with mapper-html's (template content, raw text, data blocks,
// attributes, handlers, dropped Strategy 1 text) buildMap makes DeckMap.shadows and toClientMap
// ClientMap.shadowValues: a literal equal to one is `ambiguous` (`shadow`) (PHASE0-FINDINGS F22)
isHtmlLiteral(cooked: string): boolean               // LiteralUnit.html: the fragment parse holds markup (D-d)

// js-literals.ts
jsLiteralTable(rawContent: string, kind: 'string' | 'template' | 'json-string', quote: "'" | '"' | '`'): { cooked: string; table: OffsetTable } | null
escapeJsText(text: string, quote: "'" | '"' | '`', kind: 'string' | 'template'): string   // 9.2 Strategy 2 step 5.2, in that order
escapeJsonText(text: string): string                                                   // 9.2 Strategy 2 step 5.3

// mapper.ts
buildMap(src: string, opts: { version: string; utf8: boolean; defer?: boolean }): DeckMap
// Since review round 1 (decision D-9) buildMap returns after Strategy 1 (the stamps the served copy needs) unless
// defer is false; the Strategy 2 fields (units, literals, scripts, keyValues, keys, shadows) are accessors that
// complete all of them on the first read of any. completeMap(map) runs Strategy 2 now; isMapComplete(map) says
// whether it ran. A complete map equals the eager one field for field.
toClientMap(map: DeckMap): ClientMap
buildServedCopy(src: string, map: DeckMap, opts: { protected: boolean }): string   // (served.ts) stamps, data-bl-e stripped, notes block removed, rel hints stripped when protected

// matcher.ts
createMatcher(map: ClientMap | DeckMap, opts?: { fileName?: string }): (node: DomTextNode) => MatchResult
// step 1 trusts the own stamped run only while node.texts (the element's live non-whitespace direct text
// nodes) agree with the stamp's source runs and no other run of the element has the same text (PHASE0-FINDINGS F22)

// edit-cleanup.ts
cleanupCommit(before: string, after: string): string     // NBSP → space unless at the same position relative to the unchanged prefix/suffix; drop U+200B/U+FEFF; line breaks → spaces
changedSpan(before: string, after: string): { start: number; endBefore: number; endAfter: number }
```

`DeckMap` may gain fields (for example the stamp insertion sites that `buildServedCopy` needs); existing
fields keep their names and meaning.

Run ids: `h:<stamp>:<textIndex>` for Strategy 1, `l:<unit>:<runIndex>` for Strategy 2. A run id is only
meaningful together with the map `version` it came from.

### editor

`packages/editor/src/index.ts` exports `editorVersion` and `createWriteQueue(io, opts)` (the
`EditorModule` interface), plus the pure functions the fuzz test uses (`planEdit`, `verifyEdit`,
`planUndo`). The write queue implements the whole write protocol (9.2): per-deck serial queue, version
check and re-resolution by `beforeText` + 32 chars of context, re-check, atomic write through
`DeckIO.atomicWrite` (which re-hashes before rename), verify (re-parse, same run holds `afterText`, no new
parse5 errors, Strategy 2 checks), restore on failure, and the verbatim fallback.

### app main

- **Windows.** One `BrowserWindow` per document. Its own `webContents` is the **shell** (sandboxed,
  context-isolated, `preload-shell.cjs`, loads `app://shell/index.html`, own partition `shell`). The **deck view**
  is a `WebContentsView` added to `win.contentView`, positioned in the content area from `ShellLayout`
  (main owns the layout numbers and sends them in `ShellState`). Playwright's `_electron` sees the window.
- **Deck view webPreferences:** `sandbox: true, contextIsolation: true, nodeIntegration: false,
  nodeIntegrationInSubFrames: true, webSecurity: true, partition, preload: dist/preload-deck.cjs,
  additionalArguments: ['--bl-mode=deck']`. `nodeIntegrationInSubFrames` (review round 1, decision D-4) only
  loads the sandboxed preload in every frame: in a subframe it installs the file-drop guard and nothing else
  (`preload/drop-guard.ts guardFrameDrops`), and main's IPC guard still answers only the main frame. The
  Diagnostics window's visible deck view sets it too.
  Partition: non-persistent `deck-<docId>` when Protected, `persist:deck-<fileKey>` when Trusted.
  A Trusted file keeps its docId (and so its origin and storage, 6.10) across opens: random, generated once,
  kept in `<userData>/files/<fileKey>/origin` (`documents.ts` `trustedDocumentId`). Protected opens always get
  a fresh docId.
- **One window per file** (6.1; `controller.ts`, `window-key.ts`). A file's window is found by the file's
  device and inode (`fs.stat` with `bigint`) or by its realpath as returned, never case-folded. So a symlink or
  a hard link focuses the open window, while `Deck.html` and `deck.html` on a case-sensitive volume are two
  files. The open windows' inode keys are read again before each lookup: an atomic write gives the file a new
  inode, and a freed inode number can be reused. A window that is closing is never listed (`all()`, the test
  hooks) or returned: a reopen waits for its `closed` and opens a new window. A new window reads
  `session.json` only after any write of that file still in flight has landed (6.8 One writer;
  `SessionStore.open`).
- **Closing a window** (`window.ts` `onClosed`). The deck partition's and view's policy callbacks read a small
  state object (`deckPolicies`), never the `BlDocument` or the `DocWindow`. Closing does four things:
  - clears that state, so the callbacks fail closed: Protected, no network;
  - disposes the trust-hook handles once the deck view is gone;
  - replaces a Protected partition's request listener and permission handlers with capture-free ones that
    refuse everything (only `blueline:` and `blueline-media:` pass, and nothing serves them there any more);
  - drops the document's bytes and served copies (`BlDocument.release`).

  Electron keeps a partition's Session for the life of the process, so without this every closed Protected
  window kept about three times its file's size in main memory. A Trusted `persist:` partition is never
  reset: a reopened window of the same file installs its own policy over it.
- **Render windows** (6.7): hidden offscreen `BrowserWindow`s (`show: false`, `offscreen: { deviceScaleFactor }`,
  `enableLargerThanScreen: true`), same partition, protocol and policy as the document, preload in
  `--bl-mode=render`. Pool of at most 2 per document. Keys are trusted `sendInputEvent`. Whether they reach the
  page is read from the render agent's keydown counter (`RenderCmd keydowns`), which is registered at preload
  start. Scrolling and single-page walks step with `RenderCmd scroll-to`. The probe gives every load of its
  copy a fresh docId.
- **Schemes.** `blueline` (decks; 9.1 Protocol), `blueline-media` (the decks' audio and video; not
  CORS-enabled, so a `crossorigin` media element cannot read them) and `app` (shell UI from the bundle). All
  are registered privileged before `ready` in `protocol.ts` (`registerPrivilegedSchemes()`), and
  `installDeckProtocol` handles both deck schemes on each deck partition.
- **Document serving.** `protocol.ts` exports
  `installDeckProtocol(ses: Electron.Session, lookup: (docId: string) => ServedDoc | undefined): void`,
  where the lookup only returns documents that belong to that partition, and

  ```ts
  interface ServedDoc {
    docId: string;          // 16 lowercase hex digits, at least one a letter (documents.ts isDocumentId)
    fileName: string;       // basename; the document is served at blueline://<docId>/<encoded fileName>
    folderReal: string;     // realpath of the document's folder
    trust(): TrustState;    // current trust (adds connect-src 'none' etc. when protected)
    documentBody(): Promise<{ body: Uint8Array; utf8: boolean }>;  // served copy (app-shell builds it with buildServedCopy)
  }
  ```
- **Trust hooks** (`trust-hooks.ts`): `installDeckSessionPolicy(ses, policy)` (permission and device
  handlers, the single `onBeforeRequest` listener, the Protected proxy: `fixed_servers` to a closed port with
  `<-loopback>`) and `installDeckWebContentsPolicy(wc, opts)` (navigation, window open, downloads, Bluetooth
  chooser, WebRTC policy, link handling; re-installing on a view replaces every listener of the previous
  install), with `policy` exposing live getters (`trust()`, `networkAllowed()`, `strict()`, `allowlist()`) and
  an `update()` that re-applies the proxy after a trust change. `installShellPolicy(ses, wc)` installs the
  shell session's part once per session and the view part per window.
- **IPC guard** (`ipc-guard.ts`): `registerDeckChannel(channel, validate, handler)` style helpers that check
  the sender is a deck/render webContents main created (main frame, origin `blueline://<docId>`), look the
  document up from the sender (never from the payload), validate the payload with size limits, and rate-limit.
  `validateSlides` also keeps the optional per-slide `hashes`, `revealIndices` and `ids` (dropped when their
  length is not `count`) and `deckNav` (keys from `DECK_NAV_KEYS`, the preload's navigation keys). Main builds
  each note's SlideRef and `Session.deckNav` from them.
- **Editor loader** (`editor-loader.ts`): `loadEditor(): EditorModule | null` from `dist/editor.cjs`;
  `capabilities = { edit: !!editor, agent: !!editor }`.
- **Commands.** The app accepts `--bl-cmd=<open|map|check|pdf>` (`pdf` since Phase 1: `pdf-command.ts runPdfCommand`), `--bl-args=<base64url JSON>`, `--bl-out=<file>`
  and `--bl-parent=<pid>`. `map` and `check` are headless or diagnostic runs that write a JSON result to
  `--bl-out` and exit with its exit code. `runMapCommand(args)` lives in `map-command.ts` and
  `openDiagnostics(opts)` in `diagnostics.ts`. Both stop on SIGINT, SIGTERM and SIGHUP (exit 130, 143, 129;
  map deletes its probe copy first, check saves check.json if guided steps were recorded) and when the process
  `--bl-parent` names (the `blueline` command) is gone. The `blueline` command starts the app in its own
  process group and passes those signals on to the app's main process (under xvfb-run, the child of
  xvfb-run, so xvfb-run still stops Xvfb and cleans up); a run that has not ended 10 s later is killed as a
  group. A file macOS delivers through `open-file` to a `map` or `check` process goes to a regular instance
  (`open-file.ts`).
- **Packaged paths.** A packaged build reads its code from `app.asar`, but `dist/shell` and `dist/assets` ship
  unpacked (`asarUnpack`) and main serves them from `app.asar.unpacked` (`app-paths.ts`): the confined
  protocol handlers refuse every file inside the archive. `npm run package:smoke` packs a test build
  (unpacked dir target, local Electron) and checks the shell, the trust bar and `check --auto` on it.
- **userData** can be overridden with `BLUELINE_USER_DATA` (tests).

### deck preload ↔ main

`packages/core/src/ipc.ts`. The preload reads its mode from `--bl-mode=` in `process.argv`. It sends
`DeckToMain.ready` once, gets `MainToDeck.init`, and then follows the app mode. In render mode it answers
`MainToDeck.renderRequest` with `DeckToMain.renderReply`. Main calls into the page's main world only with
`webContents.executeJavaScript` (for example `Reveal.slide(h, v)`), or the preload does so with
`webFrame.executeJavaScript`.

## Running Electron in the dev container

- `node scripts/run-electron.mjs [args]` starts the built app. Under Linux without `DISPLAY` it uses
  `xvfb-run -a -s "-screen 0 3840x2160x24"`: an offscreen window is clamped to the X screen size.
- As root, Chromium needs `--no-sandbox` (the run script adds it). For the security suite, run as the
  non-root user `bltest` so the OS sandbox is on (`su bltest -c …`); user namespaces are available.
- Electron is 44.7.2 (Chromium 152, Node 24).

## Phase 1 (Reader): the new modules and who calls what

`docs/PHASE1-PLAN.md` fixed the ownership and interfaces; this is what was built. Every service module is called
from `index.ts` (startup), `controller.ts` (opening) or `window.ts` (one document window); none of them calls
`ipcMain` directly: their shell channels go through `shellRouter()` (`channels.ts`) and their deck channels
through the IPC guard. IPC types live in one core file per area: `ipc-render.ts`, `ipc-trust.ts`,
`ipc-files.ts`, `ipc-views.ts` (`ipc.ts` re-exports what the shell and the preloads need).

### Startup (`index.ts`, after `ready`)

| Call | Module | What it sets up |
|---|---|---|
| `setRenderHost({ preload, userData, log })` | `render-service.ts` | the render windows every render product uses |
| `configureNativeHelper(…)`, `disposeNativeHelper()` on `will-quit` | `native-helper.ts` | macOS: the Swift helper (`native/macos`) or `/usr/bin/xattr`; Windows: Default Apps, `reg.exe`; Linux: unsupported |
| `TrustStore.forUserData(userData).load()` | `trust-store.ts` | `<userData>/trust.json`: remembered decisions, each with the marker it was made on and, for an unmarked file and on Windows, the file's identity (`readFileIdentity`: dev, ino, birth time; decision D-2); kept under 7 MiB. It registers the live store that `documents.ts` re-binds after Blueline's own atomic writes (`rebindAfterOwnWrite`) |
| `new TrustSettings(config, …)` | `folders.ts` | trusted and untrusted folders, the strict option, the CDN allowlist (in `config.json`) |
| `RecentFiles.forUserData(…)` | `recent.ts` | `recent.json`, File › Open Recent, `app.addRecentDocument` |
| `setShellThumbResolver(…)` | `protocol.ts` | `app://shell/thumbs/<docId>/<sha256>-<slide>-<width>.png`, mapped in main to that window's thumbnail cache (`thumbnails.ts readThumb`) |
| `installSettingsWindow(…)` | `settings-window.ts` | the Settings window (General, Trust) and its `bl:settings:*` channels, answered only for its own shell |
| `installDropHandler(…)` | `drop.ts` | `bl:files:open-dropped` from document shells and the welcome window |
| `installFirstRun(…)` | `first-run.ts` | the welcome window and its `bl:welcome:*` channels, and the Open window later launches show on Linux and Windows (`OPEN_URL`, the same page without the first-run questions; main refuses the name and crash-report channels from it); the sample deck copied to `<userData>/sample` |
| `runPdfCommand(…)` for `--bl-cmd=pdf` | `pdf-command.ts` | `blueline pdf`, headless, with a private userData (as `map`); before switching to it, `command-trust.ts commandTrust()` reads the user's `config.json` read-only (`BLUELINE_USER_DATA`, else `<appData>/Blueline`) for the folders, the strict option and the allowlist, and decides trust with `resolveOpenTrust` and `TrustStore.inMemory()` (never trust.json; decision D-3). `map-command.ts` does the same |
| `noFileStart()` and `second-instance` | `index.ts`, `first-run.ts` | a launch without a file: `startupWindow({platform, welcomeSeen})` gives the first-run welcome on the first launch only (`seen.welcome`), then the Open window (`welcome.html?mode=open`) on Linux and Windows and nothing on macOS; a second launch without a file brings forward the window `secondLaunchFocus` picks (decision D-12) |

### Opening a file (`controller.ts`)

`AppController.open` → `documents.ts loadDocument({ decideTrust })`, where `decideTrust` is `folders.ts
resolveOpenTrust` (6.10 When it applies: the requested Protected view, the marker read through the native
helper, the folder lists, then the decision remembered in `trust.json` for the same marker, and for the same
file where the identity binds it). The result also says whether Allow network and Enable editing were
remembered; the window applies them. A Settings change (`onTrustSettingsChanged`, with the kind of change)
re-applies every open window's partition policy (`DocWindow.reapplyPolicy`). A Protected request for a file
already open in another state focuses that window and says so (`protectedRequestNotice`). `AppController`
also reopens a window whose trust changed on disk (below); on Linux and Windows a hidden placeholder window
keeps the app running while no window shows the file.

### One document window (`window.ts`)

- **Views** (`views.ts`, pure layout maths): the deck view sits in a clipping container `View`; Fit is
  `webContents.setZoomFactor` with `webPreferences.zoomMode: 'isolated'` (PHASE0-FINDINGS F5; without
  `isolated`, Chromium's per-host zoom also zoomed the document's own render windows); 100% and Fill width
  make the view larger than the window and the shell draws the scroll bars; documents get Reading Width
  (960 px, per file in `session.json`). The design size comes from the slide index, else from the visible
  view measured at 1600×900 (`bl:views:design`, accepted only at that viewport).
- **Present** (`present.ts`): full screen, chrome hidden, Esc caught in `before-input-event`.
- **Render products**, started when the deck view finishes loading and again for every new version
  (`startProducts`): `renderTargetFor(doc)` → `slide-index.ts buildSlideIndex` → `thumbnails.ts
  renderThumbnails` (each PNG pushed to the shell as `bl:render:thumb`, the index as `bl:render:index-ready`).
  Find (`bl:render:find`, `bl:render:find-show`) answers from the index (`find.ts findResponse`), navigates,
  then `highlightMatch` (findInPage). Save as PDF (`pdf.ts saveAsPdf`) and Print (`print.ts printDocument`)
  reuse the index. Every still image waits for what the slide's scripts reveal (`RenderView.waitScripted`,
  `slide-index.ts SCRIPTED_SETTLE`), and so do the slide index (before it reads a slide's text) and every
  `printToPDF` or print of a document or a print-CSS deck. The wait adapts per version (`SettleMemory`,
  decision D-5): a slide whose full wait saw no late change gets the 400 ms quiet-only wait next time; a
  document's page always gets the full wait. The index walk also takes the rail's thumbnails (width
  `railThumbWidth(LEFT_RAIL_WIDTH)`) in the same pass, so the wait is paid once per slide. Save as PDF picks
  print CSS only when Chromium's print is one page per slide at the slide's aspect (`pdf.ts decidePdfMode`,
  decision D-6), and lays raster pages out in slide order. Each index records the network policy it was made
  under (`renderPolicyTag`); a window whose policy differs, or that turned on Allow network or changed Settings ›
  Trust, makes the products again (`rebuildProducts`). On close: `cancelThumbnails(fileKey)` and
  `disposeRenderer(docId)` before the partition is retired; whatever still waits on a closed render view rejects
  with `RenderCancelled`. The render products reach the window only through `productsLive`, cleared on close.
- **The map after first paint** (decision D-9): `loadDocument` serves the stamped copy after Strategy 1;
  `sendInit` sends `DeckInit.map: null` with `mapPending` while Strategy 2 has not run, and
  `completeMapAfterPaint` runs it once the deck view reports its first contentful paint (3 s at most) and sends
  the complete map on `MainToDeck.map`. The preload never receives a partial map.
- **Navigation** (decision D-7): a hash or reveal.js goto that has not moved the visible slide within 1.5 s puts
  the hash back and uses the deck's keys (`Session.deckNav`); the window then remembers it (`brokenGotos`). A
  key replay or a load gives the keyboard back to the webContents that had it (the Find bar).
- **Reload** (`watcher.ts watchDeck` → `onExternalChange` → trust decided again → `doc.replaceContent` →
  `view-state.ts ReloadCoordinator`): the deck preload reports and applies the view state
  (`bl:files:capture-view-state`, `bl:files:view-state`, `bl:files:apply-view-state`,
  `bl:files:view-state-applied`) and its busy state (`bl:files:busy`); a reload waits for an edit or a card
  with unsaved input. Every external change is decided again as an open is (the controller's `decideTrust`),
  and the marker is read once more 500 ms later; when the decision differs (`trustDifferences`,
  `reopenForTrust`), the file opens again in a new window instead of reloading in place (decision D-1). A
  reload never captures a page that is still restoring: `saveState` reuses the state being restored until the
  page acknowledges it and main's key replay has finished (`restoreDone`, decision D-8).
  `noteDocumentWrite(fileKey)` makes renders wait 300 ms after a write (6.7 step 1).
- **Trust bar**: Allow network and Enable editing call `TrustStore.remember(realpath, marker, …)` (not when
  the marker could not be read).
- **Deck channels** added in Phase 1, all validated in main, none carrying a path: `bl:views:design`,
  `bl:views:page-step` and `bl:views:wheel` (honoured only right after main saw the matching real input in
  `before-input-event` / `input-event`), `bl:files:view-state`, `bl:files:busy`, `bl:files:drop-refused` (no
  payload), `bl:files:view-state-applied` (no payload). Shell channels: `bl:views:command`, `show`, `scroll`,
  `find-closed`, and the render ones above.
- **Menus** (`menu.ts`): Open Recent, Reveal, Present, View › Fit / 100% / Fill width / Reading Width / Hide
  Slides, Find, Save as PDF, Print, Settings…, Help › Install Command Line Tool (`cli-install.ts`), Welcome to
  Blueline, About Protected View.

### Files the build adds

- `dist/preload-settings.cjs`, `dist/preload-welcome.cjs`, `dist/shell/settings.*`, `dist/shell/welcome.*`
  (9.1 Shell view: their own BrowserWindows in the `shell` session, CSP header and meta, named contextBridge
  functions only).
- `dist/assets/sample/blueline-tour.html`: the sample deck.
- `packages/cli/dist/blueline` and `blueline.cmd`: the shims that find Node 22+ (`cli-install.ts` links to them).
- `native/macos/build/blueline-helper`, when `native/macos/build.sh` ran on a Mac; electron-builder ships it in
  `Resources/helper`. `packages/app/build/installer.nsh`: the Windows registry entries for Default Apps, the only
  Windows file-type registration (`fileAssociations` sit under `mac` in `electron-builder.config.cjs`, decision
  D-11); a per-machine install also removes the per-user entries a per-user install left.

### Tests and the exit gate

- `test/e2e/<item>-*.spec.ts` (render-products, trust-native, files-lifecycle, views) and
  `test/security/trust-ipc.spec.ts`. The E2E and security suites run one Xvfb display per Playwright worker
  (`test/helpers/display.ts`): an X server has one clipboard, and the clipboard tests raced when two workers
  shared one.
- The exit-gate harnesses (`scripts/parity.mjs`, `scripts/first-paint.mjs`, `test/parity/harness/`) are their
  own Electron main and import the app's modules from source (`documents.ts`, `protocol.ts`,
  `trust-hooks.ts`, `render-service.ts`, `slide-index.ts`, `pdf.ts`, …): renaming those breaks them, and tsc
  says so. The parity harness seeds `Math.random` in every render by wrapping `RenderView.prototype.load` in its
  own process (decision D-10; the app never does), so `RenderView.load` must stay a prototype method and `wc`
  public. Results: `docs/PHASE1-RESULTS.md`.

## Phase 0 findings

Facts the spike settles are recorded in `docs/PHASE0-FINDINGS.md`, each with the check that settled it.
