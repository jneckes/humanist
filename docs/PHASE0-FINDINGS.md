# Phase 0 findings

Each entry: the question from SPEC.md, what was checked, the result, and what the code does about it.

**Environment for every automated check.** Linux container (kernel 6.18), Electron 44.7.2 (Chromium
152.0.7977.149, Node 24.21.0), Xvfb with a 3840×2160 screen. `blueline map`, and the E2E tests that run the
`blueline` command, start the app as root with `--no-sandbox` (a development convenience). The E2E tests that
launch the app with Playwright, and the security suite, run it as the unprivileged user `bltest` with the OS
sandbox on (proven from `/proc`: seccomp mode 2, `no_new_privs`, its own user namespace); the security suite
also runs it inside a private mount namespace whose `resolv.conf` points at the suite's DNS server, so DNS
lookups are observable. `blueline check --auto` was run both ways with the same results. macOS behaviour
(Wispr Flow, the quarantine marker, Retina capture) is checked on Josh's Mac with the Diagnostics window; see
Still open.

Commands (final run after review round 1, 2026-10-16, from a clean `dist`): `npm run build:reader-only`, `npm
run build`, `npx tsc -p tsconfig.json --noEmit`, `npx vitest run`, `npm run test:e2e`, `npm run test:security`,
`node packages/cli/dist/blueline.cjs check --auto`, and `blueline map <deck> --report --json` on a copy of
every committed fixture. Numbers are in README.md and in each entry below. What the review found and fixed is
under Review round 1, at the end; its new entries, F18 to F24, sit in the sections they belong to.

## Keys and input

### F1. The preload's capture listener runs first, and its `stopImmediatePropagation()` stops the deck (6.2)

- **Check.** Diagnostics `key-order` and `stop-propagation` (automatic): a trusted key (`sendInputEvent`) to
  the reveal.js Diagnostics deck, whose own capture listeners on `window` and `document` record each keydown
  in `data-bl-key-log`. In Read, Shift must reach the preload before the deck; in Review, `V` (a shortcut the
  router consumes) must never reach the deck's listeners. Also `test/e2e/preload-electron.spec.ts` (the
  capture listener runs first; main-world listeners stopped) and the reveal fixture's key log.
- **Result.** Pass. The isolated world's capture listener on `window`, registered before any page script,
  runs before the page's own capture listeners on `window` and `document`, and `stopImmediatePropagation()`
  called there stops the main world's listeners (`pageListenerRan: false`). The probe reads the end of each
  keydown's dispatch synchronously (a bubble-phase `keydown` listener on `window`), so two keys sent with no
  gap, such as Wispr Flow's Cmd+V, no longer log a false `first: 'page'` (review finding 15;
  `test/unit/preload/diagnostics-hooks.test.ts`, `test/e2e/preload-electron.spec.ts`). The automatic
  `key-order` step presses one key and was not affected.
- **Code.** The key router stays in the preload (`packages/app/src/preload/key-router.ts`). The
  `before-input-event` fallback 6.2 describes is not needed for single-letter keys. Main still takes the app
  chords in `before-input-event` (F2).

### F2. App chords work on a page that calls `preventDefault()` on every keydown (6.2)

- **Check.** `fixtures/decks/keys-prevent-default.html` in a real document window
  (`test/e2e/reader.spec.ts`), and Diagnostics `app-chords` on a page whose capture listener swallows every
  key.
- **Result.** Pass. Cmd/Ctrl+1/2/3 switch modes and never reach the page (its `data-page-keys` log shows
  none of them); ArrowRight still reaches it.
- **Code.** `packages/app/src/main/chords.ts` matches exactly the app chords in `before-input-event` on the
  deck view and calls `event.preventDefault()` there; every other chord passes through (Wispr Flow's Cmd+V).

### F3. `sendInputEvent` reaches an offscreen deck while the visible window keeps focus (6.7)

- **Check.** Diagnostics `offscreen-keys`: the render service presses ArrowRight in a hidden offscreen render
  window (reveal.js deck) while a visible window holds focus.
- **Result.** Pass: `via: input`, `delivered: true`, slide 1 → 2, and the visible window was focused before
  and after (`focusedIsVisible: true`). `blueline map` relies on the same path: every generic deck in the
  fixtures was walked with trusted keys (`keys: trusted input`).
- **Code.** `RenderView.pressKey` calls `webContents.focus()` on the render window, then sends `keyDown` and
  `keyUp` with Accelerator key names. It keeps the synthetic `KeyboardEvent` fallback (with `navOk: false`
  for a deck that ignores untrusted keys) for platforms where trusted keys do not arrive. Whether a key reached
  the deck is read from the render agent's keydown counter (`RenderCmd keydowns`). The counter is a window
  capture listener that the deck preload registers at preload start, before any page script, so a page
  listener that calls `stopImmediatePropagation()` cannot hide a key from it. A trusted press that moved the
  deck never switches later presses to the synthetic fallback, and every load starts over (review finding 33;
  `fixtures/map/stopimm.html`).

### F18. Card input is the overlay's alone: the input guard (6.2 step 2, 6.5, 9.1 Preload; review findings 9, 11, 13)

- **Check.** `test/security/card-input.spec.ts` (`fixtures/security/card-exec.html`, `card-snoop.html`, both
  trust states), `test/e2e/card-input.spec.ts`, `test/e2e/preload-electron.spec.ts`,
  `test/unit/preload/input-guard.test.ts`.
- **Result.** Before the fix, a deck's capture listeners on `window` and `document` read every character
  typed, pasted or dictated into a card: `beforeinput`, `textInput`, `input` and `paste` are composed and reach
  `window` retargeted to the overlay host before the shadow root's own bubble-phase listeners run. A capture
  `paste` handler that cancels pastes outside text fields silently dropped Wispr Flow's text. And
  `document.execCommand('insertText' | 'delete' | 'selectAll' | 'undo')` from the page edited the focused card:
  Chromium fires a trusted `input` with no `beforeinput` for it, and the card saved the forged text as the
  user's note. After the fix, the snoop deck records none of the card's events (its own `<input>` is recorded:
  the positive control), every paste lands, and the saved note is exactly what the user entered while the
  forgery deck's `execCommand` calls run with focus in the card.
- **Code.** `packages/app/src/preload/input-guard.ts`: capture listeners on `window`, registered right after the
  key router at preload start, handle every trusted key and input-family event whose `composedPath()[0]` is the
  overlay host, then call `stopImmediatePropagation()`, never `preventDefault()`. The card accepts an edit only
  after a trusted `beforeinput` for it in the same task (`CardInputGate`). A refused edit is undone in a fresh
  `<textarea>`: Chromium keeps one undo history per frame, and after a script sets `value` the refused step
  stays in it (Cmd+Shift+Z brought it back as a trusted `historyRedo`). Each note opens in a fresh `<textarea>`
  for the same reason. Chromium behaviour recorded: Backspace at the start and Delete at the end fire
  `beforeinput` with no `input`; `webContents.replace()` fires `input` (`insertReplacementText`) with no
  `beforeinput`; `execCommand('selectAll')` is disabled in an empty text field. Limits: F19's ordering limit,
  and a deck can still select the card's text (`SECURITY.md`, Known limits of the note card).

### F19. `document.open()` erases the overlay's listeners, the shadow tree's included (6.2, 6.4, 6.5; review finding 12)

- **Check.** `fixtures/input/docopen.html` in the real app (`test/e2e/card-input.spec.ts`), and a
  `document.open()` page in `test/e2e/preload-electron.spec.ts`.
- **Result.** Before the fix, after a deck rewrote itself with `document.open()`, the card showed typed and
  pasted text but never saved it, and pen strokes drew nothing: the HTML spec erases the listeners of every
  shadow-including descendant of the document, and only the window listeners were added back. After the fix,
  card input is saved and strokes make marks.
- **Code.** Every overlay node listener goes through `listenOn()` (`listeners.ts`); `reinstall()` adds them back
  with the window listeners when the overlay sees the root element replaced. **Ordering limit:** `reinstall()`
  runs from a MutationObserver callback, after the scripts that `document.write()` inserted, so a capture
  listener those scripts register synchronously sees the card's keys and input events first (a `test.fail()`
  in `test/e2e/card-input.spec.ts`). The remedy is 6.2's fallback (the router in main's `before-input-event`),
  not done in Phase 0.

