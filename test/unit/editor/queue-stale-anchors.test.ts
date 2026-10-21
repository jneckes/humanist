// A stale edit, an undo and a redo are written only where the text on BOTH sides confirms the place
// (packages/editor/src/anchors.ts; lead decision E-1, the hardening round after the repair). Each case below is an
// attack that wrote into another copy of the text on the tree before it (the placement rules of the repair, and
// undo case 2's context search): it must now be a verbatim note (or a refused undo) with the file exactly as the
// other program left it, never a write into the other copy. The controls show what is still written.
import { parse, serialize } from 'parse5';
import { describe, expect, it } from 'vitest';
import { createWriteQueue } from '@blueline/editor';
import { MemIO } from './helpers';

const DOC = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Deck</title></head><body>\n';
const END = '</body></html>\n';
const deck = (...parts: string[]): string => DOC + parts.join('') + END;
const slide = (h: string, body: string, id = ''): string =>
  `<section class="slide"${id ? ` id="${id}"` : ''}>\n  <div class="kicker">Quarterly review</div>\n  <h2>${h}</h2>\n  <p>${body}</p>\n</section>\n`;

/** The stale edit of the `which`-th run (source order) whose value is `value` in A, sent after the file became C. */
async function stale(A: string, C: string, value: string, which: number, after: string) {
  const io = new MemIO(A);
  const q = createWriteQueue(io);
  const m = await q.refresh();
  const run = [...m.runs, ...m.literals].filter((r) => r.value === value).sort((a, b) => a.start - b.start)[which];
  expect(run, `run #${which} of ${JSON.stringify(value)}`).toBeTruthy();
  io.external(C);
  const out = await q.edit({ version: m.version, runId: run.id, beforeText: value, afterText: after });
  return { out, io };
}

/** A note that keeps the author's words, with the other program's file left exactly as it was. */
function expectNote(r: Awaited<ReturnType<typeof stale>>, C: string, value: string, after: string): void {
  expect(r.out).toMatchObject({ ok: false, verbatim: { before: value, after } });
  expect(r.io.text).toBe(C);
  expect(r.io.writes).toBe(0);
}

describe('copies spelled differently, a serialiser and a deleted slide (structural finding 1)', () => {
  for (const [a, b] of [
    ['R&amp;D update', 'R&D update'],
    ['Q3&nbsp;results', 'Q3 results'],
    ['Sales &amp; marketing', 'Sales & marketing'],
  ]) {
    it(`${a}: a DOM serialiser removes the author's slide and respells the other copy`, async () => {
      const A = deck(slide('Agenda', 'What we cover today'), slide(a, 'Revenue grew in every region'), slide(b, 'Costs fell in two regions'), slide('Next steps', 'Owners and dates'));
      const doc = parse(A) as unknown as { childNodes: { tagName?: string; childNodes: { tagName?: string }[] }[] };
      const body = doc.childNodes.find((n) => n.tagName === 'html')!.childNodes.find((n) => n.tagName === 'body') as unknown as { childNodes: { tagName?: string }[] };
      const secs = body.childNodes.filter((c) => c.tagName === 'section');
      body.childNodes.splice(body.childNodes.indexOf(secs[1]), 2);
      const C = serialize(doc as never);
      const value = a.replace('&amp;', '&').replace('&nbsp;', ' ');
      expectNote(await stale(A, C, value, 0, `${value} draft`), C, value, `${value} draft`);
    });
  }

  it('JS literals: the author\'s entry deleted and the other one requoted', async () => {
    const js = (entries: string) => `${DOC}<div id="root"></div>\n<script>\nconst items = [\n${entries}];\nfor (const i of items) { const h = document.createElement('h3'); h.textContent = i.title; document.getElementById('root').appendChild(h); }\n</script>\n${END}`;
    const A = js(`  { id: "r", title: "It's here", note: "Revenue grew" },\n  { id: 'o', title: 'It\\'s here', note: 'Costs fell' },\n`);
    const C = js(`  { id: "o", title: "It's here", note: "Costs fell" },\n`);
    expectNote(await stale(A, C, "It's here", 0, "It's here now"), C, "It's here", "It's here now");
  });
});

