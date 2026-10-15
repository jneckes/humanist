import { describe, expect, it } from 'vitest';
import { parse } from 'acorn';
import {
  PLACEHOLDER,
  checkLiteralSplice,
  escapeJsText,
  escapeJsonText,
  escapeLiteralText,
  jsLiteralTable,
  type LiteralQuote,
} from '@blueline/core/js-literals';

/** Seeded PRNG (mulberry32) so property tests are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function acornValue(code: string, sourceType: 'script' | 'module' = 'script'): unknown {
  const ast = parse(code, { ecmaVersion: 'latest', sourceType });
  const stmt = ast.body[0];
  if (stmt.type !== 'ExpressionStatement') throw new Error('not an expression');
  const e = stmt.expression;
  if (e.type === 'Literal') return e.value;
  if (e.type === 'TemplateLiteral') return e.quasis.map((q) => q.value.cooked).join(PLACEHOLDER);
  throw new Error('unexpected ' + e.type);
}

function rawOffsets(raw: string, kind: 'string' | 'template' | 'json-string', quote: LiteralQuote) {
  const t = jsLiteralTable(raw, kind, quote);
  if (!t) throw new Error('null table');
  return { cooked: t.cooked, map: Array.from({ length: t.table.length + 1 }, (_, i) => t.table.toRaw(i)), table: t.table };
}

describe('jsLiteralTable: JS strings', () => {
  it('maps plain characters one to one and keeps a surrogate pair whole', () => {
    const r = rawOffsets('a😀b', 'string', "'");
    expect(r.cooked).toBe('a😀b');
    expect(r.map).toEqual([0, 1, 3, 3, 4]);
    expect(r.table.widen(2, 2)).toEqual({ start: 1, end: 3 });
    expect(rawOffsets('\\uD83D x', 'string', "'").map).toEqual([0, 6, 7, 8]); // a lone surrogate escape is fine
  });

  it('makes every escape one atomic unit', () => {
    // raw: a \n b \x41 \u0042 \u{43} \' \" \\ \` \q \0
    const raw = "a\\nb\\x41\\u0042\\u{43}\\'\\\"\\\\\\`\\q\\0";
    const r = rawOffsets(raw, 'string', "'");
    expect(r.cooked).toBe('a\nbABC\'"\\`q\0');
    expect(r.map).toEqual([0, 1, 3, 4, 8, 14, 20, 22, 24, 26, 28, 30, 32]);
    // A span that starts inside \x41 is widened to the whole escape.
    expect(r.table.widen(3, 4)).toEqual({ start: 3, end: 4 });
  });

  it('cooks \\u{1F600} to a surrogate pair that cannot be split', () => {
    const r = rawOffsets('x\\u{1F600}y', 'string', '"');
    expect(r.cooked).toBe('x😀y');
    expect(r.table.length).toBe(4);
    expect(r.table.toRaw(1)).toBe(1);
    expect(r.table.toRaw(3)).toBe(10);
    expect(r.table.widen(2, 2)).toEqual({ start: 1, end: 3 });
    expect(r.table.widen(2, 3)).toEqual({ start: 1, end: 3 });
  });

  it('keeps a backslash-escaped surrogate pair whole', () => {
    const r = rawOffsets('\\😀!', 'string', "'");
    expect(r.cooked).toBe('😀!');
    expect(r.table.widen(1, 1)).toEqual({ start: 0, end: 2 });
    expect(r.table.toRaw(2)).toBe(3);
  });

  it('drops line continuations (LF, CR, CRLF, U+2028, U+2029) and keeps them with the next character', () => {
    for (const lt of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
      const raw = `ab\\${lt}cd`;
      const r = rawOffsets(raw, 'string', "'");
      expect(r.cooked).toBe('abcd');
      expect(r.table.toRaw(2)).toBe(2);
      expect(r.table.toRaw(3)).toBe(4 + lt.length);
      expect(r.table.widen(2, 3)).toEqual({ start: 2, end: 3 });
      expect(r.table.toRaw(4)).toBe(raw.length);
      expect(acornValue(`'${raw}'`)).toBe('abcd');
    }
  });

  it('accepts a raw U+2028 inside a string (ES2019) but not a raw LF or CR', () => {
    expect(rawOffsets('a\u2028b', 'string', "'").cooked).toBe('a\u2028b');
    expect(jsLiteralTable('a\nb', 'string', "'")).toBeNull();
    expect(jsLiteralTable('a\rb', 'string', "'")).toBeNull();
  });

  it('reads legacy octal escapes as acorn does, and refuses them when asked to', () => {
    for (const [raw, cooked] of [
      ['\\101', 'A'],
      ['\\377', '\u00ff'],
      ['\\400', ' 0'],
      ['\\08', '\u00008'],
      ['\\8', '8'],
      ['\\9x', '9x'],
      ['\\7', '\u0007'],
      ['\\00', '\u0000'],
    ]) {
      expect(jsLiteralTable(raw, 'string', "'")?.cooked).toBe(cooked);
      expect(acornValue(`'${raw}'`)).toBe(cooked);
      expect(jsLiteralTable(raw, 'string', "'", { legacyOctal: false })).toBeNull();
    }
    expect(jsLiteralTable('\\0', 'string', "'", { legacyOctal: false })?.cooked).toBe('\0');
  });

  it('refuses invalid literals', () => {
    for (const raw of ["it's", 'a\\', '\\x4', '\\xZZ', '\\u12', '\\u{}', '\\u{110000}', '\\u{12', 'a\nb']) {
      expect(jsLiteralTable(raw, 'string', "'")).toBeNull();
    }
    expect(jsLiteralTable('say "hi"', 'string', '"')).toBeNull();
    expect(jsLiteralTable('say "hi"', 'string', "'")?.cooked).toBe('say "hi"');
    expect(jsLiteralTable('x', 'string', '`')).toBeNull();
  });
});

describe('jsLiteralTable: templates', () => {
  it('cooks CRLF and a lone CR to LF, CRLF as one unit', () => {
    const r = rawOffsets('a\r\nb\rc', 'template', '`');
    expect(r.cooked).toBe('a\nb\nc');
    expect(r.map).toEqual([0, 1, 3, 4, 5, 6]);
    expect(acornValue('`a\r\nb\rc`')).toBe('a\nb\nc');
  });

  it('treats each ${…} substitution as one atomic unit that cooks to U+E000', () => {
    const raw = 'Hi ${user.name}, ${ {a:1}.a } left';
    const placeholders = [
      { start: 3, end: 15 },
      { start: 17, end: 29 },
    ];
    const t = jsLiteralTable(raw, 'template', '`', { placeholders });
    expect(t?.cooked).toBe(`Hi ${PLACEHOLDER}, ${PLACEHOLDER} left`);
    const table = t!.table;
    expect(table.toRaw(3)).toBe(3);
    expect(table.toRaw(4)).toBe(15);
    expect(table.toRaw(6)).toBe(17);
    expect(table.toRaw(7)).toBe(29);
    expect(table.widen(3, 4)).toEqual({ start: 3, end: 4 });
  });

  it('refuses placeholder ranges that do not fit the raw text', () => {
    const raw = 'a${b}c';
    expect(jsLiteralTable(raw, 'template', '`')).toBeNull(); // `${` without a known substitution
    expect(jsLiteralTable(raw, 'template', '`', { placeholders: [{ start: 1, end: 4 }] })).toBeNull();
    expect(jsLiteralTable(raw, 'template', '`', { placeholders: [{ start: 0, end: 5 }] })).toBeNull();
    expect(jsLiteralTable('\\${b}', 'template', '`', { placeholders: [{ start: 1, end: 5 }] })).toBeNull();
    expect(jsLiteralTable(raw, 'template', '`', { placeholders: [{ start: 1, end: 5 }] })?.cooked).toBe(`a${PLACEHOLDER}c`);
    expect(jsLiteralTable('abc', 'string', "'", { placeholders: [{ start: 0, end: 1 }] })).toBeNull();
  });

  it('accepts \\0, \\x, \\u{} and escaped ${ and backticks, and refuses octal-like escapes', () => {
    expect(jsLiteralTable('\\0\\x41\\u{1F600}\\${x}\\`', 'template', '`')?.cooked).toBe('\0A😀${x}`');
    for (const raw of ['\\01', '\\1', '\\8', '\\9', 'a`b', '\\u{110000}']) {
      expect(jsLiteralTable(raw, 'template', '`')).toBeNull();
    }
  });

  it('keeps a line continuation in a template atomic', () => {
    const r = rawOffsets('a\\\r\nb', 'template', '`');
    expect(r.cooked).toBe('ab');
    expect(r.map).toEqual([0, 1, 5]);
  });
});

describe('jsLiteralTable: JSON strings', () => {
  it('accepts exactly the JSON escapes', () => {
    const r = rawOffsets('\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9\\uD83D\\uDE00\'', 'json-string', '"');
    expect(r.cooked).toBe('"\\/\b\f\n\r\té😀\'');
    expect(r.map).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 22, 28, 34, 35]);
  });

  it('refuses JS-only escapes, raw control characters and a raw quote', () => {
    for (const raw of ["\\'", '\\v', '\\x41', '\\u{41}', '\\0', 'a\nb', 'a\tb', 'a"b', '\\', '\\u12']) {
      expect(jsLiteralTable(raw, 'json-string', '"')).toBeNull();
    }
    expect(jsLiteralTable('x', 'json-string', "'")).toBeNull();
  });
});

describe('jsLiteralTable agrees with the parsers it stands in for', () => {
  const pieces = [
    'a', 'Z', ' ', 'é', '😀', '\u2028', '\\n', '\\r', '\\t', '\\b', '\\f', '\\v', '\\0', '\\01', '\\08', '\\1',
    '\\377', '\\400', '\\8', '\\x41', '\\x4', '\\u0041', '\\u004', '\\u{1F600}', '\\u{}', '\\u{110000}', '\\\n',
    '\\\r\n', '\\\r', '\\\u2028', "\\'", '\\"', '\\\\', '\\`', '\\$', '\\q', "'", '"', '`', '$', '{', '}', '${',
    '\r\n', '\r', '\n', '\\/', '\\u00e9', '\t', '<', '/',
  ];
  const rand = rng(20261015);
  const sample = (): string => {
    let s = '';
    const n = Math.floor(rand() * 7);
    for (let k = 0; k < n; k++) s += pieces[Math.floor(rand() * pieces.length)];
    return s;
  };

  it('JS strings (both quotes, sloppy script)', () => {
    for (let k = 0; k < 3000; k++) {
      const raw = sample();
      for (const q of ["'", '"'] as const) {
        let expected: unknown = null;
        try {
          expected = acornValue(`${q}${raw}${q}`);
        } catch {
          expected = null;
        }
        // A raw quote can make acorn see a different program (e.g. '' + ''), not a single literal.
        if (expected !== null && typeof expected !== 'string') continue;
        let single = true;
        try {
          const ast = parse(`${q}${raw}${q}`, { ecmaVersion: 'latest' });
          const st = ast.body[0];
          single = ast.body.length === 1 && st.type === 'ExpressionStatement' && st.expression.type === 'Literal';
        } catch {
          single = true;
        }
        if (!single) continue;
        expect(jsLiteralTable(raw, 'string', q)?.cooked ?? null, JSON.stringify(raw)).toBe(expected);
      }
    }
  });

  it('JS strings in strict code (legacyOctal: false) agree with a module parse', () => {
    for (let k = 0; k < 2000; k++) {
      const raw = sample();
      let expected: unknown = null;
      try {
        const ast = parse(`'${raw}'`, { ecmaVersion: 'latest', sourceType: 'module' });
        const st = ast.body[0];
        if (ast.body.length !== 1 || st.type !== 'ExpressionStatement' || st.expression.type !== 'Literal') continue;
        expected = st.expression.value;
      } catch {
        expected = null;
      }
      expect(jsLiteralTable(raw, 'string', "'", { legacyOctal: false })?.cooked ?? null, JSON.stringify(raw)).toBe(expected);
    }
  });

  it('templates without substitutions', () => {
    for (let k = 0; k < 3000; k++) {
      const raw = sample();
      let expected: unknown = null;
      try {
        const ast = parse('`' + raw + '`', { ecmaVersion: 'latest' });
        const st = ast.body[0];
        if (ast.body.length !== 1 || st.type !== 'ExpressionStatement' || st.expression.type !== 'TemplateLiteral') continue;
        if (st.expression.quasis.length !== 1) continue; // has a substitution: covered elsewhere
        expected = st.expression.quasis[0].value.cooked;
      } catch {
        expected = null;
      }
      expect(jsLiteralTable(raw, 'template', '`')?.cooked ?? null, JSON.stringify(raw)).toBe(expected);
    }
  });

  it('JSON strings', () => {
    for (let k = 0; k < 3000; k++) {
      const raw = sample();
      let expected: unknown = null;
      try {
        expected = JSON.parse('"' + raw + '"');
      } catch {
        expected = null;
      }
      expect(jsLiteralTable(raw, 'json-string', '"')?.cooked ?? null, JSON.stringify(raw)).toBe(expected);
    }
  });
});

describe('escapeJsText (9.2 Strategy 2 step 5.2)', () => {
  it('escapes in the spec order', () => {
    expect(escapeJsText('a\\b', "'", 'string')).toBe('a\\\\b');
    expect(escapeJsText(`it's "x"`, "'", 'string')).toBe(`it\\'s "x"`);
    expect(escapeJsText(`it's "x"`, '"', 'string')).toBe(`it's \\"x\\"`);
    expect(escapeJsText('a`b ${c} $d {e}', '`', 'template')).toBe('a\\`b \\${c} $d {e}');
    expect(escapeJsText('${c}', "'", 'string')).toBe('${c}');
    // A backslash before ${ is doubled first, then ${ is escaped: cooks back to \${.
    expect(escapeJsText('\\${', '`', 'template')).toBe('\\\\\\${');
    expect(escapeJsText('a\nb\rc\td\u0000e\u001ff\u000b', "'", 'string')).toBe('a\\nb\\rc\\td\\u0000e\\u001Ff\\u000B');
    expect(escapeJsText('a\u2028b\u2029c', "'", 'string')).toBe('a\\u2028b\\u2029c');
    expect(escapeJsText('</script><SCRIPT><!-- </ScRiPt', "'", 'string')).toBe(
      '\\x3C/script>\\x3CSCRIPT>\\x3C!-- \\x3C/ScRiPt',
    );
    expect(escapeJsText('</scrip <!- < /script <b>', '`', 'template')).toBe('</scrip <!- < /script <b>');
    expect(escapeLiteralText('<!--', 'template', '`')).toBe('\\x3C!--');
  });

  it('rejects a quote that does not fit the kind', () => {
    expect(() => escapeJsText('x', '`', 'string')).toThrow();
    expect(() => escapeJsText('x', "'", 'template')).toThrow();
  });

  it('produces literals that end no script and parse back to the text (acorn)', () => {
    const text = 'a\\\'"`${x}\n\r\t\u0000\u2028</script><!--<script>é😀';
    for (const [q, kind] of [
      ["'", 'string'],
      ['"', 'string'],
      ['`', 'template'],
    ] as const) {
      const lit = escapeJsText(text, q, kind);
      expect(/<\/script|<script|<!--/i.test(lit)).toBe(false);
      expect(/[\n\r\u2028\u2029]/.test(lit)).toBe(false);
      expect(acornValue(q + lit + q)).toBe(text);
      expect(acornValue(q + lit + q, 'module')).toBe(text);
    }
  });
});

describe('escapeJsonText (9.2 Strategy 2 step 5.3)', () => {
  it('uses JSON rules', () => {
    expect(escapeJsonText(`it's "x" \\`)).toBe(`it's \\"x\\" \\\\`);
    expect(escapeJsonText('a\nb\tc\u0001')).toBe('a\\u000Ab\\u0009c\\u0001');
    expect(escapeJsonText('</script><!--<SCRIPT')).toBe('\\u003C/script>\\u003C!--\\u003CSCRIPT');
    expect(escapeJsonText('a\u2028b')).toBe('a\u2028b');
    expect(escapeLiteralText('"', 'json-string', '"')).toBe('\\"');
    const text = 'x\'"\\\n</script><!--😀\u0000';
    expect(JSON.parse('"' + escapeJsonText(text) + '"')).toBe(text);
  });
});

describe('round trip: jsLiteralTable(escape(s)) cooks back to s', () => {
  const alphabet = [
    'a', 'b', ' ', '\\', "'", '"', '`', '$', '{', '}', '<', '/', '!', '-', 's', 'c', 'r', 'i', 'p', 't', 'S', 'C',
    'R', 'I', 'P', 'T', '\n', '\r', '\t', '\u0000', '\u0001', '\u001f', '\u2028', '\u2029', 'é', '😀', '\u00a0',
    '\u200b', '\ufeff', PLACEHOLDER, '0', '7', '8', 'x', 'u',
  ];
  const rand = rng(42);
  const randomText = (): string => {
    let s = '';
    const n = Math.floor(rand() * 24);
    for (let k = 0; k < n; k++) s += alphabet[Math.floor(rand() * alphabet.length)];
    // Splice in the dangerous sequences often.
    if (rand() < 0.3) s += ['</script', '<SCRIPT', '<!--', '${', '\\${', '</ScRiPt>'][Math.floor(rand() * 6)];
    return s;
  };

  it('holds for every quote and kind', () => {
    for (let k = 0; k < 4000; k++) {
      const s = randomText();
      for (const [q, kind] of [
        ["'", 'string'],
        ['"', 'string'],
        ['`', 'template'],
      ] as const) {
        const raw = escapeJsText(s, q, kind);
        const t = jsLiteralTable(raw, kind, q, { legacyOctal: false });
        expect(t?.cooked, JSON.stringify({ s, q })).toBe(s);
        expect(/<\/script|<script|<!--/i.test(raw)).toBe(false);
        expect(acornValue(q + raw + q, 'module')).toBe(s);
      }
      const json = escapeJsonText(s);
      expect(jsLiteralTable(json, 'json-string', '"')?.cooked).toBe(s);
      expect(JSON.parse('"' + json + '"')).toBe(s);
      expect(/<\/script|<script|<!--/i.test(json)).toBe(false);
    }
  });
});

describe('checkLiteralSplice', () => {
  it('accepts an ordinary escaped insertion', () => {
    const raw = 'Hello world';
    const ins = escapeJsText("big 'new'", "'", 'string');
    expect(checkLiteralSplice(raw, 6, 6, ins, 'string', "'", "Hello big 'new'world")).toBe(true);
  });

  it('catches a digit typed after \\0 (it would become a legacy octal escape)', () => {
    const raw = 'a\\0';
    expect(checkLiteralSplice(raw, 3, 3, '5', 'string', "'", 'a\u00005')).toBe(false);
    // Re-encoding the NUL with the insertion (widened span) is fine.
    expect(checkLiteralSplice(raw, 1, 3, escapeJsText('\u00005', "'", 'string'), 'string', "'", 'a\u00005')).toBe(true);
  });

  it('catches ${ formed across the edge of a template splice', () => {
    expect(checkLiteralSplice('cost $', 6, 6, escapeJsText('{x}', '`', 'template'), 'template', '`', 'cost ${x}')).toBe(false);
  });

  it('catches </script and <!-- formed across either edge', () => {
    // Existing raw "<" followed by inserted "/script".
    expect(checkLiteralSplice('a <', 3, 3, '/script>', 'string', "'", 'a </script>')).toBe(false);
    expect(checkLiteralSplice('<!-x-', 3, 4, '', 'string', "'", '<!--')).toBe(false);
    expect(checkLiteralSplice('-- tail', 0, 0, 'a <!', 'string', "'", 'a <!-- tail')).toBe(false);
    // A pre-existing sequence away from the splice is not the splice's doing.
    expect(checkLiteralSplice('<!-- c --> x', 12, 12, 'y', 'string', "'", '<!-- c --> xy')).toBe(true);
  });

  it('refuses a splice that cuts into a substitution and shifts later ones', () => {
    const raw = 'a${b}c${d}';
    const placeholders = [
      { start: 1, end: 5 },
      { start: 6, end: 10 },
    ];
    expect(checkLiteralSplice(raw, 2, 3, 'x', 'template', '`', 'never', { placeholders })).toBe(false);
    expect(
      checkLiteralSplice(raw, 5, 6, 'CC', 'template', '`', `a${PLACEHOLDER}CC${PLACEHOLDER}`, { placeholders }),
    ).toBe(true);
    expect(checkLiteralSplice(raw, 0, 1, 'AAA', 'template', '`', `AAA${PLACEHOLDER}c${PLACEHOLDER}`, { placeholders })).toBe(
      true,
    );
  });
});
