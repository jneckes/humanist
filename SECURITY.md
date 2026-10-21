# Security

Blueline opens HTML files from other people, so it treats every document as untrusted code (SPEC 9.9).
This file is completed before the first public release (SPEC Phase 6): the disclosure address depends on who
publishes Blueline (SPEC 13, question 4). Until then, report issues privately to the maintainer, not in a
public issue.

## How documents are contained

- Every deck runs sandboxed (`sandbox`, `contextIsolation`, no Node, `webSecurity`), in its own session
  partition, with every permission and device chooser denied, and with no navigation, popups or
  `file://` access. Files next to a deck are served from a second origin, so a page can show them but
  never read them (SPEC 9.1). Audio and video come from a third origin on a scheme that is not
  CORS-enabled, so a `crossorigin` `<video>` or `<audio>` cannot read them either.
- What you type, paste or dictate into a note card is kept from the page. The card is a `<textarea>` in the
  overlay's closed shadow root. The deck preload registers capture-phase listeners on `window` before any
  page script runs; they handle every key and input event that comes from the overlay (`beforeinput`,
  `input`, `textInput`, composition, clipboard, drag and drop, keys) and stop it there, so no listener of the
  deck sees it or can cancel it. The card saves an edit only when the browser announced it with a trusted
  `beforeinput`, so a deck cannot write into a note with `document.execCommand` (SPEC 9.1, 6.5).
  `test/security/card-input.spec.ts` checks both in each trust state.
- Files from other people open in **Protected view** (SPEC 6.10): no network except `GET` of fonts, styles,
  scripts and images from a short CDN allowlist; `connect-src 'none'`; resource hints removed; a proxy that
  sends every other host, `localhost` and loopback and link-local addresses included, to a closed port;
  WebRTC limited to proxied connections; storage cleared when the window closes.
- Electron is upgraded within 14 days of each Electron security release (SPEC 9.6).

## What Phase 1 added (Reader)

Every addition follows the rules above: nothing a deck sends is trusted, a deck view never gives main a path,
and main changes a file's trust only from the trust bar's buttons and Settings.

