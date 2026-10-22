// The second hardening round: wrong-place writes three attackers found in the build after the first round, each must
// now leave the author's words as a verbatim note (or refuse the undo) with the file exactly as the other program
// left it, never write into another copy of the text. The controls show what is still written.
//
//   - a program that renumbers slides by position (a deck generator run again, a script that renumbers ids and page
//     counters) gives the author's id and counter to the slide now at the author's old position (place.ts rule 3,
//     records.ts);
//   - a new card or record modelled on the author's, put beside it while the word next to the author's label is
//     renamed (rule 3), and Cmd+Z after the same shape (undo case 2 carried through the queue's steps);
//   - a deck another program is still writing in place (write-queue.ts readWhole);
//   - Blueline's own writes between a write and its undo, between a field's version and its commit, and a restore
//     (write-queue.ts carryRange: own writes exactly, a restore placed as another program's change; no whole-span
//     diff across Blueline's own writes).
import { describe, expect, it } from 'vitest';
import { createWriteQueue } from '@blueline/editor';
import { encodeDeck } from '@blueline/core/text';
import type { DeckMap } from '@blueline/core/types';
import { MemIO } from './helpers';

const DOC = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Deck</title></head><body>\n';
const END = '</body></html>\n';
const deck = (...parts: string[]): string => DOC + parts.join('') + END;

function runs(m: DeckMap, value: string) {
  return [...m.runs, ...m.literals].filter((r) => r.value === value).sort((a, b) => a.start - b.start);
}

/** The stale edit of the `which`-th run holding `value` in A, sent after the file became C. */
async function stale(A: string, C: string, value: string, which: number, after: string) {
  const io = new MemIO(A);
  const q = createWriteQueue(io);
  const m = await q.refresh();
  const run = runs(m, value)[which];
  expect(run, `run #${which} of ${JSON.stringify(value)}`).toBeTruthy();
  io.external(C);
  const out = await q.edit({ version: m.version, runId: run.id, beforeText: value, afterText: after });
  return { out, io };
}

function expectNote(r: Awaited<ReturnType<typeof stale>>, C: string, value: string, after: string): void {
  expect(r.out).toMatchObject({ ok: false, verbatim: { before: value, after } });
  expect(r.io.text).toBe(C);
  expect(r.io.writes).toBe(0);
}

