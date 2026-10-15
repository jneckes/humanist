import { describe, expect, it } from 'vitest';
import { parse } from 'acorn';
import { extractLiterals, literalRunMapping, scanJsonLiterals } from '@blueline/core/mapper-literals';
import { checkLiteralSplice, escapeJsText, escapeJsonText, PLACEHOLDER } from '@blueline/core/js-literals';
import { decodeHtmlText } from '@blueline/core/html-tables';
import type { OffsetTable } from '@blueline/core/offset-table';
import { LineIndex } from '@blueline/core/text';
import type { LiteralRun, LiteralUnit, ScriptInfo } from '@blueline/core/types';

const PH = PLACEHOLDER;

/** Test-only script finder (the real one is the Strategy 1 walk). */
function findScripts(src: string): ScriptInfo[] {
  const out: ScriptInfo[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const m of src.matchAll(re)) {
    const attrs = m[1];
    const type = (/\btype\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? '').toLowerCase();
    const contentStart = m.index + m[0].indexOf('>') + 1;
    const kind: ScriptInfo['kind'] =
      type === '' || type === 'text/javascript'
        ? 'classic'
        : type === 'module'
          ? 'module'
          : type === 'application/json'
            ? 'json'
            : 'other';
    out.push({
      index: out.length,
      start: m.index,
      end: m.index + m[0].length,
      contentStart,
      contentEnd: contentStart + m[2].length,
      type,
      hasSrc: /\bsrc\s*=/.test(attrs),
      kind,
      parsed: true,
    });
  }
  return out;
}

function extract(src: string) {
  return extractLiterals(src, findScripts(src), new LineIndex(src));
}

/** Every run's raw range holds its value, as far as a plain-text run can show it. */
function rawOf(src: string, r: { start: number; end: number }): string {
  return src.slice(r.start, r.end);
}

function runsOf(literals: LiteralRun[], unit: number): LiteralRun[] {
  return literals.filter((r) => r.unit === unit);
}