- **New shell pages.** Settings (`app://shell/settings.html`) and the welcome window (`app://shell/welcome.html`)
  follow 9.1 Shell view as the document shell does: their own sandboxed, context-isolated BrowserWindows in the
  `shell` session, the CSP as a response header and a `<meta>`, a preload whose `contextBridge` API is named,
  typed functions only, pages built with `textContent` (no `innerHTML`), and no navigation. Their channels
  (`bl:settings:*`, `bl:welcome:*`) are answered only for that window's own webContents.
  `test/security/trust-ipc.spec.ts` invokes every Settings channel from a Protected deck view and from a
  render-mode view: each is refused and nothing changes (config.json, trust.json, the document's trust).
- **Thumbnails** reach the shell through `app://shell/thumbs/<docId>/<name>`, which exists only in the shell
  session. Main maps the docId to that window's file itself and serves only a well-formed
  `<sha256>-<slide>-<width>.png` that is a regular file (no links) in that file's thumbnail cache, with
  `nosniff` and `no-store`; anything else under `/thumbs/` is a 404.
- **New IPC.** From the deck view: the measured design size, PageUp/PageDown steps and wheel pans (honoured only
  right after main saw the matching real input in `before-input-event` or `input-event`), the view state for a
  reload (scroll, hash, slide, open card and its draft; bounded field by field), the busy state, and a refused
  file drop (no payload). From the shell: view commands, rail clicks, scroll, Find, and files dropped on the
  shell (the shell preload reads the path with `webUtils.getPathForFile` in its isolated world; main checks each
  one again: absolute, an existing regular `.html`/`.htm` file, and opens it with its own trust state). Every
  payload is rebuilt field by field in main, as `ipc-guard.ts` does.
- **File drops.** A file dragged onto a deck view is refused before the frame's page sees it, in both trust
  states, in every frame the deck preload reaches (two kinds of frame a deck can build are the exception: see
  the known limit below). The deck preload runs in every frame (`nodeIntegrationInSubFrames`) and installs only
  the drop guard in a subframe: no overlay, no key router, no IPC (main refuses every message from a frame that
  is not the deck view's main frame). The top frame also guards the same-origin frames the subframe preload does
  not run in time for — an `about:blank` frame a script makes, guarded on its synchronous load event — and guards
  them again after `document.open()`. A refused drop on the top frame tells main only that one was refused, and
  the shell says where to drop it (a drop refused by the guard a subframe runs itself, in a `srcdoc`, `data:`,
  `blob:` or same-origin frame, shows no notice; it simply does nothing). `test/e2e/views-open.spec.ts` checks the main frame; `test/security/drop-frames.spec.ts` drops
  a local file onto srcdoc, `about:blank` (scripted and written), `data:`, `blob:`, same-origin, nested and
  `-files` frames, and in Trusted view a cross-origin `http` frame: no frame sees a File, and a text drag at the
  same point (the positive control) reaches each frame that can record it, which is every one but the `-files`
  frame (served with a CSP sandbox, so no script runs there to record anything). The test's drag (CDP
  `Input.dispatchDragEvent`) enters the page through the same browser-process calls as a drag from the desktop
  (`RenderWidgetHostImpl`'s `DragTargetDragEnter`, `DragTargetDragOver`, `DragTargetDrop`). Chromium's drag
  interception (`Input.setInterceptDrags`) is not used: it holds only drags the page itself starts, never one
  from the desktop, and a drag the deck started was held and never finished (no `drop`, no `dragend`), after
  which the deck took no keys (clicks were not tested; `test/e2e/views-drag-inpage.spec.ts`).
- **Trust memory** (`<userData>/trust.json`, mode 0600, atomic writes): Allow network, Enable editing and
  "received" per file realpath, each stored with the whole internet marker it was made on. A decision applies
  only while the file carries exactly that marker; a new download with a new marker drops it. Where the marker
  cannot tell two files apart, the decision is also bound to the file's identity (device, file number and birth
  time, from `fs.stat` with bigint) and applies only while the file at the path is that same file. That is the
  case for a file with no marker (Protected because it is in an untrusted folder) and for every file on
  Windows, where `Zone.Identifier` has no time or id, so two downloads of the same link or two Outlook
  attachments carry the same text. When a browser, mail client or sync tool saves another file over it, that
  file opens Protected with both switches off and the old decision is dropped. Blueline's own atomic writes
  re-bind the decision to the file they write. On macOS the quarantine value (a time and an event id per
  download) binds by itself. A decision is not stored when the marker or a needed identity could not be read.
  Nothing moves trust from one path to another. A malformed file or entry is ignored, never read as Trusted. A
  file opened in Protected view on request ignores remembered switches. trust.json is kept under 7 MiB, oldest
  decisions dropped first, so the next launch never ignores it.
- **A file that changes on disk is decided again.** On every external change, and when a file that went away
  comes back, Blueline decides 6.10 again for the file as it is on disk, the same way an open does (the
  marker, the trusted and untrusted folders, trust.json), and reads the marker once more 500 ms later, because
  some browsers write it just after the rename. If the decision differs (trust state, reason, marker, whether
  the marker could be read, or, in a Protected window, a remembered Allow network or Enable editing), the view
  is not reloaded in place: the window closes and the file opens again at the same place, with its view state,
  a fresh docId and the partition its trust needs, and the trust bar states the new reason. There are two
  exceptions (`view-state.ts` `trustDifferences`, `reopenForTrust`). A change from one Trusted decision to
  another (a different marker, or one that now can or cannot be read; for example a marked download saved over
  an unmarked file in a trusted folder) reloads in place: a Trusted file keeps its docId and partition on every
  open, and Trusted view has network and editing on, so opening it again would give the same window. And a
  window opened Protected on request does not compare the switches (Known limits, below). Blueline's own writes
  never reach this path (it knows their hash). `test/e2e/views-reload-trust.spec.ts`.
- **`blueline pdf` and `blueline map` decide trust as the app decides an open**: `--protected`, then the
  trusted and untrusted folders, then the internet marker. Their partition policy uses "Block all network in
  Protected view" and the CDN allowlist from Settings › Trust. They read the user's config.json
  (`BLUELINE_USER_DATA` when set, else the app's own userData, `<appData>/Blueline`) and never write it. They
  never read or write trust.json, so a remembered Allow network or Enable editing never applies to them (the
  stricter direction). The PDF of a Protected deck is marked as a derived file. Their own Chromium data stays
  in a private folder. `test/e2e/command-trust.spec.ts`.
- **Trusted and untrusted folders** (Settings › Trust): a marked file in a trusted folder opens Trusted; an
  unmarked file in an untrusted folder opens Protected; the deepest folder wins, and untrusted wins a tie.
  Blueline refuses to trust the home folder, Desktop, Downloads, temporary and mail folders, any folder that
  contains one of them, mount points (`/Volumes`, `/mnt`, `/media`), drive and share roots. Trusted folders
  match exactly; untrusted folders also match case-insensitively on macOS and Windows (the safe direction).
- **Settings › Trust** also holds "Block all network in Protected view" (the CDN exception off too) and the CDN
  allowlist (editable, reset to the defaults); a change applies at once to every open document's partition.
- **Derived files keep the marker** (9.9): a Save as PDF output and the `blueline map` probe copy get the
  document's marker (on macOS through the native helper, on Windows a copy of `Zone.Identifier`); a copy of a
  Protected document that has no marker gets a new one naming the document. A marker that cannot be written
  fails the save and leaves whatever was at the output as it was: the PDF is marked on its temporary file,
  before the rename, and the probe copy right after its exclusive create, before any byte of the deck is
  written. One exception: Save as PDF to a Windows volume that keeps no named streams (FAT, exFAT, some
  shares) saves the PDF without a `Zone.Identifier`, as Windows does for its own downloads there; HTML copies
  (the probe copy) are still refused on such volumes. A consequence for `blueline map`: a deck that opens
  Protected without a marker (an untrusted folder, or `--protected`) on such a stream-less Windows volume
  cannot be given a marked probe copy, so the probe does not run and map reports its coverage as "NOT verified"
  rather than copy an HTML deck that could then open Trusted. The probe copy would sit in the same untrusted
  folder and open Protected anyway, so refusing it costs only the probe, not safety (decision D-3, D-14).
- **Print** of a raster deck shows a print-only page of the slide images, served from app data to a hidden
  window in a partition of its own that runs no script and reaches no network.
- **The macOS helper** (`native/macos`) is a long-lived child of main speaking JSON lines: absolute paths only,
  size caps on every request and line, a timeout per request; it ships in `Resources/helper` and is signed with
  the app. Without it, main uses `/usr/bin/xattr` for the marker and says so.
- **The Windows installer** (`packages/app/build/installer.nsh`) writes the `Blueline.HTML` ProgID (its
  command quotes the executable and the file), `OpenWithProgids` for `.html` and `.htm`,
  `Software\Blueline\Capabilities` and the `RegisteredApplications` value in the install mode's hive (per user
  or per machine), so Blueline appears in Default Apps. It never writes or clears an extension's own default
  value: electron-builder's NSIS file associations are not used (`fileAssociations` are macOS's only). An
  uninstall removes exactly those keys and values; an update keeps them; a per-machine install also removes the
  per-user copy that the installing user's earlier per-user install left (only that user's hive is reached).
  Not run on Windows; under Wine 9, a per-user install, then a per-machine install, then the uninstall left no
  Blueline key in either hive.

