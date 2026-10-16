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

## Not in the code: decisions for Josh

### 1. Edit and Review with reduced motion for animated decks

Five of the twelve real decks animate with GSAP. With motion on they split headings into one span per word or
letter and scramble text, so with motion on, most of their text is not `exact` (PHASE0-FINDINGS F27). With
`prefers-reduced-motion: reduce` every deck draws its final frame directly, and coverage is 89.0% across the
twelve.

Proposal: the deck view of Review and Edit renders with reduced motion (Chromium's media emulation for that
view only); Read and Present keep motion as the deck sets it. Principle 2 still holds: this is how the deck
looks in Chrome for a viewer who asks for reduced motion, and these decks are built to look right that way.

### 2. An untouched stamped node takes precedence over an equal literal

9.2 says "A stamped run is never preferred over a literal with the same text", because a script may have
replaced the element's text with that literal. The preload now records every text node a script changes
(F28), so for a node no script touched, the reason no longer applies.

Measured on the three real decks with the most `duplicate` nodes, with the probe on:

| Deck | 9.2 as written | Untouched own stamp first | New probe failures |
|---|---|---|---|
| `substrate-x-cabanillas-proposal-v5` | 80.7% | 83.8% | 0 |
| `bobsled-landing-zone` | 80.1% | 85.3% | 0 |
| `substrate-x-press-on-fundos` | 87.4% | 89.5% | 0 |

Proposal: in "Matching DOM to source at runtime", replace "A stamped run is never preferred over a literal
with the same text" with "A stamped run is preferred over a literal with the same text only when no script has
changed the node (it is the parser's own text node)". The tracker's limit: a script that sets `node.data` while
the page is still loading is not seen; the mutation probe still checks every such claim in `map`.
