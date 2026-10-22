import { describe, expect, it } from 'vitest';
import { planEdit, verifyEdit, type EditPlan } from '@blueline/editor';
import { cleanupCommit } from '@blueline/core/edit-cleanup';
import { createMatcher } from '@blueline/core/matcher';
import { PLACEHOLDER } from '@blueline/core/js-literals';
import type { DeckMap, EditRequest } from '@blueline/core/types';
import { mapOf, requestFor } from './helpers';

/** Plans and verifies one edit of the run holding `before`; returns the plan and the new source. */
function edit(src: string, before: string, after: string, map: DeckMap = mapOf(src)): { plan: EditPlan; out: string; map: DeckMap } {
  const req = requestFor(map, before, after);
  const plan = planEdit(src, map, req);
  if (!plan.ok) throw new Error(`refused: ${plan.why}`);
  const newMap = mapOf(plan.newSrc);
  const v = verifyEdit(src, plan.newSrc, map, newMap, plan, req);
  if (!v.ok) throw new Error(`verify: ${v.why}`);
  return { plan, out: plan.newSrc, map: newMap };
}

function refusal(src: string, before: string, after: string, map: DeckMap = mapOf(src)): string {
  const plan = planEdit(src, map, requestFor(map, before, after));
  if (plan.ok) throw new Error(`expected a refusal, got ${JSON.stringify(plan.rawAfter)}`);
  return plan.why;
}

const doc = (body: string, head = ''): string => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