Known limits added by Phase 1:

- **A marker written after the change.** Some browsers write the internet marker just after the rename. When
  the first decision after an external change finds the file unchanged in trust, the view reloads in place and
  the marker is read **once more**, 500 ms later; a marker found then opens the file again in Protected view,
  but the new content has run under the old trust until then (measured: about 1.2 s after the rename, with 2
  requests to a test server first). A marker written **later than that** (a slow antivirus or Zone.Identifier
  write) is not seen while the window stays open: the file is decided again only on the next external change or
  the next open. The two reads cover the common case; Blueline does not poll the marker indefinitely.
- **A window opened Protected on request keeps its switches on an in-place reload, and remembers them.** A
  window opened in Protected view on request (`--protected`, File › Open in Protected View) never uses
  remembered switches: it opens with Allow network and Enable editing off. When the user turns either on in it,
  the switch is remembered in trust.json as in any Protected window (for the file's marker, and its identity
  where the decision is bound to the file), so it applies at the next ordinary open of that file that opens
  Protected (a marked file, or an unmarked one in an untrusted folder). The decision for such a window is always
  Protected with the reason "Opened at your request", so on an external change only a change in the marker, or
  in whether the marker could be read, reopens it, which turns the switches off. Any other change reloads it in
  place and keeps them: also when the folder lists would now open the file Trusted, and when the change is a
  new unmarked file saved at the path. An ordinary agent save of an unmarked file is such a change, so the
  switches survive it.
