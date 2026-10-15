import { describe, expect, it } from 'vitest';
import { parse, serialize, Parser, type DefaultTreeAdapterMap, type DefaultTreeAdapterTypes } from 'parse5';
import { mapHtmlText, type HtmlMapResult } from '@blueline/core/mapper-html';
import { htmlRunTable, decodeHtmlText } from '@blueline/core/html-tables';
import { buildServedCopy } from '@blueline/core/served';
import { LineIndex } from '@blueline/core/text';
import type { DeckMap } from '@blueline/core/types';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

function map(src: string, opts: { utf8?: boolean; notesBlock?: { start: number; end: number } | null } = {}): HtmlMapResult {
  return mapHtmlText(src, { notesBlock: opts.notesBlock ?? null, lines: new LineIndex(src), utf8: opts.utf8 ?? true });
}

/** A DeckMap shell around a Strategy 1 result, for buildServedCopy. */
function deckMap(src: string, r: HtmlMapResult, utf8 = true, notesBlock: { start: number; end: number } | null = null): DeckMap {
  return {
    version: 'v',
    utf8,
    bom: src.startsWith('\uFEFF'),
    lineEnding: '\n',
    notesBlock,
    stampCount: r.stampCount,
    runs: r.runs,
    units: [],
    literals: [],
    scripts: r.scripts,
    keyValues: r.keyValues,
    keys: r.keys,
    parseErrors: r.parseErrors,
    served: r.served,
  };
}

function elements(root: Node, out: Element[] = []): Element[] {
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if ('tagName' in n) out.push(n as Element);
    if ('childNodes' in n) for (let k = (n.childNodes as Node[]).length - 1; k >= 0; k--) stack.push((n.childNodes as Node[])[k]);
  }
  return out;
}

const nonWsTexts = (el: Element) =>
  el.childNodes.filter((c) => c.nodeName === '#text' && !/^[ \t\n\r\f]*$/.test((c as DefaultTreeAdapterTypes.TextNode).value)).map((c) => (c as DefaultTreeAdapterTypes.TextNode).value);

/**
 * The served copy parses to the same tree as the source (data-bl-e aside), every run is held by exactly
 * one element with its stamp at its textIndex, and no element carries a stamp the map did not issue.
 */
function checkServed(src: string, r: HtmlMapResult): string {
  const served = buildServedCopy(src, deckMap(src, r), { protected: false });
  const strip = (doc: Node) => {
    for (const el of elements(doc)) el.attrs = el.attrs.filter((a) => a.name !== 'data-bl-e');
    return serialize(doc as DefaultTreeAdapterTypes.Document);
  };
  const body = (s: string) => (s.startsWith('\uFEFF') ? s.slice(1) : s);
  expect(strip(parse(body(served)))).toBe(strip(parse(body(src))));
  const doc = parse(body(served));
  const stamps = new Set(r.runs.map((x) => x.stamp));
  const holders = new Map<string, Element[]>();
  for (const el of elements(doc)) {
    const st = el.attrs.find((a) => a.name === 'data-bl-e');
    if (!st) continue;
    expect(stamps.has(st.value), `unexpected stamp ${st.value}`).toBe(true);
    holders.set(st.value, [...(holders.get(st.value) ?? []), el]);
  }
  for (const run of r.runs) {
    const els = holders.get(run.stamp) ?? [];
    const withText = els.filter((el) => nonWsTexts(el).length > run.textIndex);
    expect(withText.length, run.id).toBe(1);
    expect(nonWsTexts(withText[0])[run.textIndex], run.id).toBe(run.value);
    expect(withText[0].tagName).toBe(run.tagName);
  }
  return served;
}

/** Every aligned run's raw slice decodes, through its table, to its value. */
function checkRuns(src: string, r: HtmlMapResult): void {
  for (const run of r.runs) {
    if (!run.aligned) continue;
    const table = htmlRunTable(src, run);
    expect(table, run.id).not.toBeNull();
    const raw = src.slice(run.start, run.end);
    expect(decodeHtmlText(raw, run.textOpts)).toBe(run.value);
    expect(table!.toRaw(table!.length)).toBe(raw.length);
  }
}

