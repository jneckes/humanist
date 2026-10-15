# Blueline architecture (Phase 0 build contract)

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
| `packages/core/src/mapper-html.ts` | Strategy 1 walk: stamps, runs, scripts, key values, parse errors | core-mapper |
| `packages/core/src/served.ts` | the served (stamped) copy | core-mapper |
| `packages/core/src/mapper.ts` | `buildMap`, `toClientMap` | core-mapper |
| `packages/core/src/js-literals.ts` | cooked-to-raw tables for JS strings/templates/JSON strings; escaping | core-literals |
| `packages/core/src/mapper-literals.ts` | Strategy 2: acorn walk, units, HTML-fragment runs, JSON tokenizer | core-literals |
| `packages/core/src/matcher.ts` | the shared matcher (9.2 Matching DOM to source at runtime) | core-literals |
| `packages/core/src/edit-cleanup.ts` | commit clean-up and changed-span diff (9.2 Committing an edit, 3–4) | editor |
| `packages/core/src/slides.ts` | slide detection (9.4), DOM | preload |
| `packages/core/src/dom-walk.ts` | visible-text walk, locators, CSS paths (section 10 step 4), DOM | preload |
| `packages/core/src/index.ts` | barrel | contract |
| `packages/editor/src/*` | patcher: plan, encode, splice, verify, undo/redo, write queue | editor |
| `packages/app/src/main/protocol.ts`, `confine.ts`, `network-policy.ts`, `trust-hooks.ts`, `ipc-guard.ts`, `markers.ts` | protocol, confinement, trust hooks, IPC validation, internet markers | app-security |
| `packages/app/src/preload/*` (except `shell.ts`) | deck preload: overlay, key router, card, ink, render agent, diagnostics hooks | preload |
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
extractLiterals(src: string, scripts: ScriptInfo[], lines: LineIndex): { units: LiteralUnit[]; literals: LiteralRun[]; scripts: ScriptInfo[] }

// js-literals.ts
jsLiteralTable(rawContent: string, kind: 'string' | 'template' | 'json-string', quote: "'" | '"' | '`'): { cooked: string; table: OffsetTable } | null
escapeJsText(text: string, quote: "'" | '"' | '`', kind: 'string' | 'template'): string   // 9.2 Strategy 2 step 5.2, in that order
escapeJsonText(text: string): string                                                   // 9.2 Strategy 2 step 5.3

// mapper.ts
buildMap(src: string, opts: { version: string; utf8: boolean }): DeckMap
toClientMap(map: DeckMap): ClientMap
buildServedCopy(src: string, map: DeckMap, opts: { protected: boolean }): string   // (served.ts) stamps, data-bl-e stripped, notes block removed, rel hints stripped when protected

// matcher.ts
createMatcher(map: ClientMap | DeckMap): (node: DomTextNode) => MatchResult

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
  webSecurity: true, partition, preload: dist/preload-deck.cjs, additionalArguments: ['--bl-mode=deck']`.
  Partition: non-persistent `deck-<docId>` when Protected, `persist:deck-<fileKey>` when Trusted.
- **Render windows** (6.7): hidden offscreen `BrowserWindow`s (`show: false`, `offscreen: { deviceScaleFactor }`,
  `enableLargerThanScreen: true`), same partition, protocol and policy as the document, preload in
  `--bl-mode=render`. Pool of at most 2 per document.
- **Schemes.** `blueline` (decks; 9.1 Protocol) and `app` (shell UI from the bundle). Both are registered
  privileged before `ready` in `protocol.ts` (`registerPrivilegedSchemes()`).
- **Document serving.** `protocol.ts` exports
  `installDeckProtocol(ses: Electron.Session, lookup: (docId: string) => ServedDoc | undefined): void`,
  where the lookup only returns documents that belong to that partition, and

  ```ts
  interface ServedDoc {
    docId: string;          // lowercase hex
    fileName: string;       // basename; the document is served at blueline://<docId>/<encoded fileName>
    folderReal: string;     // realpath of the document's folder
    trust(): TrustState;    // current trust (adds connect-src 'none' etc. when protected)
    documentBody(): Promise<{ body: Uint8Array; utf8: boolean }>;  // served copy (app-shell builds it with buildServedCopy)
  }
  ```
- **Trust hooks** (`trust-hooks.ts`): `installDeckSessionPolicy(ses, policy)` (permission and device
  handlers, the single `onBeforeRequest` listener, the PAC proxy) and `installDeckWebContentsPolicy(wc, opts)`
  (navigation, window open, downloads, Bluetooth chooser, WebRTC policy, link handling), with `policy`
  exposing live getters (`trust()`, `networkAllowed()`, `strict()`, `allowlist()`) and an
  `update()` that re-applies the proxy after a trust change.
- **IPC guard** (`ipc-guard.ts`): `registerDeckChannel(channel, validate, handler)` style helpers that check
  the sender is a deck/render webContents main created (main frame, origin `blueline://<docId>`), look the
  document up from the sender (never from the payload), validate the payload with size limits, and rate-limit.
- **Editor loader** (`editor-loader.ts`): `loadEditor(): EditorModule | null` from `dist/editor.cjs`;
  `capabilities = { edit: !!editor, agent: !!editor }`.
- **Commands.** The app accepts `--bl-cmd=<open|map|check>`, `--bl-args=<base64url JSON>` and
  `--bl-out=<file>`. `map` and `check` are headless or diagnostic runs that write a JSON result to
  `--bl-out` and exit (map) with its exit code. `runMapCommand(args)` lives in `map-command.ts` and
  `openDiagnostics(opts)` in `diagnostics.ts` (app-render); app-shell creates stub versions first.
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

## Phase 0 findings

Facts the spike settles are recorded in `docs/PHASE0-FINDINGS.md`, each with the check that settled it.