- **A file written in place keeps its decision.** A program that writes new content into the existing file,
  instead of saving a new file, keeps the file's identity, and on Windows it can keep the same
  `Zone.Identifier` text (on macOS the quarantine value stays the same in that case too), so the file keeps a
  remembered Allow network or Enable editing.
- **A file dropped onto a frame a deck rewrites with `document.open()`, or onto a frame a deck makes
  `about:blank` inside a shadow root, can be read by the deck.** Neither frame can be reached by a renderer-side
  guard before the deck's own capture listener. For `document.open()` the guard's listeners are erased and
  re-added only from a MutationObserver callback, after the scripts the deck wrote in have run. For a
  shadow-nested `about:blank` frame, `window.frames` does not list it, its load event does not cross the closed
  shadow boundary, and the subframe preload does not run in an initial `about:blank` document (PHASE0-FINDINGS
  F11), so no code runs in it before the deck's own script. In both cases a capture listener the deck registers
  comes first, can accept the drop and can read the dropped file, in both trust states. This holds for a real
  drag from the desktop: it reaches the page through the same browser-process calls as the security suite's
  `Input.dispatchDragEvent`, and Electron 44 gives main no event to cancel a drop before the renderer sees it.
  So a deck built for it can read a file the user drops on it, although Blueline asks for files on the toolbar
  and rails. In Protected view such a deck has no network to send it on beyond what Protected view always
  allows: `GET` requests to the CDN allowlist (unless "Block all network in Protected view" is on) and the two
  DNS channels below. Do not drop files onto a document's page. Both cases are tracked as expected failures in
  `test/security/drop-frames.spec.ts`.

- Render windows (thumbnails, the slide index, PDF pages) use the document's own partition and origin, as 9.1
  says, so they share its storage: a deck that keeps its current slide in `localStorage` sees the background
  walk's last slide on its next load (and keeps it, for a Trusted file).
- The local dogfooding build (`npm run dist` without signing credentials) is signed ad hoc, without the hardened
  runtime, and not notarized. It is for the machine that built it, not for distribution.

## What Phase 2 added (Edit)

Phase 2 is the first time Blueline writes the user's file. The rule is the same as before: nothing a deck sends is
trusted. A deck view never names a path, a file offset or a write record; it can only ask main to change the text of
one run of the version it shows, and only right after the user pressed a key or the mouse in it.

- **The edit channels** (deck view → main, `core/ipc-edit.ts`): `bl:edit:begin` (a field opened: its id, the page's
  version, the run ids of its text nodes), `bl:edit:commit` (the field's result: a run id with the run's whole text
  before and after, or the field's text for a verbatim note, plus the target's CSS path and text for the note),
  `bl:edit:candidates` (the picker asks for the candidates of runs the matcher named), `bl:edit:undo` (the toast's
  Undo: a 128-bit token, never a record) and `bl:edit:busy`. Main answers each only from the deck view's main frame
  and rebuilds every payload field by field (`ipc-guard.ts`): sizes in UTF-8 bytes, no lone surrogates, run ids,
  versions and tokens by format, kinds from fixed lists, at most 512 run ids per field and 50 per picker request.
  Main → deck: the result, the candidates (built by main from its own map of that version: ±40 characters of
  context, the line, a key warning), and what an app undo changed.
