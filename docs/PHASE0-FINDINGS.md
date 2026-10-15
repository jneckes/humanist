# Phase 0 findings

Each entry: the question from SPEC.md, what was checked, the result, and what the code does about it.

**Environment for every automated check.** Linux container (kernel 6.18), Electron 44.7.2 (Chromium
152.0.7977.149, Node 24.21.0), Xvfb with a 3840×2160 screen. The E2E tests and `blueline map` run the app as
root with `--no-sandbox` (a development convenience). The security suite runs the app as the unprivileged user
`bltest` with the OS sandbox on (proven from `/proc`: seccomp mode 2, `no_new_privs`, its own user namespace),
inside a private mount namespace whose `resolv.conf` points at the suite's DNS server, so DNS lookups are
observable. `blueline check --auto` was run both ways with the same results. macOS behaviour (Wispr Flow, the
quarantine marker, Retina capture) is checked on Josh's Mac with the Diagnostics window; see Still open.

Commands (final run, 2026-10-15): `npm run build`, `npm run build:reader-only`, `npx tsc -p tsconfig.json
--noEmit`, `npx vitest run`, `npm run test:e2e`, `npm run test:security`, `node packages/cli/dist/blueline.cjs
check --auto`, and `blueline map <deck> --report --json` on every committed fixture. Numbers are in README.md
and in each entry below.

## Keys and input

### F1. The preload's capture listener runs first, and its `stopImmediatePropagation()` stops the deck (6.2)

- **Check.** Diagnostics `key-order` and `stop-propagation` (automatic): a trusted key (`sendInputEvent`) to
  the reveal.js Diagnostics deck, whose own capture listeners on `window` and `document` record each keydown
  in `data-bl-key-log`. In Read, Shift must reach the preload before the deck; in Review, `V` (a shortcut the
  router consumes) must never reach the deck's listeners. Also `test/e2e/preload-electron.spec.ts` (the
  capture listener runs first; main-world listeners stopped) and the reveal fixture's key log.
- **Result.** Pass. The isolated world's capture listener on `window`, registered before any page script,
  runs before the page's own capture listeners on `window` and `document`, and `stopImmediatePropagation()`
  called there stops the main world's listeners (`pageListenerRan: false`).
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
  for a deck that ignores untrusted keys) for platforms where trusted keys do not arrive.

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
  "second origin" alone does not stop reads, as 9.1 assumed it would.
- **Code.** Two layers make up for it, in both trust states: `onBeforeRequest` cancels every `xhr` (how
  webRequest reports `fetch()`, XHR and `EventSource`) to a `-files` URL (`network-policy.ts`,
  `files-read`), and the handler refuses every request that carries an `Origin` header except fonts (module
  scripts, `import()`, `crossorigin` images and styles; `protocol.ts` `corsReadRefused`). The security suite's
  `local-files` fixture (fetch, XHR, iframe, object, canvas, `cssRules`, muted script errors, a module script,
  a worker, `.ssh/id_rsa`) passes in both trust states.

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

### F11. Covert channels in Protected view (9.9, section 10 Security fixtures)

- **Check.** `npm run test:security` (`fixtures/security/network.html`, `hints.html`, `webrtc.html`,
  `navigation.html`), with the suite's own HTTP and WebSocket server, DNS server, and UDP and TCP listeners on
  a non-loopback address. Each attempt uses its own host name, so whatever arrives names the channel. Results
  per attempt were also dumped from the real app in both trust states.
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
  | pagehide and visibilitychange beacons | nothing arrived after close | as above |
  | static `dns-prefetch`, `preconnect`, `prefetch`, `prerender`, `x-dns-prefetch-control: on` meta | nothing arrived, no DNS | removed from the served copy; `X-DNS-Prefetch-Control: off` |
  | script-inserted `preconnect`, `prefetch`, `prerender`; speculation rules; links | nothing arrived, no DNS | PAC proxy to a closed port; webRequest |
  | **script-inserted `dns-prefetch`** | **DNS lookup of the name** | **not stoppable (below)** |
  | WebRTC STUN and TURN over UDP, by name and by IP | no packet, no DNS | `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` |
  | **WebRTC TURN over TCP and TLS, by name** | **DNS lookup of the name**, no connection | connection: PAC proxy to a closed port; lookup: not stoppable (below) |
  | `<a ping>`, `<meta http-equiv=refresh>`, scripted navigation, `window.open`, form `_self`/`_top`, custom scheme | nothing arrived | will-navigate / will-frame-navigate, window open handler, webRequest |

