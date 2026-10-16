# Security fixtures (SPEC 6.10, 9.1, 9.9; section 10 Security fixtures; section 11 Security suite)

Decks that try to leave Blueline's sandbox. `test/security/*.spec.ts` opens each one in **both trust states**
(Protected via `--protected`, and Trusted) inside the real app and checks every attempt against the 6.10
table: in Protected view nothing may reach the test servers and no DNS query may be made for the fixtures'
unique names; in Trusted view only the allowed kinds (subresources, fetch, XHR) arrive, while navigation,
popups, permissions and local-file reads still fail.

The suite's verdict for the network comes from its own servers (`test/helpers/servers.ts`): a recording HTTP
and WebSocket server (which also logs every raw TCP connection, so a socket that sends no request, such as a
preconnect, is seen), a DNS server that answers `*.bl-attacker.test`, and UDP and TCP listeners. For local
files it comes from the page (whether it could read the bytes) and from main (the handler's status and
bytes). The servers listen on the machine's non-loopback address (the "sink IP", e.g. `192.0.2.2` in the dev
container), and the DNS zone resolves there, because a real attacker host is never loopback. Loopback is
checked on its own: a TCP listener on `127.0.0.1` (and on `[::1]` where the machine has IPv6) is the local
service `webrtc.html` tries to reach.

Every assertion has a positive control that shows the attempt ran and would have been seen: the same
fixture in Trusted view (the network fixtures, `hints.html`, `webrtc.html`), an in-folder file that must load
(`local-files.html`, `protocol-fuzz.html`), the same page with the Protected layers turned off
(`layers.html`), the same call with one handler loosened by the test in main (`permissions.html`: a
permissive permission request handler, and a permissive check handler that lets the device choosers show),
the same shell calls from the shell (`ipc.html`), a reload in the same window and a probe of the partition
while the document is open (`storage.html`), main's log of each navigation it cancelled (`navigation.html`,
`navigation-refresh.html`), or the page's own `<input>` (`card-snoop.html`) and focus in the card
(`card-exec.html`).

## Placeholders and the probe runtime

The files are templates. `test/helpers/security.ts` copies them into a temporary folder and substitutes:

| Placeholder | Value |
|---|---|
| `__BL_CFG__` | the run config JSON (`{uniq, zone, port, udp, tcp, loopTcp, loopTcp6, sink}`), assigned to `window.__BL_CFG` (`loopTcp6` is 0 without IPv6) |
| `/*__BL_PROBE__*/` | the inlined contents of `_probe.js` (the shared probe runtime) |
| `__BL_UNIQ__` | a label unique to the run and trust state (`p…` Protected, `t…` Trusted) |
| `__BL_ZONE__` | `bl-attacker.test` |
| `__BL_SINK__` | the sink IP (the test host by address) |
| `__BL_PORT__` / `__BL_UDP__` / `__BL_TCP__` | the HTTP, UDP and TCP listener ports |

`_probe.js` defines `window.__bl` with `results[name] = { kind, status, detail }` (status: `blocked`,
`leaked`, `ok`, `pending` or `unavailable`, an API the build lacks) and `phases[phase] = true`. Each network attempt uses its own host
(`<attempt>.__BL_UNIQ__.__BL_ZONE__`) or its own path, so whatever reaches a server names the attempt.

## Files