describe('mapHtmlText: stamps and runs', () => {
  it('stamps elements with direct text in document order, with ranges, lines and columns', () => {
    const src = '<!doctype html><html><head><title>T</title></head><body>\n<h1>Title</h1>\n<p>Some <b>bold</b> text</p>\n</body></html>';
    const r = map(src);
    expect(r.stampCount).toBe(3);
    expect(r.runs.map((x) => [x.id, x.tagName, x.textIndex, x.value, src.slice(x.start, x.end), x.line, x.col])).toEqual([
      ['h:bl-1:0', 'h1', 0, 'Title', 'Title', 2, 5],
      ['h:bl-2:0', 'p', 0, 'Some ', 'Some ', 3, 4],
      ['h:bl-2:1', 'p', 1, ' text', ' text', 3, 20],
      ['h:bl-3:0', 'b', 0, 'bold', 'bold', 3, 12],
    ]);
    expect(r.runs.every((x) => x.aligned && x.strategy === 'html-text' && !x.usesNbspRef)).toBe(true);
    const served = checkServed(src, r);
    expect(served).toContain('<h1 data-bl-e="bl-1">Title</h1>');
    expect(served).toContain('<p data-bl-e="bl-2">Some <b data-bl-e="bl-3">bold</b> text</p>');
    checkRuns(src, r);
  });

  it('inserts the stamp after the raw tag name: uppercase tags, unquoted values ending in /', () => {
    const src = '<body><P CLASS=x>Hi</P><a href=https://x.com/>link</a><br/><SPAN\tid=s>t</SPAN><p/x>y</p>';
    const r = map(src);
    const served = checkServed(src, r);
    expect(served).toContain('<P data-bl-e="bl-1" CLASS=x>Hi</P>');
    expect(served).toContain('<a data-bl-e="bl-2" href=https://x.com/>link</a>');
    expect(served).toContain('<SPAN data-bl-e="bl-3"\tid=s>t</SPAN>');
    expect(served).toContain('<p data-bl-e="bl-4"/x>y</p>');
    // The unquoted href keeps its trailing slash.
    const a = elements(parse(served)).find((e) => e.tagName === 'a')!;
    expect(a.attrs.find((x) => x.name === 'href')!.value).toBe('https://x.com/');
  });

  it('counts textIndex over non-whitespace direct text nodes only (comments split nodes, NBSP is text)', () => {
    const src = '<body><p>a<!--c-->b<i>c</i> <i></i>d</p><p> \n\t</p><p>&nbsp;</p><p>\u00A0</p>';
    const r = map(src);
    expect(r.runs.map((x) => [x.id, x.value])).toEqual([
      ['h:bl-1:0', 'a'],
      ['h:bl-1:1', 'b'],
      ['h:bl-1:2', 'd'],
      ['h:bl-2:0', 'c'],
      ['h:bl-3:0', '\u00A0'],
      ['h:bl-4:0', '\u00A0'],
    ]);
    expect(r.runs.find((x) => x.id === 'h:bl-3:0')!.usesNbspRef).toBe(true);
    expect(r.runs.find((x) => x.id === 'h:bl-4:0')!.usesNbspRef).toBe(false);
    checkServed(src, r);
    checkRuns(src, r);
  });

  it('skips script, style, template content, textarea, title, noscript and raw-text elements', () => {
    const src =
      '<html><head><title>Title</title><style>p{}</style><script>var a="x"</script><noscript>no</noscript></head>' +
      '<body><template><p>in template</p></template><textarea>ta</textarea><xmp>&amp;</xmp><iframe>if</iframe>' +
      '<noembed>ne</noembed><p>kept</p></body></html>';
    const r = map(src);
    expect(r.runs.map((x) => x.value)).toEqual(['kept']);
    const served = checkServed(src, r);
    expect(served).toContain('<template><p>in template</p></template>');
  });

  it('skips elements the parser invented (implied body, tbody)', () => {
    const src = 'Hello<table><tr><td>cell</td></tr></table>';
    const r = map(src);
    expect(r.runs.map((x) => [x.tagName, x.value])).toEqual([['td', 'cell']]);
    checkServed(src, r);
  });

  it('maps foster-parented text only when its raw range is plain text', () => {
    const merged = '<body><table>a<tr>b</table>';
    const r1 = map(merged);
    expect(r1.runs).toHaveLength(1);
    expect(r1.runs[0].value).toBe('ab');
    expect(r1.runs[0].aligned).toBe(false); // raw "a<tr>b" is not text: never wrong, only unmapped
    checkServed(merged, r1);
    const clean = '<body><table><tr><td>x</td></tr>yy</table>';
    const r2 = map(clean);
    const yy = r2.runs.find((x) => x.value === 'yy')!;
    expect(yy.tagName).toBe('body');
    expect(yy.aligned).toBe(true);
    expect(clean.slice(yy.start, yy.end)).toBe('yy');
    checkServed(clean, r2);
  });

  it('maps SVG <text>, with NUL decoding to U+FFFD', () => {
    const src = '<body><svg viewBox="0 0 10 10"><text x="1">Hi &amp; bye</text><text>a\0b</text><text>c\0\0d</text><foreignObject><p>fo</p></foreignObject></svg>';
    const r = map(src);
    expect(r.runs.map((x) => [x.tagName, x.value, x.aligned, x.textOpts])).toEqual([
      ['text', 'Hi & bye', true, { nul: 'replace' }],
      ['text', 'a\uFFFDb', true, { nul: 'replace' }],
      ['text', 'c\uFFFDd', false, { nul: 'replace' }],
      ['p', 'fo', true, undefined],
    ]);
    const served = checkServed(src, r);
    expect(served).toContain('<svg viewBox="0 0 10 10"><text data-bl-e="bl-1" x="1">');
    checkRuns(src, r);
  });

  it('keeps the newline parse5 drops after <pre> out of the run', () => {
    const src = '<body><pre>\n\n  code</pre><pre>\nx</pre><listing>\r\n\r\ny</listing><pre>&#10;&#10;z</pre>';
    const r = map(src);
    expect(r.runs.map((x) => [x.value, x.textOpts?.dropLeadingNewline ?? false, x.aligned])).toEqual([
      ['\n  code', true, true],
      ['x', false, true], // the lone newline token was dropped whole: the node starts after it
      ['\ny', true, true],
      ['\nz', true, true],
    ]);
    // Line and column point at the first visible character, after the dropped newline.
    expect([r.runs[0].line, r.runs[0].col]).toEqual([2, 1]);
    checkServed(src, r);
    checkRuns(src, r);
  });

  it('does not record text for an element whose stamp a parser clone also carries', () => {
    // Reconstruction: <b> is unclosed, so it is re-opened inside the second <p> with the same attributes.
    const src = '<body><p><b class=k>bold</p><p>more';
    const r = map(src);
    // "more" is inside the re-opened <b>, so both texts are the <b> stamp's index 0: neither is recorded.
    expect(r.runs).toEqual([]);
    checkServed(src, r);
    // Adoption agency: the clone has no location.
    const src2 = '<body><b id=x>1<p>2</b>3</p>';
    const r2 = map(src2);
    expect(r2.runs.map((x) => [x.tagName, x.value])).toEqual([['p', '3']]);
    checkServed(src2, r2);
    // Same text in the original and the clone: the case that would otherwise map `exact` to the wrong place.
    const src3 = '<body><p><b>Same</p><p>Same';
    const r3 = map(src3);
    expect(r3.runs.filter((x) => x.tagName === 'b')).toEqual([]);
    checkServed(src3, r3);
  });

  it('records a clone text index that only one element holds', () => {
    const src = '<body><p><b>x</p><p>y<!---->z';
    const r = map(src);
    const b = r.runs.filter((x) => x.tagName === 'b');
    expect(b.map((x) => [x.textIndex, x.value])).toEqual([[1, 'z']]);
    checkServed(src, r);
  });

  it('never stamps formatting elements that Noah\u2019s Ark can compare', () => {
    // Four <b>s open at once: the 4th has text. Stamping it would make it differ from the others and change
    // which <b>s the parser re-opens in the next <p>.
    const src = '<body><p><b><b><b><b>x</p><p>y';
    const r = map(src);
    expect(r.runs.filter((x) => x.tagName === 'b')).toEqual([]);
    checkServed(src, r);
    // Three is fine.
    const ok = '<body><p><b><b><b>x</b></b></b></p>';
    const r2 = map(ok);
    expect(r2.runs.map((x) => [x.tagName, x.value])).toEqual([['b', 'x']]);
    checkServed(ok, r2);
  });

  it('refuses every stamp when a data-bl-e it must strip sits on an element Noah\u2019s Ark compares', () => {
    const src = '<body><h1>t</h1><p><b data-bl-e=bl-1><b><b><b>x</p><p>y';
    const r = map(src);
    expect(r.runs).toEqual([]);
    expect(r.served.stamps).toEqual([]);
    expect(r.served.strip).toHaveLength(1);
  });

  it('pins the parse5 internals the instrumentation uses', () => {
    const parser = new Parser<DefaultTreeAdapterMap>({ sourceCodeLocationInfo: true });
    expect(typeof parser.onStartTag).toBe('function');
    expect(typeof parser.activeFormattingElements.pushElement).toBe('function');
    expect(Array.isArray(parser.activeFormattingElements.entries)).toBe(true);
    expect(typeof parser.tokenizer.write).toBe('function');
    // Clones share their token's attrs array (the grouping key).
    const doc = parse('<p><b class=k>x</p><p>y', { sourceCodeLocationInfo: true });
    const bs = elements(doc).filter((e) => e.tagName === 'b');
    expect(bs).toHaveLength(2);
    expect(bs[0].attrs).toBe(bs[1].attrs);
  });

  it('refuses text from a <select> that parse5 and Chromium parse differently onward', () => {
    // parse5 8 ignores tags other than option/optgroup/hr inside <select>; Chromium's relaxed <select>
    // parser keeps them, so stamps and text indexes may name other nodes from there on.
    const plain = '<body><select><option>A</option><optgroup label=g><option>B</option><hr></optgroup></select><p>after</p>';
    expect(map(plain).runs.map((x) => [x.tagName, x.value, x.aligned])).toEqual([
      ['option', 'A', true],
      ['option', 'B', true],
      ['p', 'after', true],
    ]);
    const relaxed = '<body><p>before</p><select><b>y</b>y<option>A</option></select><p>after</p>';
    expect(map(relaxed).runs.map((x) => [x.value, x.aligned])).toEqual([
      ['before', true],
      ['yy', false],
      ['A', false],
      ['after', false],
    ]);
    const custom = '<body><select><button><selectedcontent></selectedcontent></button><option>One</option></select>';
    expect(map(custom).runs.every((x) => !x.aligned)).toBe(true);
    const unclosed = '<body><select><option>A</option>';
    expect(map(unclosed).runs.every((x) => !x.aligned)).toBe(true);
    // The select family inside SVG or MathML, and <selectedcontent> anywhere, parse differently too.
    const foreign = '<body><p>before</p><svg><text>a<optgroup>x</optgroup>y</text></svg><p>after</p>';
    expect(map(foreign).runs.map((x) => [x.value, x.aligned])).toEqual([
      ['before', true],
      ['a', true],
      ['y', false],
      ['x', false],
      ['after', false],
    ]);
    const sc = '<body><p>before</p><div><selectedcontent>s</selectedcontent></div><p>after</p>';
    expect(map(sc).runs.map((x) => [x.value, x.aligned])).toEqual([
      ['before', true],
      ['s', false],
      ['after', false],
    ]);
    // Options outside any select and outside foreign content parse the same in both.
    const datalist = '<body><datalist><option>d1</option><option>d2</option></datalist><p>after</p>';
    expect(map(datalist).runs.every((x) => x.aligned)).toBe(true);
  });

  it('refuses text after an end tag that parse5 matches to a MathML or SVG element', () => {
    // Chromium ignores </mi> while <span> (HTML) is current inside <mi>; parse5 closes the <mi>, so the
    // text after it lands in a different element.
    const src = '<body><p>before</p><math><mi><span>x</mi></math>tail<p>later</p>';
    const r = map(src);
    expect(r.runs.map((x) => [x.tagName, x.value, x.aligned])).toEqual([
      ['body', 'tail', false],
      ['p', 'before', true],
      ['span', 'x', true],
      ['p', 'later', false],
    ]);
    // A well-formed integration point is fine.
    const ok = '<body><svg><foreignObject><div>in</div></foreignObject></svg><p>after</p>';
    expect(map(ok).runs.every((x) => x.aligned)).toBe(true);
  });

  it('finds the notes block itself when not given one', () => {
    const block = '<script type="application/vnd.blueline+json" id="blueline-notes">{}</script>';
    const src = '\uFEFF<body><p>one</p>' + block + '</body>';
    const r = mapHtmlText(src, { lines: new LineIndex(src), utf8: true });
    expect(r.notesBlock).toEqual({ start: 17, end: 17 + block.length });
    expect(r.runs.map((x) => [x.value, x.start])).toEqual([['one', 10]]);
    expect(r.scripts).toEqual([]);
    const none = mapHtmlText('<p>x</p>', { lines: new LineIndex('<p>x</p>'), utf8: true });
    expect(none.notesBlock).toBeNull();
  });

  it('survives deep nesting', () => {
    const depth = 12000; // past where plain recursion overflows (about 11k frames); parse5 itself is quadratic in depth
    const src = '<body>' + '<div>'.repeat(depth) + 'deep' + '</div>'.repeat(depth);
    const r = map(src);
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0].value).toBe('deep');
  });

  it('gives no stamps or runs for a deck that is not UTF-8, but still strips data-bl-e', () => {
    const src = '<body><p data-bl-e="bl-4">caf\u00e9</p>';
    const r = map(src, { utf8: false });
    expect(r.runs).toEqual([]);
    expect(r.stampCount).toBe(0);
    expect(r.served.stamps).toEqual([]);
    expect(buildServedCopy(src, deckMap(src, r, false), { protected: false })).toBe('<body><p >caf\u00e9</p>');
  });
});

