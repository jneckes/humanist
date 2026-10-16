// Shadow values (9.2 Strategy 2 step 3, "that run occurs once in the file"; section 10 exit gate: a node
// reported exact that fails the probe is a write to the wrong place). Text the page may show that Blueline
// never writes (template content, raw-text elements, script data blocks, tagged templates, attribute values,
// event-handler strings, Strategy 1 text the walk drops, numbers) must keep an equal literal from looking
// unique. Each reproduction comes from the adversarial review (findings 0, 1 and 3); every check runs on the
// DeckMap (blueline map, the patcher) and on the ClientMap (the overlay), which must agree.

import { describe, expect, it } from 'vitest';
import { buildMap, toClientMap } from '@blueline/core/mapper';
import { createMatcher } from '@blueline/core/matcher';
import type { DeckMap, DomTextNode, MatchResult } from '@blueline/core/types';

function mapOf(src: string): DeckMap {
  return buildMap(src, { version: 'v', utf8: true });
}

/** Matches an unstamped node (text a script put on the page) with both matchers; they must agree. */
function matchFree(map: DeckMap, data: string): MatchResult {
  const node: DomTextNode = { stamp: null, textIndex: 0, data };
  const a = createMatcher(map)(node);
  const b = createMatcher(toClientMap(map))(node);
  expect({ confidence: b.confidence, reason: b.reason, runIds: b.candidates.map((c) => c.runId) }).toEqual({
    confidence: a.confidence,
    reason: a.reason,
    runIds: a.candidates.map((c) => c.runId),
  });
  return a;
}

/** The one literal run with this value. */
function literal(map: DeckMap, value: string) {
  const ls = map.literals.filter((l) => l.value === value);
  expect(ls).toHaveLength(1);
  return ls[0];
}

/** Ambiguous because the text also comes from a source Blueline never writes; the literal is the only candidate. */
function expectShadow(map: DeckMap, data: string): void {
  const r = matchFree(map, data);
  expect(r.confidence, data).toBe('ambiguous');
  expect(r.reason, data).toBe('shadow');
  expect(r.runId).toBeNull();
  expect(r.candidates.map((c) => c.runId)).toEqual([literal(map, data).id]);
}

const doc = (head: string, body: string): string => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

