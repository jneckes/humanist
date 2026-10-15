import { describe, expect, it } from 'vitest';
import { buildMap, toClientMap } from '@blueline/core/mapper';
import { MAX_SEARCH_CANDIDATES, createMatcher, normalizeForMatch } from '@blueline/core/matcher';
import type { ClientMap, DeckMap, DomTextNode, HtmlRun, LiteralRun } from '@blueline/core/types';

const PH = '\uE000';

let pos = 0;
function html(stamp: string, textIndex: number, value: string, extra: Partial<HtmlRun> = {}): HtmlRun {
  const start = (pos += 100);
  return {
    id: `h:${stamp}:${textIndex}`,
    strategy: 'html-text',
    stamp,
    tagName: 'p',
    textIndex,
    start,
    end: start + value.length,
    value,
    line: Math.floor(start / 100),
    col: 1,
    aligned: true,
    usesNbspRef: false,
    ...extra,
  };
}

let unitNo = 0;
function lit(value: string, extra: Partial<LiteralRun> = {}): LiteralRun {
  const start = (pos += 100);
  const unit = unitNo++;
  return {
    id: `l:${unit}:0`,
    strategy: 'script-literal',
    unit,
    runIndex: 0,
    start,
    end: start + value.length,
    value,
    placeholder: value.includes(PH),
    html: false,
    line: Math.floor(start / 100),
    col: 5,
    aligned: true,
    ...extra,
  };
}

function deck(runs: HtmlRun[], literals: LiteralRun[], keys: { value: string; attr: string; line: number }[] = []): DeckMap {
  return {
    version: 'v1',
    utf8: true,
    bom: false,
    lineEnding: '\n',
    notesBlock: null,
    stampCount: runs.length,
    runs,
    units: [],
    literals,
    scripts: [],
    keyValues: keys.map((k) => k.value),
    keys,
    parseErrors: [],
  };
}

function client(map: DeckMap): ClientMap {
  return {
    version: map.version,
    utf8: map.utf8,
    runs: map.runs.map(({ id, stamp, textIndex, value, aligned }) => ({ id, stamp, textIndex, value, aligned })),
    literals: map.literals.map(({ id, value, placeholder, html, strategy, aligned }) => ({
      id,
      value,
      placeholder,
      html,
      strategy,
      aligned,
    })),
    keyValues: map.keyValues,
  };
}

const node = (data: string, stamp: string | null = null, textIndex = 0): DomTextNode => ({ stamp, textIndex, data });

