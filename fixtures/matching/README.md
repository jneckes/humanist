# Matching fixtures

Reproduction decks for the review's matching findings (SPEC 9.2 Strategy 2 step 3, "exact: … that run occurs
once in the file"; section 10 exit gate: "a node reported exact that fails the probe is a write to the wrong
place"). `test/e2e/map-matching.spec.ts` copies each deck to a temp folder, runs
`blueline map <copy> --report --json`, and checks that the named nodes are not `exact`, that no probe fails,
and that a control text only one literal holds stays `exact` and passes the probe.

| Deck | Finding | Not exact |
|---|---|---|
| `shadow-sources.html` | 0: text from sources that are not runs (a cloned `<template>`, `<title>` through `document.title`, `text/x-template` through innerHTML, an `html\`…\`` tagged template, an `aria-label`, a hidden `<textarea>`) equals a canvas label literal | `Revenue`, `Board review`, `Churn outlook`, `Hiring plan`, `Gross margin`, `Pipeline health` |
| `adoption.html` | 1: an unclosed `<em>` reconstructed in the next `<li>` (the walk drops both texts) and a button set from an equal literal | `Ship the beta` |
| `unclosed-heading.html` | 1: `<h2><em>Plan</h2><p>Details</p>` and a contents list built from `TITLES` | `Plan` |
| `breadcrumb.html` | 2: `p.prepend('You are here: ')` shifts the separators' live textIndex | ` / ` |
| `numbers.html` | 3: computed numbers (`DATA.deals = 600`, a counter, Intl `1,234`) equal to unrelated string literals (`setAttribute('width', '600')`, `style.opacity = '1'`, a fallback `'1,234'`) | `600`, `1`, `1,234` |
| `member-keys.html` | 4: a key made by member assignment (`totals.Bookings = 120`) and a quoted key read by name (`KPI.Retention`) | `Bookings`, `Retention` |
| `foster-table.html` | 6: a cell inside the range of a foster-parented text run (every write there is refused by verify) | `Cell one` |
| `chrome-rewrite.html` | real decks: the engine rewrites the slide number and section label after load; on slide 1 they equal their stamped runs by coincidence (`DomTextNode.touched`) | `01`, `Cover`, `/ 03` (written by an inline script while the page loads) |