### F20. N's anchor pin is not a user mark (6.2 N, 6.4; review finding 18)

- **Result.** N anchors its note with a pin at the hovered element or the selection (the TextQuoteSelector
  target without a mark is Phase 3). That pin took mark number 1 and kept an N note closed with no text as an
  empty open note. Now the first stroke on the open card takes the pin's place (keeping the pin's target), so
  the user's strokes are ① and ②, and an N note closed with no text is deleted (NoteOp `delete`; main discards
  a draft without a tombstone).
- **Code.** `packages/app/src/preload/notes.ts` (`syntheticPin`, local to the preload);
  `test/unit/preload/notes.test.ts`, `test/e2e/card-input.spec.ts`, `test/e2e/diagnostics.spec.ts`
  (dictate-strokes: 2 marks).

## Rendering

### F4. Offscreen capture size (6.7)

- **Check.** Diagnostics `capture-size`: `capturePage` of a hidden offscreen `BrowserWindow`, 1600×900,
  `offscreen.deviceScaleFactor: 2`.
- **Result.** 3200×1800, not empty, as root and as `bltest`. When the X screen is narrower than the window, the
  window is clamped to the screen even with `enableLargerThanScreen: true` (on a 1280-px Xvfb screen the
  capture was 2560×1800).
- **Code.** The render service compares the captured size with the expected one and reports a mismatch;
  `scripts/run-electron.mjs`, the CLI and the test display use a 3840×2160 Xvfb screen. Recheck on a Retina
  Mac (Diagnostics does this automatically).

### F5. Fit: CSS `zoom` versus `webContents.setZoomFactor` (6.9)

- **Check.** Diagnostics `fit-zoom`: a 1600×900 design whose layout depends on the viewport (`vw`, `vh`, a
  width media query, percentages and px) rendered at its design size, then at half size with CSS `zoom: 0.5`
  on the root and with `setZoomFactor(0.5)`, each compared pixel by pixel with the design-size render.
- **Result.** `setZoomFactor` matches exactly (0.00% of pixels differ; the page sees a 1600×900 viewport).
  CSS `zoom` does not (11.47% differ; the page sees 800×450, so `vw`, `vh` and media queries resolve against
  the small window).
- **Code.** Fit is a Phase 1 feature and is not built yet. Phase 1 implements Fit with
  `webContents.setZoomFactor` on the deck view, not with the preload's CSS `zoom` that 6.9 first proposed (6.9:
  "keeps whichever matches Chrome's layout at the design size"). Chromium keeps zoom per host, and each deck
  has its own partition and host, so one deck's zoom does not leak to another; Phase 1 confirms this.

## Serving and the page's world

### F6. `protocol.handle` can redirect sibling files to a second origin (9.1 Serving)

- **Check.** A partition handler returns `307` with `Location: blueline://<docId>-files/<path>` for any path
  other than the document's own (`packages/app/src/main/protocol.ts`, `test/unit/app/protocol.test.ts`), and a
  standalone Electron experiment with the same scheme privileges: an `<img>` and a `fetch()` of a relative
  sibling path.
- **Result.** Works. The follow-up request arrives at the handler on the `-files` host, for images and for
  fetches, and `webRequest.onBeforeRequest` sees both legs.
- **Code.** Sibling files are served only from the `-files` host, with `nosniff`, `Content-Security-Policy:
  sandbox` and `no-store`; on the `<docId>` host only the document's own path is served.

### F7. Electron 44 applies no CORS to `protocol.handle` responses (9.1 Serving)

- **Check.** The same experiment with no CSP and no webRequest listener: a page on `blueline://<id>` fetching
  `blueline://<id>-files/x.txt` (cross-origin).
- **Result.** The fetch and the XHR **read the file**. Custom-scheme responses are not CORS-checked, so the
  "second origin" alone does not stop reads, as 9.1 assumed it would. A `crossorigin` `<video>` or `<audio>`
  is a third case (review finding 7): Chromium sends it in CORS mode with **no** `Origin` header and the same
  headers as a plain load (`accept`, `accept-encoding`, `range`, `user-agent`; webRequest type `media` for
  both), so neither layer below saw it, and it read sibling media in both trust states (a video frame's pixels
  through `getImageData`, `toDataURL`, `captureStream`; audio samples through Web Audio). With the scheme
  registered without `corsEnabled`, the same load fails ("Cross origin requests are only supported for
  protocol schemes …", MEDIA_ERR 4), and a plain load still plays, tainted.
- **Code.** Two layers make up for it, in both trust states: `onBeforeRequest` cancels every `xhr` (how
  webRequest reports `fetch()`, XHR and `EventSource`) to a `-files` URL (`network-policy.ts`,
  `files-read`), and the handler refuses every request that carries an `Origin` header except fonts (module
  scripts, `import()`, `crossorigin` images and styles; `protocol.ts` `corsReadRefused`). Audio and video are
  never served from the CORS-enabled `-files` host: both hosts 307 them to `blueline-media://<docId>/<path>`, a
  scheme that is neither CORS-enabled nor fetch-capable, which Blink refuses for every CORS-mode load and
  redirect, and onBeforeRequest lets only resource type `media` load it (`media-only`). Sibling media embedded
  with `<iframe>`, `<object>` or `<embed>` therefore no longer loads; `<video>`, `<audio>` and `<source>` do.
  The security suite's `local-files` fixture (fetch, XHR, iframe, object, canvas, `cssRules`, muted script
  errors, a module script, a worker, `.ssh/id_rsa`, and plain and `crossorigin` webm, mp4, wav, ogg and mp3
  through the document host, the `-files` host and `blueline-media://`, read with canvas and Web Audio) passes
  in both trust states.

### F8. The page's CSP applies to the preload's isolated world (9.1 Preload)

- **Check.** A standalone Electron experiment: a preload in the isolated world, under page policies
  `default-src 'none'; script-src 'unsafe-inline'` (with and without `style-src 'unsafe-inline'`) and
  `default-src 'none'; script-src 'nonce-abc'`, tries a `<style>` element, a `style` attribute, a CSSOM
  property write, a constructable stylesheet in a closed shadow root, a `data:` image, a `fetch()`, an inline
  `<script>` and `eval`. Also the three CSP fixtures in the real app
  (`test/e2e/csp.spec.ts`, `test/e2e/preload-electron.spec.ts`).
- **Result.** The page policy governs what the isolated world loads: the `data:` image, the `fetch()`, the
  `<style>` element and the `style` attribute are blocked whenever the page's policy blocks them, and an inline
  script the preload inserts runs in the main world, so the page's `script-src` decides. CSSOM property writes
  (`el.style.setProperty`) and constructable stylesheets are applied under every policy. `eval` in the isolated
  world is **not** governed by the page's `script-src` (it ran under every policy). In the app, the overlay
  mounts, works and adds no CSP violation under all three CSP fixtures, and every fixture's own scripts run.
- **Code.** The overlay rule stands as 9.1 states it (no URLs, no `<style>`, no `style` attributes, no inline
  code, no `data:`/`blob:`; constructable sheets and CSSOM writes only). It also forbids `eval` and
  `new Function`, not because the CSP would stop them but because nothing needs them.

### F9. The render agent's main-world calls work under a strict CSP (6.7, 9.4)

- **Check.** `test/e2e/preload-electron.spec.ts`: `Reveal.slide` and `Reveal.getConfig` through
  `webFrame.executeJavaScript`, on a page with a small Reveal stand-in under `default-src 'none'; script-src
  'nonce-x'; require-trusted-types-for 'script'; trusted-types 'none'`; the settle step pauses animations with
  an adopted stylesheet.
