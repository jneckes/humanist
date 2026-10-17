# Proposed SPEC amendments

SPEC.md is Josh's document and is not edited by the build. Where Phase 0 found that the code must do something
the spec does not say, the code does it, and the wording is proposed here for Josh to accept or reject. The
patches apply in order:

```sh
git apply docs/spec-amendments/phase0-review1.patch
git apply docs/spec-amendments/phase0-real-decks.patch
```

## In the code, wording proposed

| Patch | What changes | Why |
|---|---|---|
| `phase0-review1.patch` | 9.1 `blueline-media` scheme; 9.2 shadow values, the number rule, object keys, the markup test, the own-stamp check; 9.9 the loopback-safe proxy and the layer switch; section 10 whole-page walks; section 11 `coverage.slides` | The review round (PHASE0-FINDINGS, Review round 1) |
| `phase0-real-decks.patch` | 6.7 a key that changes nothing is pressed again, and build steps are collected; section 10 probe batches and `--reduced-motion`; 9.2 script-changed nodes, split-text pieces and single characters | Josh's real decks (PHASE0-FINDINGS F25–F29) |

## Decided by Josh (2026-10-17), in the code, wording proposed

Josh accepted all three proposals below ("go with your recommendations"). The code does each; the SPEC.md
wording is proposed here and not applied, as with the patches.

### 1. Edit and Review with reduced motion for animated decks

Five of the twelve real decks animate with GSAP. With motion on they split headings into one span per word or
letter and scramble text, so most of their text is not `exact` (PHASE0-FINDINGS F27). With
`prefers-reduced-motion: reduce` every deck draws its final frame directly.

**In the code:** the deck view of Review and Edit emulates `prefers-reduced-motion: reduce` (Chromium's media
emulation, for that view only, `packages/app/src/main/motion.ts`); Read and Present keep motion as the deck sets
it. A deck whose inline script reads the setting is reloaded on the switch, keeping its URL hash. `blueline map
--reduced-motion` maps a deck as Edit shows it.

**Proposed wording**, a new first paragraph of 6.3 Edit mode, with a pointer from 6.4: "In Review and Edit the deck renders with
`prefers-reduced-motion: reduce`, as Chrome shows it to a viewer who asks for reduced motion; Read and Present
keep the deck's motion." Principle 2 still holds: these decks are built to look right that way.

### 2. An untouched stamped node takes precedence over an equal literal

9.2 says "A stamped run is never preferred over a literal with the same text", because a script may have
replaced the element's text with that literal. The preload records every text node a script changes (F28), so
for a node no script touched, the reason no longer applies.

Measured on the three real decks with the most `duplicate` nodes (labels as in PHASE0-FINDINGS F30), with the
probe on, on the build before the split and single-character rules (F29):

| Deck | 9.2 as written | Untouched own stamp first | New probe failures |
|---|---|---|---|
| D10 | 80.7% | 83.8% | 0 |
| D3 | 80.1% | 85.3% | 0 |
| D11 | 87.4% | 89.5% | 0 |

On the final build all twelve decks rose from 89.0% to 90.7% of all text, with no new probe failure.

**In the code:** `matcher.ts` step 1 drops equal literals from the doubt when the walk tracked script changes
(`DomTextNode.tracked`) and the node is not `touched`. Without tracking (a caller that does not run the
tracker), 9.2's rule stands.

**Proposed wording**, "Matching DOM to source at runtime": replace "A stamped run is never preferred over a
literal with the same text" with "A stamped run is preferred over a literal with the same text only when no
script has changed the node (it is the parser's own text node)". The tracker's limit: a script that sets
`node.data` while the page is still loading is not seen; the mutation probe still checks every such claim in
`map`.

### 3. The coverage gate measures wording

Of the text nodes that are not exact, about half are numbers, counters, dates and glyphs: slide numbers and
totals the engine writes, KPIs a script computes. 6.3 rarely offers them for editing.

**In the code:** `coverage.wording` counts the nodes whose text has two letters in a row (`hasWords`,
`packages/core/src/text.ts`); `blueline map --min-coverage N` gates on its share. The report still gives the
share of all text.

**Proposed wording**, section 10 Phase 0 exit gate, Coverage: replace "at least 95% of visible text nodes map
`exact` and pass the probe" with "at least 95% of the visible text nodes that hold words (two letters in a row)
map `exact` and pass the probe; the report also gives the share of all text nodes".
