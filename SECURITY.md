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