- **Result.** Pass, with no CSP violation: main-world calls from the preload are not subject to the page's
  `script-src` or Trusted Types.
- **Code.** The render agent calls the page's world only with `webFrame.executeJavaScript` and integer
  arguments.

### F21. A closed window's document stayed in main memory, and an all-digit docId is not a valid host (9.1; review finding 21)

- **Check.** `test/e2e/lifecycle.spec.ts` opens and closes a 4.1 MB deck in Protected view 6 times, with `gc()`
  in between. A standalone Electron script loads `<standard scheme>://8117861969109379/`.
- **Result.** Before the fix, main's external memory grew 12 MB per close: the file's bytes, decoded source
  and served copy, kept alive by the partition's handlers, which Electron keeps until the app quits. After the
  fix it stays at 4.2 MB. Separately, a host of decimal digits only is parsed as an IPv4 number, so
  `blueline://<docId>/…` with such an id is an invalid URL (`ERR_INVALID_URL`). About 1 random id in 1,850 is
  all digits: that Protected open showed nothing, that Trusted file (whose id is kept) could never load, and
  `blueline map` failed now and then once every probe load got a fresh docId (F23).
- **Code.** `window.ts` `deckPolicies` / `onClosed`: the partition's and view's policy callbacks read a small
  state object that closing clears (they then fail closed: Protected, no network), the trust-hook handles are
  disposed, a Protected partition's listener and permission handlers are replaced by capture-free ones that
  refuse everything, and the document's bytes and served copies are released (`BlDocument.release`).
  `documents.ts` `isDocumentId`: a docId is 16 lowercase hex digits with at least one letter; `newDocumentId`
  draws again until it is, and `trustedDocumentId` replaces a kept all-digit id.

## Network policy and Protected view (9.9)

### F10. webRequest sees custom-scheme requests, and each layer works on its own (9.9 Network policy)

- **Check.** 9.9: "Electron also does not document that webRequest sees custom-scheme requests, so the
  security fixtures check each layer on its own." A standalone experiment with the `blueline` scheme
  privileges, in three configurations: no CSP and an observing listener; `connect-src 'none'` only; a
  listener that cancels `xhr` on the custom scheme and no CSP. Then the real suite.
- **Result.** `onBeforeRequest` **does** see custom-scheme requests, with resource types: images as `image`,
  `fetch()`, XHR and `EventSource` as `xhr`, and both legs of a 307. Each layer alone blocks `fetch`, XHR and
  `EventSource` of same-origin, `-files` and redirected URLs: `connect-src 'none'` stops them before
  webRequest sees anything; the listener alone cancels them. `navigator.sendBeacon` to `blueline://` is refused
  by Blink itself ("Beacons are only supported over HTTP(S)"), so no `ping` ever reaches the scheme.
- **Code.** Protected serves the document with `connect-src 'none'` and the single listener also cancels
  `blueline` `xhr` and `ping` requests (second layer); `-files` reads are cancelled in both trust states (F7).
  The standalone experiment is now a suite test (review finding 41): `test/security/layers.spec.ts` opens
  `layers.html` Protected with two of the three layers (CSP, listener, proxy) turned off by the test-only
  switch `BLUELINE_TEST_DISABLE_LAYER` (unpackaged `BLUELINE_TEST=1` builds only), and asserts what each layer
  blocks alone: the CSP alone stops fetch, XHR, EventSource, WebSocket and `sendBeacon` for every origin,
  `blueline://` included (an `<img>` still arrives); the listener alone cancels every http(s) and ws request
  and `blueline://` fetch and XHR; the proxy alone lets no connection reach the test host (a `blueline://`
  fetch then reads the document). With all three off, every attempt reaches the server (positive control).

### F11. Covert channels in Protected view (9.9, section 10 Security fixtures)

- **Check.** `npm run test:security` (`fixtures/security/network.html`, `hints.html`, `webrtc.html`,
  `navigation.html`), with the suite's own HTTP and WebSocket server, DNS server, and UDP and TCP listeners on
  a non-loopback address, plus a TCP listener on `127.0.0.1` (and `[::1]` with IPv6) for the loopback case.
  The hints and WebRTC fixtures also run in Trusted view as positive controls. Each attempt uses its own host
  name, so whatever arrives names the channel. Results per attempt were also dumped from the real app in both
  trust states.
- **Result, Protected.** Nothing reached the HTTP, WebSocket, UDP or TCP listeners from any fixture. Per
  attempt:

  | Channel | Protected | How it is stopped |
  |---|---|---|
  | `fetch`, `fetch` by IP, keepalive `fetch`, XHR | blocked | `connect-src 'none'` and onBeforeRequest |
  | image beacon, static and script-inserted CSS, JS, images, CSS `@import`, `@font-face`, background images | blocked | onBeforeRequest (not allowlisted) |
  | WebSocket, `EventSource`, WebTransport | blocked | `connect-src 'none'` and onBeforeRequest |
  | `navigator.sendBeacon` | queued by the page, nothing arrived | onBeforeRequest (`ping`) |
  | form POST into an iframe | submitted by the page, nothing arrived | onBeforeRequest and frame navigation policy |
  | remote iframe, object, embed, video; dynamic `import()`; remote worker | blocked | onBeforeRequest; workers need same-origin script |
  | `navigator.serviceWorker.register` | blocked | not supported on the `blueline:` scheme |
  | pagehide and visibilitychange beacons (`sendBeacon`, keepalive `fetch`) | nothing arrived after a reload, which runs them (in Trusted view both arrive) | `connect-src 'none'` and onBeforeRequest. Closing a window runs no unload handlers (the deck's webContents is closed without beforeunload/unload), so a close sends nothing in either trust state |
  | static `dns-prefetch`, `preconnect`, `prefetch`, `prerender`, `x-dns-prefetch-control: on` meta | nothing arrived, no DNS | removed from the served copy; `X-DNS-Prefetch-Control: off`; of these only `dns-prefetch` and `prefetch` make traffic in Electron 44 (Trusted run) |
  | script-inserted `prefetch` | nothing arrived, no DNS | onBeforeRequest (type `other`) |
  | static and script-inserted `preconnect` (by name and by address), `prerender`; speculation rules; links | nothing arrived, no DNS, no connection | inert in Electron 44: they make no traffic in Trusted view either. A Trusted run of `hints.html` fails if one starts to |
  | **script-inserted `dns-prefetch`** | **DNS lookup of the name** | **not stoppable (below)** |
  | WebRTC STUN and TURN over UDP, by name and by IP | no packet, no DNS | `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` |
  | **WebRTC TURN over TCP and TLS, by name** | **DNS lookup of the name**, no connection | connection: the Protected proxy to a closed port; lookup: not stoppable (below) |
  | WebRTC TURN over TCP to `127.0.0.1`, `localhost`, `[::1]` (`[::1]` only where the machine has IPv6; the dev container has none) | no connection | the Protected proxy is `fixed_servers` with `<-loopback>`. The first proxy was a PAC script, which Chromium skips for loopback hosts (its implicit bypass), and these connected: a TURN Allocate reached a local listener (review finding 8). In Trusted view it still does (positive control) |
  | `<a ping>`, `<meta http-equiv=refresh>`, scripted navigation, `window.open`, form `_self`/`_top`, custom scheme | nothing arrived | will-navigate / will-frame-navigate, window open handler, webRequest |

- **Result, Trusted (positive control).** Subresources, `fetch`, XHR, WebSocket, `EventSource`, keepalive
  fetch, `sendBeacon` and the hyperlink-auditing POST of a clicked `<a ping>` reach the server, as 6.10 and
  9.9 Trusted allow (`<a ping>` and `sendBeacon` are both network subresources of webRequest type `ping`).
  Navigation, popups, meta refresh and the `<a ping>` link's own href still reach nothing. The `pagehide`
  beacons arrive after a reload; TURN over TCP reaches the test host and the loopback listener. Of the hints,
  only `dns-prefetch` (DNS) and `prefetch` (HTTP) make traffic.
- **The two open channels.** Only a host name leaves; no packet, connection or request reaches the host.
  1. *Script-inserted `<link rel=dns-prefetch>`.* Blink checks only the `dns_prefetching_enabled`
     WebPreferences switch for link-element prefetches (not `X-DNS-Prefetch-Control`), Electron 44 does not
     expose that switch, Electron's network hints handler resolves the name in the partition's network
     context without consulting the proxy, and no CSP directive covers it.
  2. *WebRTC TURN over TCP/TLS host names.* ICE resolves the TURN server's name before the proxied connect (the
     connection itself, loopback included, goes to the closed port).
     9.9's example mitigation was tried: removing `RTCPeerConnection` (and `webkitRTCPeerConnection`) from the
     page's world with `contextBridge.executeInMainWorld` before page scripts run. It works in the main frame,
     but a script-created `about:blank` iframe (`contentWindow` or `window[0]`, and `document.write` into it)
     still has a working `RTCPeerConnection`. With `nodeIntegrationInSubFrames` the preload also runs in
     `srcdoc`, `blob:` and `data:` frames, but still not in time for the initial `about:blank` document.
     Electron 44 has no switch that disables WebRTC per webContents, so this is not a sound mitigation and was
     not shipped.