describe('extractLiterals: JS string literals', () => {
  it('makes each string literal a unit and run with raw range, line and column', () => {
    const src = `<p>x</p>\n<script>\nconst a = 'Hello';\n  const b = "World";\n</script>`;
    const { units, literals, scripts } = extract(src);
    expect(scripts[0].parsed).toBe(true);
    expect(units.map((u) => [u.kind, u.quote, u.cooked, u.html, u.aligned, u.scriptIndex])).toEqual([
      ['string', "'", 'Hello', false, true, 0],
      ['string', '"', 'World', false, true, 0],
    ]);
    expect(rawOf(src, units[0])).toBe('Hello');
    expect(literals.map((r) => [r.id, r.strategy, r.value, rawOf(src, r), r.line, r.col, r.placeholder, r.aligned])).toEqual([
      ['l:0:0', 'script-literal', 'Hello', 'Hello', 3, 12, false, true],
      ['l:1:0', 'script-literal', 'World', 'World', 4, 14, false, true],
    ]);
  });

  it('cooks escapes and keeps the raw range of the whole content', () => {
    const src = `<script>x = 'Caf\\u00e9 \\'quoted\\' \\x41\\
B';</script>`;
    const { units, literals } = extract(src);
    expect(units[0].cooked).toBe("Café 'quoted' AB");
    expect(units[0].aligned).toBe(true);
    expect(rawOf(src, literals[0])).toBe("Caf\\u00e9 \\'quoted\\' \\x41\\\nB");
    const m = literalRunMapping(src, units[0], 0)!;
    // 'é' starts at the escape, and 'B' after the line continuation is with its own unit.
    expect(m.rawStart + m.table.toRaw(3)).toBe(units[0].start + 3);
    expect(m.rawStart + m.table.toRaw(4)).toBe(units[0].start + 9);
  });

  it('includes string keys, class member names and destructuring keys; excludes directives and module specifiers', () => {
    const src =
      `<script>'use strict'; const o = {'Revenue': 1, "m"() {}, plain: 'v'}; class C { 'field' = 'init' }` +
      ` const {'a b': c} = o; f('use strict');</script>` +
      `<script type="module">import x from './x.js'; export * from "./y.js"; export { z } from './z.js';` +
      ` import j from './j.json' with { type: 'json' }; const d = import('./d.js'); await 0; export const t = 'Module text';</script>`;
    const { units, scripts } = extract(src);
    expect(scripts.map((s) => s.parsed)).toEqual([true, true]);
    expect(units.map((u) => u.cooked)).toEqual(['Revenue', 'm', 'v', 'field', 'init', 'a b', 'use strict', 'Module text']);
  });

  it('walks modern syntax without refusing the script', () => {
    const classic = [
      '#!/usr/bin/env node',
      'label: for (const x of [1n, 0b1, 1_000]) { break label; }',
      "class A { #p = 'priv'; static { this.s = 'static'; } get [`k`]() { return this?.#p ?? 'nn'; } static async *g() { yield* ['y']; } }",
      "let o = { ...{ a: 'spread' }, b: /re/v, c: a ||= 'or', d: 2 ** 3, async *m() { for await (const z of 'w') {} } };",
      "function f(a = 'def', { b = 'pat', ...rest } = {}, [c = 'arr'] = []) { return new.target ?? 'nt'; }",
      "x?.y?.['opt']?.('call'); ({ 'k1': v1, ['k' + 'c']: v2 } = obj);",
      "switch (q) { case 'case': break; default: } try { throw 'err' } catch { } finally { }",
      "with (o) { 'sloppy'; }",
    ].join('\n');
    const module = [
      "import def, * as ns from './m.js'; import { \"str name\" as alias } from './n.js' with { type: 'json' };",
      "export { alias as \"exported name\" }; export default class { m() { return import.meta.url + 'meta'; } }",
      "await import('./dyn.js'); using r = null; await using r2 = null;",
      "const t = tag`x${'in tag'}y`; export const z = `tmpl ${1}`;",
    ].join('\n');
    const { units, scripts } = extract(`<script>${classic}</script><script type="module">${module}</script>`);
    expect(scripts.map((s) => s.parsed)).toEqual([true, true]);
    expect(units.map((u) => u.cooked)).toEqual([
      'priv', 'static', 'k', 'nn', 'y', 'spread', 'or', 'w', 'def', 'pat', 'arr', 'nt', 'opt', 'call', 'k1', 'k', 'c',
      'case', 'err', 'sloppy', 'meta', 'in tag', `tmpl ${PH}`,
    ]);
  });

  it('marks a script that fails to parse and takes nothing from it', () => {
    const src = `<script>const a = 'kept';</script><script>const = 'lost';</script><script>await x; 'lost too'</script>`;
    const { units, scripts } = extract(src);
    expect(scripts.map((s) => s.parsed)).toEqual([true, false, false]);
    expect(units.map((u) => u.cooked)).toEqual(['kept']);
  });

  it('uses sourceType module for type=module and leaves src and data scripts alone', () => {
    const src =
      `<script type="module">await 0; const m = 'mod';</script>` +
      `<script src="x.js">const ignored = 'inline';</script>` +
      `<script type="text/template">'not js'</script>`;
    const input = findScripts(src);
    input[2].parsed = false;
    const { units, scripts } = extractLiterals(src, input, new LineIndex(src));
    expect(units.map((u) => u.cooked)).toEqual(['mod']);
    expect(scripts[0].parsed).toBe(true);
    expect(scripts[1]).toEqual(input[1]);
    expect(scripts[2]).toEqual(input[2]);
    expect(scripts[1]).not.toBe(input[1]); // copies, never the caller's objects
  });

  it('drops whitespace-only and empty runs but keeps their units', () => {
    const { units, literals } = extract(`<script>a = ''; b = ' '; c = '\\n'; d = 'x';</script>`);
    expect(units).toHaveLength(4);
    expect(literals.map((r) => r.value)).toEqual(['x']);
    expect(literals[0].id).toBe('l:3:0');
  });

  it('parses the raw slice, so CRLF files keep raw offsets', () => {
    const src = '<script>\r\nconst a = `one\r\ntwo`;\r\nconst b = \'three\';\r\n</script>';
    const { units, literals } = extract(src);
    expect(units[0].cooked).toBe('one\ntwo');
    expect(units[0].aligned).toBe(true);
    expect(rawOf(src, literals[0])).toBe('one\r\ntwo');
    expect(literals[1]).toMatchObject({ value: 'three', line: 4, col: 12 });
    expect(rawOf(src, literals[1])).toBe('three');
  });

  it('handles astral characters and U+2028 inside strings', () => {
    const src = `<script>a = '😀 \u2028 x'; b = '\\u{1F600}!';</script>`;
    const { units, literals } = extract(src);
    expect(units.map((u) => u.cooked)).toEqual(['😀 \u2028 x', '😀!']);
    expect(literals.every((r) => r.aligned)).toBe(true);
    const m = literalRunMapping(src, units[1], 0)!;
    expect(m.table.widen(1, 1)).toEqual({ start: 0, end: 2 });
    expect(m.table.toRaw(2)).toBe('\\u{1F600}'.length);
  });
});