describe('matcher: stamped runs', () => {
  it('maps a node to its own stamped run when the text is equal', () => {
    const h = html('bl-1', 0, 'Quarterly results');
    const m = createMatcher(deck([h], []));
    const r = m(node('Quarterly results', 'bl-1', 0));
    expect(r.confidence).toBe('exact');
    expect(r.runId).toBe('h:bl-1:0');
    expect(r.strategy).toBe('html-text');
    expect(r.candidates).toEqual([{ runId: h.id, strategy: 'html-text', start: h.start, end: h.end, line: h.line }]);
    expect(r.reason).toBeUndefined();
  });

  it('uses textIndex to pick the run among the element’s text nodes', () => {
    const a = html('bl-2', 0, 'Before ');
    const b = html('bl-2', 1, ' after');
    const m = createMatcher(deck([a, b], []));
    expect(m(node(' after', 'bl-2', 1)).runId).toBe(b.id);
    // Same stamp, wrong index: the run is someone else's text.
    const r = m(node(' after', 'bl-2', 0));
    expect(r.confidence).toBe('ambiguous');
    expect(r.reason).toBe('stamp-other');
  });

  it('keeps own-run matches exact even when other headings share the text', () => {
    const m = createMatcher(deck([html('bl-1', 0, 'Revenue'), html('bl-7', 0, 'Revenue')], []));
    expect(m(node('Revenue', 'bl-7')).runId).toBe('h:bl-7:0');
    // Without a stamp the same text has two candidates.
    const r = m(node('Revenue'));
    expect(r.confidence).toBe('ambiguous');
    expect(r.reason).toBe('duplicate');
    expect(r.candidates.map((c) => c.runId)).toEqual(['h:bl-1:0', 'h:bl-7:0']);
  });

  it('is none for an unaligned own run', () => {
    const m = createMatcher(deck([html('bl-1', 0, 'Odd &text', { aligned: false })], []));
    const r = m(node('Odd &text', 'bl-1'));
    expect(r.confidence).toBe('none');
    expect(r.reason).toBe('unaligned');
    expect(r.runId).toBeNull();
  });

  it('never prefers the own stamped run over a literal with the same text', () => {
    const h = html('bl-1', 0, 'Loading');
    const l = lit('Loading');
    const m = createMatcher(deck([h], [l]));
    const r = m(node('Loading', 'bl-1'));
    expect(r.confidence).toBe('ambiguous');
    expect(r.reason).toBe('duplicate');
    expect(r.candidates.map((c) => c.runId).sort()).toEqual([h.id, l.id].sort());
  });

  it('is ambiguous when an unstamped node equals one stamped run (JS-built copy)', () => {
    const h = html('bl-3', 0, 'Market size');
    const m = createMatcher(deck([h], []));
    const r = m(node('Market size'));
    expect(r).toMatchObject({ confidence: 'ambiguous', reason: 'stamp-other', runId: null, strategy: null });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ runId: h.id, start: h.start, line: h.line });
  });

  it('falls through when the own run no longer equals the node (the page changed the text)', () => {
    const m = createMatcher(deck([html('bl-1', 0, 'Draft title')], [lit('Final title')]));
    const r = m(node('Final title', 'bl-1'));
    expect(r.confidence).toBe('exact');
    expect(r.strategy).toBe('script-literal');
  });

  it('is none with not-utf8 for a map of a deck that is not UTF-8', () => {
    const d = deck([html('bl-1', 0, 'x')], []);
    d.utf8 = false;
    for (const map of [d, client(d)]) {
      expect(createMatcher(map)(node('x', 'bl-1'))).toEqual({
        confidence: 'none',
        runId: null,
        strategy: null,
        candidates: [],
        reason: 'not-utf8',
      });
    }
  });
});

describe('matcher: literal runs (Strategy 2 matching)', () => {
  it('is exact for one literal run that occurs once', () => {
    const l = lit('Revenue grew 40%');
    const r = createMatcher(deck([], [l]))(node('Revenue grew 40%', 'bl-9'));
    expect(r).toMatchObject({ confidence: 'exact', runId: l.id, strategy: 'script-literal' });
    expect(r.candidates).toEqual([{ runId: l.id, strategy: 'script-literal', start: l.start, end: l.end, line: l.line }]);
  });

  it('reports json-literal for JSON runs', () => {
    const l = lit('From JSON', { strategy: 'json-literal' });
    expect(createMatcher(deck([], [l]))(node('From JSON')).strategy).toBe('json-literal');
  });

  it('is none for a run with a placeholder (pin-only) and for an unaligned run', () => {
    const p = lit(`Total ${PH}`);
    const u = lit('Escaped oddly', { aligned: false });
    const m = createMatcher(deck([], [p, u]));
    expect(m(node(`Total ${PH}`))).toMatchObject({ confidence: 'none', reason: 'placeholder' });
    expect(m(node('Escaped oddly'))).toMatchObject({ confidence: 'none', reason: 'unaligned' });
  });

  it('is ambiguous when the text is also a key, with the warning and line', () => {
    const l = lit('overview');
    const map = deck([], [l], [
      { value: 'overview', attr: 'id', line: 12 },
      { value: 'overview', attr: 'href', line: 40 },
    ]);
    const r = createMatcher(map)(node('overview'));
    expect(r).toMatchObject({ confidence: 'ambiguous', reason: 'key' });
    expect(r.candidates[0].keyWarning).toBe('This text is also used as a key at deck.html:12');
    expect(createMatcher(map, { fileName: 'q3.html' })(node('overview')).candidates[0].keyWarning).toBe(
      'This text is also used as a key at q3.html:12',
    );
    const c = createMatcher(client(map))(node('overview'));
    expect(c).toMatchObject({ confidence: 'ambiguous', reason: 'key' });
    expect(c.candidates[0].keyWarning).toBe('This text is also used as a key in deck.html');
  });

  it('is ambiguous when two literal runs are equal, and lists both', () => {
    const a = lit('Next');
    const b = lit('Next');
    const r = createMatcher(deck([], [a, b], [{ value: 'Next', attr: 'class', line: 3 }]))(node('Next'));
    expect(r).toMatchObject({ confidence: 'ambiguous', reason: 'duplicate' });
    expect(r.candidates.map((c) => c.runId)).toEqual([a.id, b.id]);
    expect(r.candidates.every((c) => c.keyWarning === 'This text is also used as a key at deck.html:3')).toBe(true);
  });

  it('is ambiguous for a literal and a stamped run with the same text (stamped is never preferred)', () => {
    const h = html('bl-1', 0, 'Summary');
    const l = lit('Summary');
    const r = createMatcher(deck([h], [l]))(node('Summary'));
    expect(r).toMatchObject({ confidence: 'ambiguous', reason: 'duplicate' });
    expect(r.candidates).toHaveLength(2);
    // Only the literal candidate can carry a key warning.
    const r2 = createMatcher(deck([h], [l], [{ value: 'Summary', attr: 'id', line: 2 }]))(node('Summary'));
    expect(r2.candidates.find((c) => c.runId === h.id)?.keyWarning).toBeUndefined();
    expect(r2.candidates.find((c) => c.runId === l.id)?.keyWarning).toContain('deck.html:2');
  });
});