describe('a program that renumbers slides by position (tools finding 1)', () => {
  const T = '<div class="frame"><div class="rule"></div><div class="logo">Acme</div></div>';
  const slide = (n: number, h: string, body: string) =>
    `<section id="s${n}">${T}${T}<h2>${h}</h2><span class="pg">${n}</span>${T}${T}<p>${body}</p></section>\n`;
  const mk = (rows: string[][]) => deck(...rows.map(([h, b], i) => slide(i + 1, h, b)));

  it('slides 2 and 3 swapped and renumbered: a note, never the slide now numbered 2', async () => {
    const A = mk([['Agenda', 'Today'], ['Results', 'Revenue grew'], ['Results', 'Margins held'], ['Next', 'Dates']]);
    const C = mk([['Agenda', 'Today'], ['Results', 'Margins held'], ['Results', 'Revenue grew'], ['Next', 'Dates']]);
    expectNote(await stale(A, C, 'Results', 0, 'Results Q3'), C, 'Results', 'Results Q3');
  });

  it('slide 2 deleted and the rest renumbered, the author typed in slide 3: a note', async () => {
    const sl = [['Agenda', 'Today'], ['Results', 'Revenue grew'], ['Results', 'Margins held'], ['Results', 'Costs fell'], ['Next', 'Dates']];
    const A = mk(sl);
    const C = mk([sl[0], sl[2], sl[3], sl[4]]);
    expectNote(await stale(A, C, 'Results', 1, 'Results Q3'), C, 'Results', 'Results Q3');
  });

  // A generated, Tailwind-style deck: long class lists, a section label and an "NN / TT" page counter in each header.
  const tw = (n: number, total: number | null, label: string, title: string, body: string) =>
    `<section id="slide-${n}" class="relative flex min-h-screen w-full flex-col justify-between overflow-hidden bg-white px-16 py-12 text-slate-900 antialiased">\n` +
    `  <header class="flex items-center justify-between border-b border-slate-200 pb-4 text-sm font-medium uppercase tracking-widest text-slate-500"><h2 class="text-xs font-semibold">${label}</h2><span class="tabular-nums">${String(n).padStart(2, '0')}${total === null ? '' : ` / ${String(total).padStart(2, '0')}`}</span></header>\n` +
    `  <div class="mx-auto grid w-full max-w-6xl grid-cols-12 gap-8"><div class="col-span-8 flex flex-col gap-6"><h3 class="text-5xl font-bold leading-tight">${title}</h3><p class="text-xl leading-relaxed text-slate-600">${body}</p></div></div>\n` +
    `</section>\n`;
  const twDeck = (rows: string[][]) => deck(...rows.map(([l, t, b], i) => tw(i + 1, rows.length, l, t, b)));
  const SL = [
    ['Overview', 'Where we stand', 'A short summary of the quarter.'],
    ['Results', 'Revenue grew in every region', 'All four regions beat their targets.'],
    ['Results', 'Margins held', 'Gross margin stayed at 41 percent.'],
    ['Results', 'Costs fell', 'Two regions cut their spend.'],
    ['Next', 'What happens next', 'Owners and dates for each item.'],
  ];

  for (const [name, order] of [
    ['slides 2 and 3 swapped', [0, 2, 1, 3, 4]],
    ['slide 2 moved after slide 4', [0, 2, 3, 1, 4]],
  ] as const) {
    it(`a generator run again after ${name}: a note`, async () => {
      const A = twDeck(SL);
      const C = twDeck(order.map((i) => SL[i]));
      expectNote(await stale(A, C, 'Results', 0, 'Results Q3'), C, 'Results', 'Results Q3');
    });
  }

  it('a generator run again after slide 2 was deleted (page numbers without a total), the author typed in slide 3: a note', async () => {
    const nt = (rows: string[][]) => deck(...rows.map(([l, t, b], i) => tw(i + 1, null, l, t, b)));
    const A = nt(SL);
    const C = nt([SL[0], SL[2], SL[3], SL[4]]);
    expectNote(await stale(A, C, 'Results', 1, 'Results Q3'), C, 'Results', 'Results Q3');
  });

  it('a generator run again after the author\'s own slide was deleted: a note, never the slide renumbered into its place', async () => {
    const nt = (rows: string[][]) => deck(...rows.map(([l, t, b], i) => tw(i + 1, null, l, t, b)));
    const A = nt(SL);
    const C = nt([SL[0], SL[2], SL[3], SL[4]]);
    expectNote(await stale(A, C, 'Results', 0, 'Results Q3'), C, 'Results', 'Results Q3');
  });

  it('control: the same swap with ids that go with their slides is never written into the other slide', async () => {
    const sem = (id: string, h: string, body: string) => `<section id="${id}">${T}${T}<h2>${h}</h2>${T}${T}<p>${body}</p></section>\n`;
    const A = deck(sem('agenda', 'Agenda', 'Today'), sem('rev', 'Results', 'Revenue grew'), sem('mar', 'Results', 'Margins held'), sem('next', 'Next', 'Dates'));
    const C = deck(sem('agenda', 'Agenda', 'Today'), sem('mar', 'Results', 'Margins held'), sem('rev', 'Results', 'Revenue grew'), sem('next', 'Next', 'Dates'));
    const r = await stale(A, C, 'Results', 0, 'Results Q3');
    if (r.out.ok) expect(r.io.text).toBe(C.replace('<h2>Results</h2>' + T + T + '<p>Revenue grew', '<h2>Results Q3</h2>' + T + T + '<p>Revenue grew'));
    else expect(r.io.text).toBe(C);
  });

  it('control: a slide appended after the author\'s, numbers before it unchanged: written in the author\'s slide', async () => {
    const A = mk([['Agenda', 'Today'], ['Results', 'Revenue grew'], ['Results', 'Margins held'], ['Next', 'Dates']]);
    const C = mk([['Agenda', 'Today'], ['Results', 'Revenue grew'], ['Results', 'Margins held'], ['Next', 'Dates'], ['Appendix', 'Method']]);
    const r = await stale(A, C, 'Results', 0, 'Results Q3');
    expect(r.out.ok).toBe(true);
    expect(r.io.text).toBe(mk([['Agenda', 'Today'], ['Results Q3', 'Revenue grew'], ['Results', 'Margins held'], ['Next', 'Dates'], ['Appendix', 'Method']]));
  });
});

