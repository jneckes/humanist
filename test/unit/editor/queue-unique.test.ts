// The uniqueness rule (lead decision F-1; packages/editor/src/place.ts, write-queue.ts). When every change between
// the version an edit was made on (V) and the current file (C) is one of Blueline's own writes, the run is carried
// exactly. Otherwise another program changed the file, and the edit is written only when
//   (a) beforeText is the decoded value of exactly one place in V and in C (HTML-text and literal runs; a shadow value,
//       text the page may show that Blueline never writes, counts as a copy),
//   (b) the run, carried through the recorded steps and the diff, lands exactly on that one run in C, and
//   (c) the confirmations that only turn writes into notes do not object (the anchors on both sides, the wait for a
//       program still writing the deck).
// Anything else is a verbatim note: `ambiguous` when the text is in more than one place, `stale` when it is in one and
// the mapping or the anchors fail. Undo and redo case 2 follow the same rule for the run that holds the text they
// replace; otherwise case 3. The byte-identical classes the hardening rounds accepted as limits (identical slides
// swapped or moved, an identical copy at the author's deleted slide's place, a slide duplicated and its original
// deleted, identical divider slides) have the text in two places on one side, so they are notes now.
import { describe, expect, it } from 'vitest';
import { createWriteQueue, placesOf } from '@blueline/editor';
import type { DeckMap } from '@blueline/core/types';
import { MemIO, mapOf } from './helpers';

const DOC = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Deck</title></head><body>\n';
const END = '</body></html>\n';
const deck = (...parts: string[]): string => DOC + parts.join('') + END;
const pad = (k: string) => Array.from({ length: 4 }, (_, i) => `<p>Filler ${k} line ${i}: words that stay as they are.</p>\n`).join('');
const slide = (h: string, body: string, id = ''): string =>
  `<section class="slide"${id ? ` id="${id}"` : ''}>\n  <div class="kicker">Quarterly review</div>\n  <h2>${h}</h2>\n  <p>${body}</p>\n</section>\n`;

function runsOf(m: DeckMap, value: string) {
  return [...m.runs, ...m.literals].filter((r) => r.value === value).sort((a, b) => a.start - b.start);
}

/** The stale edit of the `which`-th run holding `value` in A, sent after another program made the file C. */
async function stale(A: string, C: string, value: string, which: number, after: string) {
  const io = new MemIO(A);
  const q = createWriteQueue(io);
  const m = await q.refresh();
  const run = runsOf(m, value)[which];
  expect(run, `run #${which} of ${JSON.stringify(value)}`).toBeTruthy();
  io.external(C);
  const out = await q.edit({ version: m.version, runId: run.id, beforeText: value, afterText: after });
  return { out, io };
}

/** A verbatim note with this code, the other program's file left exactly as it was. */
function expectNote(r: Awaited<ReturnType<typeof stale>>, C: string, value: string, after: string, code: 'ambiguous' | 'stale'): void {
  expect(r.out).toMatchObject({ ok: false, code, verbatim: { before: value, after } });
  expect(r.io.text).toBe(C);
  expect(r.io.writes).toBe(0);
}

const A1 = deck(slide('Agenda', 'What we cover today'), pad('a'), slide('Key takeaways', 'Revenue grew in every region'), pad('b'), slide('Next steps', 'Owners and dates'));
const farChange = (x: string) => x.replace('Filler b line 3', 'Filler b line three');