describe('extractLiterals: template literals', () => {
  it('joins quasis with U+E000 and records each ${…} as an atomic placeholder', () => {
    const src = '<script>const s = `Hello ${user.name}, ${n} new`;</script>';
    const { units, literals } = extract(src);
    const u = units[0];
    expect(u.kind).toBe('template');
    expect(u.quote).toBe('`');
    expect(u.cooked).toBe(`Hello ${PH}, ${PH} new`);
    expect(u.placeholders!.map((p) => src.slice(p.start, p.end))).toEqual(['${user.name}', '${n}']);
    expect(literals[0]).toMatchObject({ value: `Hello ${PH}, ${PH} new`, placeholder: true, aligned: true });
    const m = literalRunMapping(src, u, 0)!;
    expect(m.table.widen(6, 7)).toEqual({ start: 6, end: 7 });
    expect(src.slice(m.rawStart + m.table.toRaw(6), m.rawStart + m.table.toRaw(7))).toBe('${user.name}');
  });

  it('excludes tagged templates (String.raw included) but not literals inside their substitutions', () => {
    const src = '<script>a = html`<b>x</b>`; b = String.raw`a\\nb`; c = tag`t ${"inner"} u`; d = `plain`;</script>';
    const { units } = extract(src);
    expect(units.map((u) => u.cooked)).toEqual(['inner', 'plain']);
  });

  it('nests literals inside substitutions in source order', () => {
    const src = "<script>x = `a ${ cond ? 'yes' : `no ${'deep'}` } b`;</script>";
    const { units, literals } = extract(src);
    expect(units.map((u) => u.cooked)).toEqual([`a ${PH} b`, 'yes', `no ${PH}`, 'deep']);
    expect(units.map((u) => u.index)).toEqual([0, 1, 2, 3]);
    expect(literals.map((r) => r.unit)).toEqual([0, 1, 2, 3]);
  });
});

