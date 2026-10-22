// The uniqueness rule (lead decision F-1) judged on what happened to the file, in order (write-queue.ts, the log):
// regression tests for the third attack round on F-1 (docs/PHASE2-RESULTS.md, "The uniqueness rule"). Each case was
// a write into another copy, or a write where F-1 asks for a note, on the editor of the first F-1 implementation.
//
//  - Main's own sightings: main takes every external change from the watcher (EditLane.takeExternal) and tells the
//    queue with know(…, { onDisk: true }); a version the queue never read itself still counts as another program's
//    change (two saves that bring the bytes back, a slide duplicated and then its original deleted).
//  - One diff over the whole span (more than FOREIGN_STEPS_MAX changes, or the client's version not where the queue
//    saw the file) checks the copies the queue saw on the way.
//  - An undo or redo is judged from the write it undoes (the log entry that made it), not from when the bytes it made
//    were last made by any write.
//  - The run's value at each change another program made, not beforeText.
//  - A program still writing the deck in place, paused right after a `</html>` that is not the document's end.
import { describe, expect, it } from 'vitest';
import { createWriteQueue } from '@blueline/editor';
import { endsWhole } from '@blueline/editor/write-queue';
import { buildMap } from '@blueline/core/mapper';
import { decodeDeck } from '@blueline/core/text';
import type { DeckMap } from '@blueline/core/types';
import { MemIO, mapOf, sha256 } from './helpers';

const DOC = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Deck</title></head><body>\n';
const END = '</body></html>\n';
const deck = (...parts: string[]): string => DOC + parts.join('') + END;
const pad = (k: string) => Array.from({ length: 4 }, (_, i) => `<p>Filler ${k} line ${i}: words that stay as they are.</p>\n`).join('');
const slide = (h: string, body: string, id = ''): string =>
  `<section class="slide"${id ? ` id="${id}"` : ''}>\n  <div class="kicker">Quarterly review</div>\n  <h2>${h}</h2>\n  <p>${body}</p>\n</section>\n`;
const LONG = 'Revenue grew in every region, led by the north and the west, with margins steady and costs flat across the year; the board asked for detail on churn and on the new accounts';
/** A slide whose last line (far past the anchors' reach) says which one it is. */
const tagged = (h: string, tag: string) =>
  `<section class="slide" id="k">\n  <div class="kicker">Quarterly review</div>\n  <h2>${h}</h2>\n  <p>${LONG}</p>\n  <p>${LONG}</p>\n  <p class="foot">${tag}</p>\n</section>\n`;
const far = (x: string, n: number) => x.replace(/Filler b line 3[^<]*/, `Filler b line 3 changed ${n} times.`);

function runsOf(m: DeckMap, value: string) {
  return [...m.runs, ...m.literals].filter((r) => r.value === value).sort((a, b) => a.start - b.start);
}

/** Another program saves `text`, and main takes it from the watcher as EditLane.takeExternal does. */
function mainTakes(io: MemIO, q: ReturnType<typeof createWriteQueue>, text: string): DeckMap {
  io.external(text);
  const m = mapOf(text);
  q.know(m.version, text, m, { onDisk: true });
  return m;
}

/** Opens the deck as main does (attach: the version it read, on disk; the page holds it). */
function open(text: string) {
  const io = new MemIO(text);
  const q = createWriteQueue(io);
  const m = mapOf(text);
  q.know(m.version, text, m, { onDisk: true });
  q.know(m.version, text, m, { pin: true });
  return { io, q, m };
}