describe('mapHtmlText: offsets', () => {
  it('counts the BOM in every offset', () => {
    const src = '\uFEFF<p>\u00e9t\u00e9</p>';
    const r = map(src);
    expect(r.runs[0].start).toBe(4);
    expect(r.runs[0].end).toBe(7);
    expect(r.served.stamps).toEqual([{ offset: 3, stamp: 'bl-1' }]);
    const served = checkServed(src, r);
    expect(served).toBe('\uFEFF<p data-bl-e="bl-1">\u00e9t\u00e9</p>');
    expect(r.parseErrors[0]).toEqual({ code: 'missing-doctype', offset: 1 });
  });

  it('uses UTF-16 offsets across CRLF, lone CR and astral characters', () => {
    const src = '<body>\r\n<p>😀 a</p>\r<p>b\r\nc</p>\n<p>d</p>';
    const r = map(src);
    expect(r.runs.map((x) => [x.value, src.slice(x.start, x.end), x.line, x.col])).toEqual([
      ['😀 a', '😀 a', 2, 4],
      ['b\nc', 'b\r\nc', 3, 4],
      ['d', 'd', 5, 4],
    ]);
    checkServed(src, r);
    checkRuns(src, r);
  });

  it('maps every reference form inside a document', () => {
    const src = '<body><p>&amp; &ampx &copy &#8217; &#x2014; &#128; &#0; &#xD800; &nbsp; &NotEqualTilde;</p>';
    const r = map(src);
    expect(r.runs[0].value).toBe('& &x © \u2019 \u2014 \u20AC \uFFFD \uFFFD \u00A0 \u2242\u0338');
    expect(r.runs[0].aligned).toBe(true);
    expect(r.runs[0].usesNbspRef).toBe(true);
    checkRuns(src, r);
  });
});

