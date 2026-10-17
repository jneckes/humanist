# Phase 1 build contract (Reader)

SPEC.md section 10, Phase 1, is the scope; this page fixes who builds what and the interfaces between the
pieces, as docs/ARCHITECTURE.md did for Phase 0. Where this page and SPEC.md disagree, SPEC.md wins, except
for the decisions Josh made after Phase 0 (docs/spec-amendments/README.md; docs/PHASE0-FINDINGS.md):

- Fit uses `webContents.setZoomFactor` on the deck view, not CSS `zoom` (PHASE0-FINDINGS F5).
- Review and Edit render with reduced motion; Read and Present keep the deck's motion (`main/motion.ts`).
- Coverage gates on wording (`report.ts`); the matcher prefers an untouched own stamp over equal literals.
- Wispr Flow is not a requirement: any text input and dictation that types into the focused field.

## Scope (SPEC 10, Phase 1)

| Area | SPEC | Work item |
|---|---|---|
| Thumbnails, slide text index, Find across slides, Save as PDF (print CSS, raster, documents), Print, `blueline pdf` | 6.7, 6.9 Navigation, Find, Save as PDF, Print | render-products |
| Trust memory (`trust.json`), trusted and untrusted folders, Settings (General: default app; Trust), internet markers through the native helpers, the macOS and Windows helpers, the Windows installer registry | 6.1 Becoming the default app, 6.10, 9.6 native/, 9.9 Writes, 9.10 | trust-native |
| Open Recent, drag and drop, Reveal in Finder, the watcher and its reload, the first-run window and sample deck, Help › Install Command Line Tool, the `blueline` shim | 6.0 First run, 6.1, 6.6 Reload, 9.2 Watcher, 9.7 | files-lifecycle |
| The window anatomy, deck and document views, Fit / 100% / Fill width, Reading Width, the thumbnail rail and outline, the status bar, Present, the Find bar, wiring every service into windows, menus and the shell | 6.0 The window, 6.9 Views, Navigation, Present | views |
| Render parity, PDF parity and first-paint measurements (the exit gate) | 10 Phase 1 Exit gate, 11 Render parity | exit-gate |

## Ownership

Service items build **new modules only** and never edit `window.ts`, `controller.ts`, `menu.ts`, `index.ts`,
`channels.ts`, `packages/core/src/ipc.ts` or the main shell page. Each puts its IPC types in its own core file.
The views item owns those shared files and wires the services in. A service that has its own window (Settings,
the welcome window) declares that window's shell channels in its own module through `shellRouter()`
(`channels.ts`) and registers the window's shell with it; it never calls `ipcMain` directly. Tests go in
`test/unit/app/<module>.test.ts` and `test/e2e/<item>-*.spec.ts`.

