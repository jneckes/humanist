import { describe, expect, it } from 'vitest';
import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import {
  decodeHtmlText,
  encodeHtmlText,
  htmlTextTable,
  planHtmlTextEdit,
  type HtmlTextOptions,
  type HtmlTextTable,
} from '@blueline/core/html-tables';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/** The first text node under the first element named `tag`, with its raw slice, as parse5 sees them. */
function parse5Text(doc: string, tag: string): { raw: string; value: string } {
  const root = parse(doc, { sourceCodeLocationInfo: true });
  const stack: Node[] = [root];
  while (stack.length) {
    const n = stack.shift()!;
    if ('tagName' in n && n.tagName === tag) {
      const t = (n as Element).childNodes.find((c) => c.nodeName === '#text') as DefaultTreeAdapterTypes.TextNode;
      const loc = t.sourceCodeLocation!;
      return { raw: doc.slice(loc.startOffset, loc.endOffset), value: t.value };
    }
    if ('childNodes' in n) stack.push(...(n.childNodes as Node[]));
  }
  throw new Error('no ' + tag);
}

/** Every decoded index maps to raw, and each slice between unit boundaries decodes to its characters. */
function checkTable(raw: string, value: string, table: HtmlTextTable, opts: HtmlTextOptions = {}): void {
  expect(table.length).toBe(value.length);
  expect(table.toRaw(table.length)).toBe(raw.length);
  let prev = 0;
  for (let i = 1; i <= table.length; i++) {
    if (!table.isUnitBoundary(i)) continue;
    expect(decodeHtmlText(raw.slice(table.toRaw(prev), table.toRaw(i)), { nul: opts.nul })).toBe(value.slice(prev, i));
    prev = i;
  }
}

function aligned(raw: string, opts: HtmlTextOptions = {}): { value: string; table: HtmlTextTable } {
  const { value } = parse5Text(`<p>${raw}</p>`, 'p');
  const table = htmlTextTable(raw, value, opts);
  expect(table, `table for ${JSON.stringify(raw)}`).not.toBeNull();
  checkTable(raw, value, table!, opts);
  return { value, table: table! };
}

describe('htmlTextTable: character references agree with parse5', () => {
  const cases: [string, string][] = [
    ['a&amp;b', 'a&b'],
    ['&ampx', '&x'], // legacy reference without `;`
    ['&amp', '&'],
    ['&copy', '©'],
    ['&copy;', '©'],
    ['&copyx', '©x'],
    ['&#8217;', '’'],
    ['&#x2014;', '—'],
    ['&#X2014;', '—'],
    ['&#128;', '€'], // windows-1252 replacement table
    ['&#x9F;', 'Ÿ'],
    ['&#0;', '\uFFFD'],
    ['&#xD800;', '\uFFFD'], // surrogate
    ['&#x110000;', '\uFFFD'], // past U+10FFFF
    ['&#99999999999999999999;', '\uFFFD'],
    ['&#38', '&'], // numeric without `;`
    ['&#38x', '&x'],
    ['&nbsp;', '\u00A0'],
    ['&NotEqualTilde;', '\u2242\u0338'], // two code points
    ['&Afr;', '\u{1D504}'], // astral, emitted as two code units
    ['&#x1F600;', '\u{1F600}'],
    ['&notin;', '∉'],
    ['&notit;', '¬it;'], // longest legacy prefix wins
    ['&bogus;', '&bogus;'],
    ['& x', '& x'],
    ['&', '&'],
    ['&#', '&#'],
    ['&#x', '&#x'],
    ['&#xZ', '&#xZ'],
    ['&&amp;', '&&'],
    ['a&lt;b&gt;c', 'a<b>c'],
    ['&#13;', '\r'],
  ];
  for (const [raw, value] of cases) {
    it(`${JSON.stringify(raw)} → ${JSON.stringify(value)}`, () => {
      const got = aligned(raw);
      expect(got.value).toBe(value);
      expect(decodeHtmlText(raw)).toBe(value);
    });
  }

  it('keeps each reference atomic', () => {
    const { table } = aligned('x&amp;y');
    expect([0, 1, 2, 3].map((i) => table.toRaw(i))).toEqual([0, 1, 6, 7]);
    expect(table.widen(1, 1)).toEqual({ start: 1, end: 1 });
    const two = aligned('a&NotEqualTilde;b').table;
    expect(two.length).toBe(4);
    expect(two.widen(2, 2)).toEqual({ start: 1, end: 3 });
    expect(two.toRaw(1)).toBe(1);
    expect(two.toRaw(3)).toBe(16);
  });

  it('keeps a surrogate pair atomic', () => {
    const { table } = aligned('a😀b');
    expect(table.widen(2, 2)).toEqual({ start: 1, end: 3 });
    expect(table.toRaw(3)).toBe(3);
  });

  it('reports a U+00A0 reference', () => {
    expect(aligned('a&nbsp;b').table.usesNbspRef).toBe(true);
    expect(aligned('a&#160;b').table.usesNbspRef).toBe(true);
    expect(aligned('a\u00A0b').table.usesNbspRef).toBe(false);
  });

  it('refuses a value that does not match', () => {
    expect(htmlTextTable('a&amp;b', 'a&amp;b')).toBeNull();
    expect(htmlTextTable('ab', 'abc')).toBeNull();
    expect(htmlTextTable('abc', 'ab')).toBeNull();
  });
});