describe('mapHtmlText: the served plan', () => {
  it('strips every data-bl-e already in the source, duplicates and adopted <body> attributes included', () => {
    const src =
      '<html data-bl-e=h><body data-bl-e="bl-2"><p data-bl-e="bl-9" DATA-BL-E=\'z\' data-bl-e>x</p>' +
      '<div data-bl-e = "q" title=t></div><body data-bl-e=bl-1 class=late><img data-bl-e=bl-3/>';
    const r = map(src);
    const served = checkServed(src, r);
    expect(served).not.toMatch(/data-bl-e="(?!bl-1")/i);
    expect(served.match(/data-bl-e/gi)).toHaveLength(1);
    expect(served).toContain('<p data-bl-e="bl-1"');
    const doc = parse(served);
    const body = elements(doc).find((e) => e.tagName === 'body')!;
    expect(body.attrs.map((a) => a.name)).toEqual(['class']);
  });

  it('collects resource hints for Protected view', () => {
    const src =
      '<head><link rel="preconnect" href="https://a.example"><link REL="DNS-Prefetch Stylesheet" href=s.css>' +
      '<link rel=stylesheet href=t.css><link rel="pre&#99;onnect prefetch" href=x><meta http-equiv="X-DNS-Prefetch-Control" content="on">' +
      '<meta http-equiv="refresh" content="5"></head><body><template><link rel=prerender href=y></template><p>t</p>';
    const r = map(src);
    const m = deckMap(src, r);
    const prot = buildServedCopy(src, m, { protected: true });
    expect(prot).toContain('<link rel="" href="https://a.example">');
    expect(prot).toContain('<link rel="Stylesheet" href=s.css>');
    expect(prot).toContain('<link rel=stylesheet href=t.css>');
    expect(prot).toContain('<link rel="" href=x>');
    expect(prot).toContain('<meta  content="on">');
    expect(prot).toContain('<meta http-equiv="refresh" content="5">');
    expect(prot).toContain('<template><link rel="" href=y></template>');
    const open = buildServedCopy(src, m, { protected: false });
    expect(open).toContain('<link rel="preconnect" href="https://a.example">');
    // No hint token survives in any parsed <link>.
    for (const el of elements(parse(prot))) {
      const rel = el.attrs.find((a) => a.name === 'rel');
      if (rel) expect(rel.value.toLowerCase()).not.toMatch(/dns-prefetch|preconnect|prefetch|prerender/);
    }
  });

  it('writes a rewritten rel value in ASCII', () => {
    const src = '<link rel="preconnect &#x2603;x">';
    const r = map(src);
    expect(buildServedCopy(src, deckMap(src, r), { protected: true })).toBe('<link rel="&#x2603;x">');
  });
});

