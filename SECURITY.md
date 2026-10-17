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
  payload is rebuilt field by field in main, as `ipc-guard.ts` does. A file dropped on the deck view is stopped
  in the deck preload's capture phase before the page sees it (`test/e2e/views-open.spec.ts`).
- **Trust memory** (`<userData>/trust.json`, mode 0600, atomic writes): Allow network, Enable editing and
  "received" per file realpath, each stored with the whole internet marker it was made on. A decision applies
  only while the file carries exactly that marker; a new download of the file drops it. Nothing moves trust
  from one path to another. A malformed file or entry is ignored, never read as Trusted. A decision is not
  stored when the marker could not be read. A file opened in Protected view on request ignores remembered
  switches. `blueline pdf` runs with a private app-data folder, so remembered decisions never apply to it.
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
  fails the save.
- **Print** of a raster deck shows a print-only page of the slide images, served from app data to a hidden
  window in a partition of its own that runs no script and reaches no network.
- **The macOS helper** (`native/macos`) is a long-lived child of main speaking JSON lines: absolute paths only,
  size caps on every request and line, a timeout per request; it ships in `Resources/helper` and is signed with
  the app. Without it, main uses `/usr/bin/xattr` for the marker and says so.
- **The Windows installer** (`packages/app/build/installer.nsh`) writes the `Blueline.HTML` ProgID,
  `OpenWithProgids` for `.html` and `.htm`, `Software\Blueline\Capabilities` and `RegisteredApplications` in
  the install mode's hive (per user or per machine), so Blueline appears in Default Apps; an uninstall removes
  them, an update keeps them. Not run on Windows yet.

Known limits added by Phase 1:

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
