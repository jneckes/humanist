# Phase 0 findings

Each entry: the question from SPEC.md, what was checked, the result, and what the code does about it.
Environment for automated checks: Linux container, Electron 44.7.2 (Chromium 152.0.7977.149, Node 24.21.0),
Xvfb.

## F1. `protocol.handle` can redirect sibling files to a second origin (9.1 Serving)

- **Check.** A partition handler returns `307` with `Location: blueline://<docId>-files/<path>` for any path
  other than the document's own path.
- **Result.** Works: the follow-up request arrives at the handler on the `-files` host.
- **Code.** `packages/app/src/main/protocol.ts` serves sibling files only from the `-files` host.

## F2. Offscreen capture size (6.7)

- **Check.** Hidden offscreen `BrowserWindow`, 1600×900, `offscreen.deviceScaleFactor: 2`, `capturePage`.
- **Result.** 3200×1800 when the X screen is at least 1600 px wide. On a 1280-px Xvfb screen the window is
  clamped to the screen width (2560×1800) even with `enableLargerThanScreen: true`.
- **Code.** The render service checks the captured size and reports a mismatch; Linux runs use a
  3840×2160 Xvfb screen. macOS behaviour is re-checked on Josh's Mac.