describe('matcher: with the real mapper (buildMap)', () => {
  const src = [
    '<!doctype html><html><body>',
    '<h1 id="overview">Quarterly results</h1>',
    '<p>Revenue grew <b>40%</b> in Q3</p>',
    '<div id="slides"></div>',
    '<script>',
    "const slides = [{ title: 'Market size', body: '<p>TAM is <b>$4B</b> &amp; growing</p>' }, { title: `Team ${n}`, body: 'overview' }];",
    "const legal = 'Q&amp;A'; const plain = 'Q&A';",
    "document.getElementById('slides').innerHTML = slides.map(s => '<h2>' + s.title + '</h2>' + s.body).join('');",
    '</script>',
    '<script type="application/json" id="data">{"caption": "From JSON", "dup": "Quarterly results"}</script>',
    '</body></html>',
  ].join('\n');
  const map = buildMap(src, { version: 'abc', utf8: true });
  const matchers = [createMatcher(map), createMatcher(toClientMap(map))];
  const h1 = map.runs.find((r) => r.value === 'Quarterly results')!;
  const p = map.runs.find((r) => r.value === 'Revenue grew ')!;

  it.each([
    ['own stamped run, but a JSON value has the same text', { stamp: h1.stamp, data: 'Quarterly results' }, 'ambiguous', 'duplicate'],
    ['own stamped run', { stamp: p.stamp, data: 'Revenue grew ' }, 'exact', undefined],
    ['a JS string', { data: 'Market size' }, 'exact', undefined],
    ['a text node of an HTML literal', { data: 'TAM is ' }, 'exact', undefined],
    ['a text node with a reference', { data: ' & growing' }, 'exact', undefined],
    ['a template with a substitution', { data: 'Team 7' }, 'none', 'computed'],
    ['a literal that is also an id', { data: 'overview' }, 'ambiguous', 'key'],
    ['a JSON value', { data: 'From JSON' }, 'exact', undefined],
    ['text that innerHTML could have made from another literal', { data: 'Q&A' }, 'ambiguous', 'duplicate'],
    ['text the HTML shows, copied by a script', { data: 'Quarterly results' }, 'ambiguous', 'duplicate'],
  ])('%s', (_name, n, confidence, reason) => {
    for (const m of matchers) {
      const r = m({ stamp: null, textIndex: 0, ...n });
      expect(r.confidence).toBe(confidence);
      expect(r.reason).toBe(reason);
    }
  });

  it('keeps UTF-16 offsets right in a deck with a BOM, CRLF and astral characters', () => {
    const deckSrc = '\uFEFF<p>😀 Intro</p>\r\n<script>\r\nconst t = `😀 Line one\r\nline two`;\r\nconst u = "Caf\\u00e9";\r\n</script>';
    const bm = buildMap(deckSrc, { version: 'v', utf8: true });
    expect(bm.scripts[0].parsed).toBe(true);
    expect(bm.literals.map((l) => [l.value, deckSrc.slice(l.start, l.end), l.line, l.col])).toEqual([
      ['😀 Line one\nline two', '😀 Line one\r\nline two', 3, 12],
      ['Café', 'Caf\\u00e9', 5, 12],
    ]);
    const r = createMatcher(bm)({ stamp: null, textIndex: 0, data: '😀 Line one\nline two' });
    expect(r).toMatchObject({ confidence: 'exact', strategy: 'script-literal' });
    expect(r.candidates[0].start).toBe(deckSrc.indexOf('😀 Line one'));
  });

  it('reports the run and its source location for an exact literal', () => {
    const r = createMatcher(map)({ stamp: null, textIndex: 0, data: ' & growing' });
    const run = map.literals.find((l) => l.id === r.runId)!;
    expect(src.slice(run.start, run.end)).toBe(' &amp; growing');
    expect(r.candidates[0]).toEqual({ runId: run.id, strategy: 'script-literal', start: run.start, end: run.end, line: 6 });
    expect(createMatcher(map)({ stamp: null, textIndex: 0, data: 'From JSON' }).strategy).toBe('json-literal');
  });
});

