// buildMap: the source map of one deck version (9.2), from the decoded file string. The notes block is
// found first and removed before mapping (section 8): offsets before it are unchanged and nothing at or
// after it is mapped. Strategy 1 (mapper-html) gives the stamps, runs, scripts, keys and parse errors;
// Strategy 2 (mapper-literals) gives the literal units and runs of those scripts.

import { mapHtmlText } from './mapper-html';
import { extractLiterals } from './mapper-literals';
import { detectLineEnding, LineIndex } from './text';
import type { ClientMap, DeckMap } from './types';

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
  if (opts.utf8) {
    const lit = extractLiterals(src, html.scripts, lines);
    units = lit.units;
    literals = lit.literals;
    scripts = lit.scripts;
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
  };
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
  };
}