describe('the author\'s copy re-wrapped while a templated slide is inserted before it (structural finding 2)', () => {
  const A = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Revenue grew in every region'), slide('Next steps', 'Owners and dates'));
  const inserted = slide('Key takeaways', 'Costs fell in two regions');
  for (const wrapped of ['<em>Key takeaways</em>', '<strong>Key takeaways</strong>', '<span class="hl">Key takeaways</span>', '<a href="#r">Key takeaways</a>']) {
    it(`heading ${wrapped}`, async () => {
      const C = deck(slide('Agenda', 'What we cover today'), inserted, slide(wrapped, 'Revenue grew in every region'), slide('Next steps', 'Owners and dates'));
      expectNote(await stale(A, C, 'Key takeaways', 0, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two');
    });
  }
  it('<h2> changed to <h3>', async () => {
    const C = deck(slide('Agenda', 'What we cover today'), inserted, slide('Key takeaways', 'Revenue grew in every region').replace(/<(\/?)h2>/g, '<$1h3>'), slide('Next steps', 'Owners and dates'));
    expectNote(await stale(A, C, 'Key takeaways', 0, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two');
  });
  it('a duplicate of the author\'s slide inserted before it, the original wrapped', async () => {
    const C = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Revenue grew in every region'), slide('<em>Key takeaways</em>', 'Revenue grew in every region'), slide('Next steps', 'Owners and dates'));
    expectNote(await stale(A, C, 'Key takeaways', 0, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two');
  });
});

describe('the author\'s copy changed or deleted, another copy next to its unchanged context on one side (structural finding 3)', () => {
  const page = (rows: string) =>
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>Plans</title></head><body>\n<section class="slide">\n<h2>Plans</h2>\n<table>\n  <thead><tr><th>Feature</th><th>Basic</th><th>Pro</th><th>Team</th></tr></thead>\n  <tbody>\n${rows}  </tbody>\n</table>\n</section>\n</body></html>\n`;
  const tr = (cells: string[]) => `    <tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>\n`;
  const rows = [
    ['Single sign-on', 'Partial', 'Yes', 'No'],
    ['Audit log', 'Yes', 'Partial', 'Partial'],
    ['API access', 'No', 'Partial', 'No'],
  ];
  const A = page(rows.map(tr).join(''));
  it('a table: the author\'s cell set to another value and a row ending in the old value appended', async () => {
    const C = page([rows[0], rows[1], ['API access', 'No', 'Partial', 'Yes'], ['Uptime SLA', 'Yes', 'Partial', 'No']].map(tr).join(''));
    expectNote(await stale(A, C, 'No', 2, 'No (beta)'), C, 'No', 'No (beta)');
  });
  it('a table: the author\'s row deleted and a row ending in the old value appended', async () => {
    const C = page([rows[0], rows[1], ['Uptime SLA', 'Yes', 'Partial', 'No']].map(tr).join(''));
    expectNote(await stale(A, C, 'No', 2, 'No (beta)'), C, 'No', 'No (beta)');
  });
  it('a list: the author\'s item deleted and the one before it set to the same value', async () => {
    const li = (a: string, b: string) => `  <li class="row"><b>${a}</b> <span>${b}</span></li>\n`;
    const list = (items: string) => `${DOC}<ul class="checks">\n${items}</ul>\n${END}`;
    const A2 = list(li('Single sign-on', 'No') + li('Audit log', 'Partial') + li('API access', 'Partial'));
    const C2 = list(li('Single sign-on', 'Partial') + li('API access', 'Partial'));
    expectNote(await stale(A2, C2, 'Partial', 0, 'Partial (beta)'), C2, 'Partial', 'Partial (beta)');
  });
  it('slides: the author\'s slide deleted and the next templated slide\'s subtitle edited', async () => {
    const s = (sub: string, body: string) => `<section class="slide">\n  <div class="kicker">Quarterly review</div>\n  <h2 class="title">Key takeaways</h2>\n  <p class="sub">${sub}</p>\n  <p>${body}</p>\n  <footer>Acme Corp · Confidential</footer>\n</section>\n`;
    const title = '<section class="slide">\n  <h1>Quarterly review</h1>\n</section>\n';
    const A3 = deck(title, s('Hire two engineers', 'Revenue grew in every region'), s('Cut two vendors', 'Costs fell in two regions'));
    for (const sub of ['Cut three vendors', 'Cut two suppliers']) {
      const C3 = deck(title, s(sub, 'Costs fell in two regions'));
      expectNote(await stale(A3, C3, 'Key takeaways', 0, 'Key takeaways (draft)'), C3, 'Key takeaways', 'Key takeaways (draft)');
    }
  });
});

describe('one copy before and one after, another place now holding the text (structural finding 4)', () => {
  const s = (id: string, h: string, b: string) => slide(h, b, id);
  const A = deck(s('a', 'Agenda', 'What we cover today'), s('r', 'Key takeaways', 'Revenue grew in every region'), s('o', 'Key takeaway', 'Costs fell in two regions'), s('n', 'Next steps', 'Owners'));
  it('a near copy fixed while the author\'s slide is deleted', async () => {
    const C = deck(s('a', 'Agenda', 'What we cover today'), s('o', 'Key takeaways', 'Costs fell in two regions'), s('n', 'Next steps', 'Owners'));
    expectNote(await stale(A, C, 'Key takeaways', 0, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two');
  });
  it('a commented-out slide restored, a slide out of a <template>, another slide renamed', async () => {
    const A1 = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Revenue grew in every region'), `<!--\n${slide('Key takeaways', 'Costs fell in two regions')}-->\n`, slide('Next steps', 'Owners'));
    const C1 = deck(slide('Agenda', 'What we cover today'), `${slide('Key takeaways', 'Costs fell in two regions')}\n`, slide('Next steps', 'Owners'));
    expectNote(await stale(A1, C1, 'Key takeaways', 0, 'Key takeaways two'), C1, 'Key takeaways', 'Key takeaways two');
    const A2 = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Revenue grew in every region'), `<template id="spare">\n${slide('Key takeaways', 'Costs fell in two regions')}</template>\n`, slide('Next steps', 'Owners'));
    const C2 = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Costs fell in two regions'), slide('Next steps', 'Owners'));
    expectNote(await stale(A2, C2, 'Key takeaways', 0, 'Key takeaways two'), C2, 'Key takeaways', 'Key takeaways two');
    const A3 = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Revenue grew in every region'), slide('Summary', 'Costs fell in two regions'), slide('Next steps', 'Owners'));
    const C3 = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Costs fell in two regions'), slide('Next steps', 'Owners'));
    expectNote(await stale(A3, C3, 'Key takeaways', 0, 'Key takeaways two'), C3, 'Key takeaways', 'Key takeaways two');
  });
  it('a copy of the author\'s slide with another id, left where the author\'s slide was deleted', async () => {
    const t = (id: string) => `<section class="slide" id="${id}">\n  <div class="kicker">Section recap</div>\n  <h2 class="title">Key takeaways</h2>\n  <p class="sub">Same subtitle</p>\n  <p>Body text</p>\n</section>\n`;
    const A4 = deck(slide('Agenda', 'What we cover today', 's1'), t('s4'));
    const C4 = deck(slide('Agenda', 'What we cover today', 's1'), t('s4c'));
    expectNote(await stale(A4, C4, 'Key takeaways', 0, 'Key takeaways two'), C4, 'Key takeaways', 'Key takeaways two');
  });
});

describe('a formatter\'s white space in the author\'s heading, a templated slide inserted before it (structural finding 5)', () => {
  const A = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Revenue grew in every region'), slide('Next steps', 'Owners and dates'));
  for (const h of ['\n    Key takeaways\n  ', ' Key takeaways ']) {
    it(JSON.stringify(h), async () => {
      const C = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Costs fell in two regions'), slide(h, 'Revenue grew in every region'), slide('Next steps', 'Owners and dates'));
      expectNote(await stale(A, C, 'Key takeaways', 0, 'Key takeaways (x)'), C, 'Key takeaways', 'Key takeaways (x)');
    });
  }
});

describe('two short records with the same text swapped, or the edited one moved and rewritten (literals findings 1 and 2)', () => {
  it('a task list: the 1st and 3rd items swapped', async () => {
    const li = (a: string, b: string) => `  <li><b>${a}</b> <i>${b}</i></li>\n`;
    const ul = (items: string) => `${DOC}<ul class="tasks">\n${items}</ul>\n${END}`;
    const A = ul(li('Hire', 'Open') + li('Ship', 'Done') + li('Hire', 'Done'));
    const C = ul(li('Hire', 'Done') + li('Ship', 'Done') + li('Hire', 'Open'));
    const wrong = ul(li('Hire', 'Done') + li('Ship', 'Done') + li('Hire two', 'Open'));
    const r = await stale(A, C, 'Hire', 1, 'Hire two');
    expect(r.io.text).not.toBe(wrong);
    expectNote(r, C, 'Hire', 'Hire two');
  });
  it('table rows, a JS array and one template literal, reversed', async () => {
    const tr = (a: string, b: string) => `  <tr><td>${a}</td><td>${b}</td></tr>\n`;
    const table = (x: string) => `${DOC}<table>\n${x}</table>\n${END}`;
    const A1 = table(tr('Growth', 'Open') + tr('Churn', 'Done') + tr('Growth', 'Done'));
    const C1 = table(tr('Growth', 'Done') + tr('Churn', 'Done') + tr('Growth', 'Open'));
    expectNote(await stale(A1, C1, 'Growth', 1, 'Growth two'), C1, 'Growth', 'Growth two');
    const c = (a: string, b: string) => `  { title: "${a}", status: "${b}" },\n`;
    const js = (cards: string) => `${DOC}<div id="root"></div>\n<script>\nconst cards = [\n${cards}];\nfor (const x of cards) { const h = document.createElement('h3'); h.textContent = x.title; document.getElementById('root').appendChild(h); }\n</script>\n${END}`;
    const A2 = js(c('Growth', 'Open') + c('Churn', 'Done') + c('Growth', 'Done'));
    const C2 = js(c('Growth', 'Done') + c('Churn', 'Done') + c('Growth', 'Open'));
    expectNote(await stale(A2, C2, 'Growth', 1, 'Growth two'), C2, 'Growth', 'Growth two');
    const card = (a: string, b: string) => `<div class="card"><h3>${a}</h3><p>${b}</p></div>`;
    const tpl = (x: string) => `${DOC}<div id="root"></div>\n<script>\ndocument.getElementById('root').innerHTML = \`${x}\`;\n</script>\n${END}`;
    const A3 = tpl(card('Growth', 'Open') + card('Churn', 'Done') + card('Growth', 'Done'));
    const C3 = tpl(card('Growth', 'Done') + card('Churn', 'Done') + card('Growth', 'Open'));
    expectNote(await stale(A3, C3, 'Growth', 1, 'Growth two'), C3, 'Growth', 'Growth two');
  });
  it('the edited item moved to the top and its text rewritten (HTML list, JSON block)', async () => {
    const A1 = `${DOC}<ul><li><b>Revenue</b> <i>Done</i></li><li><b>Growth</b> <i>Done</i></li></ul>\n${END}`;
    const C1 = `${DOC}<ul><li><b>Growth</b> <i>Agent text</i></li><li><b>Revenue</b> <i>Done</i></li></ul>\n${END}`;
    expectNote(await stale(A1, C1, 'Done', 1, 'Done two'), C1, 'Done', 'Done two');
    const json = (j: string) => `${DOC}<script type="application/json" id="data">${j}</script>\n${END}`;
    const A2 = json('[{"title":"Revenue","tag":"Done"},{"title":"Growth","tag":"Done"}]');
    const C2 = json('[{"title":"Growth","tag":"Done x"},{"title":"Revenue","tag":"Done"}]');
    expectNote(await stale(A2, C2, 'Done', 1, 'Done two'), C2, 'Done', 'Done two');
  });
});

describe('what is still written (controls)', () => {
  const far = (n: number) => Array.from({ length: n }, (_, i) => `<p>Filler paragraph ${i} of the deck, with its own words.</p>\n`).join('');
  const A = deck(slide('Agenda', 'What we cover today', 'a'), far(6), slide('Key takeaways', 'Revenue grew in every region', 'r'), far(6), slide('Key takeaways', 'Costs fell in two regions', 'o'), far(6), slide('Next steps', 'Owners and dates', 'n'));
  it('a change far from the run, before and after it: both copies are written where the author typed', async () => {
    const C = A.replace('Filler paragraph 0 of', 'Filler paragraph zero of').replace('Owners and dates', 'Owners, dates and budgets');
    for (const which of [0, 1]) {
      const r = await stale(A, C, 'Key takeaways', which, 'Key takeaways two');
      expect(r.out).toMatchObject({ ok: true, merged: true });
      const at = C.split('<h2>Key takeaways</h2>');
      expect(r.io.text).toBe(which === 0 ? `${at[0]}<h2>Key takeaways two</h2>${at[1]}<h2>Key takeaways</h2>${at[2]}` : `${at[0]}<h2>Key takeaways</h2>${at[1]}<h2>Key takeaways two</h2>${at[2]}`);
    }
  });
  it('a slide inserted far before the run and one moved far after it: written on the author\'s slide', async () => {
    const C = A.replace('<section class="slide" id="a">', `${slide('New slide', 'Added by the agent', 'x')}<section class="slide" id="a">`);
    const r = await stale(A, C, 'Key takeaways', 1, 'Key takeaways two');
    expect(r.out.ok).toBe(true);
    expect(r.io.text).toBe(C.replace('<h2>Key takeaways</h2>\n  <p>Costs fell', '<h2>Key takeaways two</h2>\n  <p>Costs fell'));
  });
  it('a change right next to the run is a note: the text there no longer says which copy it is (E-1)', async () => {
    const C = A.replace('Costs fell in two regions', 'Costs fell in three regions');
    const r = await stale(A, C, 'Key takeaways', 1, 'Key takeaways two');
    expectNote(r, C, 'Key takeaways', 'Key takeaways two');
  });
});

describe('undo and redo case 2 are placed by position too (literals findings 3 and 4)', () => {
  const s = (h: string, sub: string) => `<section class="slide">\n  <h2 class="title">${h}</h2>\n  <p class="sub">${sub}</p>\n</section>\n`;
  it('U1: a deletion makes the edited heading equal its twin, the edited slide\'s subtitle changes, undo: refused, never the twin', async () => {
    const A = deck(s('Revenue!', 'Up 12% this year'), s('Revenue', 'Up 12% this year'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const run = m.runs.find((r) => r.value === 'Revenue!')!;
    const out = await q.edit({ version: m.version, runId: run.id, beforeText: 'Revenue!', afterText: 'Revenue' });
    if (!out.ok) throw new Error(out.why);
    const C = deck(s('Revenue', 'Up 15% this year'), s('Revenue', 'Up 12% this year'));
    io.external(C);
    expect(await q.undo(out.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(C);
  });
  it('U2: an insertion makes it equal its twin: refused, the twin keeps its text', async () => {
    const A = deck(s('Key takeaways', 'Same subtitle here'), s('Key takeaway', 'Same subtitle here'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const run = m.runs.find((r) => r.value === 'Key takeaway')!;
    const out = await q.edit({ version: m.version, runId: run.id, beforeText: 'Key takeaway', afterText: 'Key takeaways' });
    if (!out.ok) throw new Error(out.why);
    const C = deck(s('Key takeaways', 'Same subtitle here'), s('Key takeaways', 'Agent subtitle!!'));
    io.external(C);
    expect(await q.undo(out.record)).toMatchObject({ ok: false, code: 'stale' });
    expect(io.text).toBe(C);
  });
  it('U3: JS cards, the edited card\'s note changes: refused, card 3 keeps its title', async () => {
    const card = (t: string, n: string) => `  { title: "${t}", note: "${n}" },\n`;
    const page = (cards: string) => `${DOC}<div id="root"></div>\n<script>\nconst cards = [\n${cards}];\nfor (const c of cards) { const d = document.createElement('div'); d.textContent = c.title + ' ' + c.note; document.getElementById('root').appendChild(d); }\n</script>\n${END}`;
    const N = 'Revenue up 12% on the year';
    const io = new MemIO(page(card('Intro', N) + card('Growth!', N) + card('Growth', N)));
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const run = m.literals.find((r) => r.value === 'Growth!')!;
    const out = await q.edit({ version: m.version, runId: run.id, beforeText: 'Growth!', afterText: 'Growth' });
    if (!out.ok) throw new Error(out.why);
    const C = page(card('Intro', N) + card('Growth', 'Revenue up 15% on the year') + card('Growth', N));
    io.external(C);
    expect(await q.undo(out.record)).toMatchObject({ ok: false, code: 'stale' });
    expect(io.text).toBe(C);
  });
  it('R1, R2: redo after an external change near the undone copy: refused, never the identical twin', async () => {
    const A = deck(s('Key takeaways', 'Same subtitle here'), s('Key takeaways', 'Same subtitle here'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const run = m.runs.filter((r) => r.value === 'Key takeaways')[1];
    const w = await q.edit({ version: m.version, runId: run.id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    if (!w.ok) throw new Error(w.why);
    expect((await q.undo(w.record)).ok).toBe(true);
    const C = deck(s('Key takeaways', 'Same subtitle here'), s('Key takeaways', 'Agent rewrote it'));
    io.external(C);
    expect(await q.redo(w.record)).toMatchObject({ ok: false, code: 'stale' });
    expect(io.text).toBe(C);

    const card = (t: string, n: string) => `  { title: "${t}", note: "${n}" },\n`;
    const S = (cards: string) => `${DOC}<script>\nconst cards = [\n${cards}];\n</script>\n${END}`;
    const N = 'Revenue up 12% on the year';
    const io2 = new MemIO(S(card('Intro', N) + card('Growth', N) + card('Growth', N)));
    const q2 = createWriteQueue(io2);
    const m2 = await q2.refresh();
    const lit = m2.literals.filter((r) => r.value === 'Growth')[0];
    const w2 = await q2.edit({ version: m2.version, runId: lit.id, beforeText: 'Growth', afterText: 'Growth two' });
    if (!w2.ok) throw new Error(w2.why);
    expect((await q2.undo(w2.record)).ok).toBe(true);
    const C2 = S(card('Intro', N) + card('Growth', 'Revenue up 15% on the year') + card('Growth', N));
    io2.external(C2);
    expect(await q2.redo(w2.record)).toMatchObject({ ok: false, code: 'stale' });
    expect(io2.text).toBe(C2);
  });
  const pad = (k: string) => Array.from({ length: 8 }, (_, i) => `<p>Filler paragraph ${i} of part ${k}, with its own words.</p>\n`).join('');
  it('control: undo case 2 after a change far away still restores the bytes', async () => {
    const A = deck(pad('one'), s('Revenue!', 'Up 12% this year'), pad('two'), s('Revenue', 'Up 9% this year'), pad('three'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const run = m.runs.find((r) => r.value === 'Revenue!')!;
    const out = await q.edit({ version: m.version, runId: run.id, beforeText: 'Revenue!', afterText: 'Revenue' });
    if (!out.ok) throw new Error(out.why);
    const C = io.text.replace('Filler paragraph 0 of', 'Filler paragraph zero of');
    io.external(C);
    const u = await q.undo(out.record);
    expect(u.ok).toBe(true);
    expect(io.text).toBe(A.replace('Filler paragraph 0 of', 'Filler paragraph zero of'));
  });
  it('a version the queue no longer holds: undo case 2 is refused (case 3), never placed by text alone', async () => {
    for (const keepVersions of [8, 2]) {
      const A = deck(pad('one'), s('Revenue!', 'Up 12% this year'), pad('two'));
      const io = new MemIO(A);
      const q = createWriteQueue(io, { keepVersions });
      const m = await q.refresh();
      const out = await q.edit({ version: m.version, runId: m.runs.find((r) => r.value === 'Revenue!')!.id, beforeText: 'Revenue!', afterText: 'Revenue' });
      if (!out.ok) throw new Error(out.why);
      // Seven changes by another program: the queue also keeps the 6 versions around the last ones (carry), no more.
      for (let i = 0; i < 7; i++) {
        io.external(io.text.replace(`Filler paragraph ${i} of part one`, `Filler paragraph ${i}b of part one`));
        await q.refresh();
      }
      const now = io.text;
      const u = await q.undo(out.record);
      if (keepVersions === 8) {
        expect(u.ok).toBe(true);
        expect(io.text).toBe(now.replace('<h2 class="title">Revenue</h2>', '<h2 class="title">Revenue!</h2>'));
      } else {
        expect(u).toMatchObject({ ok: false, code: 'stale' });
        expect(io.text).toBe(now);
      }
    }
  });
});

describe('a stale edit after the author\'s own writes only is placed exactly through them', () => {
  const doc = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;
  it('three edits made on one version, right next to each other: each is written on its run', async () => {
    const io = new MemIO(doc('<p>One</p><p>Two</p><p>Three</p>'));
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const req = (v: string, after: string) => {
      const run = m.runs.find((r) => r.value === v)!;
      return { version: m.version, runId: run.id, beforeText: v, afterText: after };
    };
    const outs = await Promise.all([q.edit(req('One', 'One!')), q.edit(req('Two', 'Two!')), q.edit(req('Three', 'Three!'))]);
    expect(outs.map((o) => o.ok)).toEqual([true, true, true]);
    expect(io.text).toBe(doc('<p>One!</p><p>Two!</p><p>Three!</p>'));
  });
  it('the same copy of repeated text, the other copies edited by the author meanwhile: written on the right one', async () => {
    const io = new MemIO(doc('<p>Owner</p><p>Owner</p><p>Owner</p>'));
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const runs = m.runs.filter((r) => r.value === 'Owner');
    const outs = await Promise.all(runs.map((r, i) => q.edit({ version: m.version, runId: r.id, beforeText: 'Owner', afterText: `Owner ${i}` })));
    expect(outs.map((o) => o.ok)).toEqual([true, true, true]);
    expect(io.text).toBe(doc('<p>Owner 0</p><p>Owner 1</p><p>Owner 2</p>'));
  });
  it('another program\'s change between them: back to the diff and both sides, so a change next to the run is a note', async () => {
    const io = new MemIO(doc('<p>One</p><p>Two</p><p>Three</p>'));
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const two = m.runs.find((r) => r.value === 'Two')!;
    expect((await q.edit({ version: m.version, runId: m.runs.find((r) => r.value === 'One')!.id, beforeText: 'One', afterText: 'One!' })).ok).toBe(true);
    io.external(io.text.replace('<p>Three</p>', '<p>Three (agent)</p>'));
    const C = io.text;
    expect(await q.edit({ version: m.version, runId: two.id, beforeText: 'Two', afterText: 'Two!' })).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(C);
  });
  it('an undo and a redo of the author\'s write between: still placed exactly through them', async () => {
    const io = new MemIO(doc('<p>One</p><p>Two</p><p>Three</p>'));
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const req = (v: string, after: string) => ({ version: m.version, runId: m.runs.find((r) => r.value === v)!.id, beforeText: v, afterText: after });
    // Each write undone and redone right away (as the fuzz gate does): both return to versions already seen.
    for (const [v, after] of [['One', 'One!'], ['Two', 'Two!']]) {
      const w = await q.edit(req(v, after));
      if (!w.ok) throw new Error(w.why);
      expect((await q.undo(w.record)).ok).toBe(true);
      expect((await q.redo(w.record)).ok).toBe(true);
    }
    expect((await q.edit(req('Three', 'Three!'))).ok).toBe(true);
    expect(io.text).toBe(doc('<p>One!</p><p>Two!</p><p>Three!</p>'));
  });
  it('the author\'s own later write touched the run: never placed through it (a note, or the request does not fit)', async () => {
    const io = new MemIO(doc('<p>Alpha</p><p>Beta</p>'));
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const beta = m.runs.find((r) => r.value === 'Beta')!;
    expect((await q.edit({ version: m.version, runId: beta.id, beforeText: 'Beta', afterText: 'Beta one' })).ok).toBe(true);
    const now = io.text;
    const out = await q.edit({ version: m.version, runId: beta.id, beforeText: 'Beta', afterText: 'Beta two' });
    expect(out.ok).toBe(false);
    expect(io.text).toBe(now);
  });
});

describe('own writes and another program\'s change between: only the other program\'s change is placed by position', () => {
  const filler = (k: string) => Array.from({ length: 6 }, (_, i) => `<p>Filler paragraph ${i} of part ${k}, with its own words.</p>\n`).join('');
  const doc = (mid: string, end: string) =>
    `<!doctype html><html><head></head><body>\n<section><h2>Owner</h2><p>Summary</p></section>\n${filler('a')}<section><h2>Owner</h2>${mid}</section>\n${filler('b')}<p>${end}</p>\n</body></html>\n`;
  const owner = (m: { runs: { value: string; start: number; id: string }[] }, i: number) =>
    m.runs.filter((r) => r.value === 'Owner').sort((a, b) => a.start - b.start)[i];

  it('the author\'s write right next to the run, then a change far away: written on the right copy', async () => {
    const A = doc('<p>Summary</p>', 'Closing words');
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const sum2 = m.runs.filter((r) => r.value === 'Summary').sort((a, b) => a.start - b.start)[1];
    expect((await q.edit({ version: m.version, runId: sum2.id, beforeText: 'Summary', afterText: 'Summary, revised' })).ok).toBe(true);
    io.external(io.text.replace('Closing words', 'Closing words (agent)'));
    const out = await q.edit({ version: m.version, runId: owner(m, 1).id, beforeText: 'Owner', afterText: 'Owner B' });
    expect(out.ok).toBe(true);
    expect(io.text).toBe(doc('<p>Summary, revised</p>', 'Closing words (agent)').replace('<h2>Owner</h2><p>Summary, revised', '<h2>Owner B</h2><p>Summary, revised'));
  });

  it('another program\'s change first, then the author\'s write right next to the run: written on the right copy', async () => {
    const A = doc('<p>Summary</p>', 'Closing words');
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    io.external(io.text.replace('Closing words', 'Closing words (agent)'));
    const m2 = await q.refresh();
    const sum2 = m2.runs.filter((r) => r.value === 'Summary').sort((a, b) => a.start - b.start)[1];
    expect((await q.edit({ version: m2.version, runId: sum2.id, beforeText: 'Summary', afterText: 'Summary, revised' })).ok).toBe(true);
    const out = await q.edit({ version: m.version, runId: owner(m, 1).id, beforeText: 'Owner', afterText: 'Owner B' });
    expect(out.ok).toBe(true);
    expect(io.text).toBe(doc('<p>Summary, revised</p>', 'Closing words (agent)').replace('<h2>Owner</h2><p>Summary, revised', '<h2>Owner B</h2><p>Summary, revised'));
  });

  it('the other program\'s change is next to the run: a note, the file as it was', async () => {
    const io = new MemIO(doc('<p>Summary</p>', 'Closing words'));
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const sum1 = m.runs.filter((r) => r.value === 'Summary').sort((a, b) => a.start - b.start)[0];
    expect((await q.edit({ version: m.version, runId: sum1.id, beforeText: 'Summary', afterText: 'Summary, revised' })).ok).toBe(true);
    // The other program deletes the author's slide's paragraph and puts the same heading's slide one later.
    io.external(io.text.replace('<h2>Owner</h2><p>Summary</p></section>', '<h2>Owner</h2></section>\n<section><h2>Owner</h2><p>Summary</p></section>'));
    const C = io.text;
    const out = await q.edit({ version: m.version, runId: owner(m, 1).id, beforeText: 'Owner', afterText: 'Owner B' });
    expect(out).toMatchObject({ ok: false, verbatim: { before: 'Owner', after: 'Owner B' } });
    expect(io.text).toBe(C);
  });

  it('many own writes after the other program\'s change: the versions around it are kept, written on the right copy', async () => {
    const io = new MemIO(doc('<p>Summary</p>', 'Closing words'));
    const q = createWriteQueue(io);
    const m = await q.refresh();
    q.know(m.version, io.text, m, { pin: true });
    const sum2 = m.runs.filter((r) => r.value === 'Summary').sort((a, b) => a.start - b.start)[1];
    expect((await q.edit({ version: m.version, runId: sum2.id, beforeText: 'Summary', afterText: 'Summary, revised' })).ok).toBe(true);
    io.external(io.text.replace('Closing words', 'Closing words (agent)'));
    // Twelve more own writes far away: more versions than the queue keeps unpinned (8).
    for (let k = 0; k < 12; k++) {
      const cm = await q.currentMap();
      const r = cm.runs.find((x) => x.value.startsWith(`Filler paragraph ${k % 6} of part a`))!;
      expect((await q.edit({ version: cm.version, runId: r.id, beforeText: r.value, afterText: `${r.value}.` })).ok).toBe(true);
    }
    const now = io.text;
    const out = await q.edit({ version: m.version, runId: owner(m, 1).id, beforeText: 'Owner', afterText: 'Owner B' });
    expect(out.ok).toBe(true);
    expect(io.text).toBe(now.replace('<h2>Owner</h2><p>Summary, revised', '<h2>Owner B</h2><p>Summary, revised'));
  });

  it('more than 3 changes by another program between: placed across the whole span (a note here)', async () => {
    const io = new MemIO(doc('<p>Summary</p>', 'Closing words'));
    const q = createWriteQueue(io);
    const m = await q.refresh();
    q.know(m.version, io.text, m, { pin: true });
    const sum2 = m.runs.filter((r) => r.value === 'Summary').sort((a, b) => a.start - b.start)[1];
    expect((await q.edit({ version: m.version, runId: sum2.id, beforeText: 'Summary', afterText: 'Summary, revised' })).ok).toBe(true);
    for (let k = 1; k <= 4; k++) {
      io.external(io.text.replace(/Closing words[^<]*/, `Closing words (agent ${k})`));
      await q.refresh();
    }
    const C = io.text;
    const out = await q.edit({ version: m.version, runId: owner(m, 1).id, beforeText: 'Owner', afterText: 'Owner B' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(C);
  });
});