describe('matcher: near misses and none reasons', () => {
  it('is ambiguous (not-equal) when equal only after whitespace collapse and NFC', () => {
    const l = lit('Revenue grew');
    const h = html('bl-1', 0, 'Café');
    const m = createMatcher(deck([h], [l]));
    expect(m(node('Revenue\n   grew '))).toMatchObject({ confidence: 'ambiguous', reason: 'not-equal' });
    expect(m(node('Revenue\n   grew ')).candidates[0].runId).toBe(l.id);
    const r = m(node('Café'));
    expect(r).toMatchObject({ confidence: 'ambiguous', reason: 'not-equal' });
    expect(r.candidates[0].runId).toBe(h.id);
    expect(normalizeForMatch('  a \t\n b\f')).toBe('a b');
  });

  it('is ambiguous (substring) when the node is part of a run', () => {
    const l = lit('Revenue grew 40% in Q3');
    const h = html('bl-1', 0, 'Our Q3 plan');
    const m = createMatcher(deck([h], [l]));
    const r = m(node('Q3'));
    expect(r).toMatchObject({ confidence: 'ambiguous', reason: 'substring' });
    expect(r.candidates.map((c) => c.runId).sort()).toEqual([h.id, l.id].sort());
    // Data containing NUL takes the slow path and still works.
    const n = createMatcher(deck([], [lit('a\u0000b c')]))(node('a\u0000b'));
    expect(n.reason).toBe('substring');
  });

  it('caps substring candidates', () => {
    const lits = Array.from({ length: 200 }, (_, i) => lit(`item ${i} of the list`));
    const r = createMatcher(deck([], lits))(node('of the'));
    expect(r.reason).toBe('substring');
    expect(r.candidates).toHaveLength(MAX_SEARCH_CANDIDATES);
  });

  it('does not offer placeholder runs as near-miss candidates', () => {
    const r = createMatcher(deck([], [lit(`Hello ${PH}, welcome back`)]))(node('welcome back'));
    expect(r.confidence).toBe('none');
  });

  it('explains a node that a template with ${…} produced as computed', () => {
    const m = createMatcher(deck([], [lit(`Slide ${PH} of ${PH}`), lit(`${PH}`), lit(`${PH} `)]));
    expect(m(node('Slide 3 of 12'))).toMatchObject({ confidence: 'none', reason: 'computed' });
    expect(m(node('Slide of'))).toMatchObject({ confidence: 'none', reason: 'no-match' });
    // A run that is only a substitution explains nothing.
    expect(m(node('Anything at all'))).toMatchObject({ confidence: 'none', reason: 'no-match' });
  });

  it('explains counts, dates and prices as computed', () => {
    const m = createMatcher(deck([], []));
    for (const t of ['42', '3 / 12', '2026-10-15', '$4.2', '(12%)', '12:30']) expect(m(node(t)).reason).toBe('computed');
    expect(m(node('-')).reason).toBe('no-match');
  });

  it('explains text assembled from several literals as multi-literal, and literal + numbers as computed', () => {
    const m = createMatcher(deck([], [lit('Revenue'), lit(': '), lit('up'), lit('Slide '), lit(' of ')]));
    expect(m(node('Revenue: up'))).toMatchObject({ confidence: 'none', reason: 'multi-literal' });
    expect(m(node('Revenue up'))).toMatchObject({ confidence: 'none', reason: 'multi-literal' });
    expect(m(node('Slide 3 of 12'))).toMatchObject({ confidence: 'none', reason: 'computed' });
    expect(m(node('Zebra crossing'))).toMatchObject({ confidence: 'none', reason: 'no-match', candidates: [] });
  });

  it('is none for whitespace-only or empty text', () => {
    const m = createMatcher(deck([html('bl-1', 0, 'x')], [lit('y')]));
    expect(m(node('  \n')).reason).toBe('no-match');
    expect(m(node('')).reason).toBe('no-match');
  });
});