- **Result, Trusted (positive control).** Subresources, `fetch`, XHR, WebSocket, `EventSource`, keepalive
  fetch and `sendBeacon` reach the server, as 6.10 allows; navigation, popups, `<a ping>` and meta refresh
  still reach nothing.
- **The two open channels.** Only a host name leaves; no packet, connection or request reaches the host.
  1. *Script-inserted `<link rel=dns-prefetch>`.* Blink checks only the `dns_prefetching_enabled`
     WebPreferences switch for link-element prefetches (not `X-DNS-Prefetch-Control`), Electron 44 does not
     expose that switch, Electron's network hints handler resolves the name in the partition's network
     context without consulting the proxy, and no CSP directive covers it.
  2. *WebRTC TURN over TCP/TLS host names.* ICE resolves the TURN server's name before the proxied connect.
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

- **Check.** `npm run test:security`: 31 tests, the app as `bltest` with the OS sandbox on, DNS observable.
- **Result.** 31 passed: 29 plain passes and the 2 expected failures of F11.

  | Area | Protected | Trusted |
  |---|---|---|
  | Network (F11) | contained except the two DNS channels | allowed kinds arrive (positive control) |
  | Local files: sibling and outside files, `.ssh/id_rsa`, `file:`/`app:` URLs, symlinks | never readable | never readable |
  | Protocol fuzz (percent-encoded, double-encoded, dot segments, mixed case, Unicode look-alikes, backslashes, dotfiles, symlinks, other hosts) | nothing outside the folder | nothing outside the folder |
  | Scripted navigation and popups | nothing reached; the document stays | same |
  | Clicked external link | confirm dialog, nothing opened until confirmed | same |
  | Clicked local `.html` link | opens in its own Blueline window | same |
  | `<a ping>`, meta refresh | nothing sent; cancelled | same |
  | Downloads | blocked | need confirmation (save dialog); nothing saved without it |
  | Permissions (camera, mic, location, notifications, clipboard read, MIDI) and Bluetooth, HID, serial and USB choosers after a real click | denied | denied |
  | Storage (cookie, localStorage, sessionStorage, IndexedDB, Cache Storage) | cleared when the window closes | kept per file across reopen |
  | Forged IPC on every deck channel, and a flood | no file written, no state changed; rate-limited | (Protected deck) |

- **Code.** One fix came out of this run: Trusted storage was not kept per file (F13).

### F13. A Trusted deck needs a stable origin to keep its storage (6.10 Storage)

- **Check.** The suite's storage fixture writes on first open; the same file is reopened with the same
  userData.
- **Result.** Before the fix, a Trusted reopen found nothing: storage is keyed by origin
  (`blueline://<docId>`), and the docId was new on every open, so the persistent partition alone did not keep
  storage "per file".
- **Code.** A Trusted file's docId is still random (9.1), never derived from its path, but it is generated
  once per file and kept in `<userData>/files/<fileKey>/origin` (`documents.ts` `trustedDocumentId`, an
  addition to the 9.7 layout). Protected opens always get a fresh docId in a non-persistent partition.
  `blueline map` and the probe copy keep fresh docIds.

## Mapping and writing (9.2; section 10 map and mutation probe)

### F14. Coverage of the committed fixtures, and the mutation probe

