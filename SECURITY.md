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