describe('htmlTextTable: line endings, NUL and markup', () => {
  it('maps CRLF and lone CR to LF, atomic', () => {
    const { value, table } = aligned('a\r\nb\rc\nd');
    expect(value).toBe('a\nb\nc\nd');
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => table.toRaw(i))).toEqual([0, 1, 3, 4, 5, 6, 7, 8]);
  });

  it('drops NUL in HTML content, replaces it in SVG content', () => {
    const { value, table } = aligned('a\0b');
    expect(value).toBe('ab');
    expect(table.toRaw(1)).toBe(1);
    const svg = parse5Text('<svg><text>a\0b</text></svg>', 'text');
    expect(svg.value).toBe('a\uFFFDb');
    expect(htmlTextTable(svg.raw, svg.value)).toBeNull();
    const t = htmlTextTable(svg.raw, svg.value, { nul: 'replace' })!;
    checkTable(svg.raw, svg.value, t, { nul: 'replace' });
  });

  it('refuses adjacent NULs in foreign content (parse5 folds them; browsers do not)', () => {
    const svg = parse5Text('<svg><text>a\0\0b</text></svg>', 'text');
    expect(svg.value).toBe('a\uFFFDb');
    expect(htmlTextTable(svg.raw, svg.value, { nul: 'replace' })).toBeNull();
  });

  it('handles slices that decode to nothing', () => {
    const t = htmlTextTable('\0', '')!;
    expect(t).not.toBeNull();
    expect(t.length).toBe(0);
    expect(t.toRaw(0)).toBe(1);
    expect(htmlTextTable('', '')!.length).toBe(0);
    expect(decodeHtmlText('\0\0')).toBe('');
  });

  it('refuses a raw range that spans markup', () => {
    // Foster parenting merges "a" and "b" across <tr> into one text node.
    const f = parse5Text('<body><table>a<tr>b</table>', 'body');
    expect(f.value).toBe('ab');
    expect(f.raw).toBe('a<tr>b');
    expect(htmlTextTable(f.raw, f.value)).toBeNull();
    expect(htmlTextTable('a<!--x-->b', 'ab')).toBeNull();
    expect(htmlTextTable('x</body>y', 'xy')).toBeNull();
    // A `<` that opens nothing is text.
    expect(aligned('a < b <3 <').value).toBe('a < b <3 <');
  });

  it('drops the leading newline after <pre> and keeps it out of the run', () => {
    for (const [doc, value] of [
      ['<pre>\n  foo</pre>', '  foo'],
      ['<pre>\r\n\r\nfoo</pre>', '\nfoo'],
      ['<pre>\r\rfoo</pre>', '\nfoo'],
      ['<pre>&#10;&#10;baz</pre>', '\nbaz'],
      ['<pre>&NewLine;&#x0a;q</pre>', '\nq'],
    ] as const) {
      const got = parse5Text(doc, 'pre');
      expect(got.value).toBe(value);
      expect(htmlTextTable(got.raw, got.value)).toBeNull();
      const t = htmlTextTable(got.raw, got.value, { dropLeadingNewline: true })!;
      expect(t).not.toBeNull();
      expect(t.prefix).toBeGreaterThan(0);
      expect(t.toRaw(0)).toBe(t.prefix);
      expect(t.toRaw(t.length)).toBe(got.raw.length);
    }
    // Nothing to drop: the option is harmless.
    const t = htmlTextTable('foo', 'foo', { dropLeadingNewline: true })!;
    expect(t.prefix).toBe(0);
  });
});