describe('planEdit: html-text (9.2 Strategy 1 step 5)', () => {
  it('splices only the changed span, keeping untouched references as spelled', () => {
    const src = doc('<p>Caf&eacute; &amp; bar &mdash; open</p>');
    const { plan, out } = edit(src, 'Café & bar — open', 'Café & baz — open');
    expect(out).toBe(doc('<p>Caf&eacute; &amp; baz &mdash; open</p>'));
    expect(plan.rawBefore).toBe('r');
    expect(plan.rawAfter).toBe('z');
  });

  it('is a pure insertion (appendLeft) when text is only added', () => {
    const src = doc('<h1>Hello world</h1>');
    const { plan, out } = edit(src, 'Hello world', 'Hello big world');
    expect(plan.start).toBe(plan.end);
    expect(plan.rawBefore).toBe('');
    expect(plan.rawAfter).toBe('big ');
    expect(out).toBe(doc('<h1>Hello big world</h1>'));
  });

  it('is a pure deletion (remove) when text is only removed', () => {
    const src = doc('<h1>Hello big world</h1>');
    const { plan, out } = edit(src, 'Hello big world', 'Hello world');
    expect(plan.rawAfter).toBe('');
    expect(plan.rawBefore).toBe('big ');
    expect(out).toBe(doc('<h1>Hello world</h1>'));
  });

  it('encodes & and < in new text and never writes raw markup', () => {
    const src = doc('<p>A and B</p>');
    const { out } = edit(src, 'A and B', 'A & <B>');
    expect(out).toBe(doc('<p>A &amp; &lt;B></p>'));
  });

  it('widens a span that starts or ends inside a reference and re-encodes it', () => {
    const src = doc('<p>x&nbsp;&mdash;y</p>');
    // Replace the em dash (one decoded char from 7 raw chars) with an en dash.
    const { plan, out } = edit(src, 'x\u00A0\u2014y', 'x\u00A0\u2013y');
    expect(plan.rawBefore).toBe('&mdash;');
    expect(plan.rawAfter).toBe('\u2013');
    expect(out).toBe(doc('<p>x&nbsp;\u2013y</p>'));
  });

  it('writes U+00A0 as &nbsp; only when the run already spelled one that way', () => {
    const withRef = doc('<p>a&nbsp;b</p>');
    expect(edit(withRef, 'a\u00A0b', 'a\u00A0b\u00A0c').out).toBe(doc('<p>a&nbsp;b&nbsp;c</p>'));
    const rawNbsp = doc('<p>a\u00A0b</p>');
    expect(edit(rawNbsp, 'a\u00A0b', 'a\u00A0b\u00A0c').out).toBe(doc('<p>a\u00A0b\u00A0c</p>'));
    const none = doc('<p>a b</p>');
    expect(edit(none, 'a b', 'a b\u00A0c').out).toBe(doc('<p>a b\u00A0c</p>'));
  });

  it('keeps a reference without ; from swallowing new text (&not + in; would read &notin;)', () => {
    const src = doc('<p>x &not y</p>');
    const { out, map } = edit(src, 'x \u00AC y', 'x \u00ACin; y');
    expect(map.runs[0].value).toBe('x \u00ACin; y');
    expect(out).not.toContain('&notin;');
  });

  it('handles a BOM: offsets are UTF-16 indices into the decoded string, the BOM stays', () => {
    const src = '\uFEFF' + doc('<p>Hi there</p>');
    const { out } = edit(src, 'Hi there', 'Hi you');
    expect(out).toBe('\uFEFF' + doc('<p>Hi you</p>'));
  });

  it('handles CRLF: a run spanning a CRLF maps through the dropped CR; new line breaks use the file ending', () => {
    const src = '<!doctype html>\r\n<body>\r\n<p>one\r\ntwo</p>\r\n</body>\r\n';
    const { out } = edit(src, 'one\ntwo', 'one\ntwo three');
    expect(out).toBe('<!doctype html>\r\n<body>\r\n<p>one\r\ntwo three</p>\r\n</body>\r\n');
    const { out: out2 } = edit(src, 'one\ntwo', 'uno\ntwo');
    expect(out2).toBe('<!doctype html>\r\n<body>\r\n<p>uno\r\ntwo</p>\r\n</body>\r\n');
  });

  it('writes a new line break with the file\'s line ending, never normalizing (9.2 rule 4)', () => {
    // The clean-up turns typed line breaks into spaces, but an applied suggestion may carry one.
    const crlf = '<!doctype html>\r\n<body>\r\n<p>one two</p>\r\n</body>\r\n';
    expect(edit(crlf, 'one two', 'one\ntwo').out).toBe('<!doctype html>\r\n<body>\r\n<p>one\r\ntwo</p>\r\n</body>\r\n');
    const lf = '<!doctype html>\n<body>\n<p>one two</p>\n</body>\n';
    expect(edit(lf, 'one two', 'one\ntwo').out).toBe('<!doctype html>\n<body>\n<p>one\ntwo</p>\n</body>\n');
  });

  it('handles astral characters without splitting surrogate pairs', () => {
    const src = doc('<p>Launch \u{1F680} now</p>');
    const { plan, out } = edit(src, 'Launch \u{1F680} now', 'Launch \u{1F6F8} now');
    expect(plan.rawBefore).toBe('\u{1F680}');
    expect(plan.rawAfter).toBe('\u{1F6F8}');
    expect(out).toBe(doc('<p>Launch \u{1F6F8} now</p>'));
    const ref = doc('<p>go &#x1F680;!</p>');
    expect(edit(ref, 'go \u{1F680}!', 'go \u{1F680}!!').out).toBe(doc('<p>go &#x1F680;!!</p>'));
  });

  it('edits one run among inline elements and leaves the others alone', () => {
    const src = doc('<p>Before <b>bold</b> after</p>');
    expect(edit(src, 'bold', 'bolder').out).toBe(doc('<p>Before <b>bolder</b> after</p>'));
    expect(edit(src, ' after', ' later').out).toBe(doc('<p>Before <b>bold</b> later</p>'));
  });

  it('inserts after the newline <pre> drops', () => {
    const src = doc('<pre>\ncode</pre>');
    const { out } = edit(src, 'code', 'my code');
    expect(out).toBe(doc('<pre>\nmy code</pre>'));
  });

  it('a cell inside a foster-parented run is never planned; the cell after it is written (finding 6)', () => {
    const src = doc('<section>\n<table><tr><td>Cell one</td></tr>Foster text<tr><td>Cell two</td></tr></table>\n</section>');
    const map = mapOf(src);
    const one = map.runs.find((r) => r.value === 'Cell one')!;
    expect(createMatcher(map)({ stamp: one.stamp, textIndex: 0, data: 'Cell one', texts: ['Cell one'] })).toMatchObject({ confidence: 'none', reason: 'unaligned' });
    expect(refusal(src, 'Cell one', 'Cell one!')).toMatch(/unaligned/);
    expect(edit(src, 'Cell two', 'Cell two!').out).toBe(src.replace('Cell two', 'Cell two!'));
  });

  it('refuses structural edits: emptying a run or leaving it whitespace-only (6.3)', () => {
    const src = doc('<p>Before <b>bold</b> after</p>');
    expect(refusal(src, 'bold', '')).toMatch(/structural/);
    expect(refusal(src, 'bold', '  ')).toMatch(/structural/);
  });

  it('refuses when the run no longer holds beforeText, and unknown runs', () => {
    const src = doc('<p>Hello</p>');
    const map = mapOf(src);
    const req: EditRequest = { ...requestFor(map, 'Hello', 'Hi'), beforeText: 'Hullo' };
    const p = planEdit(src, map, req);
    expect(p.ok).toBe(false);
    expect(planEdit(src, map, { ...req, runId: 'h:bl-99:0', beforeText: 'Hello' }).ok).toBe(false);
    expect(planEdit(src, map, { ...req, runId: 'x', beforeText: 'Hello' }).ok).toBe(false);
  });

  it('refuses a deck that is not UTF-8 and an unchanged edit', () => {
    const src = doc('<p>Hello</p>');
    const map = { ...mapOf(src), utf8: false };
    expect(planEdit(src, map, requestFor(mapOf(src), 'Hello', 'Hi')).ok).toBe(false);
    expect(refusal(src, 'Hello', 'Hello')).toMatch(/unchanged/);
  });

  it('refuses a lone surrogate (it cannot be written as UTF-8)', () => {
    const src = doc('<p>a \u{1F600} b</p>');
    expect(refusal(src, 'a \u{1F600} b', 'a \uD83D b')).toMatch(/surrogate/);
  });

  it('refuses a character that is an HTML parse error by rule (escape), and verify would catch it too', () => {
    const src = doc('<p>Hello</p>');
    const map = mapOf(src);
    // C0 controls other than white space, C1 controls and noncharacters, in HTML text.
    for (const ch of ['\u0001', '\u0007', '\u007F', '\u0085', '\uFDD0', '\uFFFE', '\u{1FFFF}']) {
      const plan = planEdit(src, map, requestFor(map, 'Hello', `Hel${ch}lo`));
      expect(plan).toMatchObject({ ok: false, code: 'escape', why: expect.stringMatching(/parser reports as an error/) });
    }
    // White space and ordinary characters are fine.
    expect(planEdit(src, map, requestFor(map, 'Hello', 'Hel\tlo\u00A0\u2028')).ok).toBe(true);
    // Verify still refuses such a character if a plan ever carried one (the precheck is a typed rule, not the guard).
    const ok = planEdit(src, map, requestFor(map, 'Hello', 'Helxlo'));
    if (!ok.ok) throw new Error(ok.why);
    const forged = { ...ok, rawAfter: '\u0001', afterText: 'Hel\u0001lo', newSrc: doc('<p>Hel\u0001lo</p>') };
    const v = verifyEdit(src, forged.newSrc, map, mapOf(forged.newSrc), forged, { afterText: 'Hel\u0001lo' });
    expect(v).toEqual({ ok: false, why: expect.stringMatching(/new parse error control-character-in-input-stream/) });
  });

  it('refuses a character reference right after the dropped newline of <pre> (parse5 cannot locate that text node)', () => {
    for (const nl of ['\n', '\r\n']) {
      const src = `<!doctype html><body><pre>${nl}Plan${nl}  next</pre></body>`;
      const map = mapOf(src);
      const run = map.runs.find((r) => r.tagName === 'pre')!;
      for (const lead of ['&', '<', '&amp; ']) {
        expect(planEdit(src, map, requestFor(map, run.id, lead + run.value)), JSON.stringify([nl, lead])).toMatchObject({ ok: false, code: 'escape' });
      }
      // Anywhere else in the run, and plain text at its start, are written and verify.
      expect(edit(src, run.value, 'X' + run.value, map).out).toContain(`<pre>${nl}XPlan`);
      expect(edit(src, run.value, 'R&D ' + run.value, map).out).toContain(`<pre>${nl}R&amp;D Plan`);
      expect(edit(src, run.value, run.value.replace('Plan', 'Plan & do'), map).out).toContain('Plan &amp; do');
    }
    // Without a dropped newline the reference maps fine.
    const flat = '<!doctype html><body><pre>Plan</pre></body>';
    expect(edit(flat, 'Plan', '&Plan').out).toContain('<pre>&amp;Plan</pre>');
  });

  it('refuses an edit that changes whether white space follows the dropped newline of <pre> (parse5 moves the node)', () => {
    // The Node fuzz (third F-1 round): parse5 starts the text node at the dropped newline when white space follows
    // it, and after it otherwise, so such an edit moved the run and only verify refused it.
    for (const nl of ['\n', '\r\n']) {
      for (const [body, after] of [
        ['npm run build', ' x run'],
        [' npm run build', 'npm run build'],
        ['npm run', '\tnpm run'],
      ]) {
        const src = `<!doctype html><body><p>Head</p><pre class="code">${nl}${body}</pre></body>`;
        const map = mapOf(src);
        const run = map.runs.find((r) => r.tagName === 'pre')!;
        expect(planEdit(src, map, requestFor(map, run.id, after)), JSON.stringify([nl, body, after])).toMatchObject({ ok: false, code: 'escape' });
      }
      // Keeping the leading white space (or its absence) is written and verifies.
      const src = `<!doctype html><body><p>Head</p><pre class="code">${nl} npm run</pre></body>`;
      expect(edit(src, ' npm run', ' npm run build').out).toContain(`<pre class="code">${nl} npm run build</pre>`);
      const src2 = `<!doctype html><body><p>Head</p><pre class="code">${nl}npm run</pre></body>`;
      expect(edit(src2, 'npm run', 'npm run build').out).toContain(`<pre class="code">${nl}npm run build</pre>`);
    }
    // Without a dropped newline white space at the start is fine.
    expect(edit('<!doctype html><body><pre>npm run</pre></body>', 'npm run', ' npm run').out).toContain('<pre> npm run</pre>');
  });

  it('lets a literal carry C0 controls (escaped as \\u00XX) but not C1 controls or noncharacters', () => {
    const src = doc('<div id="app"></div>', "<script>var a = 'Line';</script>");
    const map = mapOf(src);
    expect(planEdit(src, map, requestFor(map, 'Line', 'Line\u0007')).ok).toBe(true);
    expect(planEdit(src, map, requestFor(map, 'Line', 'Line\u0085'))).toMatchObject({ ok: false, code: 'escape' });
    expect(planEdit(src, map, requestFor(map, 'Line', 'Line\uFFFF'))).toMatchObject({ ok: false, code: 'escape' });
  });

  it('edits text after a notes block is removed from mapping and keeps the block intact', () => {
    const notes = '<script type="application/vnd.blueline+json" id="blueline-notes" data-version="1">{"notes":[]}</script>';
    const src = `<!doctype html><body><p>Hello</p>${notes}</body>`;
    const { out } = edit(src, 'Hello', 'Hello, world');
    expect(out).toBe(`<!doctype html><body><p>Hello, world</p>${notes}</body>`);
  });
});