- **The trusted-input rule (P2-7).** Main takes a `begin` only in Edit, with Edit available (the Edit capability,
  editing allowed, a UTF-8 file that is still there), and only when the deck view received a real press within the
  last 2 s: Electron's `input-event`, which reports only input the browser process dispatched (the OS, or main's own
  `sendInputEvent`), never a page script's. A press made while a commit of that view was unanswered counts from
  that commit's answer instead (E-1: the field it opens waits for the answer, which on a large deck can come later
  than 2 s after the press). Each press opens at most one field. A `commit` is taken only for a field
  main accepted and still authorises, for the version that field opened on, and for an edit only to one of that
  field's runs. A field's authorisation ends when it closes (its commit is taken, or the deck reports no field
  open), when a newer field begins (the deck has one open field), when the view leaves Edit, and after 10 minutes
  without trusted input in that view. One commit outlives those last two: the one main itself asks for (E-2: the
  view leaves Edit, the window closes, the app quits, or a click in the shell takes focus from the deck view) is
  taken for 5 s after the request, so the words of a user who typed, walked away and then closed the window are
  kept. When
  main accepts a commit it checks Edit, the capability and editing allowed **at that moment**; the queue checks the
  capability and editing allowed once more just before the rename (`canWrite`), not the mode, so a commit accepted
  in Edit is written even if the user switches mode while it waits. Anything else is dropped before the queue,
  without a note or a session write, so a forged message changes nothing on disk or in app data. One exception keeps
  the user's words: a commit main accepted and still authorises that cannot be written because the file just went
  away, stopped being UTF-8 or became Protected is kept as a verbatim note with its exact texts (app data only).
  The picker's request and the toast's Undo need Edit and a press within 2 s too.
- **What a write can be.** Main turns a commit into an `EditRequest` (version, run id, the run's text before and
  after); the write queue re-reads the file and places the run by position: when the file changed since that
  version, a diff of that version to the current bytes maps the run's range, and the run must be unchanged there
  (neither its text nor the 32 characters of context around it ever chooses between copies). When the text is in
  several places, the diff must also account for every copy, each told apart from the others by text it left
  unchanged around it, and no other copy may carry the edited one's surroundings (editor/place.ts): a moved or
  copied templated slide is a note, never a write into another slide. A version the queue does not hold, a diff
  that runs out of time, a change that overlaps the run, or a place the text around it does not confirm makes the
  commit a verbatim note. Main keeps the
  version of every open field and of the page shown until its commit is answered. The queue then plans the smallest
  splice inside that run, encodes it (`&` and `<` as references in
  HTML text; the 9.2 escapes in a literal; `<` or `&` into a plain literal, which a page may set as HTML, becomes a
  note instead), and verifies the exact bytes before they are renamed in: the run holds the new text, nothing else
  moved, no new parse error, and for literals the script still parses, the literal cooks to the new text and the
  script ranges are unchanged (decision P2-1). A bad file never lands. Whatever the queue cannot place or verify
  becomes a `verbatim` note with the user's exact words, and the file stays byte-identical.