describe('encodeHtmlText', () => {
  it('encodes & and < and, on request, NBSP', () => {
    expect(encodeHtmlText('a & b < c > d', { nbspAsRef: false })).toBe('a &amp; b &lt; c > d');
    expect(encodeHtmlText('a\u00A0b', { nbspAsRef: false })).toBe('a\u00A0b');
    expect(encodeHtmlText('a\u00A0b', { nbspAsRef: true })).toBe('a&nbsp;b');
    expect(encodeHtmlText('&amp;', { nbspAsRef: false })).toBe('&amp;amp;');
  });

  it('writes line breaks with the file line ending, CR as a reference', () => {
    expect(encodeHtmlText('a\nb', { nbspAsRef: false, lineEnding: '\r\n' })).toBe('a\r\nb');
    expect(encodeHtmlText('a\nb', { nbspAsRef: false })).toBe('a\nb');
    expect(encodeHtmlText('a\rb', { nbspAsRef: false })).toBe('a&#13;b');
  });

  it('round-trips through decodeHtmlText', () => {
    const samples = ['plain', 'a&b', '<p>', '&amp;', '&lt;&gt;', 'x\u00A0y', '😀 & “quotes” — dash', 'a\r\nb', '&notin;', '&#38;'];
    for (const s of samples) {
      for (const nbspAsRef of [false, true]) {
        expect(decodeHtmlText(encodeHtmlText(s, { nbspAsRef }))).toBe(s.replace(/\r\n/g, '\r\n'));
      }
    }
  });
});