describe('finding 0: text from sources that are not runs counts for uniqueness', () => {
  it('a <template> clone and a canvas label literal with the same text (scratch deck template.html)', () => {
    const src = doc(
      '<title>Template deck</title>',
      '<div id="grid"></div><canvas id="chart"></canvas>\n' +
        '<template id="kpi"><div class="kpi"><h3>Revenue</h3></div></template>\n' +
        "<script>const SERIES = ['Revenue', 'Cost'];\n" +
        "document.getElementById('grid').appendChild(document.getElementById('kpi').content.cloneNode(true));\n" +
        "SERIES.forEach((s, i) => document.getElementById('chart').getContext('2d').fillText(s, 20, 40 + i * 30));</script>",
    );
    const map = mapOf(src);
    expectShadow(map, 'Revenue');
    // The shadow records where the template text is; it is never a run.
    expect(map.shadows).toContainEqual(expect.objectContaining({ value: 'Revenue', kind: 'template', start: src.indexOf('Revenue</h3>') }));
    expect(map.runs.some((r) => r.value === 'Revenue')).toBe(false);
    // Control: a literal no other source shows stays exact.
    expect(matchFree(map, 'Cost').confidence).toBe('exact');
  });

  it('nested template content, text directly in the content, and every SKIP_TEXT element', () => {
    const src = doc(
      '<title>Board review</title><style>.a{}</style><noscript>Turn on scripts</noscript>',
      '<template><p>Outer</p><template>Inner tpl</template>Loose tpl</template>' +
        '<textarea id="src">Pipeline health</textarea><xmp>Raw xmp</xmp><iframe>Iframe text</iframe>' +
        '<noembed>Noembed text</noembed><noframes>Noframes text</noframes>' +
        "<script>const L = ['Board review', 'Outer', 'Inner tpl', 'Loose tpl', 'Pipeline health', 'Raw xmp'," +
        " 'Iframe text', 'Noembed text', 'Noframes text', 'Turn on scripts', 'Only in script'];</script>",
    );
    const map = mapOf(src);
    for (const t of ['Board review', 'Outer', 'Inner tpl', 'Loose tpl', 'Pipeline health', 'Raw xmp', 'Iframe text', 'Noembed text', 'Noframes text', 'Turn on scripts']) {
      expectShadow(map, t);
    }
    expect(matchFree(map, 'Only in script').confidence).toBe('exact');
    expect(map.shadows!.find((s) => s.value === 'Board review')?.kind).toBe('raw-text');
  });

  it('<plaintext> text and markup inside raw text (a <textarea> holding HTML)', () => {
    const src = doc('', "<textarea><b>Bold note</b></textarea><script>const a = 'Bold note'; const b = 'Tail text';</script><plaintext>Tail text");
    const map = mapOf(src);
    expectShadow(map, 'Bold note');
    expectShadow(map, 'Tail text');
  });

  it('script data blocks that are neither JS nor JSON (text/x-template, text/babel, ld+json)', () => {
    const src = doc(
      '<script type="application/ld+json">{"name": "Acme Analytics"}</script>',
      '<div id="xt"></div><script type="text/x-template" id="tmpl"><p>Churn outlook</p></script>' +
        '<script type="text/babel">const App = () => <h1>Hello team</h1>;</script>' +
        '<script type="text/markdown"># Agenda</script>' +
        "<script>const LABELS = ['Churn outlook', 'Hello team', 'Acme Analytics', '# Agenda'];" +
        " document.getElementById('xt').innerHTML = document.getElementById('tmpl').textContent;</script>",
    );
    const map = mapOf(src);
    for (const t of ['Churn outlook', 'Hello team', 'Acme Analytics', '# Agenda']) expectShadow(map, t);
    expect(map.shadows!.find((s) => s.value === 'Churn outlook')?.kind).toBe('script-data');
  });

  it('tagged templates (lit-html / htm, String.raw): quasis and their fragment text nodes', () => {
    const src = doc(
      '',
      "<div id=\"t\"></div><script>const html = (s) => s.raw.join('');\n" +
        "document.getElementById('t').innerHTML = html`<span>Hiring plan</span><li>Hello ${name}!</li>`;\n" +
        'const p = String.raw`C:\\new folder`;\n' +
        "const LABELS = ['Hiring plan', 'Hello ', 'C:\\\\new folder', 'Not shown elsewhere'];</script>",
    );
    const map = mapOf(src);
    expectShadow(map, 'Hiring plan');
    expectShadow(map, 'Hello ');
    expectShadow(map, 'C:\\new folder');
    expect(matchFree(map, 'Not shown elsewhere').confidence).toBe('exact');
    expect(map.shadows!.find((s) => s.value === 'Hiring plan')?.kind).toBe('tagged-template');
  });

  it('attribute values (all of them, not only key attributes), srcdoc text and event-handler strings', () => {
    const src = doc(
      '',
      '<div id="tip" aria-label="Gross margin" title="Hover help"></div><img alt="Team photo" src="a.png">' +
        '<iframe srcdoc="<p>Inner frame text</p>"></iframe>' +
        '<button onclick="this.textContent = \'Saved\'; show(`Done ${n}`)">Save</button>' +
        '<span data-tippy-content="<b>Tip body</b>"></span>' +
        "<script>const L = ['Gross margin', 'Hover help', 'Team photo', 'Inner frame text', 'Saved', 'Done ', 'Tip body'];" +
        " const tip = document.getElementById('tip'); tip.textContent = tip.getAttribute('aria-label');</script>",
    );
    const map = mapOf(src);
    for (const t of ['Gross margin', 'Hover help', 'Team photo', 'Inner frame text', 'Saved', 'Done ', 'Tip body']) expectShadow(map, t);
    expect(map.shadows!.find((s) => s.value === 'Gross margin')?.kind).toBe('attribute');
    expect(map.shadows!.find((s) => s.value === 'Saved')?.kind).toBe('event-handler');
  });

  it('the scratch deck variants.html: title, x-template, tagged template, aria-label and textarea all ambiguous', () => {
    const src =
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Board review</title>\n</head>\n<body>\n' +
      '<h1 id="hdr"></h1>\n<div id="xt"></div>\n<div id="tagged"></div>\n<div id="tip" aria-label="Gross margin"></div>\n' +
      '<div id="ta"></div>\n<canvas id="chart" width="400" height="200"></canvas>\n' +
      '<textarea id="src">Pipeline health</textarea>\n<script type="text/x-template" id="tmpl"><p>Churn outlook</p></script>\n' +
      "<script>\nconst LABELS = ['Board review', 'Churn outlook', 'Hiring plan', 'Gross margin', 'Pipeline health'];\n" +
      "const html = (s) => s.raw.join('');\ndocument.getElementById('tagged').innerHTML = html`<span>Hiring plan</span>`;\n" +
      '</script>\n</body>\n</html>\n';
    const map = mapOf(src);
    for (const t of ['Board review', 'Churn outlook', 'Hiring plan', 'Gross margin', 'Pipeline health']) expectShadow(map, t);
  });

  it('two equal literals stay duplicate; a stamped node keeps its own run (step 1 ignores shadows)', () => {
    const src = doc('<title>Summary</title>', "<h1>Summary</h1><script>const a = 'Twice'; const b = 'Twice';</script><template>Twice</template>");
    const map = mapOf(src);
    expect(matchFree(map, 'Twice')).toMatchObject({ confidence: 'ambiguous', reason: 'duplicate' });
    const h1 = map.runs.find((r) => r.value === 'Summary')!;
    for (const m of [createMatcher(map), createMatcher(toClientMap(map))]) {
      expect(m({ stamp: h1.stamp, textIndex: 0, data: 'Summary', texts: ['Summary'] })).toMatchObject({ confidence: 'exact', runId: h1.id });
    }
  });

  it('never takes shadows from the notes block, and lists each value once in the ClientMap', () => {
    const notes = '<script type="application/vnd.blueline+json" id="blueline-notes" data-version="1">{"notes":[{"text":"Only in notes, 77 times"}]}</script>';
    const src = doc('', `<p title="Twin" class="Twin">x</p><b id="n"></b><script>const a = 'Only in notes'; document.getElementById('n').textContent = '77';</script>\n${notes}\n`);
    const map = mapOf(src);
    expect(map.notesBlock).not.toBeNull();
    expect(matchFree(map, 'Only in notes').confidence).toBe('exact');
    // "77" occurs once outside the notes block: the literal is the only place it is.
    expect(matchFree(map, '77').confidence).toBe('exact');
    const values = toClientMap(map).shadowValues!;
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain('Twin');
  });
});