- **Code.** 9.9 allows Phase 0 to state a channel it cannot close: both are stated in `SECURITY.md`, and stay
  `test.fail()` tests in `test/security/network.spec.ts`, so a fix shows up as a passing test. The Protected
  view help text (Phase 1 UI) must state them too.

### F12. Security suite results per trust state (6.10, 9.9, section 10)

- **Check.** `npm run test:security`: 45 tests (after review round 1; 31 before it), the app as `bltest` with
  the OS sandbox on, DNS observable.
- **Result.** 45 passed: 43 plain passes and the 2 expected failures of F11.

  | Area | Protected | Trusted |
  |---|---|---|
  | Network (F11) | contained except the two DNS channels | allowed kinds arrive (positive control) |
  | Network layers on their own (`layers.spec.ts`, F10) | each of CSP, listener, proxy blocks its share alone; all off: everything arrives | (Protected only) |
  | Local files: sibling and outside files, `.ssh/id_rsa`, `file:`/`app:` URLs, symlinks; sibling media (F7) | never readable; `crossorigin` video and audio never load, plain ones play, tainted | never readable; `crossorigin` video and audio never load, plain ones play, tainted |
  | Protocol fuzz (percent-encoded, double-encoded, dot segments, mixed case, Unicode look-alikes, backslashes, dotfiles, symlinks, other hosts) | nothing outside the folder; the outside files have served extensions and a marker, so a handler that served one would fail the test | same |
  | Scripted navigation and popups | nothing reached; the document stays | same |
  | Clicked external link | confirm dialog, nothing opened until confirmed | same |
  | Clicked local `.html` link | opens in its own Blueline window | same |
  | Clicked `<a ping>` | nothing sent | the ping POST arrives (allowed subresource; the positive control); the link's href is not fetched |
  | Meta refresh | cancelled, nothing sent, the "tried to leave" bar shows | same |
  | Downloads | will-download prevented, item cancelled, no save path | waits for the save dialog (options set, no save path, still in progress); no file appears in HOME, TMPDIR or Downloads |
  | Permissions: camera and mic (with fake devices present: NotAllowedError), location (PERMISSION_DENIED), notifications, clipboard read, MIDI, `permissions.query` | denied by the handlers; a permissive handler installed by the test yields a stream (positive control) | same |
  | HID, serial and USB choosers after a real click | refused by the permission check before a chooser shows; with the check let through (test only), each select-*-device event fires and is prevented with no device chosen (a serial port was offered) | same |
  | Bluetooth chooser | `navigator.bluetooth` does not exist in this Electron 44 Linux build (and there is no adapter), so requestDevice is not called; the `select-bluetooth-device` handler is checked with a synthetic event: prevented, no device id passed | same |
  | localStorage, sessionStorage, IndexedDB | partition `deck-<docId>` (non-persistent; nothing under userData/Partitions); empty in the same process once the window closed; a reopen finds nothing | localStorage and IndexedDB kept per file across reopen (`persist:deck-<fileKey>` on disk); sessionStorage belongs to the window |
  | `document.cookie`, Cache Storage | do not work on `blueline://` at all: the cookie reads back empty, Cache Storage rejects the scheme | same |
  | Note card input (F18; `card-input.spec.ts`) | the page sees none of the card's key and input events, and its `execCommand` calls never change the saved note | same |
  | Forged IPC on every deck channel and every shell channel, a flood, and note operations naming another open document's note | no file written; every shell channel refused; no trust, network, editing, mode or trust-bar change; the other document's notes and session.json unchanged; rate-limited | (Protected deck) |

- **Code.** One fix came out of the first run: Trusted storage was not kept per file (F13). Review round 1
  (below) made several of these tests able to fail (findings 36–46: each new check fails when the defence it
  covers is removed, where the old test passed); they found no further product defect. Findings 7 and 8
  (sibling media read through `crossorigin`, and loopback reached through WebRTC TURN) were product defects,
  now fixed and tested here.

### F13. A Trusted deck needs a stable origin to keep its storage (6.10 Storage)

- **Check.** The suite's storage fixture writes on first open; the same file is reopened with the same
  userData.
- **Result.** Before the fix, a Trusted reopen found nothing: storage is keyed by origin
  (`blueline://<docId>`), and the docId was new on every open, so the persistent partition alone did not keep
  storage "per file".
- **Code.** A Trusted file's docId is still random (9.1), never derived from its path, but it is generated
  once per file and kept in `<userData>/files/<fileKey>/origin` (`documents.ts` `trustedDocumentId`, an
  addition to the 9.7 layout). Protected opens always get a fresh docId in a non-persistent partition.
  `blueline map` keeps a fresh docId. The probe copy gets a new docId for every probe load, so each load is a
  fresh origin with empty localStorage, sessionStorage and IndexedDB, as the walk's own load was. Every probe
  load also brings a generic deck back to slide 1 before the replay (review finding 30).

## Mapping and writing (9.2; section 10 map and mutation probe)

### F14. Coverage of the committed fixtures, and the mutation probe

- **Check.** `blueline map <deck> --report --json` on all 18 committed fixtures, each compared with its
  `<name>.expect.json` (what the fixture is meant to test). This comparison is now automated in
  `test/e2e/map.spec.ts` together with the baseline check. The probe writes the sentinel `⟦bl⟧` through the
  real patcher on a hidden copy, reloads, goes back to the slide, checks the sentinel is in that node and no
  other (except reported renders of the same run), checks for new console errors and an unchanged slide count,
  then undoes through the patcher and requires the copy's bytes to equal the original's.