- **Check.** `blueline map <deck> --report --json` on all 18 committed fixtures, each compared with its
  `<name>.expect.json` (what the fixture is meant to test). This comparison is now automated in
  `test/e2e/map.spec.ts` together with the baseline check. The probe writes the sentinel `⟦bl⟧` through the
  real patcher on a hidden copy, reloads, goes back to the slide, checks the sentinel is in that node and no
  other (except reported renders of the same run), checks for new console errors and an unchanged slide count,
  then undoes through the patcher and requires the copy's bytes to equal the original's.
- **Result.** Every expectation holds on all 18 decks, every slide of every deck was reached, and **every
  `exact` node passes the probe (413 of 413), with every undo byte-exact**. These do not count toward the 95%
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
  | `js-templates` | generic · 4 · index | 31 / 18 / 14 (63) | 49.2% | 31/31, 31 |
  | `json-data` | generic · 4 · index | 31 / 8 / 9 (48) | 64.6% | 31/31, 28 |
  | `keys-prevent-default` | generic · 4 · index | 14 / 0 / 0 (14) | 100.0% | 14/14, 14 |
  | `notes-block` | generic · 3 · index | 9 / 0 / 1 (10) | 90.0% | 9/9, 9 |
  | `report` | scroll · 5 · scroll | 63 / 0 / 0 (63) | 100.0% | 63/63, 63 |
  | `reveal-hash` | reveal · 8 · reveal | 27 / 0 / 0 (27) | 100.0% | 27/27, 27 |
  | `single` | single · 1 · none | 21 / 0 / 0 (21) | 100.0% | 21/21, 21 |
  | `unicode-edit-points` | generic · 3 · index | 14 / 0 / 0 (14) | 100.0% | 14/14, 14 |
  | `windows-1252` | generic · 3 · index | 0 / 0 / 9 (9) | 0.0% | not run: not UTF-8, never written |
  | **all** | | **413 / 28 / 47 (488)** | 84.6% | **413/413** |

  The non-`exact` nodes are the ones each fixture exists to show: JS-built counters and `${…}` text
  (`computed`), duplicated and key-like literals, near misses (`not-equal`, `substring`), literals shown through
  `innerHTML`, text from external scripts, cloned templates, and the windows-1252 deck (`not-utf8`).
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
  it as a key"): JSON object keys and identifier keys of JS object literals and class fields
  (`mapper-literals.ts`, merged into `DeckMap.keys`/`keyValues` by `buildMap`). Such text is `ambiguous`
  (`key`), with the picker warning "also used as a key at deck.html:<line>". JSON keys are still not units.
  Verify compares the key list last, so a script that stops parsing reports that first. Baselines
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
  `skipClipped`), and the probe ignores sentinel copies in nodes that are neither visible nor counted
  (`probe.ts` `judgeNode`). Fragments stay at opacity 0 after `Reveal.slide(h, v)`, so they are not counted.

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

## Still open

- **The 95% coverage gate and the 90% navigation gate** need Josh's 10 real decks in `fixtures/local/`
  (SPEC 13, question 1). Run `blueline map <deck> --report --json > fixtures/local/expected/<deck>.json` on
  each and report the combined figure.
- **Diagnostics on Josh's Mac.** The guided steps (Wispr Flow into the card and the heading, dictation in
  each mode, two strokes while dictating) need a person and Wispr Flow; `check.json` from that run decides
  the Diagnostics exit gate. F3, F4 and F5 are also rechecked there (Retina scale, macOS focus rules).
- **The two DNS channels** (F11) remain; Phase 1's Protected view help states them.
- **The CSP recording card.** 9.1 wants the `default-src 'none'` fixture to include a note card with a
  recording; recordings arrive in Phase 5.
- **`script-src 'self'` decks lose their sibling scripts and styles,** because sibling files come from the
  `-files` origin (`csp-self-inline.html`). Chrome's own `file://` behaviour for such a deck was not compared.