describe('extractLiterals: HTML literals', () => {
  it('takes the text nodes of a literal that contains < as runs', () => {
    const src = `<script>el.innerHTML = '<h2 class="t">Revenue &amp; costs</h2><p>Grew <b>40%</b> in Q3</p>';</script>`;
    const { units, literals } = extract(src);
    expect(units[0].html).toBe(true);
    expect(literals.map((r) => [r.id, r.value, rawOf(src, r), r.html, r.aligned])).toEqual([
      ['l:0:0', 'Revenue & costs', 'Revenue &amp; costs', true, true],
      ['l:0:1', 'Grew ', 'Grew ', true, true],
      ['l:0:2', '40%', '40%', true, true],
      ['l:0:3', ' in Q3', ' in Q3', true, true],
    ]);
    // The run table keeps the character reference atomic and maps through to src.
    const m = literalRunMapping(src, units[0], 0)!;
    expect(m.table.widen(8, 9)).toEqual({ start: 8, end: 9 });
    expect(m.rawStart + m.table.toRaw(8)).toBe(src.indexOf('&amp;'));
    expect(m.rawStart + m.table.toRaw(9)).toBe(src.indexOf('&amp;') + 5);
  });

  it('maps HTML runs through JS escapes too', () => {
    const src = `<script>x = "<p>Price: \\u20AC5 \\x3Cnow\\x3E</p>";</script>`;
    const { units, literals } = extract(src);
    expect(units[0].cooked).toBe('<p>Price: €5 <now></p>');
    // "<now>" is an element in the fragment, so the run ends before it.
    expect(literals.map((r) => r.value)).toEqual(['Price: €5 ']);
    expect(rawOf(src, literals[0])).toBe('Price: \\u20AC5 ');
    const m = literalRunMapping(src, units[0], 0)!;
    expect(src.slice(m.rawStart + m.table.toRaw(7), m.rawStart + m.table.toRaw(8))).toBe('\\u20AC');
  });

  it('marks text nodes with a substitution as placeholders and leaves the others editable', () => {
    const src = '<script>list.innerHTML = `<li>${item}</li><li class="${cls}">Fixed text</li>`;</script>';
    const { literals } = extract(src);
    expect(literals.map((r) => [r.value, r.placeholder, r.aligned])).toEqual([
      [PH, true, true],
      ['Fixed text', false, true],
    ]);
    expect(rawOf(src, literals[0])).toBe('${item}');
    expect(rawOf(src, literals[1])).toBe('Fixed text');
  });

  it('skips script and style text but keeps text a script may still show (template content, textarea)', () => {
    const src =
      "<script>x = '<style>.a{}</style><p>Shown</p><script>hid()<\\/script><template><b>T</b></template>" +
      "<textarea>A</textarea><svg><text>Label</text><style>s{}</style></svg>';</script>";
    const { literals } = extract(src);
    expect(literals.map((r) => [r.value, r.aligned])).toEqual([
      ['Shown', true],
      ['T', true],
      ['A', true],
      ['Label', true],
    ]);
    expect(literals.map((r) => rawOf(src, r))).toEqual(['Shown', 'T', 'A', 'Label']);
  });

  it('follows parse5 for the newline after <pre> and for NUL in foreign content', () => {
    const src = "<script>x = '<pre>\\nline</pre><svg><text>a\\0b</text></svg><p>c\\0d</p>';</script>";
    const { units, literals } = extract(src);
    expect(units[0].cooked).toBe('<pre>\nline</pre><svg><text>a\u0000b</text></svg><p>c\u0000d</p>');
    expect(literals.map((r) => [r.value, r.aligned])).toEqual([
      ['line', true],
      ['a\uFFFDb', true],
      ['cd', true],
    ]);
    const m = literalRunMapping(src, units[0], 0)!;
    expect(src.slice(m.rawStart + m.table.toRaw(0), m.rawStart + m.table.toRaw(4))).toBe('line');
    expect(m.textOpts).toEqual({ dropLeadingNewline: true });
    expect(literalRunMapping(src, units[0], 1)!.textOpts).toEqual({ nul: 'replace' });
    const c = literalRunMapping(src, units[0], 2)!;
    expect(src.slice(c.rawStart + c.table.toRaw(1), c.rawStart + c.table.toRaw(2))).toBe('\\0d');
  });

  it('keeps a run whose text table fails, unaligned, with the smallest raw range that covers it', () => {
    // parse5 merges "x" and "y" around the stray end tag into one text node.
    const src = "<script>x = '<p>x</span>y</p>';</script>";
    const { units, literals } = extract(src);
    expect(units[0].aligned).toBe(true);
    expect(literals).toHaveLength(1);
    expect(literals[0]).toMatchObject({ value: 'xy', aligned: false });
    expect(rawOf(src, literals[0])).toBe('x</span>y');
    expect(literalRunMapping(src, units[0], 0)).toBeNull();
  });

  it('adds an unaligned shadow run for a literal with references but no <, as innerHTML would show it', () => {
    const src = "<script>a = 'Q&amp;A'; b = 'Fish & Chips'; c = 'R\\u0026amp;D';</script>";
    const { units, literals } = extract(src);
    expect(units.map((u) => [u.cooked, u.html])).toEqual([
      ['Q&amp;A', false],
      ['Fish & Chips', false],
      ['R&amp;D', false],
    ]);
    expect(literals.map((r) => [r.id, r.value, r.html, r.aligned])).toEqual([
      ['l:0:0', 'Q&amp;A', false, true],
      ['l:0:1', 'Q&A', true, false],
      ['l:1:0', 'Fish & Chips', false, true],
      ['l:2:0', 'R&amp;D', false, true],
      ['l:2:1', 'R&D', true, false],
    ]);
    expect(rawOf(src, literals[1])).toBe('Q&amp;A');
    expect(literalRunMapping(src, units[0], 1)).toBeNull();
    expect(literalRunMapping(src, units[0], 0)).not.toBeNull();
  });

  it('treats a literal with only a stray < as HTML text', () => {
    const { literals } = extract("<script>x = 'a < b';</script>");
    expect(literals.map((r) => [r.value, r.html])).toEqual([['a < b', true]]);
  });
});

