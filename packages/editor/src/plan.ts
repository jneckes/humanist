// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// planEdit: turns one EditRequest into one minimal raw splice of src (9.2 Strategy 1 step 5, Strategy 2
// steps 4–5, rule 5). The plan is deterministic (D5): it never guesses. Anything it cannot place exactly is
// refused with a reason, and the write queue turns the edit into a `verbatim` note (Strategy 3).
//
// Rules applied here, in order:
//   - the deck decoded as UTF-8 (rule 1), the request's text is well-formed, and something changed;
//   - the run (by id, in this map) holds beforeText exactly ("Committing an edit" step 4, Write protocol 3);
//   - the edit is not structural: a run emptied or left whitespace-only would drop its text node, renumber
//     textIndex (and possibly stamps) of what follows, and change layout, so it becomes a note (6.3 "Edits
//     that need structural changes become notes");
//   - html-text: the run is aligned; map the changed span through its decoded-to-raw table, widen over
//     references, CRLF and surrogate pairs, encode `&`, `<` and (only where the run already did) U+00A0,
//     splice only that range (Strategy 1 step 5, via html-tables' planHtmlTextEdit);
//   - literals: placeholder runs are pin-only (7); a literal without `<` may reach the page through innerHTML,
//     so adding `<` or `&` to it is refused (Strategy 2 step 5.1); HTML-fragment runs are HTML-encoded first,
//     then JS- or JSON-escaped (5.2, 5.3); the span is widened through the HTML table and the unit's escape
//     table, so no reference, escape or `${…}` is ever cut (step 4); `${…}` is never touched;
//   - the splice is checked against the unit's own cooked-to-raw parser before anything is written
//     (checkLiteralSplice: it must cook to the expected value and form no `</script`, `<script` or `<!--`).

import { changedSpan } from '@blueline/core/edit-cleanup';
import { decodeHtmlText, htmlTextTable, planHtmlTextEdit } from '@blueline/core/html-tables';
import { checkLiteralSplice, escapeJsonText, escapeJsText, PLACEHOLDER } from '@blueline/core/js-literals';
import { literalRunMapping } from '@blueline/core/mapper-literals';
import { isWhitespaceOnly } from '@blueline/core/text';
import type { DeckMap, EditRequest, HtmlRun, LiteralRun, LiteralUnit } from '@blueline/core/types';
import { applySplice, isWellFormed } from './splice';

export type EditStrategy = 'html-text' | 'script-literal' | 'json-literal';

/** A planned write: one raw splice of src, and what verify must find afterwards. */
export interface EditPlan {
  ok: true;
  runId: string;
  strategy: EditStrategy;
  /** Raw splice in src (UTF-16 offsets): [start, end) is replaced by rawAfter. start === end: pure insertion. */
  start: number;
  end: number;
  /** src.slice(start, end): the exact raw text the write removes (already encoded and escaped). */
  rawBefore: string;
  /** The exact raw text the write inserts, already encoded and escaped. Empty: pure deletion. */
  rawAfter: string;
  /** src with the splice applied (magic-string, 9.2 rule 5). */
  newSrc: string;
  beforeText: string;
  afterText: string;
  /** The run's raw range in src before the edit. */
  runStart: number;
  runEnd: number;
  /** html-text: the stamp, its insertion site (the element's identity across versions) and textIndex. */
  html?: { stamp: string; stampOffset: number; textIndex: number };
  /** Literals: the unit (identified by its content start) and the cooked value it must hold afterwards. */
  literal?: {
    unitIndex: number;
    runIndex: number;
    unitStart: number;
    unitEnd: number;
    scriptIndex: number;
    kind: LiteralUnit['kind'];
    quote: LiteralUnit['quote'];
    expectedCooked: string;
  };
}

export interface PlanRefusal {
  ok: false;
  why: string;
}

export type PlanOutcome = EditPlan | PlanRefusal;

function refuse(why: string): PlanRefusal {
  return { ok: false, why };
}

/** The run with this id in this map version, or null. */
export function findRun(map: DeckMap, runId: string): HtmlRun | LiteralRun | null {
  if (runId.startsWith('h:')) return map.runs.find((r) => r.id === runId) ?? null;
  if (runId.startsWith('l:')) return map.literals.find((l) => l.id === runId) ?? null;
  return null;
}

/**
 * Plans one edit of src (whose map is `map`). `req.runId` names a run of this map; the caller (the write
 * queue) has already re-resolved it when the client's version was stale. Never throws on bad input.
 */