- **Result.** Every expectation holds on all 18 decks, every slide of every deck was reached, and **every
  `exact` node passes the probe (411 of 411), with every undo byte-exact**. These do not count toward the 95%
  gate (section 10), which needs Josh's 10 real decks.

  | Fixture | Kind · slides · nav | exact / ambiguous / none (total) | Coverage | Probe (nodes, runs) |
  |---|---|---|---|---|
  | `bom` | generic · 3 · index | 12 / 0 / 0 (12) | 100.0% | 12/12, 12 |
  | `crlf` | generic · 3 · index | 11 / 0 / 0 (11) | 100.0% | 11/11, 11 |
  | `csp-default-none` | generic · 3 · index | 11 / 0 / 0 (11) | 100.0% | 11/11, 11 |
  | `csp-nonce-strict-dynamic` | generic · 3 · index | 13 / 0 / 1 (14) | 92.9% | 13/13, 13 |
  | `csp-self-inline` | generic · 3 · index | 14 / 0 / 0 (14) | 100.0% | 14/14, 14 |
  | `entities` | generic · 6 · index | 38 / 0 / 6 (44) | 86.4% | 38/38, 38 |
  | `generic-hash` | generic · 5 · hash | 28 / 0 / 0 (28) | 100.0% | 28/28, 28 |
  | `generic-index` | generic · 6 · index | 28 / 2 / 7 (37) | 75.7% | 28/28, 28 |
  | `inline-markup` | generic · 4 · index | 48 / 0 / 0 (48) | 100.0% | 48/48, 48 |
  | `js-templates` | generic · 4 · index | 30 / 19 / 14 (63) | 47.6% | 30/30, 30 |
  | `json-data` | generic · 4 · index | 30 / 9 / 9 (48) | 62.5% | 30/30, 27 |
  | `keys-prevent-default` | generic · 4 · index | 14 / 0 / 0 (14) | 100.0% | 14/14, 14 |
  | `notes-block` | generic · 3 · index | 9 / 0 / 1 (10) | 90.0% | 9/9, 9 |
  | `report` | scroll · 5 · scroll | 63 / 0 / 0 (63) | 100.0% | 63/63, 63 |
  | `reveal-hash` | reveal · 8 · reveal | 27 / 0 / 0 (27) | 100.0% | 27/27, 27 |
  | `single` | single · 1 · none | 21 / 0 / 0 (21) | 100.0% | 21/21, 21 |
  | `unicode-edit-points` | generic · 3 · index | 14 / 0 / 0 (14) | 100.0% | 14/14, 14 |
  | `windows-1252` | generic · 3 · index | 0 / 0 / 9 (9) | 0.0% | not run: not UTF-8, never written |
  | **all** | | **411 / 30 / 47 (488)** | 84.2% | **411/411** |

  The non-`exact` nodes are the ones each fixture exists to show: JS-built counters and `${…}` text
  (`computed`), duplicated and key-like literals, near misses (`not-equal`, `substring`), literals shown through
  `innerHTML`, text from external scripts, cloned templates, text Blueline never writes (a `<title>`, a number
  elsewhere in the file; `shadow`, F22), and the windows-1252 deck (`not-utf8`). Review round 1 changed two
  nodes: `14` in `js-templates` (also `.14em` in the CSS) and `Checkout redesign — results` in `json-data`
  (also the `<title>`) went from `exact` to `ambiguous` (`shadow`). The final run mapped a copy of every deck
  and got output byte-identical to `fixtures/expected/`.
- **Byte-exact undo on the 9.2 fixtures.** `entities` (references, legacy references without `;`, C1
  references, `&nbsp;` versus raw NBSP), `bom` (the BOM is written back), `crlf` (CRLF everywhere, a line
  continuation, a CRLF JSON block), `js-templates` and `json-data` (string, template and JSON literals,
  escapes, HTML literals) and `unicode-edit-points` (astral characters before every edit point): every probe
  write was undone to the original bytes.

### F15. A write to the wrong place, found by the probe and fixed (9.2 Strategy 2 step 3)

- **Check.** The probe on `json-data.html`.
- **Result.** One node failed: a metric label `Retention`, rendered by the deck from a JSON object **key**
  (`Object.entries`), was matched `exact` to the JSON **value** `"Retention"` elsewhere, because JSON keys are
  not units, so the value looked unique. The probe's sentinel landed in the value, not in the label. The same
  shape exists in JS: `STATUS_COLOR[s.status]` in `js-templates.html` looks a status up by an identifier key.
