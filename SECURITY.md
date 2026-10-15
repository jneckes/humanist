# Security

Blueline opens HTML files from other people, so it treats every document as untrusted code (SPEC 9.9).
This file is completed before the first public release (SPEC Phase 6): the disclosure address depends on who
publishes Blueline (SPEC 13, question 4). Until then, report issues privately to the maintainer, not in a
public issue.

## How documents are contained

- Every deck runs sandboxed (`sandbox`, `contextIsolation`, no Node, `webSecurity`), in its own session
  partition, with every permission and device chooser denied, and with no navigation, popups or
  `file://` access. Files next to a deck are served from a second origin, so a page can show them but
  never read them (SPEC 9.1).
- Files from other people open in **Protected view** (SPEC 6.10): no network except `GET` of fonts, styles,
  scripts and images from a short CDN allowlist; `connect-src 'none'`; resource hints removed; a proxy
  that sends every other host to a closed port; WebRTC limited to proxied connections; storage cleared
  when the window closes.
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
   port, and UDP STUN and TURN are turned off, so no socket reaches the host. Removing `RTCPeerConnection`
   from the page does not help: a page gets it back from an `about:blank` iframe.

If this matters for a file, keep it closed, or open it with networking off for the whole computer. Settings
› Trust › "Block all network in Protected view" does not change these two channels.

Both are tracked as expected failures in `test/security/network.spec.ts`, so a fix shows up as a passing
test. Details: `docs/PHASE0-FINDINGS.md`.