describe('finding 1: Strategy 1 text the walk drops counts for uniqueness', () => {
  it('an unclosed <em> reconstructed in the next <li> (adoption.html)', () => {
    const src = doc('', "<section class=\"slide\">\n<ul><li><em>Ship the beta<li>Next step</ul>\n<button id=\"b\"></button>\n</section>\n<script>\ndocument.getElementById('b').textContent = 'Ship the beta';\n</script>");
    const map = mapOf(src);
    expect(map.runs.some((r) => r.value === 'Ship the beta')).toBe(false); // dropped, not a run
    expectShadow(map, 'Ship the beta');
    expect(map.shadows!.find((s) => s.value === 'Ship the beta')?.kind).toBe('dropped-run');
  });

  it('<h2><em>Plan</h2><p>Details</p> and a contents list from TITLES (plan-exact.html)', () => {
    const src = doc(
      '',
      '<section class="slide">\n<h1>Contents</h1>\n<ul id="toc"></ul>\n</section>\n<section class="slide">\n<h2><em>Plan</h2><p>Details</p>\n</section>\n' +
        "<script>\nconst TITLES = ['Contents', 'Plan'];\nconst toc = document.getElementById('toc');\n" +
        "for (const t of TITLES) { const li = document.createElement('li'); li.textContent = t; toc.appendChild(li); }\n</script>",
    );
    const map = mapOf(src);
    expectShadow(map, 'Plan');
    expect(matchFree(map, 'Contents')).toMatchObject({ confidence: 'ambiguous', reason: 'duplicate' });
  });

  it('a Noah\u2019s Ark group (four <b>s open at once)', () => {
    const src = doc('', "<p><b>one<b>two<b>three<b>Plan</p><script>const t = 'Plan';</script>");
    const map = mapOf(src);
    expect(map.runs.filter((r) => r.tagName === 'b')).toEqual([]);
    expectShadow(map, 'Plan');
  });

  it('a noahStripped deck: no stamps at all, every text is a shadow', () => {
    const src = doc('', "<h1>Plan</h1><p><b data-bl-e=bl-1><b><b><b>x</p><p>y</p><script>const t = 'Plan'; const u = 'Lonely';</script>");
    const map = mapOf(src);
    expect(map.runs).toEqual([]);
    expectShadow(map, 'Plan');
    expect(matchFree(map, 'Lonely').confidence).toBe('exact');
  });

  it('text directly under a parser-invented element (an implied <body>)', () => {
    const src = "<!doctype html><title>t</title>Loose words<script>const t = 'Loose words';</script>";
    const map = mapOf(src);
    expect(map.runs).toEqual([]);
    expectShadow(map, 'Loose words');
    expect(map.shadows!.find((s) => s.value === 'Loose words')?.kind).toBe('invented-parent');
  });

  it('a text index held by two clones (reconstruction with attributes)', () => {
    const src = doc('', "<p><b class=k>bold</p><p>more</p><script>const a = 'bold'; const b = 'more';</script>");
    const map = mapOf(src);
    expectShadow(map, 'bold');
    expectShadow(map, 'more');
  });
});