| Item | Owns |
|---|---|
| render-products | `packages/app/src/main/{thumbnails,slide-index,find,pdf,print,pdf-command}.ts`, `render-service.ts` (extend), `packages/core/src/ipc-render.ts`, tests for these |
| trust-native | `packages/app/src/main/{trust-store,folders,settings-window,native-helper}.ts`, `markers.ts` and `config.ts` (extend: folders and the Trust settings), `packages/app/src/shell/settings.*`, `packages/app/src/preload/settings.ts`, `native/macos/**`, `native/windows/**`, `packages/app/build/installer.nsh`, `packages/core/src/ipc-trust.ts`, electron-builder config entries for the helpers and the installer, tests for these |
| files-lifecycle | `packages/app/src/main/{recent,watcher,view-state,first-run,cli-install,drop}.ts`, `packages/app/src/shell/welcome.*`, `packages/app/src/preload/welcome.ts`, `packages/app/assets/sample/**`, `packages/cli/src/**` (the `pdf` command's CLI side and the shim), `packages/core/src/ipc-files.ts`, tests for these |
| views | `window.ts`, `controller.ts`, `menu.ts`, `chords.ts`, `index.ts`, `channels.ts`, `layout.ts`, `views.ts` (new), `present.ts` (new), `packages/core/src/ipc.ts`, `packages/app/src/shell/{index.html,shell.ts,shell.css}`, `packages/app/src/preload/shell.ts`, the deck preload's view-state and fit hooks, `protocol.ts` (a shell route for thumbnails only), tests for these |
| exit-gate | `test/parity/**`, `scripts/parity.mjs`, `scripts/first-paint.mjs`, `fixtures/perf/**` (the 2 MB deck, generated), `docs/PHASE1-RESULTS.md` |

## Interfaces

### render-products

```ts
// main/slide-index.ts: one offscreen walk per document version (reuses DeckWalker / RenderView).
interface SlideIndex {
  version: string;                       // the document version (sha256) it was built from
  kind: 'reveal' | 'generic' | 'scroll' | 'single';
  slides: { index: number; title: string; nav: SlideRef['nav']; text: string[] }[];
  designSize: { w: number; h: number };
}
function buildSlideIndex(doc: RenderTarget, opts): Promise<SlideIndex>   // cached per (fileKey, version)

// main/thumbnails.ts: background renders (6.7) cached by (sha256, slide index, width) under
// <userData>/files/<fileKey>/thumbs/. Reports each thumbnail as it is written.
function renderThumbnails(doc: RenderTarget, index: SlideIndex, width: number, onThumb: (slide: number, file: string) => void): Promise<void>

// main/find.ts: 6.9 Find, over the slide index's text (all slides, shown or not).
function findInDeck(index: SlideIndex, query: string): FindHit[]       // { slide, title, snippet, matchIndex }

// main/pdf.ts: 6.9 Save as PDF. Print CSS → printToPDF({preferCSSPageSize, printBackground}); other decks →
// raster pages at the design size and 2x composed with pdf-lib (page = slide aspect, lossless); documents →
// printToPDF({printBackground, pageSize: Letter or A4 by locale}). Title from <title>. Never notes.
function saveAsPdf(doc: RenderTarget, out: string, opts?): Promise<{ pages: number; mode: 'print-css' | 'raster' | 'document' }>
```

`RenderTarget` is what a render needs from a document: its partition, docId, fileName, trust policy, the
reduced-motion choice, and its viewport. Background renders (thumbnails, the slide index, PDF pages) use
reduced motion, so a still image shows the slide's final frame, as `blueline map --reduced-motion` does; the
visible Read and Present views keep the deck's motion. `blueline pdf deck.html [-o out.pdf]`
runs `saveAsPdf` headless (`--bl-cmd=pdf`), like `map`.

### trust-native

```ts
// main/trust-store.ts: <userData>/trust.json, per realpath, with the marker the decision was made on (6.10).
// (documents.ts already has a TrustDecision, the result of deciding a file's trust state; this is what is stored.)
interface RememberedTrust { marker: string | null; allowNetwork: boolean; editing: boolean; received: boolean; at: string }
class TrustStore { get(realpath, currentMarker): RememberedTrust | null; set(realpath, d): Promise<void> }
// A decision applies only while the file carries the same marker; Blueline's own writes keep the marker.

// main/folders.ts: trusted and untrusted folders (config.json), refuseAsTrustedFolder (exists), and
// trustFor(realpath, marker, requestedProtected) → { state, reason } per 6.10.

// main/native-helper.ts: a long-lived child (macOS: native/macos Swift helper; Windows: none needed for
// markers) speaking JSON lines: setDefaultHtmlApp(), isDefaultHtmlApp(), readQuarantine(path),
// copyXattrs(from, to), setQuarantine(path, value). Falls back to /usr/bin/xattr when the helper is missing
// (development), and says so.

// Settings window: General (default app status + button), Trust (trusted/untrusted folders, the strict
// option, the CDN allowlist). Its own shell page and preload API (named functions only, 9.1).
```

### files-lifecycle

```ts
// main/recent.ts: recent.json + app.addRecentDocument + the Open Recent menu's items.
// main/drop.ts: files dropped on the shell's areas open in Blueline (shell preload webUtils.getPathForFile);
//   a drop on the deck view is blocked in the preload's capture phase so the page never sees it (9.1: a deck
//   view never gives main a path).
// main/watcher.ts: 9.2 Watcher exactly (fs.watch of the folder, 1 s stat poll, 150 ms settle, two reads 50 ms
//   apart, knownHash); onExternalChange(bytes, version).
// main/view-state.ts: 6.6 Reload: the deck view's scroll, hash, slide index and open card, saved before a
//   reload and restored after (the preload reports and applies it; the views item wires it).
// main/first-run.ts + shell/welcome.*: 6.0 First run (open a file, make Blueline the HTML app, try the sample
//   deck with a short tour, the user's name).
// main/cli-install.ts: 6.1 the command-line installer (link into ~/.local/bin, or /usr/local/bin after an
//   admin prompt); packages/cli: the shim that finds Node 22+ or says how to get it.
```

### views

Owns the window: deck view bounds, Fit (`setZoomFactor` from the design size and the view size; 100%; Fill
width), the document view (no zoom; View › Reading Width narrows the view to 960 px, remembered per file),
Present (full screen, chrome hidden, every key but Esc to the deck; Esc caught in `before-input-event`), the
rail (thumbnails from render-products, served to the shell through an `app://shell/thumbs/…` route that maps
only to files in the thumbnails cache; the outline from `h1`–`h3` for documents), the status bar (position,
zoom, trust, save state), the Find bar, the menus for every Phase 1 command, and wiring: trust-store and
folders into opening, the watcher into reload with view-state restore, recent files, drops, first run.

## Exit gate (SPEC 10, Phase 1)

- **Render parity:** at the design size, Blueline's render of each slide against the same Electron's plain
  render of the original file (no protocol, no preload), at most 0.5% of pixels different, on every slide of
  the committed fixtures and Josh's decks (SPEC asks for Chromium headless of the same version: Electron 44's
  own Chromium, with nothing of Blueline's loaded, is that). Both renders use the same viewport, scale, motion
  setting and settle steps (6.7 step 3). The per-pixel tolerance is stated in `docs/PHASE1-RESULTS.md`, and
  the exact-match count is reported next to it.
- **PDF:** the right page count, and each page within 1% of its slide render.
- **Security:** the suite passes in both trust states.
- **Speed:** a 2 MB deck reaches first paint in under 1 s (measured here on Linux; rechecked on a Mac).
- **Real use:** Josh uses Blueline as his HTML app for a week (needs a Mac build: `npm run dist` there).
