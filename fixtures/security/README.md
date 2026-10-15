# Security fixtures (SPEC 6.10, 9.1, 9.9; section 10 Security fixtures; section 11 Security suite)

Decks that try to leave Blueline's sandbox. `test/security/*.spec.ts` opens each one in **both trust states**
(Protected via `--protected`, and Trusted) inside the real app and checks every attempt against the 6.10
table: in Protected view nothing may reach the test servers and no DNS query may be made for the fixtures'
unique names; in Trusted view only the allowed kinds (subresources, fetch, XHR) arrive, while navigation,
popups, permissions and local-file reads still fail.

The suite's verdict for the network comes from its own servers (`test/helpers/servers.ts`): a recording HTTP
and WebSocket server, a DNS server that answers `*.bl-attacker.test`, and UDP and TCP listeners. For local
files it comes from the page (whether it could read the bytes). The servers listen on the machine's
non-loopback address (the "sink IP", e.g. `192.0.2.2` in the dev container), and the DNS zone resolves there,
because Chromium bypasses the Protected proxy for loopback — a real attacker host is never loopback.

## Placeholders and the probe runtime

The files are templates. `test/helpers/security.ts` copies them into a temporary folder and substitutes:

| Placeholder | Value |
|---|---|
| `__BL_CFG__` | the run config JSON (`{uniq, zone, port, udp, tcp, sink}`), assigned to `window.__BL_CFG` |
| `/*__BL_PROBE__*/` | the inlined contents of `_probe.js` (the shared probe runtime) |
| `__BL_UNIQ__` | a label unique to the run and trust state (`p…` Protected, `t…` Trusted) |
| `__BL_ZONE__` | `bl-attacker.test` |
| `__BL_SINK__` | the sink IP (the test host by address) |
| `__BL_PORT__` / `__BL_UDP__` / `__BL_TCP__` | the HTTP, UDP and TCP listener ports |

`_probe.js` defines `window.__bl` with `results[name] = { kind, status, detail }` (status: `blocked`,
`leaked`, `ok` or `pending`) and `phases[phase] = true`. Each network attempt uses its own host
(`<attempt>.__BL_UNIQ__.__BL_ZONE__`) or its own path, so whatever reaches a server names the attempt.

## Files

| File | What it tries |
|---|---|
| `_probe.js` | the shared probe runtime (inlined into every fixture; not served) |
| `network.html` | fetch, XHR, image beacon, static and script-inserted subresources, WebSocket, EventSource, `sendBeacon`, keepalive fetch, a form POST into an iframe, a remote iframe/object/embed/video, CSS `@import` / `@font-face` / background image, dynamic `import()`, a remote worker, WebTransport, `navigator.serviceWorker.register`, and beacons on `pagehide`/`visibilitychange` |
| `hints.html` | static and script-inserted `dns-prefetch`, `preconnect`, `prefetch`, `prerender`, a `<meta http-equiv=x-dns-prefetch-control content=on>`, a link (link DNS prefetch) and speculation rules |
| `webrtc.html` | `RTCPeerConnection` with STUN and TURN (UDP, TCP and TLS) servers on the test host, by name and by address |
| `local-files.html` | reads of sibling and outside files: `fetch('../…')`, a sibling `fetch`/XHR, `<iframe>`, `<object>`, canvas read, `cssRules`, a muted sibling script error, a module script, a worker, `.ssh/id_rsa`, `file:` and `app:` URLs; plus positive controls (a sibling image shown) |
| `protocol-fuzz.html` | crafted paths (percent-encoded, double-encoded, dot-segment, mixed case, Unicode look-alikes, backslashes, symlinks, dotfiles, other hosts) loaded as a stylesheet and read as bytes; any outside file that takes effect is a leak |
| `navigation.html` | `location` assign/replace/href, form submit (`_self`, `_top`), `window.open`, `reload`, a synthetic click, a custom scheme; and links for real clicks (http, mailto, local `.html`, `file:`, `<a ping>`) |
| `navigation-refresh.html` | `<meta http-equiv=refresh>` to the test host |
| `sibling-page.html` | the local `.html` the navigation fixture links to (opens in its own Blueline window) |
| `permissions.html` | `getUserMedia`, `getDisplayMedia`, geolocation, notifications, clipboard read, MIDI, `permissions.query`, and `bluetooth`/`hid`/`serial`/`usb` `requestDevice` behind a button clicked with real input |
| `download.html` | a blob download and a `data:` download (real clicks), and a cross-origin `download` link |
| `storage.html` | `document.cookie`, `localStorage`, `sessionStorage`, IndexedDB and Cache Storage, read at load and written after, for the reopen check |
| `ipc.html` | a plain Protected deck the forged-IPC test drives through `__blTestIpc` (the preload's isolated-world ipcRenderer in test builds) |

The suite also writes, next to the rendered fixtures, the files they try to read (`test/helpers/security.ts`
`prepareFixtureFolder`): `sibling.css/.js/.mjs/.png/.svg`, `sibling-throws.js`, `sibling-worker.js`,
`confidential.txt`, a fake `.ssh/id_rsa` (+`.ssh/id_rsa.css`), symlinks that lead outside the folder, and an
`outside/` folder next to it.

## Known channels (tracked)

Two Protected-view channels are detected by the suite and cannot be closed with Electron 44's APIs. 9.9 allows
Phase 0 to state such a channel instead of mitigating it; both are stated in `SECURITY.md` and
`docs/PHASE0-FINDINGS.md`, and each stays a `test.fail()` so a fix shows up as a pass:

- a script-inserted `<link rel="dns-prefetch">` makes a DNS lookup of its host name (the served-copy strip and
  the `X-DNS-Prefetch-Control` header cover only parse-time hints);
- `RTCPeerConnection` resolves the host name of a TURN-over-TCP or TLS server before the (dead, proxied)
  connect. No socket reaches the test host, and UDP STUN/TURN names are not resolved.

Only a host name leaves in either case: no packet, connection or request reaches the test host.

Resolved in Phase 0: a Trusted deck's storage is kept per file across reopen. Its docId (and so its origin
`blueline://<docId>`) is random but generated once per file and kept in `<userData>/files/<fileKey>/origin`.