describe('planEdit: script literals (9.2 Strategy 2 steps 4–5)', () => {
  const js = (code: string, type = ''): string => doc('<div id="app"></div>', `<script${type}>${code}</script>`);

  it('escapes per quote style, in the spec order', () => {
    const single = js("var a = 'It is';");
    expect(edit(single, 'It is', "It's \\ \"ok\"").out).toBe(js("var a = 'It\\'s \\\\ \"ok\"';"));
    const double = js('var a = "Say";');
    expect(edit(double, 'Say', 'Say "hi" it\'s').out).toBe(js('var a = "Say \\"hi\\" it\'s";'));
    const tpl = js('var a = `Cost`;');
    expect(edit(tpl, 'Cost', 'Cost ${x} `q`').out).toBe(js('var a = `Cost \\${x} \\`q\\``;'));
  });

  it('escapes tabs, other controls, U+2028 and </script, <script, <!-- in templates and strings', () => {
    const src = js("var a = 'Line';");
    // `<` makes this a verbatim edit for a plain literal (5.1), so test the escapes on the HTML literal path.
    const html = js("el.innerHTML = '<p>Line</p>';");
    const { out } = edit(html, 'Line', 'Line\tA\u2028B');
    expect(out).toBe(js("el.innerHTML = '<p>Line\\tA\\u2028B</p>';"));
    expect(edit(src, 'Line', 'Line\u0007').out).toBe(js("var a = 'Line\\u0007';"));
  });

  it('turns an edit that adds < or & to a plain literal into a verbatim note (5.1)', () => {
    const src = js("var a = 'Tom and Jerry';");
    expect(refusal(src, 'Tom and Jerry', 'Tom & Jerry')).toMatch(/5\.1/);
    expect(refusal(src, 'Tom and Jerry', 'Tom <3 Jerry')).toMatch(/5\.1/);
  });

  it('a literal whose < starts no markup is plain: adding & or < is a verbatim note, a real HTML literal still encodes (finding 5)', () => {
    const src = js("el.textContent = 'Latency <5 ms'; other.innerHTML = '<b>x</b> &amp; y';");
    expect(refusal(src, 'Latency <5 ms', 'Latency <5 ms & falling')).toMatch(/5\.1/);
    expect(refusal(src, 'Latency <5 ms', 'Latency <5 ms, <3 ms soon')).toMatch(/5\.1/);
    // Text without < or & is written as typed (JS-escaped only).
    expect(edit(src, 'Latency <5 ms', 'Latency <4 ms').out).toBe(js("el.textContent = 'Latency <4 ms'; other.innerHTML = '<b>x</b> &amp; y';"));
    // A deletion that turns the < into markup would read differently through innerHTML.
    expect(refusal(src, 'Latency <5 ms', 'Latency <ms')).toMatch(/innerHTML/);
    // The HTML literal: & and < are encoded (step 5.1).
    expect(edit(src, ' & y', ' & y < z').out).toBe(js("el.textContent = 'Latency <5 ms'; other.innerHTML = '<b>x</b> &amp; y &lt; z';"));
  });

  it('refuses a deletion that makes a plain literal read differently through innerHTML', () => {
    const src = js("var a = 'R &am p D';");
    expect(refusal(src, 'R &am p D', 'R &amp D')).toMatch(/innerHTML/);
  });

  it('HTML-encodes then escapes in an HTML-fragment literal, and re-checks </script', () => {
    const src = js("el.innerHTML = '<li>Alpha</li><li>Beta</li>';");
    const { out, map } = edit(src, 'Beta', "Beta & </script> 'x'");
    expect(out).toBe(js("el.innerHTML = '<li>Alpha</li><li>Beta &amp; &lt;/script> \\'x\\'</li>';"));
    expect(map.literals.map((l) => l.value)).toEqual(['Alpha', "Beta & </script> 'x'"]);
  });

  it('keeps existing escapes and references untouched outside the span, widens inside them', () => {
    const src = js("var a = 'caf\\u00e9 \\u2014 ok';");
    const { plan, out } = edit(src, 'café — ok', 'café — okay');
    expect(plan.rawBefore).toBe('');
    expect(out).toBe(js("var a = 'caf\\u00e9 \\u2014 okay';"));
    // Replacing the em dash re-encodes only that escape.
    const r = edit(src, 'café — ok', 'café – ok');
    expect(r.plan.rawBefore).toBe('\\u2014');
    expect(r.plan.rawAfter).toBe('\u2013');
  });

  it('edits a template run without a placeholder, never touching ${…}; refuses placeholder runs (7)', () => {
    const src = js('el.innerHTML = `<h2>Title</h2><p>${n} items</p>`;');
    const { out } = edit(src, 'Title', 'New title');
    expect(out).toBe(js('el.innerHTML = `<h2>New title</h2><p>${n} items</p>`;'));
    expect(refusal(src, `${PLACEHOLDER} items`, `${PLACEHOLDER} things`)).toMatch(/placeholder/);
  });

  it('refuses (in verify) an & in raw-text elements of an HTML literal, where &amp; would show as typed', () => {
    for (const tag of ['xmp', 'noscript', 'iframe', 'noembed']) {
      const src = js(`el.innerHTML = '<p>a</p><${tag}>Hello</${tag}>';`);
      const map = mapOf(src);
      const req = requestFor(map, 'Hello', 'Hello & bye');
      const plan = planEdit(src, map, req);
      const verdict = plan.ok ? verifyEdit(src, plan.newSrc, map, mapOf(plan.newSrc), plan, req) : plan;
      expect(verdict.ok, tag).toBe(false);
      // Text without & or < is the same in raw text and in data, so it is written.
      expect(edit(src, 'Hello', 'Hello there').out, tag).toBe(js(`el.innerHTML = '<p>a</p><${tag}>Hello there</${tag}>';`));
    }
  });

  it('refuses typed U+E000 (the placeholder character)', () => {
    const src = js('var a = `Plain`;');
    expect(refusal(src, 'Plain', `Plain ${PLACEHOLDER}`)).toMatch(/U\+E000/);
  });

  it('handles a module script and a template with a line continuation', () => {
    const src = js('export const t = `one \\\ntwo`;', ' type="module"');
    const { out } = edit(src, 'one two', 'one two three');
    expect(out).toBe(js('export const t = `one \\\ntwo three`;', ' type="module"'));
  });

  it('re-escapes a neighbour when only the edge forms a substitution (`$` before an inserted `{`)', () => {
    const src = js('var a = `cost $`;');
    const { plan, out, map } = edit(src, 'cost $', 'cost ${x}');
    expect(plan.rawBefore).toBe('$');
    expect(plan.rawAfter).toBe('\\${x}');
    expect(out).toBe(js('var a = `cost \\${x}`;'));
    expect(map.units[0].cooked).toBe('cost ${x}');
  });

  it('edits a string used as an object key (the mapper treats it as a literal)', () => {
    const src = js("var o = {'Label': 1}; show('Other');");
    expect(edit(src, 'Label', 'Name').out).toBe(js("var o = {'Name': 1}; show('Other');"));
  });
});