describe('planHtmlTextEdit', () => {
  const apply = (raw: string, p: { start: number; end: number; text: string }) => raw.slice(0, p.start) + p.text + raw.slice(p.end);

  it('splices only the changed range and keeps untouched references', () => {
    const raw = 'Caf&eacute; &amp; bar';
    const p = planHtmlTextEdit({ raw, before: 'Café & bar', after: 'Café & baz', nbspAsRef: false })!;
    expect(p).toEqual({ start: 20, end: 21, text: 'z' });
    expect(apply(raw, p)).toBe('Caf&eacute; &amp; baz');
  });

  it('widens a span that starts inside a reference and re-encodes it', () => {
    const raw = 'a&NotEqualTilde;b';
    const before = decodeHtmlText(raw)!;
    const after = before.slice(0, 2) + 'X' + before.slice(2); // insert between the two code points
    const p = planHtmlTextEdit({ raw, before, after, nbspAsRef: false })!;
    expect(p.start).toBe(1);
    expect(p.end).toBe(16);
    expect(decodeHtmlText(apply(raw, p))).toBe(after);
  });

  it('re-encodes a reference without `;` that new text would extend', () => {
    const raw = 'x &not y';
    const p = planHtmlTextEdit({ raw, before: 'x ¬ y', after: 'x ¬in; y', nbspAsRef: false })!;
    expect(decodeHtmlText(apply(raw, p))).toBe('x ¬in; y');
    expect(apply(raw, p)).toBe('x ¬in; y');
  });

  it('re-encodes a bare & that new text would turn into a reference', () => {
    const raw = 'Q& A';
    const p = planHtmlTextEdit({ raw, before: 'Q& A', after: 'Q&amp; A', nbspAsRef: false })!;
    expect(decodeHtmlText(apply(raw, p))).toBe('Q&amp; A');
    const raw2 = 'x &am y';
    const p2 = planHtmlTextEdit({ raw: raw2, before: 'x &am y', after: 'x &amp; y', nbspAsRef: false })!;
    expect(decodeHtmlText(apply(raw2, p2))).toBe('x &amp; y');
  });

  it('inserts at the start of a <pre> run after the dropped newline', () => {
    const raw = '\nfoo';
    const p = planHtmlTextEdit({ raw, before: 'foo', after: 'Xfoo', nbspAsRef: false, opts: { dropLeadingNewline: true } })!;
    expect(p).toEqual({ start: 1, end: 1, text: 'X' });
  });

  it('keeps CRLF spelling and encodes NBSP as the run does', () => {
    const raw = 'a\r\nb&nbsp;c';
    const p = planHtmlTextEdit({ raw, before: 'a\nb\u00A0c', after: 'a\nb\u00A0\u00A0c', nbspAsRef: true, lineEnding: '\r\n' })!;
    expect(apply(raw, p)).toBe('a\r\nb&nbsp;&nbsp;c');
  });

  it('plans pure insertions and deletions as minimal splices', () => {
    const raw = 'one &amp; two\r\nthree';
    const before = 'one & two\nthree';
    // Pure insertion: empty range.
    expect(planHtmlTextEdit({ raw, before, after: 'one & two!\nthree', nbspAsRef: false })).toEqual({ start: 13, end: 13, text: '!' });
    // Pure deletion of a reference: exactly its raw range, nothing inserted.
    expect(planHtmlTextEdit({ raw, before, after: 'one  two\nthree', nbspAsRef: false })).toEqual({ start: 4, end: 9, text: '' });
    // Deleting a line break removes the whole CRLF.
    expect(planHtmlTextEdit({ raw, before, after: 'one & twothree', nbspAsRef: false })).toEqual({ start: 13, end: 15, text: '' });
    // Replacing one character next to a reference leaves the reference alone.
    expect(planHtmlTextEdit({ raw, before, after: 'One & two\nthree', nbspAsRef: false })).toEqual({ start: 0, end: 1, text: 'O' });
    // An explicit span (an insertion at a boundary goes where the caret was).
    expect(planHtmlTextEdit({ raw: 'aa', before: 'aa', after: 'aaa', nbspAsRef: false, span: { start: 0, endBefore: 0, endAfter: 1 } })).toEqual({ start: 0, end: 0, text: 'a' });
  });

  it('refuses text HTML cannot hold, and a wrong `before`', () => {
    expect(planHtmlTextEdit({ raw: 'ab', before: 'ab', after: 'a\0b', nbspAsRef: false })).toBeNull();
    expect(planHtmlTextEdit({ raw: 'ab', before: 'xy', after: 'xz', nbspAsRef: false })).toBeNull();
  });
});

describe('property: decoding through the table reproduces parse5 values', () => {
  // Seeded generator of text runs mixing every unit kind.
  function rng(seed: number) {
    return () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
  }
  const pieces = [
    'a', 'Z', ' ', '\t', '\n', '\r\n', '\r', '&amp;', '&amp', '&ampx', '&copy', '&notin;', '&notit', '&#8217;', '&#x2014;',
    '&#128;', '&#0;', '&#xD800;', '&nbsp;', '&NotEqualTilde;', '&Afr;', '&', '& ', '&#', '&bogus;', '<3', '< ', '😀', '\u00A0',
    '—', '“', '\0', '>', ';', '#', 'x', '9',
  ];
  it('holds for 500 generated runs', () => {
    const r = rng(42);
    for (let k = 0; k < 500; k++) {
      let raw = 'x';
      const len = 1 + Math.floor(r() * 12);
      for (let j = 0; j < len; j++) raw += pieces[Math.floor(r() * pieces.length)];
      raw += 'y';
      const { raw: got, value } = parse5Text(`<p>${raw}</p>`, 'p');
      expect(got).toBe(raw);
      const table = htmlTextTable(raw, value);
      expect(table, JSON.stringify(raw)).not.toBeNull();
      checkTable(raw, value, table!);
      // Rebuild the value from raw unit by unit through toRaw.
      let rebuilt = '';
      let prev = 0;
      for (let i = 1; i <= table!.length; i++) {
        if (!table!.isUnitBoundary(i)) continue;
        rebuilt += decodeHtmlText(raw.slice(table!.toRaw(prev), table!.toRaw(i)));
        prev = i;
      }
      expect(rebuilt).toBe(value);
    }
  });
});
