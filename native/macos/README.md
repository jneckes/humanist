# blueline-helper (macOS)

Blueline's macOS native helper (SPEC 6.1 Becoming the default app, 9.6 `native/`, 9.9 Write protocol addition and
Derived files keep the marker). A small Swift command-line tool, Swift 5.9, macOS 12 or later, system frameworks
only (AppKit, CoreServices, UniformTypeIdentifiers, Darwin).

## What it does

Main (`packages/app/src/main/native-helper.ts`) starts it once, on first use, as a long-lived child, and talks to it
in JSON lines: one request per line on its stdin, one reply per line on its stdout, matched by `id`. Replies can
come out of order. When stdin closes (Blueline quit or crashed) the helper exits. Main restarts it with a backoff
if it dies, kills it if a quick request is not answered within 10 s, and stops restarting it after six exits in a
row (it then falls back to `/usr/bin/xattr` for the quarantine marker).

| Request | Does | Reply |
|---|---|---|
| `{"id":1,"op":"readQuarantine","path":"/abs/deck.html"}` | `getxattr(path, "com.apple.quarantine")`, the whole value | `{"id":1,"ok":true,"value":"0083;…"}`, or `"value":null` when there is none |
| `{"id":2,"op":"copyXattrs","from":"/abs/deck.html","to":"/abs/.bl-write-….tmp"}` | `copyfile(from, to, NULL, COPYFILE_XATTR)`: every extended attribute, the marker included (the atomic write, 9.9) | `{"id":2,"ok":true}` |
| `{"id":3,"op":"setQuarantine","path":"/abs/copy.html","value":"0083;…"}` | `setxattr` with that whole value (a derived file keeps its document's marker, 9.9) | `{"id":3,"ok":true,"value":"…"}` (read back) |
| `{"id":4,"op":"setQuarantine","path":"/abs/data.csv","properties":{"agent":"Blueline","originUrl":"file:///…/deck.html","dataUrl":"https://…"}}` | Launch Services quarantine properties (`URLResourceValues.quarantineProperties`): a new marker naming the deck as its origin (a deck's download; a copy of a Protected document that had no marker) | as above |
| `{"id":5,"op":"isDefaultHtmlApp","app":"/Applications/Blueline.app"}` | `NSWorkspace.urlForApplication(toOpen: UTType.html)`, compared with `app` | `{"id":5,"ok":true,"isDefault":false,"current":"/Applications/Safari.app","currentName":"Safari"}` |
| `{"id":6,"op":"setDefaultHtmlApp","app":"/Applications/Blueline.app"}` | `NSWorkspace.setDefaultApplication(at:toOpen:completionHandler:)` with `UTType.html` (covers `.html` and `.htm`) | `{"id":6,"ok":true}`, or `{"id":6,"ok":false,"error":"…","declined":true,"domain":"…","code":…}` |

Every failure is `{"id":n,"ok":false,"error":"…"}`. Paths must be absolute and contain no NUL. A quarantine value
is at most 64 KB of text with no NUL or line break.

**From macOS 26.4**, every file-type default change made through `setDefaultApplication` asks the user (Use or
Keep), and the completion handler waits for the answer; main waits up to 10 minutes. Apple documents no error code
for Keep, so on 26.4 and later any refusal is reported as `"declined": true`, which the welcome window and Settings
treat as "not now". The check reads both `ProcessInfo.isOperatingSystemAtLeast(26.4)` and the Darwin kernel release
(25.4 or later), because a binary built with an older SDK may be told an older macOS version. Apple changed which
changes prompt during the 26.4 betas, so Phase 1 re-checks this on the current macOS (6.1).

## Build

```sh
native/macos/build.sh        # → native/macos/build/blueline-helper (universal arm64 + x86_64, ad-hoc signed)
```

`swiftc -O` per architecture, then `lipo`. `swift build -c release` (Package.swift) also works for a local check.

## Where it ships and how it is found

- **Packaged:** electron-builder copies `native/macos/build/blueline-helper` to
  `Blueline.app/Contents/Resources/helper/blueline-helper` through `mac.extraResources`, outside `app.asar` (an
  executable cannot run from inside the archive). The entry is added only when the built binary exists, so the
  config still works on Linux and in CI without it (`packages/app/electron-builder.config.cjs`). Main looks only
  there in a packaged app (`process.resourcesPath/helper/blueline-helper`).
- **Development:** main looks for `native/macos/build/blueline-helper` in the checkout. Without it, the quarantine
  marker is read, copied and written with `/usr/bin/xattr` (main says so once in its log), and "Make Blueline your
  HTML app" says it needs the helper. A development run never sets the default app: its bundle is Electron's own.

## Signing and notarization (9.10)

The helper is signed and notarized with the app; it needs no step of its own:

- electron-builder's macOS signing (`@electron/osx-sign`) walks the whole `.app` and signs every Mach-O file in it,
  this one included, with the Developer ID identity, the hardened runtime (`mac.hardenedRuntime: true`) and the
  inherited entitlements file (`entitlements.mac.inherit.plist`; the helper needs none of its own: no sandbox,
  no JIT). It is signed before the app bundle, so the bundle's seal covers it.
- Notarization submits the signed `.app` (or the dmg/zip made from it), which includes the helper; a helper that
  was not signed with the hardened runtime and a secure timestamp would fail notarization.
- Check a release build with `codesign --verify --deep --strict --verbose=2 Blueline.app` and
  `codesign -dv --verbose=4 Blueline.app/Contents/Resources/helper/blueline-helper` (look for `flags=0x10000(runtime)`
  and the Developer ID authority), and `spctl -a -vvv -t exec Blueline.app`.

## Not run here

The dev container is Linux with no Swift toolchain, so this helper has not been compiled or run. It was written
against Apple's documented APIs (NSWorkspace `setDefaultApplication(at:toOpen:completionHandler:)` and
`urlForApplication(toOpen:)`, macOS 12; `getxattr`/`setxattr`; `copyfile(3)` `COPYFILE_XATTR`;
`URLResourceValues.quarantineProperties`). The JSON-lines client, its timeouts, restarts and the `/usr/bin/xattr`
fallback are unit-tested in `test/unit/app/native-helper.test.ts` with a fake child. On a Mac, check:

```sh
native/macos/build.sh
f=$(mktemp); xattr -w com.apple.quarantine "0083;65f1c2a3;Safari;" "$f"
printf '{"id":1,"op":"readQuarantine","path":"%s"}\n' "$f" | native/macos/build/blueline-helper
g=$(mktemp); printf '{"id":2,"op":"copyXattrs","from":"%s","to":"%s"}\n' "$f" "$g" | native/macos/build/blueline-helper
xattr -p com.apple.quarantine "$g"
printf '{"id":3,"op":"isDefaultHtmlApp","app":"/Applications/Blueline.app"}\n' | native/macos/build/blueline-helper
```
