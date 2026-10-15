# Coverage baselines

One file per committed fixture deck, written by `blueline map <deck> --report --json` (SPEC section 11,
Coverage baseline). `reveal-hash.json` is `decks/reveal-hash/index.html`; every other file is named after its
deck.

```jsonc
{
  "deckSha": "…",                                   // sha256 of the deck's bytes
  "coverage": { "exact": 38, "ambiguous": 0, "none": 6, "total": 44 },  // exact = mapped exact AND passed the mutation probe
  "runs": [                                         // one entry per visible text node, in walk order
    { "slide": 0, "text": "…", "strategy": "html-text", "confidence": "exact", "start": 2552, "end": 2588, "probe": "pass" },
    { "slide": 0, "text": "1 / 6", "strategy": null, "confidence": "none", "start": null, "end": null, "reason": "computed" }
  ],
  "report": { … }                                   // the detailed report (per slide, non-exact strings, probe, inline blocks)
}
```

- `slide` is 0-based, in detected order (the text report prints it 1-based).
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