- **What a deck cannot make Blueline write:** anything outside one run's text; markup (it is always encoded or
  escaped); a write in Read or Review, in Protected view before Enable editing, in a reader-only build, or to a file
  that is not UTF-8; a write to another file (main writes only the realpath it opened); an undo record (main holds
  the records; the deck names a token, and main checks it is the window's latest undoable write); a history restore
  (the shell's history list only, after a native confirmation). **What it can:** a compromised page in a Trusted (or
  Enable-editing) file in Edit can, within 2 s of a real press of the user's, open a field, and while that field stays
  authorised (above) commit a change to one run of the version it opened on; it can also press the toast's Undo
  within 2 s of a press. Such a write is still exactly one run's text, verified, an edit note with its lock, undoable
  byte for byte and in the history (Known limits below).
- **The edit field's input gate** (P2-7, P2-9), like the note card's: capture listeners registered at preload start
  keep page listeners from seeing the field's keys, input, paste, drop, composition and selection events. The field
  accepts a change only when a trusted `beforeinput` announced it; a change made any other way (a page's
  `document.execCommand`, a script setting the text) is put back, and native undo is then off for that field.
  Native undo and redo work only within the field's own steps, so Cmd+Z in a field never reaches an earlier,
  already written edit. A press that opens a field never reaches the page (no click-to-advance, no link). If the
  page re-renders or removes the open field, what was typed becomes a verbatim note. Dragging selected text moves
  it only within the field (the input over SVG text included): the deletion at the source is allowed only when the
  drop landed inside the field, so a drag into the page's own editable element copies the text there and takes
  nothing out of the field. While a press waits for the page's unanswered commit before its field opens (E-1), the
  keys typed meanwhile are kept from the page (the key router, at window capture) and typed into the field once it
  opens, through the field's own gate, at the caret in one of its text nodes: only characters of trusted key events,
  Backspace over them and Enter; any other key (an arrow, Delete, a paste, an IME) stops that and the author is told.
- **History** (P2-11): before every write of the deck (edit, undo, redo, Restore), the bytes it replaces are kept in
  `<userData>/files/<fileKey>/history/<sha256>.html`, files mode 0600 in a 0700 folder, the newest 100 within
  256 MiB per document, deduplicated by sha256, listed in an `index.json` written atomically. A Protected document's
  snapshots carry its internet marker (macOS and Windows; 9.9), so a snapshot opened from Finder opens Protected.
  A snapshot is read back only when its size and sha256 match its name, so a damaged or swapped file is never
  restored. `blueline map`'s probe writes through a queue with no history.
- **New shell calls** (`bl:shell:*`): a toast button (main-minted token and action id, checked against the toast
  shown last), Copy of a note (main writes the clipboard; the shell has no clipboard permission), the name chip,
  and the history list's close and Restore. Each is refused from a deck view (`test/security/forged-ipc.spec.ts`).
  Settings › General › Smart punctuation (`bl:settings:set-smart-punctuation`) is answered only for the Settings
  window's own shell (`test/security/trust-ipc.spec.ts`).
- **Spelling suggestions** (6.3): in Edit, with a field open, a right-click on a word the spellchecker marks shows a
  native menu of the dictionary's suggestions only (at most 8, each at most 100 characters). Choosing one calls
  `replaceMisspelling`, which reaches the field as `insertReplacementText`, a change the field's gate allows. The
  suggestions come from the deck's renderer, so a compromised one can choose the words, but only for its own field
  and only when the user picks one. The page's own `contextmenu` listeners do not see a right-click in the field,
  an SVG text field's overlay input included (seen from the page, its right-click lands on the overlay host).
- **Commit requests from main** (`bl:edit:commit-now`): before a window closes, the app quits, or a click in the
  shell takes focus from the deck view (also the click that brings an inactive window back), main asks the deck to
  commit its open field; before a close or a quit it waits for the answer (at most 3 s). The answer is an ordinary
  `commit`, checked as above, and taken for 5 s after the request even when the field's authorisation otherwise
  ended (Known limits).

`test/security/edit-forged.spec.ts` forges every edit message from a Trusted deck in Edit (begin, commit with an
edit, a verbatim note, a pick and a no-op, candidates, undo tokens, busy) and from a Protected one right after a
real click: nothing is written, no note appears; the positive control (a real click, keys and Enter) writes, and
replaying its real token with no press does nothing. `edit-expiry.spec.ts` banks fields on real presses and commits
them after Read, after the idle limit, and after a newer field: nothing is written and app data does not change; and
it pins the one exception (a banked field idle past the limit gets the single commit a File › Close asks for, and a
second commit of it is refused).
`forged-ipc.spec.ts` covers every deck and shell channel, the edit ones included.

Known limits added by Phase 2:

- **A page can ride a real press.** A compromised page can open a field within 2 s of a real press in Edit (main
  cannot see where in the page the press landed), or press the toast's Undo then. It can commit a change to one run
  for as long as that field stays authorised: until a newer field begins, the deck reports no field open, the view
  leaves Edit, or 10 minutes pass without trusted input in that view. The page controls the first two, so the bound
  is leaving Edit or 10 minutes without input, with one exception: such a field, idle or not, also gets the one
  commit main asks for when the user leaves Edit, closes the window, quits, or clicks in the shell (taken for 5 s
  after that request; `test/security/edit-expiry.spec.ts` V-close). That exception is what keeps a real user's
  words after a pause; the cost is that a page holding a banked field gets that one commit too. It is one commit
  per request, in Edit, to one run, recorded and undoable.
- **A deck that does not answer before close or quit.** Before a window closes or the app quits, main asks the deck
  to commit its open field and waits at most 3 s. If the deck cannot answer in time (a hung page), the window closes
  anyway: nothing is written, and main keeps nothing it did not receive.
- **A page can move the selection inside an open field** (within one run), and the user's next keystroke replaces
  it, as with the note card. Text inserted through the accessibility API fires no `beforeinput`, so the field
  refuses it. Wispr Flow pastes with Cmd+V, which works.
- **The window between the re-hash and the rename** (9.2 Atomic write): another program's write that lands after
  Blueline re-hashed the deck and before it renamed its temp file over it is lost. A write any time before the
  re-hash is caught, and Blueline's write is requeued on top of it.
- **History snapshots on Linux** carry no marker (Linux has none), so a Protected document's snapshot opened
  directly from the history folder opens Trusted there, as an unmarked download does.

## Known channels in Protected view

SPEC 9.9 measures "zero escapes" against the security suite (`npm run test:security`). The suite finds two
channels that Electron 44 offers no way to close. In both, a Protected deck can make the computer look up a
host name the deck chooses, so the attacker's DNS server can learn that name (and any data encoded in it,
up to about 250 characters per lookup). No connection, packet or request reaches the attacker's host, and
nothing from the computer is readable by the page.

