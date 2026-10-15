import { describe, expect, it } from 'vitest';
import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { buildMap, toClientMap } from '@blueline/core/mapper';
import { createMatcher } from '@blueline/core/matcher';
import { buildServedCopy } from '@blueline/core/served';
import { decodeHtmlText, htmlRunTable, planHtmlTextEdit } from '@blueline/core/html-tables';
import type { DeckMap } from '@blueline/core/types';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;

const NOTES = '<script type="application/vnd.blueline+json" id="blueline-notes" data-version="1">{"notes":[]}</script>';

describe('buildMap', () => {
  it('fills every field', () => {
    const src =
      '\uFEFF<!doctype html>\r\n<body>\r\n<h1 id="t">Title &amp; more</h1>\r\n' +
      '<script>const s = ["One", "Title & more"];</script>\r\n' +
      '<script type="application/json">{"k":"v"}</script>\r\n' +
      `${NOTES}\r\n</body>\r\n`;
    const map = buildMap(src, { version: 'abc', utf8: true });
    expect(map.version).toBe('abc');
    expect(map.utf8).toBe(true);
    expect(map.bom).toBe(true);
    expect(map.lineEnding).toBe('\r\n');
    expect(src.slice(map.notesBlock!.start, map.notesBlock!.end)).toBe(NOTES);
    expect(map.stampCount).toBe(1);
    expect(map.runs.map((r) => [r.id, r.value, r.line, r.col])).toEqual([['h:bl-1:0', 'Title & more', 3, 12]]);
    expect(map.scripts.map((s) => [s.kind, s.parsed])).toEqual([
      ['classic', true],
      ['json', true],
    ]);
    expect(map.units.map((u) => u.cooked)).toEqual(['One', 'Title & more', 'v']);
    expect(map.literals.map((l) => [l.id, l.value, l.strategy])).toEqual([
      ['l:0:0', 'One', 'script-literal'],
      ['l:1:0', 'Title & more', 'script-literal'],
      ['l:2:0', 'v', 'json-literal'],
    ]);
    // The id, then the JSON object key (a deck can render a key as text; mapper-literals).
    expect(map.keyValues).toEqual(['t', 'k']);
    expect(map.keys.map((k) => [k.value, k.attr, k.line])).toEqual([
      ['t', 'id', 3],
      ['k', 'json key', 5],
    ]);
    expect(map.parseErrors).toEqual([]);
    expect(map.served!.stamps).toHaveLength(1);
  });

  it('leaves every offset before the notes block unchanged and maps nothing after it', () => {
    const body = '<body>\n<p>One &mdash; <b>two</b></p>\n<script>var x = "lit";</script>\n';
    const without = body + '</body>\n';
    const withBlock = body + NOTES + '\n</body>\n';
    const a = buildMap(without, { version: 'a', utf8: true });
    const b = buildMap(withBlock, { version: 'b', utf8: true });
    expect(b.notesBlock).toEqual({ start: body.length, end: body.length + NOTES.length });
    expect(b.runs).toEqual(a.runs);
    expect(b.units).toEqual(a.units);
    expect(b.literals).toEqual(a.literals);
    expect(b.scripts).toEqual(a.scripts);
    expect(b.keys).toEqual(a.keys);
    expect(buildServedCopy(withBlock, b, { protected: false })).toBe(buildServedCopy(without, a, { protected: false }).replace('\n</body>', '\n\n</body>'));
  });

  it('maps nothing in a deck that is not UTF-8', () => {
    const src = '<body><p>café</p><script>var s = "x";</script>';
    const map = buildMap(src, { version: 'v', utf8: false });
    expect(map.utf8).toBe(false);
    expect(map.runs).toEqual([]);
    expect(map.units).toEqual([]);
    expect(map.literals).toEqual([]);
    expect(map.stampCount).toBe(0);
    expect(map.scripts).toHaveLength(1);
    const client = toClientMap(map);
    expect(client.utf8).toBe(false);
    expect(client.runs).toEqual([]);
  });
});

describe('toClientMap', () => {
  it('keeps only what the overlay needs', () => {
    const src = '<body><h1 class="hero">Hi</h1><script>const a = `x ${y}`; const b = "<i>it</i>";</script>';
    const map = buildMap(src, { version: 'v9', utf8: true });
    const client = toClientMap(map);
    expect(client).toEqual({
      version: 'v9',
      utf8: true,
      runs: [{ id: 'h:bl-1:0', stamp: 'bl-1', textIndex: 0, value: 'Hi', aligned: true }],
      literals: map.literals.map((l) => ({ id: l.id, value: l.value, placeholder: l.placeholder, html: l.html, strategy: l.strategy, aligned: l.aligned ?? true })),
      keyValues: ['hero'],
    });
    expect(client.literals.some((l) => l.placeholder)).toBe(true);
    // Structured-clone safe (it crosses IPC): plain data only.
    expect(structuredClone(client)).toEqual(client);
  });
});