describe('a new card or record modelled on the author\'s (decks findings 3 and 4)', () => {
  const LEAD = 'We will review the plan with the regional leads before the end of the month and agree on owners for every open item on the list';
  const REST = 'then report back to the board in the first week of the next quarter with a short written summary.';
  const NEW = 'and close the hiring plan for the two new support roles before the holidays start.';
  const card = (label: string, code: string, lead: string, rest: string) =>
    `<div class="card"><span class="label">${label}</span><p><code>${code}</code> ${lead}, ${rest}</p></div>\n`;
  const page = (cards: string) => `<!doctype html>\n<html><head><meta charset="utf-8"><title>T</title></head><body>\n<div class="cards">\n${cards}</div>\n</body></html>\n`;
  const ctx = card('Context', 'ctx-01', 'Sales grew in three of the four regions this year while costs stayed flat across the group as a whole', 'mostly thanks to the new pricing.');
  const risks = (label: string) => card(label, 'risk-03', 'Two suppliers may raise prices in the spring and one contract ends in June without a renewal option', 'so we are talking to others.');

  it('a new card above the author\'s, its tag renamed: a note, never the new card', async () => {
    const author = card('Next steps', 'step-02', LEAD, REST);
    const A = page(ctx + author + risks('Risks'));
    const C = A.replace(author, card('Next steps', 'step-02', LEAD, NEW) + author.replace('<code>step-02</code>', '<code>stage-2</code>'));
    expectNote(await stale(A, C, 'Next steps', 0, 'Next steps now'), C, 'Next steps', 'Next steps now');
  });

  it('the same in a page without <html> and <body> tags (elements the parser implies), with a third card of that label', async () => {
    const bare = (cards: string) => `<!doctype html>\n<meta charset="utf-8"><title>T</title>\n<div class="cards">\n${cards}</div>\n`;
    const author = card('Next steps', 'step-02', LEAD, REST);
    const A = bare(ctx + author + risks('Next steps'));
    const C = A.replace(author, card('Next steps', 'step-02', LEAD, NEW) + author.replace('<code>step-02</code>', '<code>stage-2</code>'));
    expectNote(await stale(A, C, 'Next steps', 0, 'Next steps now'), C, 'Next steps', 'Next steps now');
  });

  it('a data record duplicated above the author\'s with its other fields rewritten, the next field renamed: a note', async () => {
    const rec = (title: string, code: string, lead: string, rest: string) => `  { title: "${title}", code: "${code}", lead: "${lead}", rest: "${rest}" },\n`;
    const js = (rows: string) => `${DOC}<div id="root"></div>\n<script>\nconst cards = [\n${rows}];\nfor (const c of cards) { const h = document.createElement('h3'); h.textContent = c.title; document.getElementById('root').appendChild(h); }\n</script>\n${END}`;
    const author = rec('Next steps', 'step-02', LEAD, REST);
    const A = js(rec('Context', 'ctx-01', 'Sales grew in three regions', 'thanks to pricing.') + author + rec('Risks', 'risk-03', 'Two suppliers may raise prices', 'talking to others.'));
    const C = A.replace(author, rec('Next steps', 'step-02', LEAD, NEW) + author.replace('"step-02"', '"stage-2"'));
    expectNote(await stale(A, C, 'Next steps', 0, 'Next steps now'), C, 'Next steps', 'Next steps now');
  });

  it('a row duplicated right after itself, the cell before the edited one reworded in the first: a note', async () => {
    const row = (y: number, cells: string[]) => `<div class="g-row"><span class="y">${y}</span>${cells.map((c) => `<span class="c-x">${c}</span>`).join('')}</div>\n`;
    const cells = (k: number) => ['Low', 'Mid', 'Top', 'Low', 'Mid', 'Top'].map((c, i) => (i === 5 ? 'Yes' : `${c}${k}${i}`));
    const grid = (rows: string) => `<!doctype html>\n<html><head><meta charset="utf-8"><title>T</title></head><body>\n<div class="grid">\n${rows}</div>\n</body></html>\n`;
    const A = grid(row(2023, cells(3)) + row(2024, cells(4)) + row(2025, cells(5)));
    const r2024 = row(2024, cells(4));
    const C = A.replace(r2024, row(2024, cells(4).map((c, i) => (i === 4 ? `Key ${c}` : c))) + r2024);
    expectNote(await stale(A, C, 'Yes', 1, 'Yes!'), C, 'Yes', 'Yes!');
  });

  it('a copy below the author\'s card with the start of its common text rewritten, the author\'s code renamed: a note', async () => {
    const COMMON = 'Status: open. Owner: the regional lead for the area. Reviewed at the end of each quarter with the board and the finance team, then filed with the minutes of the meeting.';
    const rot13 = (t: string) => t.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + (c < 'a' ? 65 : 97)));
    const item = (code: string, common: string) => `<div class="card"><p>${common}</p><code>${code}</code><span class="label">Next steps</span></div>\n`;
    const A = page(item('step-01', COMMON) + item('step-02', COMMON) + item('step-03', COMMON));
    const author = item('step-02', COMMON);
    const C = A.replace(author, item('fgrc-02', COMMON) + item('step-02', rot13(COMMON.slice(0, 60)) + COMMON.slice(60)));
    expectNote(await stale(A, C, 'Next steps', 1, 'Next steps now'), C, 'Next steps', 'Next steps now');
  });

  it('control: a card with the same label and new text inserted below: written in the author\'s card', async () => {
    const author = card('Next steps', 'step-02', LEAD, REST);
    const A = page(ctx + author + risks('Risks'));
    const C = A.replace(author, author + card('Next steps', 'ops-07', 'Hire two support engineers for the new region and train them on the product', NEW));
    const r = await stale(A, C, 'Next steps', 0, 'Next steps now');
    expect(r.out.ok).toBe(true);
    expect(r.io.text).toBe(C.replace(author, author.replace('>Next steps<', '>Next steps now<')));
  });

  it('Cmd+Z after a new card modelled on the edited one is inserted above and the author\'s tag renamed: refused', async () => {
    const A = page(ctx + card('Next steps', 'step-02', LEAD, REST) + risks('Next steps'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runs(m, 'Next steps')[0].id, beforeText: 'Next steps', afterText: 'Next steps now' });
    if (!w.ok) throw new Error('the edit was not written');
    const edited = card('Next steps now', 'step-02', LEAD, REST);
    const C = io.text.replace(edited, card('Next steps now', 'step-02', LEAD, NEW) + edited.replace('<code>step-02</code>', '<code>stage-2</code>'));
    io.external(C);
    const u = await q.undo(w.record);
    expect(u).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(C);
  });
});