- **Code.** Object keys that are not units now count as keys, like `id` or `data-*` values ("the deck may use
  it as a key"): JSON object keys, identifier keys of JS object literals and class fields, non-computed member
  names (`o.X`, `o?.X`, `this.X`, read or written) and identifier keys of object patterns (`const { X } = o`)
  (`mapper-literals.ts`, merged into `DeckMap.keys`/`keyValues` by `buildMap`; `attr` is `json key`, `object
  key`, `member name` or `destructuring key`). Such text is `ambiguous` (`key`), with the picker warning "also
  used as a key at deck.html:<line>". JSON keys are still not units. Member names count because
  `totals.Bookings = 120` makes a key just as `{ Bookings: 120 }` does, and because a label edit that renames a
  quoted key code reads by name (`KPI.Retention`) breaks that read while verify and the probe pass (review
  finding 4). Verify compares the key list last, so a script that stops parsing reports that first. Baselines
  `json-data.json` and `js-templates.json` changed accordingly (one node each from `exact` to `ambiguous`).

### F16. parse5 8 misplaces a `<pre>` text node that starts with an astral character (9.2 rule 2)

- **Check.** The patcher's fuzz test (`test/unit/editor/fuzz.test.ts`).
- **Result.** When `<pre>` or `<listing>` drops its leading newline and the text then starts with a character
  outside the BMP, parse5 reports the text node's start one code unit late, on the low surrogate. The run was
  refused (unaligned), never misplaced.
- **Code.** `mapper-html.ts` steps a run start that lands on a low surrogate back onto its high surrogate (a
  text node never starts inside a surrogate pair); the decoded-to-raw table still validates the slice.

### F17. reveal.js's live region and the section 10 walk

- **Check.** The walk and the probe on `reveal-hash/index.html`.
- **Result.** reveal.js keeps a 1×1 px `.aria-status` live region clipped to a zero area at (0, 0) that repeats
  the current slide's text. A literal reading of section 10 step 4 counts it (its rect is non-zero), and every
  probe sentinel would appear in it, failing every reveal.js node.
- **Code.** The walk skips text in absolutely positioned elements clipped to a zero area (`dom-walk.ts`
  `skipClipped`). `find` marks such matches `clipped`, and the probe ignores a sentinel copy only in a clipped
  node the walk never counted (`probe.ts` `judgeNode`). Any other copy the report does not count fails the
  node, hidden or not: a `display: none` copy, an opacity-0 fragment, text off the viewport, or a slide the
  walk never showed (review finding 31; `fixtures/map/hiddendup.html`, `fixtures/map/reveal-fragment.html`).
  Fragments stay at opacity 0 after `Reveal.slide(h, v)`, so they are not counted, and a run that a fragment
  also shows fails the probe.

### F22. Text the map did not count made literals look unique (9.2 Strategy 2 step 3; review findings 0–6)

- **Check.** The review's reproduction decks, kept as `fixtures/matching/*.html`
  (`test/e2e/map-matching.spec.ts`), and `test/unit/core/shadow-values.test.ts`.
- **Result.** Before the fix every deck had an `exact` node that failed the probe, a write to the wrong place:
  text cloned from a document `<template>`, `<title>` shown through `document.title`, a `text/x-template`
  block, an `` html`…` `` tagged template, an `aria-label` and a hidden `<textarea>`, each equal to a canvas
  label literal; text the Strategy 1 walk dropped (an unclosed `<em>` re-opened in the next `<li>`,
  `<h2><em>Plan</h2><p>…`); a breadcrumb whose script prepends a text node, which moved the live `textIndex`
  onto the next separator; computed numbers (`DATA.deals = 600`, a counter, Intl `1,234`) equal to unrelated
  string literals (`setAttribute('width', '600')`, `style.opacity = '1'`); a key made by member assignment
  (`totals.Bookings = 120`); a table cell inside a foster-parented text run. A quoted key read by name
  (`KPI.Retention`) passed the probe while the write renamed the property, and an edit of `'Latency <5 ms'`,
  set with `textContent`, wrote `&amp;` for a typed `&`.
- **Code.**
  - Shadow values (`DeckMap.shadows`, `ClientMap.shadowValues`): text the page may show that Blueline never
    writes. They are template content, raw-text elements, script data blocks, tagged-template text, every
    attribute value, strings in inline handlers, Strategy 1 text the walk drops (and text under
    parser-invented elements), and every number in inline JS and JSON (`String(n)`, `-n`, and the en-US
    grouped form). A literal equal to one is `ambiguous` (`shadow`). Shadows are never candidates and never
    written. A literal made only of digits and number punctuation is `exact` only if its text occurs once in
    the file (notes block excluded). Verify refuses a write that changes the shadows (except the number
    counts), and a stale-version write whose `beforeText` is a shadow needs the 32-character context.
  - The own stamped run is trusted only while the element's live non-whitespace text nodes
    (`DomTextNode.texts`, sent by the render walk; F23) agree with the stamp's source runs, and never when
    another run of the element has the same text (`duplicate`).
  - A literal is an HTML unit only if its fragment parse holds markup (an element, a character reference, a
    comment or another tag). `'Latency <5 ms'` is a plain literal, so an edit that adds `<` or `&` becomes a
    verbatim note (step 5.1).
  - A run whose raw range lies inside another run's range (foster-parented text merged before a `<table>`) is
    unaligned (`none`).
  - Baselines: `js-templates` "14" (also `.14em` in the CSS) and `json-data` "Checkout redesign — results"
    (also the `<title>`) went from `exact` to `ambiguous` (`shadow`). The repeated-number rule may lower
    coverage on real decks where short numbers (`1`, `2024`) also occur elsewhere; that is the conservative
    reading.

### F23. What the walk reaches and counts (section 10 map steps 3–5, mutation probe, exit gate; review findings 28, 30–35)

- **Check.** The review's reproduction decks, kept as `fixtures/map/*.html` (`test/e2e/map-walk.spec.ts`), plus
  `test/e2e/render-agent.spec.ts` and `test/unit/app/{report,probe,render-service}.test.ts`.
- **Result.** Before the fixes:
  - A generic deck whose first ArrowRight shows a build step was walked to slide 1 only, and reported 100% with
    `--min-coverage` met. At the 200-key cap, 201 of 300 slides were reached and the gate still passed.
  - A deck that restores its slide from `localStorage`, or throws on a second visit in the same tab, failed the
    probe on correct nodes, because every probe load shared one origin.
  - A sentinel that also landed in a `display: none` copy, an opacity-0 reveal.js fragment, an open shadow root
    or a same-origin frame passed the probe.
  - Text in shadow roots and frames was not counted.
  - A page window-capture listener that called `stopImmediatePropagation()` made the walk switch to synthetic
    keys after a trusted key had moved the deck.
  - Scrolling and single-page documents were counted one viewport per block: 40 of 83 and 19 of 81 text nodes.
  - Short blocks were reported as never shown, and their nodes were counted on another block.
- **Code.**
  - An incomplete walk is reported as such. The text report shows `Coverage: … INCOMPLETE: the walk reached X
    of Y slides`, `--min-coverage` reports `NOT met (…)`, and `map` exits 1 with or without `--min-coverage`.
    The baseline's `coverage` gains `slides: {count, reached}`.
  - Every probe load gets a new docId for the copy: a fresh origin with empty storage. After each load, a
    generic deck is brought back to slide 1 by hash or back keys before the replay.
  - `find` reports `clipped`, and the probe skips only clipped nodes the walk never counted (F17).
  - The walk, `find` and the probe enter open shadow roots and same-origin frame documents (srcdoc,
    about:blank, blob:). Visibility is computed in each frame's own document, and rects are offset by the
    frame's position.
    - That text is counted `none` (`subdocument`; section 7: text in iframes is pin only) and never probed. A
      sentinel that lands there fails the probed node.
    - Visible cross-origin frames (`data:`, the `-files` origin, the network) are listed as `Uncounted visible
      content: N cross-origin frames`.
    - Closed shadow roots cannot be seen from the page, so their text is neither counted nor listed.
  - The keydown counter belongs to the render agent (`RenderCmd keydowns`) and is registered before any page
    script (F3).
  - Scrolling and single-page documents are stepped through in viewport heights (`RenderCmd scroll-to`) until
    the bottom of each block and of the page has been in view. Each such stop records its offset, which the
    probe replays.
  - A block is reached when its box meets the viewport at a stop. Each node is counted on the slide or block
    that contains it (`WalkNode.slide`).
  - The walk sends each node's `DomTextNode.texts`, which the matcher's step 1 needs (F22). Limits: 256 text
    nodes and 256 KiB per parent, 8 MiB per reply.
  - Baselines: all 18 gained `coverage.slides`, and `report.json` moved six nodes to the block that contains
    them.
- **Still open.**
  - A generic deck with in-slide build steps is still walked only to its first build. Section 10 step 3 stops
    when the slide stops changing. Such a deck is now reported incomplete, never met.
  - A document that scrolls inside its own container instead of the window is stepped only as far as
    `scrollIntoView` on its blocks takes it. A single page that does this is still counted at its first
    viewport only.

## Electron behaviour recorded by the build

- **A `WebContentsView`'s webContents outlives its window** in Electron 44, and a quit waits for it. Closing it
  in the window's `close` event never stalled a quit; closing it in `closed`, in `before-quit` or later
  sometimes left the process hanging (`window.ts` `closeDeck`).
- **`alert()` and `confirm()` in a hidden render window** block the page and even `app.exit` until answered;
  render windows set `disableDialogs: true` (`render-service.ts`).
- **`location.reload()` emits `will-frame-navigate` to the same URL**; it is cancelled without the "tried to
  leave" bar, and main reloads the document itself (`trust-hooks.ts`).
- **The content area shrinks after creation** on Linux and Windows when the menu bar is attached; the layout
  also follows `contentView` `bounds-changed` (`window.ts`).
- **Chromium bypasses a PAC script for `localhost`, `*.localhost`, loopback and link-local hosts** before it
  consults the script; only a `fixed_servers` bypass list can remove that implicit bypass, with `<-loopback>`
  (`network-policy.ts`; F11, review finding 8).
- **getUserMedia without capture devices fails with NotFoundError before the permission request handler is
  asked.** The security suite launches with `--use-fake-device-for-media-stream`, so the handler decides;
  `--use-fake-ui-for-media-stream` bypasses the handler and grants even when it denies. A denied geolocation
  fails with code 1; a granted one with no provider fails with code 2.
- **`setPermissionCheckHandler(() => false)` refuses HID, serial and USB before any `select-*-device` event.**
  `navigator.bluetooth` is undefined on Linux; even with the WebBluetooth flag there is no adapter, and no event
  fires. With no `select-bluetooth-device` listener, every Bluetooth request is cancelled; Electron picks the
  first device only when a listener exists and does not call `preventDefault()`.
- **A DownloadItem whose `will-download` was prevented is destroyed when the event returns.** Any later read
  throws "DownloadItem used after being destroyed".
- **`document.cookie` and Cache Storage do not work on a custom standard scheme** (`blueline://`): the cookie
  reads back empty, and `Cache.put` rejects with "Request scheme 'blueline' is unsupported".
- **A host of decimal digits only is an IPv4 address** on a standard scheme, so `blueline://8117861969109379/`
  is an invalid URL (`ERR_INVALID_URL`; F21).
- **An unhandled `EPIPE` on stderr in Electron main shows a modal dialog that blocks main.** Main now ignores
  stdout and stderr errors (`index.ts`).
- **Electron installs SIGINT, SIGTERM and SIGHUP graceful-quit handlers while it starts,** so main installs its
  own signal handlers after `ready` (F24).

## Josh's real decks (section 10 exit gate; SPEC 13, question 1)

Josh sent 14 files on 2026-10-16: 12 distinct decks (two were byte-identical copies). They are kept in the
gitignored `fixtures/local/`, with their baselines in `fixtures/local/expected/` (`<deck>.json` with motion as
the deck sets it, `<deck>.reduced-motion.json` with `blueline map --reduced-motion`). Their file names and text
identify clients, so this page calls them D1–D12; `fixtures/local/DECKS.md` (gitignored) holds the key. All 12 use their own
slide engine (no reveal.js), update `location.hash`, and honour `prefers-reduced-motion`; five animate with GSAP
(SplitText, ScrambleText). Eight have more than 400 visible text nodes; the largest file is 977 KB.

### F25. The walk must be patient with decks that build (6.7 Index replay; section 10 step 3)

- **Check.** `blueline map` on D4, a 16-slide GSAP deck.
- **Result.** The walk stopped on slide 2 of 16. The deck's `next()` returns while a transition is busy and
  spends the first press on fast-forwarding a build that has more than 0.6 s left; read literally, 6.7's "If a
  key changes nothing, it stops" ends the walk there. The hash fallback did not help: the deck reads
  `location.hash` only at start.
- **Code.** A key that changes nothing on a slide that is not the last is pressed again after 700, 1,400 and
  2,500 ms. The walk also collects after every such press, because it may have shown a key-gated build step,
  and counts only text that is new at its place (a counter re-rendered on every key is not counted twice). A
  press that shows new text does not use up a retry. The probe's replay presses the same way and knows how
  many presses before each move changed nothing. `fixtures/map/builds.html` now reaches all 5 slides and
  counts both build points. All 193 slides of the 12 decks are reached.

### F26. One probe load per run takes hours on real decks (section 10 mutation probe)

- **Check.** The same decks: each load is a 0.5–1 MB file with an animated engine, then a replay of every key
  to the node's slide.
- **Result.** A 17-slide deck was still probing after 30 minutes.
- **Code.** The probe writes up to 24 runs at once, each with a sentinel of its own (`⟦bl1⟧`, `⟦bl2⟧`…, none a
  substring of another), checks every node of the batch on one load against step 4 (its own sentinel in that
  node, and that sentinel in no other node except reported renders of its run), undoes the writes newest first
  and compares the copy's bytes (step 5). A run passes on the batch only if all its nodes pass. Whatever a batch
  cannot attribute (a new console error, a changed slide count, a refused or failed write, a failed undo) and
  every run that fails on it is probed again on its own with `⟦bl⟧`, and that verdict stands, so a batch can
  only make the probe faster, never more lenient (`test/unit/app/probe.test.ts`, "a write that lands in another
  node fails on the batch and again on its own"). Real decks now take 2–7 minutes each.

### F27. Animated decks: map as reduced motion shows them (6.3, 6.9, section 10 step 4)

- **Check.** `blueline map` with and without `--reduced-motion` (Chromium's `force-prefers-reduced-motion`) on
  all 12 decks.
- **Result.** With motion on, the GSAP decks split headings into one span per word or letter, scramble text
  for a few seconds, and fade content in after each slide change; the walk read many slides mid-build. With
  reduced motion every deck draws its final frame directly, as plain text.

  | | Motion as set | Reduced motion |
  |---|---|---|
  | Visible text nodes | 7,023 | 6,676 |
  | Exact and probe-passed | 5,007 (71.3%) | 5,942 (89.0%) |
  | Slides reached | 193 of 193 | 193 of 193 |
  | Probe failures | 0 | 1 (F30) |

  The five GSAP decks fall to 54.0% with motion on (their split text counts as more, smaller nodes); the seven
  others are within a few points either way.
- **Code.** `blueline map --reduced-motion`. Edit mode (Phase 2) needs a decision: see Still open.

### F28. Deck engines rewrite their chrome (9.2 Matching DOM to source at runtime)

- **Check.** The probe on the reduced-motion maps.
- **Result.** Slide 1's counter, total and section label ("01", "/ 16", "Cover") matched their own stamped
  runs, because the source holds slide 1's values, and failed the probe: the engine writes them again on every
  load, so an edit there would be undone. Some engines write them from an inline script while the page is still
  loading.
- **Code.** The preload records the text nodes scripts change: after parsing, any change; while parsing, any
  record that removes a text node (the parser never does; `el.textContent = …` always does). The matcher never
  takes the own stamped run for such a node (`DomTextNode.touched`; `fixtures/matching/chrome-rewrite.html`).

### F29. Split text and lone characters (9.2 Strategy 2 step 3)

- **Check.** The probe on the motion-on maps.
- **Result.** 23 wrong-place writes, all caught by the probe: GSAP split headings into one span per letter or
  word, and a lone "A" or "T", or a word, matched a literal elsewhere in the file (in the bundled library's own
  code, such as `"client"` in a property name). The words were missed at first because a mutation record
  names only the element a script inserts, not the text built inside it.
- **Code.** Text inside an element a script inserted counts as touched. A touched node whose text lies inside its
  nearest stamped ancestor's source text is `ambiguous` (`split`), and a single character through a lone literal
  is `ambiguous` (`short`). Two-character labels ("Q1", "EU") stay exact (`fixtures/matching/split-chars.html`).
  With motion on, no probe failure remains on the 12 decks.

### F30. Coverage on the real decks, and what stops the rest

| Deck | Animation | Nodes (reduced motion) | Exact and probe-passed, motion as set | Reduced motion |
|---|---|---|---|---|
| D1 | own | 716 | 88.8% | 89.7% |
| D2 | own | 291 | 91.8% | 93.8% |
| D3 | own | 483 | 79.3% | 80.1% |
| D4 | GSAP | 343 | 57.6% | 90.4% |
| D5 | own | 430 | 95.8% | 96.0% |
| D6 | GSAP | 457 | 58.5% | 91.5% |
| D7 | GSAP | 653 | 52.0% | 93.7% |
| D8 | GSAP | 400 | 54.0% | 93.8% |
| D9 | GSAP | 675 | 51.5% | 93.6% |
| D10 | own | 970 | 83.4% | 80.6% |
| D11 | own | 879 | 89.3% | 86.5% |
| D12 | own | 379 | 89.2% | 89.2% |
| **All 12** | | **6676** | **71.3%** | **89.0%** |

Of the 734 nodes that are not exact on the reduced-motion maps (11.0% of all nodes): 4.7% of all nodes are
numbers and counters (slide numbers, KPIs, dates: `computed`, or equal to several runs), 0.6% are glyphs and
labels of up to three characters, and 5.8% are words. The words are mostly labels that several literals hold
(the decks draw diagrams and tables from data arrays: one product name six times), kickers assembled from parts
("01 · <section name>"), and chrome. Counting only words, 93.9% are exact.

The one probe failure (D3, a three-word status label) is not a wrong-place write: the literal is the right
source, and the deck also shows it in a hidden element on another slide, so an edit would
change that copy too. The probe does not count such a node; 6.3's "also changes N other places" is the Edit
mode answer.

**Measured, not adopted:** 176 of the 280 `duplicate` nodes are text that a stamped run and a literal both
hold. 9.2 never prefers the stamped run, because a script may have replaced the element's text with the
literal; F28's record of script changes now shows when that happened. With the own stamped run taking
precedence for nodes no script touched, the three decks with the most duplicates (D10, D3, D11) rose from
80.7%, 80.1% and 87.4% to 83.8%, 85.3% and 89.5%, with no new probe failure (measured before F29). Proposed in
`docs/spec-amendments/README.md`; not in the code.

## Packaging and the `blueline` command

### F24. A packaged build cannot serve files from inside `app.asar` (9.10, 9.1 Shell view; review findings 19, 20, 25, 27)

- **Check.** `npm run package:smoke` (`scripts/package-smoke.mjs`): packs the current build with the repo's
  electron-builder config (unpacked `--dir` target, the local Electron, offline), checks the layout, runs the
  packaged `blueline check --auto` through the packaged CLI, and opens a fixture `--protected` in the packaged
  app with Playwright. `test/unit/app/packaging.test.ts`, `app-paths.test.ts`, `test/e2e/cli.spec.ts`.
- **Result.** Before the fix the packaged shell window was blank, with no trust bar, and the Diagnostics deck
  had no reveal.js: Electron's asar fs gives `lstat` synthetic `dev`/`ino` for archive entries and extracts an
  opened entry to a temp file, so `resolveConfined` refused every file inside `app.asar`. The Linux executable
  was named `@bluelineapp`, which the packaged CLI could not find.
- **Code.** `dist/shell` and `dist/assets` ship unpacked (`asarUnpack`), and main serves them from
  `app.asar.unpacked` (`app-paths.ts`); `linux.executableName` is `blueline`. The `blueline` command starts the
  app in its own process group and passes SIGINT, SIGTERM and SIGHUP on to the app's main process (under
  `xvfb-run`, the child of `xvfb-run`, so `xvfb-run` still stops Xvfb), and kills the group if the run has not
  ended 10 s later; `map` and `check` also stop when the process `--bl-parent` names is gone. Signalling the
  whole group at once lost `map`'s result, leaked `xvfb-run` folders and crashed `check`'s GPU process, so the
  signal goes to main first. `map` and `check` exit with the result's exit code, and an interrupted run with
  128+n (130, 143, 129). `blueline open` exits 1 when the app could not start. A file macOS delivers through
  `open-file` to a `map` or `check` process goes to a regular instance (`open-file.ts`; not run on macOS here).

## Review round 1

An adversarial review of the Phase 0 build reported 47 defects, each reproduced by a second reviewer. Two were
duplicates (13 of 9, 14 of 10), so 45 were distinct. All were fixed, each with a regression test that failed
before its fix; the numbers below are the review's finding numbers.

| Area | What the review found | Where it is recorded |
|---|---|---|
| Matching (core, editor) | `exact` nodes that wrote to the wrong place: text from templates, raw-text elements, data blocks, tagged templates, attributes and dropped Strategy 1 text (0, 1); a live `textIndex` shifted by a script (2); computed numbers (3); member-assigned and by-name keys (4); a literal with `<` but no markup treated as HTML (5); a run inside a foster-parented run (6) | F15, F22 |
| Walk and probe (`blueline map`) | an incomplete walk reported as met (28); probe loads sharing storage and slide (30); sentinel copies in hidden nodes ignored (31); shadow roots and frames never walked (32); trusted-key detection latched to synthetic keys (33); long scrolling and single pages counted one viewport per block (34); short blocks missed (35) | F3, F13, F17, F23 |
| Slide detection and slide state | the IPC guard dropped `hashes`, `revealIndices`, `ids` and `deckNav`, so note SlideRefs and `Session.deckNav` were wrong (10, 14); a sibling group with no visible member was taken for the slides (29) | `ipc-guard.ts` `validateSlides`, `slides.ts` `detectGeneric`; `fixtures/slides/`, `test/e2e/slides.spec.ts` |
| Card and overlay input (preload) | a deck read and could cancel card input (9, 13) and wrote into the card with `execCommand` (11); `document.open()` left the overlay dead (12); N's pin took mark number 1 (18); Diagnostics logged a false `first: 'page'` (15), counted the chord echo as a mode change (16) and never logged a card paste (17) | F1, F18–F20 |
| Containment (main) | a `crossorigin` `<video>` or `<audio>` read sibling media (7); WebRTC TURN over TCP reached loopback services past the PAC proxy (8); the shared shell session got one `will-download` listener per window (22) | F7, F11, `trust-hooks.ts` `installShellPolicy` |
| Windows and sessions (main) | a closed window's document stayed in memory (21); `__blTest.windows()` threw while a window closed (23); `session.json` had one writer per window, not per file (24); the one-window-per-file key case-folded paths (26) | F21; `controller.ts`, `window-key.ts`, `session-store.ts` |
| Packaging and the command | the packaged build served nothing from `app.asar` (19); signals reached only `xvfb-run` (20); `blueline open` exited 0 when the app could not start (25); a macOS `open-file` was swallowed by `map` and `check` (27) | F24 |
| Security tests | tests that could not fail: permissions (36), device choosers (37), the Trusted download (38), storage and cookies (39), shell channels from a deck (40), each network layer on its own (41), the protocol-fuzz handler probe (42), hints (43), the Trusted `<a ping>` (44), post-close beacons (45), the download harness (46) | F10–F12 |

Found while fixing or integrating:

- An all-digit docId is an invalid host (F21); it made `blueline map` fail now and then.
- A render view re-attached once per probe load kept one `destroyed` listener per load
  (`trust-hooks.ts` `installDeckWebContentsPolicy`; `test/unit/app/trust-hooks.test.ts`).

Not fixed, documented as limits:

- F19's ordering limit after `document.open()`.
- A deck can select an open card's text, and input that skips `beforeinput` is refused (`SECURITY.md`, Known
  limits of the note card).
- The two DNS channels (F11).
- The walk limits in F23.
- The macOS and Windows parts of the command (Still open).

SPEC.md is unchanged: it is Josh's document. Where a fix changed what it prescribes, the proposed wording is
in [`spec-amendments/`](spec-amendments/README.md), pending his review. The code already follows it:

- 9.1 Protocol: the `blueline-media` scheme for audio and video.
- 9.2 Strategy 2 and Matching DOM to source: shadow values, the number rule, object keys that are not units,
  the markup test for HTML units, and the own-stamp check.
- 9.9: the `fixed_servers` proxy with `<-loopback>`, the layer switch, and when Electron picks a Bluetooth
  device itself.
- Section 10 map steps 3 and 4: the walk down whole pages, incomplete walks, and text in shadow roots and
  frames.
- Section 11: `coverage.slides` in the baseline.

## Still open

- **The 95% coverage gate is not met** (F30): 89.0% on Josh's 12 decks with reduced motion, 71.3% with motion as
  set. The navigation gate is met (193 of 193 slides). Two decisions for Josh: whether Edit and Review render
  animated decks with reduced motion (F27), and whether an untouched stamped node may take precedence over an
  equal literal (F30, `docs/spec-amendments/README.md`).
- **Diagnostics on Josh's Mac: no longer a gate** (Josh, 2026-10-17). Josh edits by selecting text and typing,
  or with any dictation tool; Wispr Flow specifically is not required, so the guided Wispr steps do not gate
  Phase 1. Typing, selection and paste into the card and an editable heading are covered by the E2E suite here.
  The design rules that keep any dictation tool working stay: real text fields, no shortcut on Cmd+V, and no
  shortcut while a text field has focus. F3, F4 and F5 (Retina capture size, macOS focus rules, Fit) are checked
  on the Mac with `blueline check --auto` when convenient, or by Phase 1's use as the default HTML app.
- **The input guard after `document.open()`** (F19): listeners that a deck's `document.write()` scripts register
  synchronously still see card input first; and a deck can select an open card's text (`SECURITY.md`, Known
  limits of the note card).
