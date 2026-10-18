# Coverage baselines

One file per committed fixture deck, written by `blueline map <deck> --report --json` (SPEC section 11,
Coverage baseline). `reveal-hash.json` is `decks/reveal-hash/index.html`; every other file is named after its
deck.

```jsonc
{
  "deckSha": "…",                                   // sha256 of the deck's bytes
  "coverage": { "exact": 38, "ambiguous": 0, "none": 6, "total": 44,   // exact = mapped exact AND passed the mutation probe
                "slides": { "count": 6, "reached": 6 } },          // detected slides, and how many the walk reached
  "runs": [                                         // one entry per visible text node, in walk order
    { "slide": 0, "text": "…", "strategy": "html-text", "confidence": "exact", "start": 2552, "end": 2588, "probe": "pass" },
    { "slide": 0, "text": "1 / 6", "strategy": null, "confidence": "none", "start": null, "end": null, "reason": "computed" }
  ],
  "report": { … }                                   // the detailed report (per slide, non-exact strings, probe, inline blocks)
}
```

- `slide` is 0-based, in detected order (the text report prints it 1-based): the slide or block that contains
  the node, else the slide that was current when the walk first counted it.
- `coverage.slides` (an addition to section 11's format, decision D-j): when `reached` is below `count` the walk
  missed slides, the figure leaves their text out, and `blueline map` exits 1 with `INCOMPLETE` in its report.
  A navigation regression therefore changes the baseline.
- `start` and `end` are UTF-16 offsets into the decoded file of the run an `exact` node maps to (SPEC 9.2 rule 2).
- `probe` is `pass` or `fail` for every `exact` node; coverage counts only `pass`.
- The files hold no absolute path, time or random id, so a baseline changes only when the mapping does. A
  baseline changes only in a commit that says why. CI fails when a deck's coverage drops more than 1 point
  below its stored value (test/e2e/map.spec.ts).

Regenerate one: `npm run build && node packages/cli/dist/blueline.cjs map fixtures/decks/entities.html --report --json > fixtures/expected/entities.json`.

Every `exact` node of every committed fixture passes the probe. `json-data.json` and `js-templates.json`
changed when object keys started to count as keys (9.2 Strategy 2 step 3): `Retention` in `json-data.html`
(a label rendered from a JSON object key, which the probe showed was written into a value with the same
text) and `Decision` in `js-templates.html` (a status that is also an identifier key of `STATUS_COLOR`) are
now `ambiguous` (`key`). See fixtures/README.md, Open points.

All 18 files were regenerated after the review's walk and probe fixes (findings 28, 30-35): every one gained
`coverage.slides`, `report.coverage.complete` and `report.uncounted`. Only three changed otherwise.
`report.json`: six nodes moved to the block that contains them (`Method`, its first paragraph, `Findings`,
`Recommendations` and its first item, `Appendix` were counted on the block above, which was current when
they first came into view; review finding 35). `js-templates.json` (`14`, also `.14em` in the CSS) and
`json-data.json` (`Checkout redesign — results`, also the `<title>`): one node each went from `exact` to
`ambiguous` (`shadow`), from the matcher's shadow values (review findings 0 and 3; their `.expect.json`
entries say why).

`generic-hash-writeonly.json` was added in Phase 1's review round 1 with its deck (a generic engine that writes
its slide into the hash but never reads it, review finding 17): 12 of 18 nodes `exact`, the six pagers `none`
(`computed`), every exact node passing the probe. No other baseline changed in that round: every one of the 18
earlier decks maps byte for byte as its file says.
