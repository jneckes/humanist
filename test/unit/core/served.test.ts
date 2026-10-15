import { describe, expect, it } from 'vitest';
import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import { buildMap } from '@blueline/core/mapper';
import { buildServedCopy } from '@blueline/core/served';
import { decodeDeck, encodeLatin1 } from '@blueline/core/text';
import type { DeckMap } from '@blueline/core/types';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type TextNode = DefaultTreeAdapterTypes.TextNode;

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

const nonWsTexts = (el: Element) =>
  el.childNodes.filter((c): c is TextNode => c.nodeName === '#text' && !/^[ \t\n\r\f]*$/.test((c as TextNode).value)).map((c) => c.value);

const noBom = (s: string) => (s.startsWith('\uFEFF') ? s.slice(1) : s);

/** Parses the served copy and checks every run against the element that carries its stamp. */
function roundTrip(src: string, map: DeckMap): string {
  const served = buildServedCopy(src, map, { protected: false });
  const doc = parse(noBom(served));
  const holders = new Map<string, Element[]>();
  for (const el of elements(doc)) {
    const st = el.attrs.filter((a) => a.name === 'data-bl-e');
    if (st.length === 0) continue;
    expect(st).toHaveLength(1);
    holders.set(st[0].value, [...(holders.get(st[0].value) ?? []), el]);
  }
  const issued = new Set(map.runs.map((r) => r.stamp));
  for (const s of holders.keys()) expect(issued.has(s), `stamp ${s} not issued by the map`).toBe(true);
  expect(map.served!.stamps.map((s) => s.stamp).sort()).toEqual([...issued].sort());
  for (const run of map.runs) {
    const els = (holders.get(run.stamp) ?? []).filter((el) => nonWsTexts(el).length > run.textIndex);
    expect(els, run.id).toHaveLength(1);
    expect(nonWsTexts(els[0])[run.textIndex]).toBe(run.value);
  }
  // Same tree as the file without its notes block, apart from data-bl-e.
  const strip = (d: DefaultTreeAdapterTypes.Document) => {
    for (const el of elements(d)) el.attrs = el.attrs.filter((a) => a.name !== 'data-bl-e');
    return serialize(d);
  };
  const clean = map.notesBlock ? src.slice(0, map.notesBlock.start) + src.slice(map.notesBlock.end) : src;
  expect(strip(doc)).toBe(strip(parse(noBom(clean))));
  return served;
}

const NOTES = '<script type="application/vnd.blueline+json" id="blueline-notes" data-version="1">{"format":"blueline-notes","notes":[{"text":"\\u003C/script>"}]}</script>';

const DECK = [
  '\uFEFF<!DOCTYPE html>',
  '<html lang="en"><head><meta charset="utf-8"><title>Deck &amp; title</title>',
  '<link rel="preconnect" href="https://fonts.gstatic.com"><style>.s{color:red}</style></head>',
  '<body class="reveal">',
  '<section id="s1" class="slide"><h1>Caf&eacute; &mdash; “quoted” 😀</h1>',
  '<p data-bl-e="bl-77">Some <strong>bold</strong> &amp; <em>em</em> text&nbsp;here.</p>',
  '<ul><li>One</li><li>Two &lt;3</li></ul></section>',
  '<section class="slide"><pre>\n  code &amp; more</pre><table><tr><td>Cell</td></tr></table>',
  '<svg viewBox="0 0 4 4"><text x="1">Label</text></svg><a href=https://example.com/>link</a></section>',
  '<template><p>inert</p></template>',
  '<script>const t = "lit";</script>',
  NOTES,
  '</body></html>',
].join('\r\n');

describe('buildServedCopy', () => {
  it('stamps exactly the map\u2019s runs, removes the notes block and old stamps, keeps everything else', () => {
    const map = buildMap(DECK, { version: 'v1', utf8: true });
    expect(map.notesBlock).not.toBeNull();
    expect(map.runs.length).toBeGreaterThan(10);
    const served = roundTrip(DECK, map);
    expect(served.startsWith('\uFEFF<!DOCTYPE html>\r\n')).toBe(true);
    expect(served).not.toContain('blueline-notes');
    expect(served).not.toContain('bl-77');
    // Removing what was inserted gives back the file without the notes block and the old stamp.
    const back = served.replace(/ data-bl-e="bl-\d+"/g, '');
    const nb = map.notesBlock!;
    // A stripped attribute leaves the whitespace before it, which a tag ignores.
    const expected = (DECK.slice(0, nb.start) + DECK.slice(nb.end)).replace('data-bl-e="bl-77"', '');
    expect(back).toBe(expected);
    // The deck's own text is untouched byte for byte.
    expect(served).toContain('<h1 data-bl-e="bl-1">Caf&eacute; &mdash; “quoted” 😀</h1>');
    expect(served).toContain('<a data-bl-e="bl-');
    expect(served).toContain('href=https://example.com/>link</a>');
  });

  it('removes resource hints only in Protected view', () => {
    const map = buildMap(DECK, { version: 'v1', utf8: true });
    expect(buildServedCopy(DECK, map, { protected: false })).toContain('<link rel="preconnect"');
    const prot = buildServedCopy(DECK, map, { protected: true });
    expect(prot).toContain('<link rel="" href="https://fonts.gstatic.com">');
    // The stamps are the same in both.
    const stamps = (s: string) => s.match(/data-bl-e="bl-\d+"/g);
    expect(stamps(prot)).toEqual(stamps(buildServedCopy(DECK, map, { protected: false })));
  });

  it('serves a notes-like block that is page content as it is', () => {
    const src = `<body><template>${NOTES}</template><p>x</p></body>`;
    const map = buildMap(src, { version: 'v', utf8: true });
    expect(map.notesBlock).toBeNull();
    expect(roundTrip(src, map)).toContain(NOTES);
  });

  it('builds a latin1 copy with no stamps for a deck that is not UTF-8', () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<html><head><meta charset="windows-1252"><link rel=prefetch href=a></head><body><p data-bl-e="bl-1">caf'),
      0xe9,
      0x93,
      ...new TextEncoder().encode('</p></body></html>'),
    ]);
    const d = decodeDeck(bytes);
    expect(d.utf8).toBe(false);
    const map = buildMap(d.src, { version: 'v', utf8: false });
    expect(map.runs).toEqual([]);
    expect(map.literals).toEqual([]);
    const served = buildServedCopy(d.src, map, { protected: true });
    expect(served).not.toContain('data-bl-e');
    const out = encodeLatin1(served);
    const text = new TextDecoder('latin1').decode(out);
    expect(text).toContain('<link rel="" href=a>');
    // The non-ASCII bytes come back unchanged.
    const i = out.indexOf(0xe9);
    expect([out[i], out[i + 1]]).toEqual([0xe9, 0x93]);
  });

  it('refuses a map built from another version of the file', () => {
    const map = buildMap('<p>one</p>', { version: 'v', utf8: true });
    expect(() => buildServedCopy('<p>one!</p>', map, { protected: false })).toThrow();
  });

  it('rebuilds the plan when the map carries none', () => {
    const src = '<body><p data-bl-e=x>one</p>';
    const map = buildMap(src, { version: 'v', utf8: true });
    const withPlan = buildServedCopy(src, map, { protected: false });
    const { served: _served, ...bare } = map;
    expect(buildServedCopy(src, bare, { protected: false })).toBe(withPlan);
    expect(withPlan).toBe('<body><p data-bl-e="bl-1" >one</p>');
  });
});