describe('a deck another program is still writing in place (tools finding 2)', () => {
  const slide = (h: string, body: string) =>
    `<section class="slide">\n  <h2>${h}</h2>\n  <p>${body}</p>\n  <p class="note">${'Filler text that makes the slide longer than the anchors. '.repeat(3)}</p>\n</section>\n`;
  const SL = [slide('Quarterly results', 'Revenue grew'), slide('Margins', 'Gross margin held'), slide('Costs', 'Two regions cut spend'), slide('Hiring', 'Open roles fell')];
  const A = deck(...SL);
  const C = deck(...SL, slide('Appendix', 'Method'));
  const cut = C.slice(0, C.indexOf('<section class="slide">\n  <h2>Costs'));
  const fast = { writerWaitMs: 40, writerPollMs: 5 };

  it('an edit, an undo and a redo on the half-written file are refused, and the file is left as it is', async () => {
    const io = new MemIO(A);
    const q = createWriteQueue(io, fast);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runs(m, 'Margins')[0].id, beforeText: 'Margins', afterText: 'Margins Q3' });
    if (!w.ok) throw new Error('setup');
    io.external(cut);
    const e = await q.edit({ version: m.version, runId: runs(m, 'Quarterly results')[0].id, beforeText: 'Quarterly results', afterText: 'Quarterly results now' });
    expect(e).toMatchObject({ ok: false, code: 'conflict', verbatim: { before: 'Quarterly results', after: 'Quarterly results now' } });
    expect(await q.undo(w.record)).toMatchObject({ ok: false, code: 'conflict' });
    expect(await q.redo(w.record)).toMatchObject({ ok: false, code: 'conflict' });
    expect(io.text).toBe(cut);
    expect(io.writes).toBe(1);
  });

  it('the program finishes while the edit waits: the edit lands on the whole file, in the author\'s slide', async () => {
    const io = new MemIO(A);
    let polls = 0;
    const q = createWriteQueue(io, {
      writerWaitMs: 5000,
      writerPollMs: 5,
      sleep: async () => {
        if (++polls === 3) io.external(C);
      },
    });
    const m = await q.refresh();
    io.external(cut);
    const e = await q.edit({ version: m.version, runId: runs(m, 'Quarterly results')[0].id, beforeText: 'Quarterly results', afterText: 'Quarterly results now' });
    expect(e.ok).toBe(true);
    expect(io.text).toBe(C.replace('Quarterly results', 'Quarterly results now'));
  });

  it('a deck that stays without its end past acceptCutMs is written on as it is', async () => {
    let t = 0;
    const io = new MemIO(A);
    const q = createWriteQueue(io, { writerWaitMs: 10, writerPollMs: 5, acceptCutMs: 1000, now: () => t, sleep: async (ms) => void (t += ms) });
    const m = await q.refresh();
    io.external(cut);
    const req = { version: m.version, runId: runs(m, 'Quarterly results')[0].id, beforeText: 'Quarterly results', afterText: 'Quarterly results now' };
    expect(await q.edit(req)).toMatchObject({ ok: false, code: 'conflict' });
    t += 2000;
    expect((await q.edit(req)).ok).toBe(true);
    expect(io.text).toBe(cut.replace('Quarterly results', 'Quarterly results now'));
  });

  it('control: a deck that never ended with </html> is not waited for', async () => {
    const open = A.replace('</body></html>\n', '');
    const io = new MemIO(open);
    const q = createWriteQueue(io, { writerWaitMs: 60_000, sleep: () => Promise.reject(new Error('waited')) });
    const m = await q.refresh();
    io.external(open + '<p>more</p>\n');
    const e = await q.edit({ version: m.version, runId: runs(m, 'Quarterly results')[0].id, beforeText: 'Quarterly results', afterText: 'Quarterly results now' });
    expect(e.ok).toBe(true);
  });
});

