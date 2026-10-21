# Fuzz gate self-test

`node scripts/fuzz-selftest.mjs` (after `npm run build`) runs the Chromium fuzz gate (`scripts/fuzz.mjs`, P2-16)
on the synthetic decks in `decks/`, one seed each, and checks that the gate **fails** the edits it must fail. A
gate that cannot fail proves nothing. These decks are not part of the gate's corpus: `--committed` takes
`fixtures/decks`, `fixtures/decks/reveal-hash` and `fixtures/render` only. The control runs
`fixtures/decks/single.html` and must pass with nothing failed or left unprobed.

Every deck here is synthetic. None is, or quotes, one of Josh's decks.

| Case | Deck | What the deck does | The gate must report |
| --- | --- | --- | --- |
| `wrongplace-8`, `wrongplace-6` | `wrongplace.html` | `#a` is computed (`['Quarterly','total'].join(' ')`) and only reads like the literal that fills `#b`, so the matcher calls `#a` exact for that literal. An edit typed in `#a` is written to the literal: `#b` shows it, `#a` keeps its old text. | `[render]` on `#a` (finding 25) |
| `twofeed-5`, `twofeed-1` | `twofeed.html` | The same with `#lit` (a literal) and `#calc` (a join). | `[render]` on `#calc` (finding 25) |
| `trunc-7` | `trunc.html` | One literal shown whole in `#t` and cut to 6 characters plus `...` in `#nav` when it is longer than 13. An edit typed in `#nav` that makes it longer shows in `#t` and not in `#nav`. | `[render]` on `#nav` (finding 25) |
| `throw-all-1`, `throw-all-2` | `throw-all.html` | The script throws before it renders anything when a label holds a character outside `[A-Za-z0-9 ]`, so after the round's edits the page has no text and a new uncaught error. No node is left to probe. | `[probe] new console error after the round's edits` for the round's edits (finding 26 b) |
| `throw-mixed-1` | `throw-mixed.html` | `throw-all.html` with a static heading. | the same (finding 26 b) |
| `vanish2-2` | `vanish2.html` | A label holding a quote, backslash, `$`, `#` or a brace is shown nowhere (item 0 shows a cleaned copy). Such an edit is written correctly to the literal, and the page then shows it nowhere. | `[probe] the edit shows nowhere` for each such edit (finding 26 a) |
| `sorted-1`, `sorted-6` | `sorted.html` | Eight labels from a script literal, rendered into `<li>`s in alphabetical order, so an edit that changes a label's place in the order moves it to another `<li>`: the author's locator then reads another label. The edit is written right and shows. | exit 0, 0 failures (finding 25 re-verification: the gate must not fail it with `[render]`) |
| `sortrunc-2`, `sortrunc-7` | `sortrunc.html` | The same eight labels sorted into two lists: `#full` shows them whole, `#nav` cuts a label longer than 13 characters to 6 plus `...`. An edit typed in `#nav` that makes a label long and moves it shows whole only in `#full`: the node the author typed in never shows the new text. One edit per round (`batch: 1`). | `[render]` on `#nav` (the repair's re-verification: the moved node is looked for in the author's own list only, so `#full` must not stand in for it) |
| `control-single` | `fixtures/decks/single.html` | A plain deck. | exit 0 |

A failing case passes only when the gate exits 1 and at least one failure (two where the deck makes several)
matches the expected text. The control passes only on exit 0 with 0 failures and 0 unprobed edits.

## Seeds

The fuzz draws a deck's edits from the seed and the deck's label, and a deck given by path is labelled with its
path from the repository root. The review's reproductions ran these decks from other folders, so their seeds
(wrongplace 3, twofeed 3 and 5, trunc 21, sortrunc 3) draw other edits here. The seeds above were found by a sweep
(seeds 1–10 per deck, and 21–23 for `trunc.html`) and chosen so that the gate as it was before the fixes (commit
91b58dc; for `sortrunc` commit 9a735aa) exits 0 with 0 failures on every failing case, or reports none of the
expected failure:

| Case | Before the fixes | After |
| --- | --- | --- |
| `wrongplace-8` | exit 0, 1 written, 0 failures | exit 1, `[render]` on `#a` |
| `wrongplace-6` | exit 0, 2 written, 0 failures | exit 1, `[render]` on `#a` |
| `twofeed-5` | exit 0, 3 written, 0 failures | exit 1, `[render]` on `#calc` |
| `twofeed-1` | exit 0, 4 written, 0 failures | exit 1, `[render]` on `#calc` |
| `trunc-7` | exit 0, 1 written, 0 failures | exit 1, `[render]` on `#nav` |
| `throw-all-1` | exit 0, 9 written, 9 unprobed, 0 probe loads | exit 1, 9 failures (new console error) |
| `throw-all-2` | exit 0, 6 written, 6 unprobed, 0 probe loads | exit 1, 6 failures (new console error) |
| `throw-mixed-1` | exit 0, 5 written, 5 unprobed, 0 probe loads | exit 1, 5 failures (new console error) |
| `vanish2-2` | exit 0, 13 written, 2 unprobed | exit 1, 2 edits that show nowhere (probed on their own) |
| `sorted-1` | (gate after findings 25/26, before the re-verification fix) exit 1, 2 false `[render]` failures | exit 0, 5 written, 0 failures |
| `sorted-6` | (the same) exit 1, 6 false `[render]` failures | exit 0, 7 written, 0 failures |
| `sortrunc-2` | (gate of commit 9a735aa, whose moved node could be anywhere) exit 0, 4 written, 0 failures | exit 1, `[render]` on `#nav` |
| `sortrunc-7` | (the same) exit 1 with 2 `[probe]` failures of the cut list (the probe's sentinel pushes an unmoved label past the cut), no `[render]` | exit 1, the same 2 and a `[render]` on `#nav` |
| `control-single` | exit 0 | exit 0 |

Moving a deck changes its label and so its edits: find its seeds again (`node scripts/fuzz.mjs --decks <path>
--seed <n> --edits <n>` over a few seeds) and update `scripts/fuzz-selftest.mjs`.