describe('matcher: ClientMap', () => {
  it('gives the same answers, with -1 for offsets it does not hold', () => {
    const h = html('bl-1', 0, 'Title');
    const l = lit('Body text', { strategy: 'json-literal' });
    const u = lit('Bad', { aligned: false });
    const map = client(deck([h], [l, u]));
    const m = createMatcher(map);
    expect(m(node('Title', 'bl-1'))).toEqual({
      confidence: 'exact',
      runId: h.id,
      strategy: 'html-text',
      candidates: [{ runId: h.id, strategy: 'html-text', start: -1, end: -1, line: -1 }],
    });
    expect(m(node('Body text'))).toMatchObject({ confidence: 'exact', strategy: 'json-literal' });
    expect(m(node('Bad'))).toMatchObject({ confidence: 'none', reason: 'unaligned' });
    expect(m(node('Title'))).toMatchObject({ confidence: 'ambiguous', reason: 'stamp-other' });
  });

  it('reads absent strategy and aligned as script-literal and aligned', () => {
    const map: ClientMap = {
      version: 'v',
      utf8: true,
      runs: [],
      literals: [{ id: 'l:0:0', value: 'Hi', placeholder: false, html: false }],
      keyValues: [],
    };
    expect(createMatcher(map)(node('Hi'))).toMatchObject({ confidence: 'exact', strategy: 'script-literal' });
  });
});

describe('matcher: scale', () => {
  it('matches thousands of nodes against thousands of runs quickly', () => {
    const runs: HtmlRun[] = [];
    const lits: LiteralRun[] = [];
    for (let i = 0; i < 4000; i++) runs.push(html(`bl-${i}`, 0, `Heading number ${i} of the deck`));
    for (let i = 0; i < 4000; i++) lits.push(lit(`Literal text ${i} with some words`));
    const m = createMatcher(deck(runs, lits));
    const t0 = performance.now();
    let exact = 0;
    for (let i = 0; i < 4000; i++) {
      if (m(node(`Heading number ${i} of the deck`, `bl-${i}`)).confidence === 'exact') exact++;
      if (m(node(`Literal text ${i} with some words`)).confidence === 'exact') exact++;
    }
    // Near misses go through the slower paths.
    for (let i = 0; i < 500; i++) m(node(`no such text ${i}`));
    for (let i = 0; i < 500; i++) m(node(`text ${i} with`));
    const ms = performance.now() - t0;
    expect(exact).toBe(8000);
    expect(ms).toBeLessThan(3000);
  });
});