describe('F-1 (a): the text in exactly one place in the version the edit was made on and in the current one', () => {
  it('one place in both, another program\'s change far away: written where the author typed', async () => {
    const r = await stale(A1, farChange(A1), 'Key takeaways', 0, 'Key takeaways two');
    expect(r.out).toMatchObject({ ok: true, merged: true });
    expect(r.io.text).toBe(farChange(A1).replace('<h2>Key takeaways</h2>', '<h2>Key takeaways two</h2>'));
  });

  it('two places in the version the edit was made on, one now (the other copy deleted far away): a note', async () => {
    const A = A1.replace(slide('Next steps', 'Owners and dates'), slide('Key takeaways', 'Owners and dates'));
    const C = A.replace(slide('Key takeaways', 'Owners and dates'), '');
    expect(placesOf(mapOf(C), 'Key takeaways')).toBe(1);
    expectNote(await stale(A, C, 'Key takeaways', 0, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two', 'ambiguous');
  });

  it('one place in the version the edit was made on, two now (the text pasted far away): a note', async () => {
    const C = A1.replace(END, `<p>Key takeaways</p>\n${END}`);
    expectNote(await stale(A1, C, 'Key takeaways', 0, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two', 'ambiguous');
  });

  it('a shadow value counts as a copy: a heading that is also the <title>, or an image\'s alt text', async () => {
    const T = A1.replace('<title>Deck</title>', '<title>Key takeaways</title>');
    expect(runsOf(mapOf(T), 'Key takeaways')).toHaveLength(1);
    expect(placesOf(mapOf(T), 'Key takeaways')).toBe(2);
    expectNote(await stale(T, farChange(T), 'Key takeaways', 0, 'Key takeaways two'), farChange(T), 'Key takeaways', 'Key takeaways two', 'ambiguous');
    const I = A1.replace('<p>Revenue grew', '<img alt="Key takeaways" src="k.png"><p>Revenue grew');
    expectNote(await stale(I, farChange(I), 'Key takeaways', 0, 'Key takeaways two'), farChange(I), 'Key takeaways', 'Key takeaways two', 'ambiguous');
    // With no other program's change, the run is the request's own: written.
    const io = new MemIO(T);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    expect((await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' })).ok).toBe(true);
  });

  it('HTML text and a script literal with the same text are two places: a note for either', async () => {
    const J = A1.replace(END, `<script>\nconst label = 'Key takeaways';\ndocument.title = label;\n</script>\n${END}`);
    expect(runsOf(mapOf(J), 'Key takeaways').map((r) => r.id.slice(0, 2))).toEqual(['h:', 'l:']);
    for (const which of [0, 1]) {
      expectNote(await stale(J, farChange(J), 'Key takeaways', which, 'Key takeaways two'), farChange(J), 'Key takeaways', 'Key takeaways two', 'ambiguous');
    }
  });

  it('a script literal in one place is written; one whose text a <template> also shows is a note', async () => {
    const L = A1.replace(END, `<script>\nconst note = 'Revenue by region, 2026';\n</script>\n${END}`);
    const r = await stale(L, farChange(L), 'Revenue by region, 2026', 0, 'Revenue by region, 2027');
    expect(r.out.ok).toBe(true);
    expect(r.io.text).toBe(farChange(L).replace("'Revenue by region, 2026'", "'Revenue by region, 2027'"));
    const TL = L.replace('<body>\n', '<body>\n<template><h3>Revenue by region, 2026</h3></template>\n');
    expectNote(await stale(TL, farChange(TL), 'Revenue by region, 2026', 0, 'Revenue by region, 2027'), farChange(TL), 'Revenue by region, 2026', 'Revenue by region, 2027', 'ambiguous');
  });

  it('a picked candidate follows the same rule on its run\'s value', async () => {
    // A substring pick lifted to a literal whose text is in one place: written across another program's change.
    const L = A1.replace(END, `<script>\nconst note = 'Revenue grew 12% in Q3';\n</script>\n${END}`);
    const io = new MemIO(L);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    io.external(farChange(L));
    const lit = runsOf(m, 'Revenue grew 12% in Q3')[0];
    const sub = await q.edit({ version: m.version, runId: lit.id, beforeText: 'Revenue grew 12% in Q3', afterText: 'Revenue grew 14% in Q3', pick: { kind: 'substring', nodeBefore: 'grew 12%', nodeAfter: 'grew 14%' } });
    expect(sub.ok).toBe(true);
    // An equal pick of one of two copies: written when nothing else changed (the author chose it) ...
    const D = A1.replace('<p>Owners and dates</p>', '<p>Revenue grew in every region</p>');
    const io2 = new MemIO(D);
    const q2 = createWriteQueue(io2);
    const m2 = await q2.refresh();
    const second = runsOf(m2, 'Revenue grew in every region')[1];
    const pick = { kind: 'equal' as const, nodeBefore: 'Revenue grew in every region', nodeAfter: 'Revenue grew in most regions' };
    const req = { version: m2.version, runId: second.id, beforeText: pick.nodeBefore, afterText: pick.nodeAfter, pick };
    // ... and a note once another program changed the file, however far.
    io2.external(farChange(D));
    expect(await q2.edit(req)).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: pick.nodeBefore, after: pick.nodeAfter } });
    expect(io2.text).toBe(farChange(D));
    const io3 = new MemIO(D);
    const q3 = createWriteQueue(io3);
    await q3.refresh();
    expect((await q3.edit(req)).ok).toBe(true);
    expect(io3.text).toBe(D.replace('<p>Revenue grew in every region</p>\n</section>\n' + END, '<p>Revenue grew in most regions</p>\n</section>\n' + END));
  });
});

describe('F-1 (b): the run lands exactly on that one place', () => {
  it('the author\'s slide deleted and another heading renamed to its text, far away: a note (stale), never the renamed one', async () => {
    const A = deck(slide('Agenda', 'What we cover today'), pad('a'), slide('Key takeaways', 'Revenue grew in every region'), pad('b'), slide('Summary', 'Owners and dates'));
    const C = A.replace(slide('Key takeaways', 'Revenue grew in every region'), '').replace('<h2>Summary</h2>', '<h2>Key takeaways</h2>');
    expect(placesOf(mapOf(C), 'Key takeaways')).toBe(1);
    expectNote(await stale(A, C, 'Key takeaways', 0, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two', 'stale');
  });

  it('the text moved from the HTML into a script literal at the same place: a note, an edit never moves between them', async () => {
    const A = deck(pad('a'), '<h2>Growth plan for the year</h2>\n', pad('b'));
    const C = deck(pad('a'), "<script>t = 'Growth plan for the year';</script>\n", pad('b'));
    expect(runsOf(mapOf(C), 'Growth plan for the year').map((r) => r.id.slice(0, 2))).toEqual(['l:']);
    expectNote(await stale(A, C, 'Growth plan for the year', 0, 'Growth plan for 2027'), C, 'Growth plan for the year', 'Growth plan for 2027', 'stale');
  });
});

describe('F-1 (c): the confirmations that only turn writes into notes still do', () => {
  it('the author\'s list item deleted and the one before it set to the same value: the text in one place, the anchors refuse', async () => {
    const li = (a: string, b: string) => `  <li class="row"><b>${a}</b> <span>${b}</span></li>\n`;
    const list = (items: string) => deck(`<ul class="checks">\n${items}</ul>\n`);
    const A = list(li('Single sign-on', 'Yes') + li('Audit log', 'Partial'));
    const C = list(li('Single sign-on', 'Partial'));
    expect(placesOf(mapOf(A), 'Partial')).toBe(1);
    expect(placesOf(mapOf(C), 'Partial')).toBe(1);
    expectNote(await stale(A, C, 'Partial', 0, 'Partial (beta)'), C, 'Partial', 'Partial (beta)', 'stale');
  });

  it('a change within the anchors of a heading in one place: a note', async () => {
    const C = A1.replace('Revenue grew in every region', 'Revenue grew in three regions');
    expectNote(await stale(A1, C, 'Key takeaways', 0, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two', 'stale');
  });

  it('a deck another program is still writing in place: refused before any placement', async () => {
    const io = new MemIO(A1);
    const q = createWriteQueue(io, { writerWaitMs: 30, writerPollMs: 5 });
    const m = await q.refresh();
    const cut = A1.slice(0, A1.indexOf('<section class="slide">\n  <div class="kicker">Quarterly review</div>\n  <h2>Next steps'));
    io.external(cut);
    expect(await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' })).toMatchObject({ ok: false, code: 'conflict' });
    expect(io.text).toBe(cut);
  });
});

describe('Blueline\'s own writes only: the run is carried exactly, copies or not', () => {
  it('three copies, the author\'s own writes on the other two in between: written on the run the author typed in', async () => {
    const T = deck(slide('Owner', 'One'), slide('Owner', 'Two'), slide('Owner', 'Three'));
    const io = new MemIO(T);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const [a, b, c] = runsOf(m, 'Owner');
    expect((await q.edit({ version: m.version, runId: a.id, beforeText: 'Owner', afterText: 'Owner A' })).ok).toBe(true);
    expect((await q.edit({ version: m.version, runId: c.id, beforeText: 'Owner', afterText: 'Owner C' })).ok).toBe(true);
    expect((await q.edit({ version: m.version, runId: b.id, beforeText: 'Owner', afterText: 'Owner B' })).ok).toBe(true);
    expect(io.text).toBe(deck(slide('Owner A', 'One'), slide('Owner B', 'Two'), slide('Owner C', 'Three')));
  });

  it('the same with another program\'s change far away in between: a note (the text was in two places)', async () => {
    const T = deck(slide('Owner', 'One'), pad('a'), slide('Owner', 'Two'), pad('b'));
    const io = new MemIO(T);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const [a, b] = runsOf(m, 'Owner');
    expect((await q.edit({ version: m.version, runId: a.id, beforeText: 'Owner', afterText: 'Owner A' })).ok).toBe(true);
    io.external(farChange(io.text));
    const C = io.text;
    expect(await q.edit({ version: m.version, runId: b.id, beforeText: 'Owner', afterText: 'Owner B' })).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(C);
  });
});

describe('the byte-identical classes the hardening rounds accepted are notes now', () => {
  const X = slide('Key takeaways', 'Same body', 's');
  const Y = slide('Agenda', 'What we cover today', 's');
  const Z = slide('Next steps', 'Owners and dates', 's');

  it('two identical slides, the author\'s swapped with another slide: a note', async () => {
    const A = deck(X, Y, X);
    const C = deck(Y, X, X);
    for (const which of [0, 1]) expectNote(await stale(A, C, 'Key takeaways', which, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two', 'ambiguous');
  });

  it('two identical slides, the author\'s moved past the other: a note', async () => {
    const A = deck(X, Y, Z, X);
    const C = deck(Y, Z, X, X);
    for (const which of [0, 1]) expectNote(await stale(A, C, 'Key takeaways', which, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two', 'ambiguous');
  });

  it('the author\'s slide deleted while an identical copy stands at its place: a note', async () => {
    const A = deck(Y, X, X, Z);
    const C = deck(Y, X, Z);
    expectNote(await stale(A, C, 'Key takeaways', 0, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two', 'ambiguous');
    expectNote(await stale(A, C, 'Key takeaways', 1, 'Key takeaways two'), C, 'Key takeaways', 'Key takeaways two', 'ambiguous');
  });

  it('identical divider slides: a note for each, whatever another program changed', async () => {
    const div = '<section class="divider">\n  <h2>Section break</h2>\n</section>\n';
    const A = deck(div, slide('Agenda', 'What we cover today'), pad('a'), div, slide('Next steps', 'Owners and dates'), pad('b'));
    for (const which of [0, 1]) expectNote(await stale(A, farChange(A), 'Section break', which, 'Part two'), farChange(A), 'Section break', 'Part two', 'ambiguous');
  });

  it('a slide duplicated and the original deleted, the queue reading the deck in between: a note, never the copy', async () => {
    const S = slide('Key takeaways', 'Revenue grew in every region', 'k');
    const A = deck(Y, pad('a'), S, pad('b'), Z);
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const run = runsOf(m, 'Key takeaways')[0];
    // The other program duplicates the slide (the queue reads that version: a commit of another field, a refresh) ...
    io.external(A.replace(S, S + S.replace('id="k"', 'id="k-copy"')));
    await q.refresh();
    // ... then deletes the original: the copy alone holds the text, where the original was.
    const C = A.replace(S, S.replace('id="k"', 'id="k-copy"'));
    io.external(C);
    const out = await q.edit({ version: m.version, runId: run.id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Key takeaways', after: 'Key takeaways two' } });
    expect(io.text).toBe(C);
  });
});

describe('another program changed the file and put the bytes back: the rule judges by time, not by the route', () => {
  const S = slide('Key takeaways', 'Revenue grew in every region', 'k');
  const A = deck(slide('Agenda', 'What we cover today'), pad('a'), S, pad('b'), slide('Next steps', 'Owners and dates'));

  it('a slide duplicated (the queue reading that version) and its original deleted, the bytes as before: a note', async () => {
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    io.external(A.replace(S, S + S));
    await q.refresh();
    io.external(A);
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Key takeaways', after: 'Key takeaways two' } });
    expect(io.text).toBe(A);
  });

  it('the same with an own write elsewhere after it (a route of Blueline\'s own writes alone): a note', async () => {
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    io.external(A.replace(S, S + S));
    await q.refresh();
    io.external(A);
    const m2 = await q.refresh();
    expect((await q.edit({ version: m2.version, runId: runsOf(m2, 'Next steps')[0].id, beforeText: 'Next steps', afterText: 'Next steps now' })).ok).toBe(true);
    const C = io.text;
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(C);
  });

  it('an undo after the same (case 1 by the hash): case 3', async () => {
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    if (!w.ok) throw new Error(w.why);
    const W = io.text;
    const S2 = S.replace('Key takeaways', 'Key takeaways two');
    io.external(W.replace(S2, S2 + S2));
    await q.refresh();
    io.external(W);
    expect(await q.undo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(W);
  });

  it('a field held open across it while another page shows the same bytes again: judged from the field\'s hold, a note', async () => {
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    q.know(m.version, A, m, { pin: true }); // the field opens on A
    io.external(A.replace(S, S + S));
    await q.refresh();
    io.external(A);
    await q.refresh();
    q.know(m.version, A, m, { pin: true }); // another page shows A again
    q.unpin(m.version); // ... and lets it go: the field's older hold stays
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(A);
  });

  it('controls: a change elsewhere put back, the text in one place throughout: written; a field held on the version after it: written', async () => {
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    io.external(farChange(A));
    await q.refresh();
    io.external(A);
    expect((await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' })).ok).toBe(true);
    // A copy that came and went before the page held the version again (main pins it when the page shows it).
    const io2 = new MemIO(A);
    const q2 = createWriteQueue(io2);
    const m2 = await q2.refresh();
    io2.external(A.replace(S, S + S));
    await q2.refresh();
    io2.external(A);
    await q2.refresh();
    q2.know(m2.version, A, m2, { pin: true });
    expect((await q2.edit({ version: m2.version, runId: runsOf(m2, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' })).ok).toBe(true);
    expect(io2.text).toBe(A.replace('<h2>Key takeaways</h2>', '<h2>Key takeaways two</h2>'));
  });
});

describe('undo and redo case 2 under another program\'s change (F-1)', () => {
  const s = (h: string, sub: string) => `<section class="slide">\n  <h2 class="title">${h}</h2>\n  <p class="sub">${sub}</p>\n</section>\n`;

  it('the text the undo replaces in one place, a change far away: case 2, the bytes restored', async () => {
    const A = deck(s('Key takeaways', 'Same subtitle'), pad('a'), s('Next steps', 'Same subtitle'), pad('b'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    if (!w.ok) throw new Error(w.why);
    io.external(farChange(io.text));
    expect((await q.undo(w.record)).ok).toBe(true);
    expect(io.text).toBe(farChange(A));
  });

  it('the edit made its heading equal another\'s: the undo across a far change is case 3', async () => {
    const A = deck(s('Key takeaways!', 'Same subtitle'), pad('a'), s('Key takeaways', 'Same subtitle'), pad('b'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways!')[0].id, beforeText: 'Key takeaways!', afterText: 'Key takeaways' });
    if (!w.ok) throw new Error(w.why);
    io.external(farChange(io.text));
    const C = io.text;
    expect(await q.undo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(C);
  });

  it('two identical slides edited alike by the author, then swapped by another program: the undo is case 3', async () => {
    const A = deck(s('Key takeaways', 'Same subtitle'), s('Next steps', 'Owners'), s('Key takeaways', 'Same subtitle'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    if (!w.ok) throw new Error(w.why);
    const m1 = await q.currentMap();
    expect((await q.edit({ version: m1.version, runId: runsOf(m1, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' })).ok).toBe(true);
    const C = deck(s('Next steps', 'Owners'), s('Key takeaways two', 'Same subtitle'), s('Key takeaways two', 'Same subtitle'));
    io.external(C);
    expect(await q.undo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(C);
  });

  it('a redo whose text is in two places (identical slides) across a far change: case 3; with no other change, case 1', async () => {
    const A = deck(s('Key takeaways', 'Same subtitle'), pad('a'), s('Key takeaways', 'Same subtitle'), pad('b'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[1].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    if (!w.ok) throw new Error(w.why);
    expect((await q.undo(w.record)).ok).toBe(true);
    expect((await q.redo(w.record)).ok).toBe(true);
    expect((await q.undo(w.record)).ok).toBe(true);
    io.external(farChange(io.text));
    const C = io.text;
    expect(await q.redo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(C);
  });

  it('own writes only since the write: carried exactly, even with the text in two places', async () => {
    // The subtitles differ within 32 characters, so the record's context (the needle) is in one place.
    const A = deck(s('Key takeaways', 'One subtitle'), s('Key takeaways', 'Two subtitle'));
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[1].id, beforeText: 'Key takeaways', afterText: 'Key takeaways!' });
    if (!w.ok) throw new Error(w.why);
    const m1 = await q.currentMap();
    expect((await q.edit({ version: m1.version, runId: runsOf(m1, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways!' })).ok).toBe(true);
    expect((await q.undo(w.record)).ok).toBe(true);
    expect(io.text).toBe(deck(s('Key takeaways!', 'One subtitle'), s('Key takeaways', 'Two subtitle')));
  });
});

describe('a restore lies between: placed by the rule as another program\'s change is', () => {
  it('a field open across a restore: written when its text is in one place, a note when in two', async () => {
    for (const twin of [false, true]) {
      const A = deck(slide('Key takeaways', 'Revenue grew in every region'), pad('a'), slide(twin ? 'Key takeaways' : 'Next steps', 'Owners and dates'), pad('b'));
      const io = new MemIO(A);
      const q = createWriteQueue(io);
      await q.refresh();
      const V1 = A.replace(END, `<p>Added by another program</p>\n${END}`);
      io.external(V1);
      const m1 = await q.refresh();
      const { encodeDeck } = await import('@blueline/core/text');
      expect((await q.restore(encodeDeck(A), m1.version)).ok).toBe(true);
      const out = await q.edit({ version: m1.version, runId: runsOf(m1, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
      if (twin) {
        expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
        expect(io.text).toBe(A);
      } else {
        expect(out.ok).toBe(true);
        expect(io.text).toBe(A.replace('<h2>Key takeaways</h2>', '<h2>Key takeaways two</h2>'));
      }
    }
  });
});