describe('extractLiterals: random HTML literals map consistently', () => {
  const pieces = [
    'a', 'B c', ' ', '<p>', '</p>', '<b>', '</b>', '<br>', '<table>', '<tr>', '<td>', '</td>', '</table>', '<pre>',
    '\\n', '\\r\\n', '&amp;', '&eacute;', '&copy', '&#x1F600;', '&#128;', '&', '&lt;', '<!-- c -->', '<svg><text>',
    '</text></svg>', '\\u00e9', '\\x3C', '\\x3Cb>', '😀', '\\0', '<template>', '</template>', '<select><option>', '\\\'',
    '"', '${x}', '<textarea>', '</textarea>', '<li>', '</span>', '\\t',
  ];
  let seed = 99;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;

  it('every aligned run maps back to its own text through both layers', () => {
    let checked = 0;
    for (let k = 0; k < 1500; k++) {
      let body = '<i>';
      for (let n = Math.floor(rand() * 10); n > 0; n--) body += pieces[Math.floor(rand() * pieces.length)];
      const src = `<script>x = \`${body}\`;</script>`;
      const { units, literals, scripts } = extract(src);
      if (!scripts[0].parsed) continue;
      for (const u of units) {
        for (const r of literals.filter((l) => l.unit === u.index)) {
          expect(src.slice(r.start, r.end).length).toBeGreaterThanOrEqual(0);
          if (!r.aligned) continue;
          const m = literalRunMapping(src, u, r.runIndex)!;
          expect(m, JSON.stringify(body)).not.toBeNull();
          // The run's raw range cooks to its cooked slice, which decodes to the run's text.
          const cookedSlice = u.cooked.slice(m.toCooked(0), m.toCooked(r.value.length));
          if (u.html) expect(decodeHtmlText(cookedSlice, m.textOpts ?? {}), JSON.stringify(body)).toBe(r.value);
          else expect(cookedSlice).toBe(r.value);
          // Every unit boundary of the run maps inside the run's raw range, in order.
          let prev = -1;
          for (let i = 0; i <= r.value.length; i++) {
            const w = m.table.widen(i, i);
            if (w.start !== i) continue;
            const at = m.rawStart + m.table.toRaw(i);
            expect(at).toBeGreaterThanOrEqual(Math.max(prev, r.start));
            expect(at).toBeLessThanOrEqual(r.end);
            prev = at;
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe('extractLiterals: JSON blocks', () => {
  it('makes each string value (not key) a json-string unit with exact positions', () => {
    const src =
      '<script type="application/json">\n{"title": "Hello", "items": ["A", "B <b>bold</b>"], "n": -1.5e3,\n' +
      ' "ok": true, "nil": null, "nested": {"k": "v\\u00e9\\n"}, "e": [], "o": {}}\n</script>';
    const { units, literals, scripts } = extract(src);
    expect(scripts[0].parsed).toBe(true);
    expect(units.map((u) => [u.kind, u.quote, u.cooked, u.html, u.aligned])).toEqual([
      ['json-string', '"', 'Hello', false, true],
      ['json-string', '"', 'A', false, true],
      ['json-string', '"', 'B <b>bold</b>', true, true],
      ['json-string', '"', 'vé\n', false, true],
    ]);
    expect(units.map((u) => rawOf(src, u))).toEqual(['Hello', 'A', 'B <b>bold</b>', 'v\\u00e9\\n']);
    expect(literals.map((r) => [r.strategy, r.value, r.line])).toEqual([
      ['json-literal', 'Hello', 2],
      ['json-literal', 'A', 2],
      ['json-literal', 'B ', 2],
      ['json-literal', 'bold', 2],
      ['json-literal', 'vé\n', 3],
    ]);
  });

  it('refuses invalid JSON', () => {
    for (const body of [
      '{"a": 1,}',
      "{'a': 1}",
      '{"a": 1} // c',
      '[NaN]',
      '\uFEFF{"a": "b"}',
      '{"a" "b"}',
      '["a\tb"]',
      '',
      '{"a": "b"} {"c": "d"}',
      '[01]',
      '["\\x41"]',
      '{"a": [1, 2}',
      '[1, 2]]',
    ]) {
      expect(scanJsonLiterals(body), JSON.stringify(body)).toBeNull();
      const src = `<script type="application/json">${body}</script>`;
      const { units, scripts } = extract(src);
      expect(scripts[0].parsed).toBe(false);
      expect(units).toHaveLength(0);
    }
  });

  it('accepts what JSON.parse accepts', () => {
    for (const body of ['"top"', ' 1 ', 'null', '[[], {}, [{"a": ["b"]}]]', '\r\n\t{"\\"k\\"": "\\"v\\" \\/"}\n']) {
      expect(scanJsonLiterals(body), body).not.toBeNull();
    }
    expect(scanJsonLiterals('[{"a": ["b"]}, "c"]')!.map((u) => u.cooked)).toEqual(['b', 'c']);
    expect(scanJsonLiterals('"top"')!.map((u) => [u.start, u.end])).toEqual([[1, 4]]);
  });

  it('survives very deep nesting without exhausting the stack', () => {
    const depth = 100000;
    const body = '['.repeat(depth) + '"x"' + ']'.repeat(depth);
    const r = scanJsonLiterals(body);
    // Either JSON.parse accepts it (one unit) or it is refused; it must not throw.
    if (r !== null) expect(r.map((u) => u.cooked)).toEqual(['x']);
    const js = `<script>x = ${'['.repeat(20000)}'y'${']'.repeat(20000)};</script>`;
    expect(() => extract(js)).not.toThrow();
  });
});

describe('literalRunMapping and the escapers together (patcher path)', () => {
  /** Simulates the patcher: replace run text [s, e) with `text`; null when the splice check refuses it. */
  function edit(src: string, unit: LiteralUnit, runIndex: number, s: number, e: number, text: string): string | null {
    const m = literalRunMapping(src, unit, runIndex);
    if (!m) return null;
    const value = extract(src).literals.find((r) => r.unit === unit.index && r.runIndex === runIndex)!.value;
    // 9.2 Strategy 2 step 4: widen to whole units and re-encode the characters they hold.
    const w = m.table.widen(s, e);
    const replacement = value.slice(w.start, s) + text + value.slice(e, w.end);
    const encoded = unit.html ? replacement.replace(/&/g, '&amp;').replace(/</g, '&lt;') : replacement; // step 5.1
    const escaped = unit.kind === 'json-string' ? escapeJsonText(encoded) : escapeJsText(encoded, unit.quote, unit.kind);
    const rs = m.rawStart + m.table.toRaw(w.start) - unit.start;
    const re = m.rawStart + m.table.toRaw(w.end) - unit.start;
    const raw = src.slice(unit.start, unit.end);
    const expectedCooked = unit.cooked.slice(0, m.toCooked(w.start)) + encoded + unit.cooked.slice(m.toCooked(w.end));
    // toCooked agrees with the unit table at unit boundaries.
    expect(m.toCooked(w.start)).toBe(cookedAt(m.unitTable, rs));
    expect(m.toCooked(w.end)).toBe(cookedAt(m.unitTable, re));
    const placeholders = unit.placeholders?.map((p) => ({ start: p.start - unit.start, end: p.end - unit.start }));
    if (!checkLiteralSplice(raw, rs, re, escaped, unit.kind, unit.quote, expectedCooked, { placeholders })) return null;
    if (unit.html) {
      // The HTML layer: the run's new cooked slice must decode to the new run text (an `&` before new
      // letters could otherwise form a reference), as planHtmlTextEdit checks for Strategy 1.
      const slice = expectedCooked.slice(m.cookedStart, m.cookedEnd + (encoded.length - (m.toCooked(w.end) - m.toCooked(w.start))));
      const newValue = value.slice(0, w.start) + replacement + value.slice(w.end);
      if (decodeHtmlText(slice, m.textOpts ?? {}) !== newValue) return null;
    }
    return src.slice(0, unit.start + rs) + escaped + src.slice(unit.start + re);
  }
  /** The cooked unit boundary at raw offset rawRel (relative to the unit). */
  function cookedAt(t: OffsetTable, rawRel: number): number {
    for (let i = 0; i <= t.length; i++) {
      const w = t.widen(i, i);
      if (w.start === i && w.end === i && t.toRaw(i) === rawRel) return i;
    }
    throw new Error('no cooked index at raw ' + rawRel);
  }

  it('edits a plain string run and the new file re-extracts to the new text', () => {
    const src = `<script>const t = 'It\\'s 40% up';</script>`;
    const { units } = extract(src);
    const out = edit(src, units[0], 0, 5, 8, '45%')!;
    expect(out).toBe(`<script>const t = 'It\\'s 45% up';</script>`);
    expect(extract(out).literals[0].value).toBe("It's 45% up");
  });

  it('edits text next to an escape without touching its spelling', () => {
    const src = `<script>const t = "Caf\\u00e9 au lait";</script>`;
    const { units } = extract(src);
    const out = edit(src, units[0], 0, 5, 7, 'with')!;
    expect(out).toBe(`<script>const t = "Caf\\u00e9 with lait";</script>`);
  });

  it('edits a run inside an HTML template and keeps the placeholders', () => {
    const src = '<script>x = `<li>${item}</li><li>Fixed text</li>`;</script>';
    const { units } = extract(src);
    const out = edit(src, units[0], 1, 0, 5, 'Edited <b> & "q"')!;
    expect(out).toBe('<script>x = `<li>${item}</li><li>Edited &lt;b> &amp; "q" text</li>`;</script>');
    const again = extract(out);
    expect(again.literals.map((r) => r.value)).toEqual([PH, 'Edited <b> & "q" text']);
  });

  it('edits a JSON value', () => {
    const src = '<script type="application/json">{"k": "Old \\"value\\""}</script>';
    const { units } = extract(src);
    const out = edit(src, units[0], 0, 0, 3, "New 'x' </script>")!;
    expect(out).toBe('<script type="application/json">{"k": "New \'x\' \\u003C/script> \\"value\\""}</script>');
    expect(JSON.parse(out.slice(out.indexOf('>') + 1, out.lastIndexOf('</script>'))).k).toBe("New 'x' </script> \"value\"");
  });

  for (const [name, initial, minApplied] of [
    ['a single-quoted string', `<script>const t = 'start\\x41\\u{1F600}\\\nend';</script>`, 200],
    ['a template', '<script>const t = `start\\x41\r\nmiddle $ and { end`;</script>', 120],
    ['a JSON value', '<script type="application/json">{"k": "start\\u0041 \\"q\\" end"}</script>', 200],
    ['an HTML string', "<script>x = '<p class=a>Caf&eacute; \\u00e9 &amp; done &copy</p>';</script>", 150],
    ['an HTML template', '<script>x = `<li>${a}</li><li>Total: &lt;b&gt; \\x41 ok</li>`;</script>', 150],
  ] as const) {
    it(`round-trips random edits of ${name} through the parser`, () => {
      let seed = 7;
      const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
      // No '<' or '&': adding one to a non-HTML literal is a verbatim note (9.2 Strategy 2 step 5.1).
      const alphabet = ['a', ' ', "'", '"', '\\', '\n', '\r', '/', 'script', '!--', '$', '{', '}', '`', '😀', 'é', '\u2028', '0', '\u0000'];
      // HTML runs take '<' and '&' (encoded first, 9.2 Strategy 2 step 5.1) and letters after an '&'.
      if (initial.includes('<p') || initial.includes('<li')) alphabet.push('<', '&', 'amp', ';', '&lt', 'copy;');
      const runIndex = initial.includes('<li>') ? 1 : 0;
      let src: string = initial;
      let applied = 0;
      for (let k = 0; k < 200; k++) {
        const { units, literals } = extract(src);
        const v = literals.find((r) => r.runIndex === runIndex)!.value;
        const s = Math.floor(rand() * (v.length + 1));
        // Keep the text from wearing away to whitespace (a whitespace-only literal has no run to edit).
        const e = v.length < 8 ? s : Math.min(v.length, s + Math.floor(rand() * 3));
        let text = '';
        for (let j = Math.floor(rand() * 3); j > 0; j--) text += alphabet[Math.floor(rand() * alphabet.length)];
        const out = edit(src, units[0], runIndex, s, e, text);
        if (out === null) continue; // the check refused a splice it could not prove safe
        applied++;
        const w = literalRunMapping(src, units[0], runIndex)!.table.widen(s, e);
        const expected = v.slice(0, w.start) + v.slice(w.start, s) + text + v.slice(e, w.end) + v.slice(w.end);
        const again = extract(out);
        expect(again.scripts[0].parsed).toBe(true);
        expect(again.units).toHaveLength(1);
        if (units[0].html) {
          expect(again.literals.find((r) => r.runIndex === runIndex)?.value).toBe(expected);
          expect(again.literals.every((r) => r.aligned)).toBe(true);
        } else {
          expect(again.units[0].cooked).toBe(expected);
        }
        if (units[0].kind === 'json-string') {
          const body = out.slice(out.indexOf('>') + 1, out.lastIndexOf('</script>'));
          expect(JSON.parse(body).k).toBe(expected);
        } else {
          const body = out.slice(out.indexOf('>') + 1, out.lastIndexOf('</script>'));
          expect(parse(body, { ecmaVersion: 'latest' }).body).toHaveLength(1);
        }
        expect(/<\/script|<script|<!--/i.test(out.slice(8, -9))).toBe(false);
        src = out;
      }
      expect(applied).toBeGreaterThanOrEqual(minApplied);
    });
  }
});

describe('extractLiterals: whole-deck behaviour', () => {
  it('numbers units across scripts in source order and runs per unit', () => {
    const src =
      `<script>a = '<b>One</b> two';</script><p>x</p>` +
      `<script type="application/json">["Three"]</script><script>b = \`Four\`;</script>`;
    const { units, literals } = extract(src);
    expect(units.map((u) => [u.index, u.scriptIndex, u.cooked])).toEqual([
      [0, 0, '<b>One</b> two'],
      [1, 1, 'Three'],
      [2, 2, 'Four'],
    ]);
    expect(runsOf(literals, 0).map((r) => r.id)).toEqual(['l:0:0', 'l:0:1']);
    expect(literals.map((r) => r.id)).toEqual(['l:0:0', 'l:0:1', 'l:1:0', 'l:2:0']);
    expect(literals.map((r) => r.strategy)).toEqual(['script-literal', 'script-literal', 'json-literal', 'script-literal']);
  });

  it('handles an empty script and a script with only comments', () => {
    const { units, scripts } = extract('<script></script><script>// nothing\n/* here */</script>');
    expect(units).toHaveLength(0);
    expect(scripts.map((s) => s.parsed)).toEqual([true, true]);
  });

  it('accepts HTML-like comments in classic scripts as browsers do', () => {
    const { units, scripts } = extract("<script><!--\nx = 'kept';\n--></script>");
    expect(scripts[0].parsed).toBe(true);
    expect(units.map((u) => u.cooked)).toEqual(['kept']);
  });
});

describe('extractLiterals: object keys that are not units', () => {
  it('returns JSON object keys (cooked) with their lines, and never makes them units', () => {
    const src = '<script type="application/json">{"Retention": {"v": 1},\n "focus": "Retention", "k\\u00e9": ["x"]}</script>';
    const { units, keys } = extract(src);
    expect(units.map((u) => u.cooked)).toEqual(['Retention', 'x']);
    expect(keys).toEqual([
      { value: 'Retention', attr: 'json key', line: 1 },
      { value: 'v', attr: 'json key', line: 1 },
      { value: 'focus', attr: 'json key', line: 2 },
      { value: 'k\u00e9', attr: 'json key', line: 2 },
    ]);
  });

  it('returns identifier keys of object literals and class fields, not destructuring keys or methods', () => {
    const src =
      "<script>const m = { Retention: 1, short, go() {}, [computed]: 2, 'str': 3 };" +
      " class C { field = 1; method() {} static s = 2; #p = 3 }" +
      " const { readOnly } = m; ({ alsoRead: x } = m); f(m.member);</script>";
    const { keys, units } = extract(src);
    expect(keys.map((k) => [k.value, k.attr])).toEqual([
      ['Retention', 'object key'],
      ['short', 'object key'],
      ['go', 'object key'],
      ['field', 'object key'],
      ['s', 'object key'],
    ]);
    // A string key stays a unit (it can be edited when it is the only place its text occurs).
    expect(units.map((u) => u.cooked)).toEqual(['str']);
  });

  it('returns no keys from a script that fails to parse', () => {
    expect(extract('<script>const o = { Lost: 1 </script>').keys).toEqual([]);
    expect(extract('<script type="application/json">{"Lost": 1,}</script>').keys).toEqual([]);
  });
});