- **The command on macOS and Windows** (F24): `open-file` routing from a `map` or `check` process is not run
  on macOS here; Windows still stops the app with `child.kill`; a `blueline` command killed with SIGKILL
  leaves its own run folder (`tmp/blueline-cli-*`), though the app still stops.
- **Walk limits** (F23): a document that scrolls inside its own container is walked only as far as
  `scrollIntoView` takes it. Key-gated build steps are now walked and counted (F25).
- **Slide detection trade-offs** (review finding 29): a deck that shows its first slide only after `load`,
  without inserting DOM nodes, is detected as scroll or single by the visible view until the next structural
  change; a real deck nested inside the visible member of an outer group of three siblings with one or two
  visible members loses to the outer group.
- **Index replay keys.** `Session.deckNav` can now hold `ArrowDown` and `ArrowUp`, but the render service's
  `acceleratorKeyFor` maps only `ArrowRight`, `ArrowLeft`, `PageDown`, `PageUp` and space. Phase 1's Index
  replay must map Down and Up or fall back to the default keys.
- **The two DNS channels** (F11) remain; Phase 1's Protected view help states them.
- **The CSP recording card.** 9.1 wants the `default-src 'none'` fixture to include a note card with a
  recording; recordings arrive in Phase 5.
- **`script-src 'self'` decks lose their sibling scripts and styles,** because sibling files come from the
  `-files` origin (`csp-self-inline.html`). Chrome's own `file://` behaviour for such a deck was not compared.