describe('finding 3: computed numbers are never exact to a lone string literal', () => {
  it('KPI 600 rendered from DATA.deals, and setAttribute(\u2018width\u2019, \u2018600\u2019)', () => {
    const src = doc(
      '',
      '<h1>Pipeline</h1><p>Deals in flight: <b id="v"></b></p><canvas id="c"></canvas>\n' +
        "<script>\nconst DATA = { deals: 600 };\ndocument.getElementById('v').textContent = DATA.deals;\n" +
        "document.getElementById('c').setAttribute('width', '600');\n</script>",
    );
    const map = mapOf(src);
    expectShadow(map, '600');
    expect(map.shadows).toContainEqual(expect.objectContaining({ value: '600', kind: 'number' }));
  });

  it('a slide counter "1" and style.opacity = \u20181\u2019', () => {
    const src = doc('', "<span id=\"n\"></span><script>let i = 0; document.getElementById('n').textContent = i + 1; document.body.style.opacity = '1';</script>");
    expectShadow(mapOf(src), '1');
  });

  it('Intl output "1,234" from DATA.revenue = 1234 and a fallback literal \u20181,234\u2019', () => {
    const src = doc(
      '',
      "<b id=\"r\"></b><script>const DATA = { revenue: 1234 };\ndocument.getElementById('r').textContent = new Intl.NumberFormat('en-US').format(DATA.revenue);\n" +
        "const legacy = ['1,234'];</script>",
    );
    expectShadow(mapOf(src), '1,234');
  });

  it('numbers in JSON blocks, numeric keys, bigints and negative numbers', () => {
    const src = doc(
      '',
      '<script type="application/json" id="d">{"deals": 600, "rate": 1.50, "big": 1234567}</script>' +
        "<script>const o = { 42: 'x' }; const b = 77n; const neg = -5;\nconst L = ['600', '1.5', '1,234,567', '42', '77', '-5'];</script>",
    );
    const map = mapOf(src);
    for (const t of ['600', '1.5', '1,234,567', '42', '77', '-5']) expectShadow(map, t);
  });

  it('a number-like literal is exact only if its text occurs exactly once in the whole file', () => {
    // No numeric literal 600 here, but the CSS holds "600": the literal is not the only place the text is.
    const src = doc('<style>.chart { width: 600px }</style>', "<b id=\"v\"></b><script>document.getElementById('v').textContent = '600';</script>");
    const map = mapOf(src);
    expectShadow(map, '600');
    expect(map.shadows).toContainEqual(expect.objectContaining({ value: '600', kind: 'repeated-number' }));
  });

  it('control: a unique number-like literal stays exact, and a number never written elsewhere is computed', () => {
    const src = doc('', "<b id=\"g\"></b><b id=\"k\"></b><script>document.getElementById('g').textContent = '17.5%';\nconst DATA = { deals: 905 }; document.getElementById('k').textContent = DATA.deals;</script>");
    const map = mapOf(src);
    expect(matchFree(map, '17.5%')).toMatchObject({ confidence: 'exact', runId: literal(map, '17.5%').id });
    expect(matchFree(map, '905')).toMatchObject({ confidence: 'none', reason: 'computed' });
  });
});