// ------------------------------------------------------------------------------------- property test

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function generateDeck(seed: number): string {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const nl = pick(['\n', '\r\n', '\r']);
  const word = () =>
    pick([
      'alpha', 'Beta', 'caf&eacute;', '&amp;', '&ampx', '&copy', '&#8217;', '&#x2014;', '&#128;', '&#0;', '&nbsp;', '\u00A0',
      '&NotEqualTilde;', '😀', '“q”', '—', '&', '<3', 'a&b', '&notit', 'x' + nl + 'y', '&lt;tag&gt;', 'é',
    ]);
  const text = (n: number) => Array.from({ length: n }, word).join(pick([' ', '  ', nl, '\t']));
  const inline = () =>
    pick([
      () => text(3),
      () => `${text(2)} <b>${text(1)}</b> ${text(2)}`,
      () => `<a href=https://x.example/${Math.floor(r() * 9)}/>${text(2)}</a> ${text(1)}`,
      () => `<em class="e k${Math.floor(r() * 3)}">${text(1)}</em>${text(1)}<!-- c -->${text(1)}`,
      () => `<span data-bl-e="bl-${Math.floor(r() * 5)}">${text(2)}</span>`,
      () => `<B>${text(1)}</B><I>${text(1)}</I>`,
    ])();
  const block = () =>
    pick([
      () => `<h1 id="h${Math.floor(r() * 4)}">${inline()}</h1>`,
      () => `<p>${inline()}</p>`,
      () => `<ul>${nl}<li>${inline()}</li>${nl}<li>${inline()}</li>${nl}</ul>`,
      () => `<pre>${nl}${text(2)}${nl}${text(1)}</pre>`,
      () => `<table><tr><td>${text(1)}</td><td>${inline()}</td></tr></table>`,
      () => `<svg viewBox="0 0 9 9"><text x="1">${text(2)}</text></svg>`,
      () => `<section class="slide">${nl}<h2>${text(2)}</h2>${nl}<p>${inline()}</p>${nl}</section>`,
      () => `<script>const s${Math.floor(r() * 9)} = ["${text(1).replace(/["\\\r\n]/g, '')}"];</script>`,
      () => `<template><p>${text(1)}</p></template>`,
      () => `<p><b>${text(1)}</p><p>${text(1)}</p>`, // unclosed formatting element: reconstruction
      () => `<div>${text(1)}<div>${text(1)}</div>${text(1)}</div>`,
      () => `<textarea>${text(1)}</textarea>`,
    ])();
  let out = r() < 0.3 ? '\uFEFF' : '';
  out += `<!doctype html>${nl}<html><head><title>${text(1)}</title></head>${nl}<body>${nl}`;
  const n = 4 + Math.floor(r() * 10);
  for (let k = 0; k < n; k++) out += block() + nl;
  if (r() < 0.5) out += NOTES + nl;
  return out + `</body></html>${nl}`;
}

function elements(root: Node): Element[] {
  const out: Element[] = [];
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if ('tagName' in n) out.push(n as Element);
    if ('childNodes' in n) for (let k = (n.childNodes as Node[]).length - 1; k >= 0; k--) stack.push((n.childNodes as Node[])[k]);
  }
  return out;
}

const nonWs = (el: Element) =>
  el.childNodes.filter((c): c is TextNode => c.nodeName === '#text' && !/^[ \t\n\r\f]*$/.test((c as TextNode).value)).map((c) => c.value);
const noBom = (s: string) => (s.startsWith('\uFEFF') ? s.slice(1) : s);

function checkServedAgrees(src: string, map: DeckMap): void {
  const served = buildServedCopy(src, map, { protected: false });
  const doc = parse(noBom(served));
  const holders = new Map<string, Element[]>();
  for (const el of elements(doc)) {
    const st = el.attrs.find((a) => a.name === 'data-bl-e');
    if (st) holders.set(st.value, [...(holders.get(st.value) ?? []), el]);
  }
  const issued = new Set(map.runs.map((x) => x.stamp));
  for (const s of holders.keys()) expect(issued.has(s)).toBe(true);
  for (const run of map.runs) {
    const els = (holders.get(run.stamp) ?? []).filter((el) => nonWs(el).length > run.textIndex);
    expect(els, run.id).toHaveLength(1);
    expect(nonWs(els[0])[run.textIndex]).toBe(run.value);
  }
  const strip = (d: DefaultTreeAdapterTypes.Document) => {
    for (const el of elements(d)) el.attrs = el.attrs.filter((a) => a.name !== 'data-bl-e');
    return serialize(d);
  };
  const clean = map.notesBlock ? src.slice(0, map.notesBlock.start) + src.slice(map.notesBlock.end) : src;
  expect(strip(doc)).toBe(strip(parse(noBom(clean))));
}

