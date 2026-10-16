# Input fixtures (SPEC 6.2, 6.4, 6.5, 9.1 Preload)

Decks that exercise the deck preload's input handling in the real app: the key router, the input guard
(`packages/app/src/preload/input-guard.ts`), the note card and the ink layer. `test/e2e/card-input.spec.ts`
opens copies of them (never the files here).

| File | What it does | Checked by |
|---|---|---|
| `docopen.html` | Rewrites itself with `document.open()`/`write()`/`close()` in its `load` handler, as some bundled or self-extracting decks do. `document.open()` erases every event listener on the window and on every node, the overlay's closed shadow tree included; the preload must add them all back (`listeners.ts`). The written page registers capture-phase `keydown`, `keyup`, `beforeinput`, `input` and `paste` listeners on `window` synchronously, while `document.write()` runs, and records each event's real target in `data-page-log` (it never cancels anything); `data-rewritten="yes"` marks the rewrite. | Card text typed and pasted after the rewrite reaches `session.json`, and a pen stroke makes a mark. The rewritten page's listeners run before the preload's re-added ones and see the card's events: the documented ordering limit, kept as a `test.fail()`. |