| File | What it tries |
|---|---|
| `_probe.js` | the shared probe runtime (inlined into every fixture; not served) |
| `network.html` | fetch, XHR, image beacon, static and script-inserted subresources, WebSocket, EventSource, `sendBeacon`, keepalive fetch, a form POST into an iframe, a remote iframe/object/embed/video, CSS `@import` / `@font-face` / background image, dynamic `import()`, a remote worker, WebTransport, `navigator.serviceWorker.register`, and beacons on `pagehide`/`visibilitychange` |
| `hints.html` | static and script-inserted `dns-prefetch`, `preconnect` (by name and by address), `prefetch`, `prerender`, a `<meta http-equiv=x-dns-prefetch-control content=on>`, a link (link DNS prefetch) and speculation rules. Run in both trust states: in Trusted view only `dns-prefetch` and `prefetch` make traffic in Electron 44, and the suite fails if another hint starts to (a tripwire) |
| `webrtc.html` | `RTCPeerConnection` with STUN and TURN (UDP, TCP and TLS) servers on the test host, by name and by address, and TURN over TCP to the loopback service (`127.0.0.1`, `localhost`, `[::1]`); in Trusted view the TURN Allocate arrives (positive control) |
| `local-files.html` | reads of sibling and outside files: `fetch('../…')`, a sibling `fetch`/XHR, `<iframe>`, `<object>`, canvas read, `cssRules`, a muted sibling script error, a module script, a worker, `.ssh/id_rsa`, `file:` and `app:` URLs; sibling media: plain and `crossorigin` `<video>` (webm, mp4) and `<audio>` (wav, ogg, mp3) by the document host, the `-files` host and `blueline-media://`, read with canvas `getImageData`/`toDataURL`/`captureStream` and Web Audio (`createMediaElementSource` + `AnalyserNode`); plus positive controls (a sibling image shown, plain media played, a canvas and an oscillator read back) |
| `protocol-fuzz.html` | crafted paths (percent-encoded, double-encoded, dot-segment, mixed case, Unicode look-alikes, backslashes, symlinks, dotfiles, other hosts) loaded as stylesheets; an outside file that takes effect is a leak. Positive controls: an in-folder stylesheet applies, directly and through a crafted in-folder path. The suite also requests the crafted paths through the handler from main and requires a 404 for each |
| `layers.html` | `blueline://` fetch, XHR, EventSource and `sendBeacon`, and `http` fetch, XHR, EventSource, WebSocket, `sendBeacon` and `<img>` to the test host; opened Protected with two of the three layers turned off at a time (`BLUELINE_TEST_DISABLE_LAYER`, test builds only), and with all three off as the positive control |
| `navigation.html` | `location` assign/replace/href, form submit (`_self`, `_top`), `window.open`, `reload`, a synthetic click, a custom scheme; and links for real clicks (http, mailto, local `.html`, `file:`, `<a ping>`) |
| `navigation-refresh.html` | `<meta http-equiv=refresh>` to the test host |
| `sibling-page.html` | the local `.html` the navigation fixture links to (opens in its own Blueline window) |
| `permissions.html` | `getUserMedia` (the suite adds a fake camera and microphone, so only the permission handler can refuse: NotAllowedError), `getDisplayMedia`, geolocation (records the error code), notifications, clipboard read, MIDI and `permissions.query`, rerun on demand under a prefix (`window.__blRunPermissions`) for the positive control with a permissive handler; `api-*` records which device APIs exist (`unavailable` is never a pass); `bluetooth`/`hid`/`serial`/`usb` `requestDevice` behind `#run-devices`, clicked with real input, and again behind `#run-devices-chooser` (results under `chooser-`) for the variant that lets the permission check through so the choosers show |
| `download.html` | a blob download and a `data:` download (real clicks), and a cross-origin `download` link |
| `storage.html` | `document.cookie` (read back after the write; recorded blocked, "document.cookie does not stick on blueline://", when it does not stick), `localStorage`, `sessionStorage`, IndexedDB and Cache Storage (recorded blocked with the browser's error), read at load and written after, for the reload, in-process and reopen checks |
| `ipc.html` | a plain Protected deck the forged-IPC test drives through `__blTestIpc` (the preload's isolated-world ipcRenderer in test builds): every deck channel and every shell channel |
| `ipc-second.html` | the other document of the forged-IPC test: it gets a real note, and note operations naming it from `ipc.html`'s deck must change nothing |
| `card-exec.html` | each time focus enters a note card (a new card, or one J reopens), `document.execCommand` `insertText`, `selectAll` + `delete`, `insertText` and `undo`, recorded in `data-exec-log` with each result and whether focus was in the card (the positive control); the saved note must not change (`test/security/card-input.spec.ts`) |
| `card-snoop.html` | capture and bubble listeners on `window` and `document` for every key and input-family event, recording each event's real target and data in `data-snoop`, and a capture `paste` handler that cancels pastes outside text fields; no event from a note card may be recorded and every paste into the card must land; typing into the page's own `<input>` is the positive control (`test/security/card-input.spec.ts`) |

The suite also writes, next to the rendered fixtures, the files they try to read (`test/helpers/security.ts`
`prepareFixtureFolder`): `sibling.css/.js/.mjs/.png/.svg`, `sibling-throws.js`, `sibling-worker.js`,
`fuzz-control.css`, the media (`clip.webm`, `clip.mp4`, `tone.ogg`, `tone.mp3` copied from `media/`, and a
`tone.wav` generated in Node), `confidential.txt`, a fake `.ssh/id_rsa` (+`.ssh/id_rsa.css`), symlinks that
lead outside the folder, and an `outside/` folder next to it. The outside files have extensions the `-files`
host serves (`.css`, `.js`, `.png`) and carry `OUTSIDE-<label>` in their bytes, so a path that escaped would
be served and recognised, not refused for its extension.

`media/` holds four tiny synthetic files made with ffmpeg (one second, no metadata), committed so the suite
needs no ffmpeg:

```
ffmpeg -f lavfi -i "color=c=0xC81E5A:s=32x32:d=1:r=10" -c:v libvpx -b:v 50k -pix_fmt yuv420p -an -map_metadata -1 -fflags +bitexact clip.webm
ffmpeg -f lavfi -i "color=c=0x1EC85A:s=32x32:d=1:r=10" -c:v libx264 -pix_fmt yuv420p -profile:v baseline -an -map_metadata -1 -fflags +bitexact -movflags +faststart clip.mp4
ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=8000" -c:a libvorbis -q:a 0 -map_metadata -1 -fflags +bitexact tone.ogg
ffmpeg -f lavfi -i "sine=frequency=440:duration=1:sample_rate=8000" -c:a libmp3lame -b:a 16k -map_metadata -1 -fflags +bitexact -write_xing 0 tone.mp3
```

## Test-only switch

`BLUELINE_TEST_DISABLE_LAYER` (a comma list of `csp`, `requests`, `proxy`) turns Protected layers off, so
`test/security/layers.spec.ts` can check each layer on its own (9.9). The app honours it only when
`BLUELINE_TEST=1` and the app is not packaged, and logs a `TEST ONLY` line when it does
(`packages/app/src/main/network-policy.ts`, `disabledProtectedLayers`).

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
