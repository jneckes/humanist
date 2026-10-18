// buildMap: the source map of one deck version (9.2), from the decoded file string. The notes block is
// found first and removed before mapping (section 8): offsets before it are unchanged and nothing at or
// after it is mapped. Strategy 1 (mapper-html) gives the stamps, runs, scripts, keys and parse errors;
// Strategy 2 (mapper-literals) gives the literal units and runs of those scripts. Both give shadow values
// (DeckMap.shadows, decision D-a): text the page may show that Blueline never writes, which keeps an equal
// literal from looking unique (9.2 Strategy 2 step 3).
//
// Review finding 31 (SPEC 10 Phase 1, Speed: "a 2 MB deck reaches first paint in under 1 s"): the served copy
// (9.1 Serving) and the content hash need only Strategy 1 (DeckMap.served, notesBlock, stampCount), so
// buildMap returns once Strategy 1 is done, and the parts Strategy 2 completes (units, literals, scripts, keys,
// keyValues, shadows) are computed on the first read of any of them, all at once. A map is therefore always
// complete when read: toClientMap, the motion check, the map command, the probe, verify and the matcher see
// exactly what the eager build gave; only the time it is paid moves, from before the deck view navigates to
// the first read (the deck's init message). completeMap forces it; isMapComplete says whether it is done.

import { mapHtmlText, type HtmlMapResult } from './mapper-html';
import { extractLiterals, type FoundShadow } from './mapper-literals';
import { detectLineEnding, LineIndex, looksComputed } from './text';
import type { ClientMap, DeckMap, LiteralRun, ShadowValue } from './types';

// buildServedCopy lives in served.ts (exported from the barrel there).

/** The DeckMap fields Strategy 2 completes, in DeckMap's key order (computed together on first read). */
export const DEFERRED_MAP_FIELDS = ['units', 'literals', 'scripts', 'keyValues', 'keys', 'shadows'] as const;
type Deferred = Pick<DeckMap, (typeof DEFERRED_MAP_FIELDS)[number]>;

/**
 * Builds the map. `version` is the sha256 the caller computed (core has no crypto); `utf8` is
 * DecodedDeck.utf8. A deck that is not UTF-8 gets no stamps, runs or literals: every node is `none`
 * (`not-utf8`), and it is never written (9.2 rule 1). Strategy 2 runs on the first read of a deferred field
 * (module comment), or at once with `defer: false`; the result is the same map either way.
 */
export function buildMap(src: string, opts: { version: string; utf8: boolean; defer?: boolean }): DeckMap {
  const lines = new LineIndex(src);
  // mapHtmlText finds the notes block in its own parse (section 8) and maps the file without it.
  const html = mapHtmlText(src, { lines, utf8: opts.utf8 });
  const map: DeckMap = {
    version: opts.version,
    utf8: opts.utf8,
    bom: src.charCodeAt(0) === 0xfeff,
    lineEnding: detectLineEnding(src),
    notesBlock: html.notesBlock,
    stampCount: html.stampCount,
    runs: html.runs,
    // The deferred fields hold their place in the key order; deferFields replaces them with accessors.
    units: [],
    literals: [],
    scripts: [],
    keyValues: [],
    keys: [],
    parseErrors: html.parseErrors,
    served: html.served,
    shadows: [],
  };
  if (opts.defer === false) return Object.assign(map, strategy2(src, lines, html, opts.utf8));
  deferFields(map, () => strategy2(src, lines, html, opts.utf8));
  return map;
}

/**
 * Strategy 2 and what depends on it (the deferred fields): script and JSON literals, object keys merged after
 * the attribute keys, and the shadow list of both strategies.
 */
function strategy2(src: string, lines: LineIndex, html: HtmlMapResult, utf8: boolean): Deferred {
  const notesBlock = html.notesBlock;
  let scripts = html.scripts;
  let units: DeckMap['units'] = [];
  let literals: DeckMap['literals'] = [];
  let keys = html.keys;
  let keyValues = html.keyValues;
  let found: FoundShadow[] = html.shadows;
  if (utf8) {
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
  return { units, literals, scripts, keyValues, keys, shadows: utf8 ? shadowList(found, lines) : [] };
}

/**
 * Makes the deferred fields of `map` accessors that compute them all on the first read and then become plain
 * data properties. A field assigned before that keeps its assigned value. If Strategy 2 throws, every read
 * of a deferred field throws the same error (as buildMap itself did when it ran Strategy 2 at once).
 */
function deferFields(map: DeckMap, compute: () => Deferred): void {
  let pending: (() => Deferred) | null = compute;
  let failure: { error: unknown } | null = null;
  const assigned = new Set<string>();
  const settle = (key: string, value: unknown): void => {
    Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
  };
  const complete = (): void => {
    if (failure) throw failure.error;
    if (!pending) return;
    let rest: Deferred;
    try {
      rest = pending();
    } catch (e) {
      failure = { error: e };
      throw e;
    }
    pending = null;
    for (const k of DEFERRED_MAP_FIELDS) if (!assigned.has(k)) settle(k, rest[k]);
  };
  for (const k of DEFERRED_MAP_FIELDS) {
    Object.defineProperty(map, k, {
      enumerable: true,
      configurable: true,
      get() {
        complete();
        return map[k];
      },
      set(value: unknown) {
        assigned.add(k);
        settle(k, value);
      },
    });
  }
}

/** Completes a map's deferred fields now (buildMap's module comment) and returns it. */
export function completeMap(map: DeckMap): DeckMap {
  void map.units;
  return map;
}

/** False while a map from buildMap has not computed its deferred fields yet. */
export function isMapComplete(map: DeckMap): boolean {
  return !Object.getOwnPropertyDescriptor(map, 'units')?.get;
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