describe('property: generated decks', () => {
  const SEEDS = Array.from({ length: 40 }, (_, k) => 1000 + k * 7919);

  it('decoding src.slice(start, end) through each run\u2019s table reproduces its value', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const src = generateDeck(seed);
      const map = buildMap(src, { version: String(seed), utf8: true });
      for (const run of map.runs) {
        if (!run.aligned) continue;
        const raw = src.slice(run.start, run.end);
        const table = htmlRunTable(src, run);
        expect(table, `${seed} ${run.id}`).not.toBeNull();
        expect(table!.length).toBe(run.value.length);
        expect(decodeHtmlText(raw, run.textOpts)).toBe(run.value);
        let rebuilt = '';
        let prev = 0;
        for (let i = 1; i <= table!.length; i++) {
          if (!table!.isUnitBoundary(i)) continue;
          rebuilt += decodeHtmlText(raw.slice(table!.toRaw(prev), table!.toRaw(i)), { nul: run.textOpts?.nul });
          prev = i;
        }
        expect(rebuilt, `${seed} ${run.id}`).toBe(run.value);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('the served copy holds every run under its stamp and parses to the same tree', () => {
    for (const seed of SEEDS) {
      const src = generateDeck(seed);
      checkServedAgrees(src, buildMap(src, { version: String(seed), utf8: true }));
    }
  });

  it('an edit planned through a run\u2019s table lands in that run and nowhere else (unit-level mutation probe)', () => {
    const SENTINEL = '\u27E6bl\u27E7';
    let probes = 0;
    for (const seed of SEEDS.slice(0, 15)) {
      const src = generateDeck(seed);
      const map = buildMap(src, { version: 'before', utf8: true });
      for (const run of map.runs) {
        if (!run.aligned) continue;
        const raw = src.slice(run.start, run.end);
        const plan = planHtmlTextEdit({ raw, before: run.value, after: run.value + SENTINEL, opts: run.textOpts, nbspAsRef: run.usesNbspRef, lineEnding: map.lineEnding });
        expect(plan, `${seed} ${run.id}`).not.toBeNull();
        const next = src.slice(0, run.start + plan!.start) + plan!.text + src.slice(run.start + plan!.end);
        const after = buildMap(next, { version: 'after', utf8: true });
        const same = after.runs.find((x) => x.id === run.id);
        expect(same?.value, `${seed} ${run.id}`).toBe(run.value + SENTINEL);
        // No other run changed its value.
        const others = (m: DeckMap) => m.runs.filter((x) => x.id !== run.id).map((x) => [x.id, x.value]);
        expect(others(after)).toEqual(others(map));
        // The splice is minimal: only the sentinel was added to the file.
        expect(next.length).toBe(src.length + SENTINEL.length);
        probes++;
      }
    }
    expect(probes).toBeGreaterThan(100);
  });
});

describe('buildMap + createMatcher: text that is also an object key is never exact (9.2 Strategy 2 step 3)', () => {
  // fixtures/decks/json-data.html: the deck renders the key "Retention" as a metric label (Object.entries)
  // and the value "Retention" as a chip. Matching the label exact to the value wrote the label edit into the
  // value (the mutation probe caught it).
  const node = (data: string) => ({ stamp: null, textIndex: 0, data });

  it('a JSON value equal to a JSON object key is ambiguous (key), with the key warning', () => {
    const src =
      '<!doctype html><body><script type="application/json" id="d">\n{"metrics": {"Retention": 41},\n "focus": "Retention", "lede": "Only here"}\n</script></body>';
    const map = buildMap(src, { version: 'v', utf8: true });
    for (const m of [createMatcher(map, { fileName: 'd.html' }), createMatcher(toClientMap(map))]) {
      const r = m(node('Retention'));
      expect(r.confidence).toBe('ambiguous');
      expect(r.reason).toBe('key');
      expect(m(node('Only here')).confidence).toBe('exact');
    }
    expect(createMatcher(map, { fileName: 'd.html' })(node('Retention')).candidates[0].keyWarning).toBe(
      'This text is also used as a key at d.html:2',
    );
  });

  it('a JS literal equal to an identifier key of an object literal is ambiguous (key)', () => {
    const src = "<!doctype html><body><script>const m = { Revenue: 4.2 }; const focus = 'Revenue'; const t = 'Alone';</script></body>";
    const m = createMatcher(buildMap(src, { version: 'v', utf8: true }));
    expect(m(node('Revenue'))).toMatchObject({ confidence: 'ambiguous', reason: 'key' });
    expect(m(node('Alone')).confidence).toBe('exact');
  });
});