describe('mapHtmlText: scripts, keys and parse errors', () => {
  it('lists every script with its kind and content range', () => {
    const src =
      '<script>a()</script><script type=module>b()</script><script type=" Application/JSON ">{}</script>' +
      '<script type="text/javascript; charset=utf-8">c</script><script type="text/x-template"><p>t</p></script>' +
      '<script type="">d</script><script language="javascript">e</script><script language="vbscript">f</script>' +
      '<script src="x.js"></script><script type="TEXT/JAVASCRIPT">g</script><template><script>h</script></template>' +
      '<svg><script>i</script></svg><script type="application/ld+json">{}</script><script type="  ">j</script>' +
      '<script>unterminated';
    const r = map(src);
    expect(r.scripts.map((x) => [x.kind, x.type, x.hasSrc, src.slice(x.contentStart, x.contentEnd)])).toEqual([
      ['classic', '', false, 'a()'],
      ['module', 'module', false, 'b()'],
      ['json', 'application/json', false, '{}'],
      ['other', 'text/javascript; charset=utf-8', false, 'c'],
      ['other', 'text/x-template', false, '<p>t</p>'],
      ['classic', '', false, 'd'],
      ['classic', '', false, 'e'],
      ['other', '', false, 'f'],
      ['classic', '', true, ''],
      ['classic', 'text/javascript', false, 'g'],
      ['classic', '', false, 'h'],
      ['other', '', false, 'i'],
      ['other', 'application/ld+json', false, '{}'],
      ['other', '', false, 'j'], // a whitespace-only type is a data block, unlike an empty one
      ['classic', '', false, 'unterminated'],
    ]);
    for (const s of r.scripts) {
      expect(s.parsed).toBe(false);
      expect(src.slice(s.start, s.end).startsWith('<script')).toBe(true);
      expect(s.start < s.contentStart && s.contentStart <= s.contentEnd && s.contentEnd <= s.end).toBe(true);
    }
    expect(r.scripts[r.scripts.length - 1].end).toBe(src.length);
    expect(r.scripts.map((s) => s.index)).toEqual(r.scripts.map((_, k) => k));
  });

  it('collects key values with their lines', () => {
    const src = '<body>\n<div id="hero" class="card big" data-key="k1" title="ignored">\n<label for=f name=n>x</label>\n<a href="#s2">l</a><svg><a xlink:href="#s3"></a></svg></div>';
    const r = map(src);
    expect(r.keys).toEqual([
      { value: 'hero', attr: 'id', line: 2 },
      { value: 'card big', attr: 'class', line: 2 },
      { value: 'card', attr: 'class', line: 2 },
      { value: 'big', attr: 'class', line: 2 },
      { value: 'k1', attr: 'data-key', line: 2 },
      { value: 'f', attr: 'for', line: 3 },
      { value: 'n', attr: 'name', line: 3 },
      { value: '#s2', attr: 'href', line: 4 },
      { value: '#s3', attr: 'href', line: 4 },
    ]);
    expect(r.keyValues).toEqual(['hero', 'card big', 'card', 'big', 'k1', 'f', 'n', '#s2', '#s3']);
  });

  it('records parse errors with raw offsets', () => {
    const src = '<!doctype html><p>a &notit; b</p><p>\0</p>';
    const r = map(src);
    expect(r.parseErrors).toEqual([
      { code: 'missing-semicolon-after-character-reference', offset: 24 }, // parse5 reports the next character
      { code: 'unexpected-null-character', offset: 36 },
    ]);
  });
});