export function planEdit(src: string, map: DeckMap, req: EditRequest): PlanOutcome {
  if (!map.utf8) return refuse('not-utf8: the deck is not UTF-8, so it is never written (9.2 rule 1)');
  if (typeof req.beforeText !== 'string' || typeof req.afterText !== 'string' || typeof req.runId !== 'string') {
    return refuse('invalid request');
  }
  if (map.served && map.served.srcLength !== src.length) return refuse('the map was built from another version of the file');
  const before = req.beforeText;
  const after = req.afterText;
  if (before === after) return refuse('unchanged: afterText equals beforeText');
  if (after.length === 0 || isWhitespaceOnly(after)) {
    return refuse('structural: the edit empties the run or leaves it whitespace-only (6.3)');
  }
  const run = findRun(map, req.runId);
  if (!run) return refuse(`no run ${req.runId} in this version`);
  // Phase 2 (ambiguity picker): a candidate equal only after whitespace collapse and NFC needs the
  // normalized-to-cooked-to-raw mapping of Strategy 2 step 4; until then such an edit is verbatim.
  if (run.value !== before) return refuse('the run no longer holds beforeText (9.2 Write protocol step 3)');
  if (!(run.start >= 0 && run.start <= run.end && run.end <= src.length)) return refuse('the run lies outside the file');
  if (map.notesBlock && run.end > map.notesBlock.start) return refuse('the run reaches into the notes block (8)');
  return run.strategy === 'html-text' ? planHtml(src, map, run, before, after) : planLiteral(src, map, run, before, after);
}

function planHtml(src: string, map: DeckMap, run: HtmlRun, before: string, after: string): PlanOutcome {
  if (!run.aligned) return refuse('unaligned: the run has no verified decoded-to-raw table');
  const site = map.served?.stamps.find((s) => s.stamp === run.stamp);
  if (!site) return refuse('the run has no stamp site in this map');
  const raw = src.slice(run.start, run.end);
  const span = changedSpan(before, after);
  // 9.2 Strategy 1 step 5: map, widen, encode (U+00A0 as &nbsp; only where the run already did), splice.
  const sp = planHtmlTextEdit({
    raw,
    before,
    after,
    opts: run.textOpts ?? {},
    nbspAsRef: run.usesNbspRef,
    lineEnding: map.lineEnding,
    span,
  });
  if (!sp) return refuse('html-text: no raw splice of this run decodes to afterText');
  return finish(src, run.start + sp.start, run.start + sp.end, sp.text, {
    runId: run.id,
    strategy: 'html-text',
    beforeText: before,
    afterText: after,
    runStart: run.start,
    runEnd: run.end,
    html: { stamp: run.stamp, stampOffset: site.offset, textIndex: run.textIndex },
  });
}

