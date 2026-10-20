# Edit fixtures

Decks for Edit mode in the deck view (SPEC 6.3; 9.2 "Matching DOM to source at runtime" and "Committing an edit"
1–5; Phase 2 decisions P2-5 to P2-9, P2-13, P2-14, P2-17). `test/e2e/edit-overlay-field.spec.ts` and
`test/e2e/edit-overlay-ui.spec.ts` copy a deck to a temp folder, open it in the app, switch to Edit, and drive the
deck preload against a stub main (`test/e2e/edit-overlay-harness.ts`). They are named `@edit`, so the reader-only
run (P2-15) leaves them out.

## `edit-overlay.html`

A single page (no slide engine) at the top of a 940×860 deck view. What each element is for:

| Element | Map (`exact / ambiguous / none`) | Used for |
|---|---|---|
| `#title` `Quarterly review` | `exact` `html-text` (own stamp; equal to a script literal, so `exact` only because the deck view tracks script changes, P2-6) | solid outline; click, type, Enter, the result, the toast's Undo; native undo confined to the field (P2-9) |
| `#inline` `Hello <b>bold</b> world` | three `exact` runs | the input filter: a deletion across the `<b>` is blocked, one inside a run is committed |
| `#link` `Visit the site` | `exact` | a click opens a field and is never followed (P2-17) |
| `#upper` (CSS `text-transform: uppercase`) | `exact` | source case and its badge (6.3) |
| `#fit` in `#box` (260×50 px) | `exact` | the fit guard: `+1 line · widow`, then `+2 lines · overflows` (the box has a fixed height) |
| `#narrow` (320 px wide) | `exact` | the fit guard's widow |
| `#noselect` (`user-select: none`) | `exact` | user-select lifted while editing (P2-17) |
| `#spin`, `#still` | — | a running CSS animation (paused in Edit, resumed after) and one the page paused itself (left alone) |
| `#toc` (copied by script from `#title`) | `ambiguous` (`stamp-other`) | dashed outline; the picker with one candidate, chosen with the mouse |
| `#twin` (`'Twin text'`, two equal literals) | `ambiguous` (`duplicate`) | dashed outline; the picker with two candidates, chosen with the keys |
| `#rep1`, `#rep2` (one literal shown twice) | both `exact` `script-literal` | "· also changes 1 other place"; a field the page re-renders or removes becomes a verbatim note (P2-17); a literal write waits for the reload |
| `#count` (`'Slide ' + 1 + ' of ' + 5`) | `none` | no outline; "Not editable" (P2-13) |
| `#svgtext` (SVG `<text>`) | `exact` | the overlay input over SVG text (P2-17: `contenteditable` does nothing on SVG elements in Electron 44) |

The page's script counts, at window capture, the events that reach it (`data-seen-<type>` on the root element):
a press that opens a field, the field's keys, input and paste must never reach it. It also cancels
`selectstart`, as many decks do, which must not stop selecting text in a field.