describe('mapHtmlText: the notes block range', () => {
  it('maps nothing at or after it and leaves offsets before it unchanged', () => {
    const block = '<script type="application/vnd.blueline+json" id="blueline-notes">{"a":"\\u003C/p>"}</script>';
    const head = '<body><p>one</p>';
    const src = head + block + '\n</body>';
    const nb = { start: head.length, end: head.length + block.length };
    const r = map(src, { notesBlock: nb });
    const plain = map(head + '\n</body>');
    expect(r.runs).toEqual(plain.runs);
    expect(r.scripts).toEqual([]);
    expect(buildServedCopy(src, deckMap(src, r, true, nb), { protected: false })).toBe('<body><p data-bl-e="bl-1">one</p>\n</body>');
  });

  it('marks text merged across the removed block as unaligned', () => {
    const block = '<script type="application/vnd.blueline+json" id="blueline-notes">{}</script>';
    const head = '<body><p>one</p>tail';
    const src = head + block + '\n</body>';
    const nb = { start: head.length, end: head.length + block.length };
    const r = map(src, { notesBlock: nb });
    const tail = r.runs.find((x) => x.tagName === 'body')!;
    expect(tail.value).toBe('tail\n');
    expect(tail.aligned).toBe(false);
    expect(r.runs.find((x) => x.tagName === 'p')!.aligned).toBe(true);
  });
});