describe('planEdit: JSON blocks (9.2 Strategy 2 step 5.3)', () => {
  const json = (data: string): string => doc('<div></div>', `<script type="application/json" id="d">${data}</script>`);

  it('uses JSON escaping: " always, \' never, controls as \\u00XX, < as \\u003C in the three sequences', () => {
    const src = json('{"title": "Plan"}');
    expect(edit(src, 'Plan', 'Plan "B"\tit\'s').out).toBe(json('{"title": "Plan \\"B\\"\\u0009it\'s"}'));
  });

  it('HTML values: encode, then escape </script and <!-- with \\u003C', () => {
    const src = json('{"html": "<b>Bold</b> text"}');
    const { out, map } = edit(src, ' text', ' text </script><!-- x');
    expect(out).toBe(json('{"html": "<b>Bold</b> text &lt;/script>&lt;!-- x"}'));
    expect(map.literals.find((l) => l.value.startsWith(' text'))!.value).toBe(' text </script><!-- x');
  });

  it('keeps JSON escapes (\\u2014, \\") outside the span', () => {
    const src = json('{"a": "x\\u2014\\"y\\""}');
    const { out } = edit(src, 'x\u2014"y"', 'x\u2014"y" z');
    expect(out).toBe(json('{"a": "x\\u2014\\"y\\" z"}'));
  });
});