function planLiteral(src: string, map: DeckMap, run: LiteralRun, before: string, after: string): PlanOutcome {
  if (run.placeholder) return refuse('placeholder: a run with ${…} is pin-only (7)');
  if (run.aligned === false) return refuse('unaligned: the literal run has no verified cooked-to-raw table');
  const unit = map.units[run.unit];
  if (!unit || unit.index !== run.unit) return refuse('the run has no unit in this map');
  if (!unit.aligned) return refuse('unaligned: the literal has no verified cooked-to-raw table');
  const script = map.scripts[unit.scriptIndex];
  if (!script || !script.parsed || script.hasSrc) return refuse('the literal is not in a parsed inline script');
  if (!(script.contentStart <= unit.start && unit.end <= script.contentEnd)) return refuse('the literal lies outside its script');
  const expectedKind = unit.kind === 'json-string' ? 'json' : null;
  if (expectedKind === 'json' ? script.kind !== 'json' : script.kind !== 'classic' && script.kind !== 'module') {
    return refuse('the literal kind does not fit its script');
  }
  if (run.html !== unit.html) return refuse('the run is a shadow run (innerHTML view of a literal), never written');
  const mapping = literalRunMapping(src, unit, run.runIndex);
  if (!mapping) return refuse('unaligned: the run mapping could not be rebuilt');
  const span = changedSpan(before, after);
  const inserted = after.slice(span.start, span.endAfter);
  // The placeholder character stands for `${…}` in cooked values; typed text must not look like one.
  if (inserted.includes(PLACEHOLDER)) return refuse('the new text contains U+E000, the placeholder character');

  const cooked = unit.cooked;
  // The new cooked text, and the cooked range [from, to) it replaces at the narrowest (before escaping).
  let from0: number;
  let to0: number;
  let newCooked: (a: number, b: number) => string; // new cooked text for a widened range [a, b) ⊇ [from0, to0)
  let expectedCooked: string;
  if (!unit.html) {
    // 9.2 Strategy 2 step 5.1: a literal without `<` may reach the page through textContent or innerHTML.
    if (/[<&]/.test(inserted)) return refuse('verbatim: the edit adds `<` or `&` to a literal that may be set with innerHTML (9.2 Strategy 2 step 5.1)');
    // A deletion can also make HTML out of what was plain text (`&am p` → `&amp`): what innerHTML would show
    // must stay what textContent shows, if it did before.
    if (decodeHtmlText(cooked) === cooked && decodeHtmlText(after) !== after) {
      return refuse('verbatim: the edit makes the literal read differently through innerHTML (9.2 Strategy 2 step 5.1)');
    }
    if (mapping.cookedStart !== 0 || mapping.cookedEnd !== cooked.length || cooked !== before) {
      return refuse('the run is not its whole literal');
    }
    from0 = span.start;
    to0 = span.endBefore;
    const shift = span.endAfter - span.endBefore;
    newCooked = (a, b) => after.slice(a, b + shift);
    expectedCooked = after;
  } else {
    // An HTML-fragment run: the text node `before` sits at [cookedStart, cookedEnd) of the cooked value.
    const slice = cooked.slice(mapping.cookedStart, mapping.cookedEnd);
    const table = htmlTextTable(slice, before, mapping.textOpts ?? {});
    if (!table) return refuse('unaligned: the HTML text of the literal run could not be aligned');
    // Step 5.1: HTML-encode inside the fragment, splicing only the changed span (references widened whole).
    const sp = planHtmlTextEdit({
      raw: slice,
      before,
      after,
      opts: mapping.textOpts ?? {},
      nbspAsRef: table.usesNbspRef,
      lineEnding: '\n', // a line break in a literal is escaped as \n (5.2), never written raw
      span,
    });
    if (!sp) return refuse('script-literal: no HTML splice of this run decodes to afterText');
    const cs = mapping.cookedStart + sp.start;
    const ce = mapping.cookedStart + sp.end;
    from0 = cs;
    to0 = ce;
    newCooked = (a, b) => cooked.slice(a, cs) + sp.text + cooked.slice(ce, b);
    expectedCooked = cooked.slice(0, cs) + sp.text + cooked.slice(ce);
  }
  const rawContent = src.slice(unit.start, unit.end);
  const placeholders = unit.placeholders?.map((p) => ({ start: p.start - unit.start, end: p.end - unit.start }));
  // Step 4: widen so neither end is inside an escape sequence (the composed table's outer layer), escape the
  // new characters in the spec's order (steps 5.2, 5.3), and check the splice with the literal's own parser.
  // A splice can also fail only because of what is beside it (a `$` before an inserted `{`): then widen by
  // one more character on each side and re-escape it, which keeps the cooked value, at most twice.
  let found: { rawFrom: number; rawTo: number; insert: string } | null = null;
  for (let extra = 0; extra <= 2 && !found; extra++) {
    const w = mapping.unitTable.widen(Math.max(0, from0 - extra), Math.min(cooked.length, to0 + extra));
    const piece = newCooked(w.start, w.end);
    // Never touch a `${…}`: no placeholder may be inside the range that is replaced, or in what replaces it.
    if (cooked.slice(w.start, w.end).includes(PLACEHOLDER) || piece.includes(PLACEHOLDER)) break;
    const rawFrom = mapping.unitTable.toRaw(w.start);
    const rawTo = mapping.unitTable.toRaw(w.end);
    const insert = unit.kind === 'json-string' ? escapeJsonText(piece) : escapeJsText(piece, unit.quote, unit.kind);
    if (checkLiteralSplice(rawContent, rawFrom, rawTo, insert, unit.kind, unit.quote, expectedCooked, { placeholders })) {
      found = { rawFrom, rawTo, insert };
    }
  }
  if (!found) {
    return refuse('the escaped splice does not cook to the expected value, forms </script, <script or <!--, or touches ${…}');
  }
  const { rawFrom, rawTo, insert } = found;
  return finish(src, unit.start + rawFrom, unit.start + rawTo, insert, {
    runId: run.id,
    strategy: run.strategy,
    beforeText: before,
    afterText: after,
    runStart: run.start,
    runEnd: run.end,
    literal: {
      unitIndex: unit.index,
      runIndex: run.runIndex,
      unitStart: unit.start,
      unitEnd: unit.end,
      scriptIndex: unit.scriptIndex,
      kind: unit.kind,
      quote: unit.quote,
      expectedCooked,
    },
  });
}

function finish(
  src: string,
  start: number,
  end: number,
  rawAfter: string,
  rest: Omit<EditPlan, 'ok' | 'start' | 'end' | 'rawBefore' | 'rawAfter' | 'newSrc'>,
): PlanOutcome {
  const rawBefore = src.slice(start, end);
  if (rawBefore === rawAfter) return refuse('the splice changes nothing');
  const newSrc = applySplice(src, start, end, rawAfter);
  // TextEncoder writes a lone surrogate as U+FFFD: such a file would not decode back to newSrc (rule 1).
  if (!isWellFormed(newSrc)) return refuse('the edit would leave a lone surrogate, which UTF-8 cannot hold');
  return { ok: true, start, end, rawBefore, rawAfter, newSrc, ...rest };
}