describe('Blueline\'s own writes in between (anchors findings F1 to F3)', () => {
  const s = (h: string, sub: string, body: string) =>
    `<section class="slide">\n  <div class="kicker">Section summary</div>\n  <h2 class="title">${h}</h2>\n  <p class="sub">${sub}</p>\n  <p>${body}</p>\n</section>\n`;
  const D = (...p: string[]) => `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>\n${p.join('')}</body></html>\n`;
  const C = s('Next steps', 'Costs', 'Body C');

  it('F3: undo of a heading edit after the twin got the same edit, the author\'s subtitle was edited, and the two swapped: refused', async () => {
    const V0 = D(s('Key takeaways', 'Same subtitle', 'Body B'), C, s('Key takeaways', 'Same subtitle', 'Body B'));
    const io = new MemIO(V0);
    const q = createWriteQueue(io);
    const m0 = await q.refresh();
    const W = await q.edit({ version: m0.version, runId: runs(m0, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways!' });
    const m1 = await q.currentMap();
    const W2 = await q.edit({ version: m1.version, runId: runs(m1, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways!' });
    const m2 = await q.currentMap();
    const W3 = await q.edit({ version: m2.version, runId: runs(m2, 'Same subtitle')[0].id, beforeText: 'Same subtitle', afterText: 'Hire two engineers' });
    if (!W.ok || !W2.ok || !W3.ok) throw new Error('setup');
    const V4 = D(s('Key takeaways!', 'Same subtitle', 'Body B'), C, s('Key takeaways!', 'Hire two engineers', 'Body B'));
    io.external(V4);
    expect((await q.undo(W3.record)).ok).toBe(false);
    expect((await q.undo(W2.record)).ok).toBe(false);
    expect(await q.undo(W.record)).toMatchObject({ ok: false, code: 'stale' });
    expect(io.text).toBe(V4);
  });

  it('F3 redo: redo of an undone heading edit after the author\'s subtitle edit and a swap with the twin: refused', async () => {
    const V0 = D(s('Key takeaways', 'Same subtitle', 'Body B'), C, s('Key takeaways', 'Same subtitle', 'Body B'));
    const io = new MemIO(V0);
    const q = createWriteQueue(io);
    const m0 = await q.refresh();
    const W = await q.edit({ version: m0.version, runId: runs(m0, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways!' });
    if (!W.ok) throw new Error('W');
    expect((await q.undo(W.record)).ok).toBe(true);
    const m1 = await q.currentMap();
    const W2 = await q.edit({ version: m1.version, runId: runs(m1, 'Same subtitle')[0].id, beforeText: 'Same subtitle', afterText: 'Hire two engineers' });
    if (!W2.ok) throw new Error('W2');
    const V4 = D(s('Key takeaways', 'Same subtitle', 'Body B'), C, s('Key takeaways', 'Hire two engineers', 'Body B'));
    io.external(V4);
    expect((await q.redo(W.record)).ok).toBe(false);
    expect(io.text).toBe(V4);
  });

  it('F2: a stale edit after an own write next to the run and another program\'s swap with the twin: a note', async () => {
    const A = s('Key takeaways', 'Same subtitle', 'Body B');
    const V0 = D(A, C, A);
    const io = new MemIO(V0);
    const q = createWriteQueue(io);
    const m0 = await q.refresh();
    const head = runs(m0, 'Key takeaways')[0];
    expect((await q.edit({ version: m0.version, runId: runs(m0, 'Same subtitle')[0].id, beforeText: 'Same subtitle', afterText: 'Hire two engineers' })).ok).toBe(true);
    const Vc = D(A, C, s('Key takeaways', 'Hire two engineers', 'Body B'));
    io.external(Vc);
    const out = await q.edit({ version: m0.version, runId: head.id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: false, verbatim: { before: 'Key takeaways', after: 'Key takeaways two' } });
    expect(io.text).toBe(Vc);
  });

  it('F1: a field on a slide another program inserted, committed after a restore to before the insert: a note', async () => {
    const T = '<section class="slide">\n  <h1>Quarterly review</h1>\n</section>\n';
    const V0 = D(T, s('Key takeaways', 'Costs fell', 'Body B'), s('Next steps', 'Owners', 'Body C'));
    const V2 = D(T, s('Key takeaways', 'Revenue grew', 'Body A'), s('Key takeaways', 'Costs fell', 'Body B'), s('Next steps', 'Owners', 'Body C'));
    const io = new MemIO(V0);
    const q = createWriteQueue(io);
    await q.refresh();
    io.external(V2);
    const m2 = await q.refresh();
    const runA = runs(m2, 'Key takeaways')[0];
    expect((await q.restore(encodeDeck(V0), m2.version)).ok).toBe(true);
    const out = await q.edit({ version: m2.version, runId: runA.id, beforeText: 'Key takeaways', afterText: 'Key takeaways (A)' });
    expect(out.ok).toBe(false);
    expect(io.text).toBe(V0);
  });

  it('control: an own write elsewhere, then a far change by another program: the stale edit is carried and written', async () => {
    const far = Array.from({ length: 6 }, (_, i) => s(`Topic ${i}`, `Sub ${i}`, `Body ${i}`));
    const V0 = D(s('Key takeaways', 'Same subtitle', 'Body B'), ...far, s('Key takeaways', 'Same subtitle', 'Body B'));
    const io = new MemIO(V0);
    const q = createWriteQueue(io);
    const m0 = await q.refresh();
    expect((await q.edit({ version: m0.version, runId: runs(m0, 'Sub 3')[0].id, beforeText: 'Sub 3', afterText: 'Sub three' })).ok).toBe(true);
    io.external(io.text.replace('Body 5', 'Body five'));
    const out = await q.edit({ version: m0.version, runId: runs(m0, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out.ok).toBe(true);
    expect(io.text.indexOf('Key takeaways two')).toBeLessThan(io.text.indexOf('Topic 0'));
  });

  it('control: undo after an own write elsewhere and a far change by another program is done in place', async () => {
    const far = Array.from({ length: 6 }, (_, i) => s(`Topic ${i}`, `Sub ${i}`, `Body ${i}`));
    const V0 = D(s('Key takeaways', 'Same subtitle', 'Body B'), ...far, s('Key takeaways', 'Same subtitle', 'Body B'));
    const io = new MemIO(V0);
    const q = createWriteQueue(io);
    const m0 = await q.refresh();
    const W = await q.edit({ version: m0.version, runId: runs(m0, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways!' });
    if (!W.ok) throw new Error('W');
    const m1 = await q.currentMap();
    expect((await q.edit({ version: m1.version, runId: runs(m1, 'Sub 3')[0].id, beforeText: 'Sub 3', afterText: 'Sub three' })).ok).toBe(true);
    const changed = io.text.replace('Body 5', 'Body five');
    io.external(changed);
    expect((await q.undo(W.record)).ok).toBe(true);
    expect(io.text).toBe(changed.replace('Key takeaways!', 'Key takeaways'));
  });
});