describe('cleanupCommit feeds planEdit', () => {
  it('a Chrome trailing NBSP becomes a space before the diff', () => {
    const src = doc('<p>Hello</p>');
    const after = cleanupCommit('Hello', 'Hello\u00A0world');
    expect(edit(src, 'Hello', after).out).toBe(doc('<p>Hello world</p>'));
  });
});

describe('verifyEdit refuses anything but the planned change (9.2 Write protocol step 5)', () => {
  function tamper(src: string, before: string, after: string, rawAfter: string): string {
    const map = mapOf(src);
    const req = requestFor(map, before, after);
    const plan = planEdit(src, map, req);
    if (!plan.ok) throw new Error(plan.why);
    const bad = { ...plan, rawAfter, newSrc: src.slice(0, plan.start) + rawAfter + src.slice(plan.end) };
    const v = verifyEdit(src, bad.newSrc, map, mapOf(bad.newSrc), bad, req);
    if (v.ok) throw new Error('verify accepted a tampered plan');
    return v.why;
  }

  it('shadow values that changed (D-a): a text edit never changes them; repeated-number shadows may change', () => {
    const src = doc('<h1>Deals</h1><p title="Hint">x</p><b id="v"></b><script>document.getElementById(\'v\').textContent = \'600\';</script>');
    const map = mapOf(src);
    const req = requestFor(map, 'Deals', 'Deals at 600');
    const plan = planEdit(src, map, req);
    if (!plan.ok) throw new Error(plan.why);
    const newMap = mapOf(plan.newSrc);
    // The edit makes "600" occur twice, so it becomes a repeated-number shadow: that is not a structural change.
    expect(newMap.shadows).toContainEqual(expect.objectContaining({ value: '600', kind: 'repeated-number' }));
    expect(map.shadows!.some((x) => x.kind === 'repeated-number')).toBe(false);
    expect(verifyEdit(src, plan.newSrc, map, newMap, plan, req)).toEqual({ ok: true });
    // Any other shadow that differs means the edit changed something it must not.
    const tampered: DeckMap = { ...newMap, shadows: newMap.shadows!.map((x) => (x.value === 'Hint' ? { ...x, value: 'Hint!' } : x)) };
    expect(verifyEdit(src, plan.newSrc, map, tampered, plan, req)).toMatchObject({ ok: false, why: expect.stringMatching(/shadow/) });
  });

  it('a new source that is not the old one with the splice', () => {
    const src = doc('<p>Hello</p>');
    const map = mapOf(src);
    const req = requestFor(map, 'Hello', 'Hello!');
    const plan = planEdit(src, map, req);
    if (!plan.ok) throw new Error(plan.why);
    const other = plan.newSrc.replace('<p>', '<p class=x>');
    expect(verifyEdit(src, other, map, mapOf(other), plan, req)).toMatchObject({ ok: false });
    expect(verifyEdit(src, plan.newSrc, map, mapOf(plan.newSrc), plan, { afterText: 'other' })).toMatchObject({ ok: false });
  });

  it('a splice that writes markup, or text the run does not end up holding', () => {
    const src = doc('<p>Hello <b>you</b></p>');
    expect(tamper(src, 'Hello ', 'Hello there ', 'there <i>x</i> ')).toMatch(/run|stamp/);
    expect(tamper(src, 'Hello ', 'Hello there ', 'their ')).toMatch(/afterText/);
  });

  it('an unescaped quote that ends the literal early (script no longer parses or literals change)', () => {
    const src = doc('<div></div>', "<script>var a = 'Hi'; var b = 'Yo';</script>");
    expect(tamper(src, 'Hi', "Hi'", "'")).toMatch(/parse|literal/);
  });

  it('an unescaped </script> that ends the script early', () => {
    const src = doc('<div></div>', "<script>el.innerHTML = '<b>Hi</b>';</script>");
    expect(tamper(src, 'Hi', 'Hi</script>', '</script>')).toMatch(/script|literal|run/);
  });

  it('a JSON value that no longer parses', () => {
    const src = doc('<div></div>', '<script type="application/json">{"a": "Hi"}</script>');
    expect(tamper(src, 'Hi', 'Hi"', '"')).toMatch(/JSON|literal|parse/);
  });
});