1. **Script-inserted DNS prefetch.** A `<link rel="dns-prefetch">` that a script adds after the page loads
   is resolved. Blueline removes resource hints that are in the file and sends
   `X-DNS-Prefetch-Control: off`, but Chromium honours neither for a link element added later, and the
   lookup does not go through the Protected proxy.
2. **WebRTC TURN server names.** `RTCPeerConnection` resolves the host name of a TURN server reached over
   TCP or TLS before it tries to connect. The connection itself goes through the Protected proxy to a closed
   port, for every host including `localhost`, `127.0.0.0/8`, `[::1]` and link-local addresses, and UDP STUN
   and TURN are turned off, so no socket reaches the host or a service on the computer. (Before the Phase 0
   review the proxy was a PAC script, which Chromium skips for loopback hosts, so TURN over TCP could reach
   local services; the proxy is now `fixed_servers` with `<-loopback>`.) Removing `RTCPeerConnection` from the
   page does not help: a page gets it back from an `about:blank` iframe.

If this matters for a file, keep it closed, or open it with networking off for the whole computer. Settings
› Trust › "Block all network in Protected view" does not change these two channels.

Both are tracked as expected failures in `test/security/network.spec.ts`, so a fix shows up as a passing
test. Details: `docs/PHASE0-FINDINGS.md`.

## Known limits of the note card

These hold in both trust states.

1. **A deck that rewrites itself with `document.open()`.** `document.open()` removes every event listener in
   the page, the preload's included. The preload adds them back as soon as it sees the new document, but a
   script that the deck writes into the new document runs first: a capture listener it registers while
   `document.write()` runs sees the keys and input events of a note card before the preload's listeners do,
   and could cancel them. The card still saves what the user enters, and `document.execCommand` still cannot
   write into it. The fix is SPEC 6.2's fallback, moving the key router to main's `before-input-event`.
   Tracked as an expected failure in `test/e2e/card-input.spec.ts`.
2. **A deck can select the text in an open card.** `document.execCommand('selectAll')` selects the card's text
   without changing it; the user's next keystroke, paste or dictation then replaces the selected text. The
   selection is visible, and the change is an edit the user made, so it is saved.
3. **Input that skips `beforeinput` is refused.** The card refuses any change the browser did not announce
   with a trusted `beforeinput`. Typing, input methods, dictation, paste (Wispr Flow's Cmd+V), drag and drop,
   cut, spellcheck replacement and native undo and redo all announce it. A tool that sets a text field's value
   through the accessibility API does not, so it cannot write into a card.