describe('main\'s sightings count (finding: the versions main took from the watcher were never another program\'s change)', () => {
  const S = slide('Key takeaways', 'Revenue grew in every region', 'k');
  const A = deck(slide('Agenda', 'What we cover today'), pad('a'), S, pad('b'), slide('Next steps', 'Owners and dates'));

  it('a field held across a duplicated slide and the deleted original, the bytes as before: a note', async () => {
    const { io, q, m } = open(A);
    const D = mainTakes(io, q, A.replace(S, S + S));
    q.know(D.version, A.replace(S, S + S), D, { pin: true }); // the reloaded page
    mainTakes(io, q, A);
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Key takeaways', after: 'Key takeaways two' } });
    expect(io.text).toBe(A);
    expect(io.writes).toBe(0);
  });

  it('the same where the copy differs only far past the anchors (the bytes differ): a note, never the copy', async () => {
    const ORIG = tagged('Key takeaways', 'original');
    const COPY = tagged('Key takeaways', 'copy');
    const B = deck(slide('Agenda', 'What we cover today'), pad('a'), ORIG, pad('b'), slide('Next steps', 'Owners and dates'));
    const { io, q, m } = open(B);
    mainTakes(io, q, B.replace(ORIG, ORIG + COPY));
    const C = B.replace(ORIG, COPY);
    mainTakes(io, q, C);
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(C);
  });

  it('identical dividers, one deleted and an identical one put back (copies in V and C): a note, for either divider', async () => {
    const DIV = '<section class="divider">\n  <h2>Section break</h2>\n</section>\n';
    const E = deck(slide('Agenda', 'What we cover today'), DIV, slide('Key takeaways', 'Revenue grew'), DIV, slide('Next steps', 'Owners'));
    for (const which of [0, 1]) {
      const { io, q, m } = open(E);
      mainTakes(io, q, which === 0 ? E.replace(DIV + slide('Key takeaways', 'Revenue grew'), slide('Key takeaways', 'Revenue grew')) : E.replace(DIV + slide('Next steps', 'Owners'), slide('Next steps', 'Owners')));
      mainTakes(io, q, E);
      const pick = { kind: 'equal' as const, nodeBefore: 'Section break', nodeAfter: 'Part two' };
      const out = await q.edit({ version: m.version, runId: runsOf(m, 'Section break')[which].id, beforeText: 'Section break', afterText: 'Part two', ...(which === 1 ? { pick } : {}) });
      expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
      expect(io.text).toBe(E);
    }
  });

  it('control: a field opened after the copies came and went is written (its hold begins after them)', async () => {
    const { io, q, m } = open(A);
    // The page reloads on each version main takes: it holds the new one and lets the old one go.
    const D = mainTakes(io, q, A.replace(S, S + S));
    q.know(D.version, A.replace(S, S + S), D, { pin: true });
    q.unpin(m.version);
    mainTakes(io, q, A);
    q.know(m.version, A, m, { pin: true });
    q.unpin(D.version);
    q.know(m.version, A, m, { pin: true }); // a field opens on A
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out.ok).toBe(true);
    expect(io.text).toBe(A.replace('<h2>Key takeaways</h2>', '<h2>Key takeaways two</h2>'));
  });

  it('control: unique text, two saves far away taken by main: written where the author typed', async () => {
    const { io, q, m } = open(A);
    mainTakes(io, q, far(A, 1));
    const C = far(A, 2);
    mainTakes(io, q, C);
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: true, merged: true });
    expect(io.text).toBe(C.replace('<h2>Key takeaways</h2>', '<h2>Key takeaways two</h2>'));
  });

  it('an undo after the duplicated and deleted slide main took: case 3, as after the same read by the queue', async () => {
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    if (!w.ok) throw new Error(w.why);
    const W = io.text;
    const S2 = S.replace('Key takeaways', 'Key takeaways two');
    mainTakes(io, q, W.replace(S2, S2 + S2));
    mainTakes(io, q, W); // the bytes the write made (case 1 by the hash)
    expect(await q.undo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(W);
    mainTakes(io, q, far(W, 1)); // and with the bytes not back (case 2)
    expect(await q.undo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(far(W, 1));
  });

  it('an undo whose write made a heading equal another, slide deleted and an identical one put back: case 3', async () => {
    const B = deck(slide('Key takeaways!', 'Same body'), slide('Next steps', 'Owners'), slide('Key takeaways', 'Same body'));
    const io = new MemIO(B);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways!')[0].id, beforeText: 'Key takeaways!', afterText: 'Key takeaways' });
    if (!w.ok) throw new Error(w.why);
    const W = io.text;
    mainTakes(io, q, W.replace(slide('Key takeaways', 'Same body') + slide('Next steps', 'Owners'), slide('Next steps', 'Owners')));
    mainTakes(io, q, W);
    expect(await q.undo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(W);
  });

  it('a version main read that is not UTF-8 counts as a change too', async () => {
    const DIV = '<section class="divider">\n  <h2>Section break</h2>\n</section>\n';
    const E = deck(DIV, pad('a'), DIV);
    const { io, q, m } = open(E);
    // Another program saves it with one windows-1252 byte for a moment (main takes it; it is never written), then
    // puts the bytes back.
    const enc = new TextEncoder().encode(E);
    const at = E.indexOf('Filler');
    const latin = new Uint8Array([...enc.slice(0, at), 0xe9, ...enc.slice(at)]);
    io.external(latin);
    const dec = decodeDeck(latin);
    expect(dec.utf8).toBe(false);
    const v = sha256(latin);
    q.know(v, dec.src, buildMap(dec.src, { version: v, utf8: false }), { onDisk: true });
    mainTakes(io, q, E);
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Section break')[0].id, beforeText: 'Section break', afterText: 'Part two' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(E);
  });
});

describe('one diff over the whole span checks the copies seen on the way (finding: the unknown path skipped them)', () => {
  const ORIG = tagged('Key takeaways', 'original');
  const COPY = tagged('Key takeaways', 'copy');
  const A = deck(slide('Agenda', 'What we cover today'), pad('a'), ORIG, pad('b'), slide('Next steps', 'Owners and dates'));

  for (const farSaves of [1, 2, 3, 6]) {
    it(`duplicated, ${farSaves} save(s) far away, the original deleted (the queue reading each): a note, never the copy`, async () => {
      const io = new MemIO(A);
      const q = createWriteQueue(io);
      const m = await q.refresh();
      q.know(m.version, A, m, { pin: true }); // the field's hold
      let cur = A.replace(ORIG, ORIG + COPY);
      io.external(cur);
      await q.refresh();
      for (let i = 1; i <= farSaves; i++) {
        cur = far(cur, i);
        io.external(cur);
        await q.refresh();
      }
      const C = cur.replace(ORIG, '');
      io.external(C);
      const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
      expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
      expect(io.text).toBe(C);
    });
  }

  it('the client\'s version told only with know (not where the queue saw the file), the copy read on the way: a note', async () => {
    const S = slide('Key takeaways', 'Revenue grew in every region');
    const B = deck(slide('Agenda', 'What we cover today'), pad('a'), S, pad('b'), slide('Next steps', 'Owners and dates'), pad('c'));
    const io = new MemIO(far(B, 9));
    const q = createWriteQueue(io);
    await q.refresh();
    io.external(B);
    const m = mapOf(B);
    q.know(m.version, B, m, { pin: true }); // a page holds B; the queue never read it
    io.external(B.replace(S, S + S));
    await q.refresh(); // the queue reads the two copies
    const C = far(B, 1);
    io.external(C);
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(C);
  });

  it('controls: 12 saves far away, read one by one, the text in one place throughout: written, with the bytes back or not', async () => {
    for (const back of [true, false]) {
      const io = new MemIO(A);
      const q = createWriteQueue(io);
      const m = await q.refresh();
      q.know(m.version, A, m, { pin: true });
      let cur = A;
      for (let i = 1; i <= 12; i++) {
        cur = far(cur, i);
        io.external(cur);
        await q.refresh();
      }
      if (back) cur = A;
      io.external(cur);
      const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
      expect(out.ok).toBe(true);
      expect(io.text).toBe(cur.replace('<h2>Key takeaways</h2>', '<h2>Key takeaways two</h2>'));
    }
  });
});

describe('an undo is judged from the write it undoes (finding: from when any write last made the bytes)', () => {
  const S = slide('Key takeaways', 'Revenue grew in every region', 'k');
  const A = deck(slide('Agenda', 'What we cover today'), pad('a'), S, pad('b'), slide('Next steps', 'Owners and dates'));
  const S2 = S.replace('Key takeaways', 'Key takeaways two');

  async function written() {
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    if (!w.ok) throw new Error(w.why);
    return { io, q, w, W: io.text };
  }

  for (const variant of ['an own edit elsewhere and its undo', 'the same with a redo and an undo of it']) {
    it(`the slide duplicated and one copy deleted (read), then ${variant} (they make W's bytes again): case 3`, async () => {
      const { io, q, w, W } = await written();
      io.external(W.replace(S2, S2 + S2));
      await q.refresh();
      io.external(W);
      const m2 = await q.refresh();
      const e = await q.edit({ version: m2.version, runId: runsOf(m2, 'Next steps')[0].id, beforeText: 'Next steps', afterText: 'Next steps now' });
      if (!e.ok) throw new Error(e.why);
      expect((await q.undo(e.record)).ok).toBe(true);
      if (variant.includes('redo')) {
        expect((await q.redo(e.record)).ok).toBe(true);
        expect((await q.undo(e.record)).ok).toBe(true);
      }
      expect(io.text).toBe(W);
      expect(await q.undo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
      expect(io.text).toBe(W);
    });
  }

  it('W1 on the slide, W2 far away, the slide duplicated and one copy deleted; Cmd+Z twice: W2 undone, W1 case 3', async () => {
    const { io, q, w: w1 } = await written();
    const m1 = await q.currentMap();
    const w2 = await q.edit({ version: m1.version, runId: runsOf(m1, 'Next steps')[0].id, beforeText: 'Next steps', afterText: 'Next steps now' });
    if (!w2.ok) throw new Error(w2.why);
    const W2 = io.text;
    io.external(W2.replace(S2, S2 + S2));
    await q.refresh();
    io.external(W2);
    expect((await q.undo(w2.record)).ok).toBe(true); // its run was never copied
    const before = io.text;
    expect(await q.undo(w1.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(before);
  });

  it('W made a heading equal another; another program changed a far heading; the author fixed it back and undid that: W\'s undo is case 3', async () => {
    const s = (h: string, sub: string) => `<section class="slide">\n  <h2 class="title">${h}</h2>\n  <p class="sub">${sub}</p>\n</section>\n`;
    const B = deck(s('Key takeaways!', 'One subtitle'), pad('a'), s('Key takeaways', 'Two subtitle'), pad('b'), s('Next steps', 'Owners'));
    const io = new MemIO(B);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    const w = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways!')[0].id, beforeText: 'Key takeaways!', afterText: 'Key takeaways' });
    if (!w.ok) throw new Error(w.why);
    const Q = io.text;
    const Qx = Q.replace('<h2 class="title">Next steps</h2>', '<h2 class="title">Next step</h2>');
    io.external(Qx);
    const m2 = await q.refresh();
    const fix = await q.edit({ version: m2.version, runId: runsOf(m2, 'Next step')[0].id, beforeText: 'Next step', afterText: 'Next steps' });
    if (!fix.ok) throw new Error(fix.why);
    expect(io.text).toBe(Q); // the fix makes W's bytes again
    expect((await q.undo(fix.record)).ok).toBe(true);
    expect(io.text).toBe(Qx);
    expect(await q.undo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(Qx);
  });

  it('W\'s version evicted by many saves far away, then the bytes back: case 3 (the copy was seen)', async () => {
    const { io, q, w, W } = await written();
    io.external(W.replace(S2, S2 + S2));
    await q.refresh();
    let cur = W;
    for (let i = 1; i <= 14; i++) {
      cur = far(cur, i);
      io.external(cur);
      await q.refresh();
    }
    io.external(W);
    expect(await q.undo(w.record)).toMatchObject({ ok: false, canMakeNote: true, code: 'stale' });
    expect(io.text).toBe(W);
  });

  it('controls: an own edit elsewhere and its undo, nothing else: W undone (case 1); 5 far saves without a copy: undone (case 2)', async () => {
    const a = await written();
    const m2 = await a.q.currentMap();
    const e = await a.q.edit({ version: m2.version, runId: runsOf(m2, 'Next steps')[0].id, beforeText: 'Next steps', afterText: 'Next steps now' });
    if (!e.ok) throw new Error(e.why);
    expect((await a.q.undo(e.record)).ok).toBe(true);
    expect((await a.q.undo(a.w.record)).ok).toBe(true);
    expect(a.io.text).toBe(A);
    // More than FOREIGN_STEPS_MAX changes: one diff from the version W made (still held) places it.
    const b = await written();
    let cur = b.W;
    for (let i = 1; i <= 5; i++) {
      cur = far(cur, i);
      b.io.external(cur);
      await b.q.refresh();
    }
    expect((await b.q.undo(b.w.record)).ok).toBe(true);
    expect(b.io.text).toBe(far(A, 5));
  });
});

describe('the run\'s value at each change another program made (finding: beforeText was counted instead)', () => {
  it('field 1 held; field 2 renames the run; the slide duplicated and one copy deleted; field 3 renames it back; field 1: a note', async () => {
    const S = slide('Key takeaways', 'Revenue grew in every region', 'k');
    const A = deck(slide('Agenda', 'What we cover today'), pad('a'), S, pad('b'), slide('Next steps', 'Owners and dates'));
    const SP = S.replace('Key takeaways', 'Key points');
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const m = await q.refresh();
    q.know(m.version, A, m, { pin: true });
    const e1 = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key points' });
    expect(e1.ok).toBe(true);
    const V1 = io.text;
    io.external(V1.replace(SP, SP + SP));
    await q.refresh();
    io.external(V1);
    const m3 = await q.refresh();
    q.know(m3.version, V1, m3, { pin: true });
    expect((await q.edit({ version: m3.version, runId: runsOf(m3, 'Key points')[0].id, beforeText: 'Key points', afterText: 'Key takeaways' })).ok).toBe(true);
    expect(io.text).toBe(A);
    const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(A);
  });
});

describe('a deck another program is still writing, paused right after a </html> that is not its end', () => {
  const head = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Deck</title></head><body>\n';
  const s1 = '<section class="slide">\n  <h2>Key takeaways</h2>\n  <p>Revenue grew in every region</p>\n</section>\n';
  const tail = pad('b') + '<section class="slide">\n  <h2>Next steps</h2>\n  <p>Owners and dates</p>\n</section>\n' + pad('c') + '</body></html>\n';
  const inner = {
    'an iframe srcdoc': '<iframe srcdoc="<html><body><p>Live demo</p></body></html>" width="400"></iframe>\n',
    'a script string': "<script>\nconst demo = '<html><body><p>Live demo</p></body></html>';\n</script>\n",
    'a comment': '<!-- old template ended here: </html> -->\n',
  };

  for (const [k, mid] of Object.entries(inner)) {
    it(`${k}: waited for, then refused (conflict); the file left as the other program writes it`, async () => {
      const V = head + s1 + pad('a') + mid + tail;
      const NEW = V.replace('Owners and dates', 'Owners, dates and budget');
      const prefix = NEW.slice(0, NEW.indexOf('</html>') + '</html>'.length);
      expect(prefix.length).toBeLessThan(NEW.length / 2);
      expect(endsWhole(V)).toBe(true);
      expect(endsWhole(prefix)).toBe(false);
      const io = new MemIO(V);
      let t = 0;
      const q = createWriteQueue(io, { writerWaitMs: 50, writerPollMs: 5, sleep: async () => void (t += 5), now: () => t });
      const m = await q.refresh();
      io.external(prefix);
      const out = await q.edit({ version: m.version, runId: runsOf(m, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' });
      expect(out).toMatchObject({ ok: false, code: 'conflict' });
      expect(io.text).toBe(prefix);
      // The other program finishes within the wait: the edit goes on its whole deck.
      const io2 = new MemIO(V);
      let t2 = 0;
      const q2 = createWriteQueue(io2, {
        writerWaitMs: 50,
        writerPollMs: 5,
        sleep: async () => {
          t2 += 5;
          if (t2 === 20) io2.external(NEW);
        },
        now: () => t2,
      });
      const m2 = await q2.refresh();
      io2.external(prefix);
      expect((await q2.edit({ version: m2.version, runId: runsOf(m2, 'Key takeaways')[0].id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' })).ok).toBe(true);
      expect(io2.text).toBe(NEW.replace('<h2>Key takeaways</h2>', '<h2>Key takeaways two</h2>'));
    });
  }

  it('endsWhole: the last </html> the parser reads as a tag, then only white space and comments', () => {
    expect(endsWhole('<!DOCTYPE html>\n<html><body><p>a</p></body></html>\n')).toBe(true);
    expect(endsWhole('<!DOCTYPE html>\n<HTML><body><p>a</p></HTML >\n<!-- generated -->\n')).toBe(true);
    expect(endsWhole('<p>a</p></html>')).toBe(true); // no <html> start tag: the end tag still ends it
    expect(endsWhole('<!DOCTYPE html>\n<html><body><p>a</p>')).toBe(false);
    expect(endsWhole('<!DOCTYPE html>\n<html><body></body></html><script>var s = \'</html>')).toBe(false);
    expect(endsWhole('<!DOCTYPE html>\n<html><body></body></html>\n<!-- note </html>')).toBe(false);
    expect(endsWhole('<!DOCTYPE html>\n<html><body><textarea></html>')).toBe(false);
    expect(endsWhole('<!DOCTYPE html>\n<html><head><style>/* </html>')).toBe(false);
    // A real end tag ends it even where the tree ignores it (a deck that leaves a table cell open).
    expect(endsWhole('<!DOCTYPE html>\n<html><body><table><tr><td>x</html>\n')).toBe(true);
  });
});
