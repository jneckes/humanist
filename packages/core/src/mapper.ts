// buildMap: the source map of one deck version (9.2), from the decoded file string. The notes block is
// found first and removed before mapping (section 8): offsets before it are unchanged and nothing at or
// after it is mapped. Strategy 1 (mapper-html) gives the stamps, runs, scripts, keys and parse errors;
// Strategy 2 (mapper-literals) gives the literal units and runs of those scripts. Both give shadow values
// (DeckMap.shadows, decision D-a): text the page may show that Blueline never writes, which keeps an equal
// literal from looking unique (9.2 Strategy 2 step 3).

import { mapHtmlText } from './mapper-html';
import { extractLiterals, type FoundShadow } from './mapper-literals';
import { detectLineEnding, LineIndex, looksComputed } from './text';
import type { ClientMap, DeckMap, LiteralRun, ShadowValue } from './types';

// buildServedCopy lives in served.ts (exported from the barrel there).

/**
 * Builds the map. `version` is the sha256 the caller computed (core has no crypto); `utf8` is
 * DecodedDeck.utf8. A deck that is not UTF-8 gets no stamps, runs or literals: every node is `none`
 * (`not-utf8`), and it is never written (9.2 rule 1).
 */
export function buildMap(src: string, opts: { version: string; utf8: boolean }): DeckMap {
  const lines = new LineIndex(src);
  // mapHtmlText finds the notes block in its own parse (section 8) and maps the file without it.
  const html = mapHtmlText(src, { lines, utf8: opts.utf8 });
  const notesBlock = html.notesBlock;
  let scripts = html.scripts;
  let units: DeckMap['units'] = [];
  let literals: DeckMap['literals'] = [];
  let keys = html.keys;
  let keyValues = html.keyValues;
  let found: FoundShadow[] = html.shadows;
  if (opts.utf8) {
    const lit = extractLiterals(src, html.scripts, lines);
    units = lit.units;
    literals = lit.literals;
    scripts = lit.scripts;
    found = [...html.shadows, ...lit.shadows, ...repeatedNumbers(src, notesBlock, literals)];
    // Object keys count as keys too (9.2 Strategy 2 step 3; mapper-literals module comment): attribute
    // values first, then script keys, each value listed once in keyValues.
    if (lit.keys.length > 0) {
      keys = [...html.keys, ...lit.keys];
      const seen = new Set(html.keyValues);
      keyValues = html.keyValues.slice();
      for (const k of lit.keys) {
        if (!seen.has(k.value)) {
          seen.add(k.value);
          keyValues.push(k.value);
        }
      }
    }
  }
  return {
    version: opts.version,
    utf8: opts.utf8,
    bom: src.charCodeAt(0) === 0xfeff,
    lineEnding: detectLineEnding(src),
    notesBlock,
    stampCount: html.stampCount,
    runs: html.runs,
    units,
    literals,
    scripts,
    keyValues,
    keys,
    parseErrors: html.parseErrors,
    served: html.served,
    shadows: opts.utf8 ? shadowList(found, lines) : [],
  };
}

/**
 * Review finding 3: a node whose text is only digits and number punctuation (a count, a KPI, Intl output) is
 * usually computed, and a string literal with the same characters is often an unrelated style value or
 * attribute ('1', '600'). Such a literal is `exact` only if its text occurs exactly once in the decoded file
 * (the notes block excluded: it is not page text and changes with every note), which makes the literal itself
 * the only occurrence. Otherwise its value is recorded as a `repeated-number` shadow, so the DeckMap and
 * ClientMap matchers both see it as not unique. Counting stops at two.
 */
function repeatedNumbers(src: string, nb: DeckMap['notesBlock'], literals: LiteralRun[]): FoundShadow[] {
  // NUL is never in such text, so nothing can match across the seam where the block was.
  const text = nb ? src.slice(0, nb.start) + '\u0000' + src.slice(nb.end) : src;
  const out: FoundShadow[] = [];
  const seen = new Set<string>();
  for (const l of literals) {
    if (seen.has(l.value) || !looksComputed(l.value)) continue;
    seen.add(l.value);
    let count = 0;
    for (let at = text.indexOf(l.value); at >= 0 && count < 2; at = text.indexOf(l.value, at + 1)) count++;
    if (count !== 1) out.push({ value: l.value, kind: 'repeated-number', start: l.start });
  }
  return out;
}

/** Each (kind, value) once, at its first place, in source order, with lines (DeckMap.shadows). */
function shadowList(found: FoundShadow[], lines: LineIndex): ShadowValue[] {
  const seen = new Set<string>();
  const out: ShadowValue[] = [];
  for (const f of found.slice().sort((a, b) => (a.start < 0 ? Infinity : a.start) - (b.start < 0 ? Infinity : b.start))) {
    const key = f.kind + '\u0000' + f.value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f.start >= 0 ? { value: f.value, kind: f.kind, start: f.start, line: lines.at(f.start).line } : { value: f.value, kind: f.kind });
  }
  return out;
}

/** The part of the map the overlay needs (sent over IPC; 9.2 Matching DOM to source at runtime). */
export function toClientMap(map: DeckMap): ClientMap {
  return {
    version: map.version,
    utf8: map.utf8,
    runs: map.runs.map((r) => ({ id: r.id, stamp: r.stamp, textIndex: r.textIndex, value: r.value, aligned: r.aligned })),
    literals: map.literals.map((l) => ({
      id: l.id,
      value: l.value,
      placeholder: l.placeholder,
      html: l.html,
      strategy: l.strategy,
      aligned: l.aligned ?? true,
    })),
    keyValues: map.keyValues.slice(),
    shadowValues: [...new Set((map.shadows ?? []).map((sh) => sh.value))],
  };
}
