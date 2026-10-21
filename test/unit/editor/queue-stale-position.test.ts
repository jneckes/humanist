// A stale edit is placed by POSITION (lead decision E-1; review findings 0, 1 and 22): the client's run is mapped
// from its version to the current one through a diff, and only the run at that exact place, holding beforeText,
// with no change overlapping it, is written. Text and its 32 characters of context never pick a copy by
// themselves; anything else is a verbatim note. The versions a client holds are pinned (9.2 Write protocol step 1),
// and a version the queue does not know is a `stale` note, never a guess.
import { describe, expect, it } from 'vitest';
import { createWriteQueue } from '@blueline/editor';
import type { EditRequest, WriteOutcome } from '@blueline/core/types';
import { MemIO, mapOf } from './helpers';

const slide = (n: number, kicker: string, sub: string) =>
  `<section id="s${n}">\n  <div class="kicker">${kicker}</div>\n  <h2 class="title">Key takeaways</h2>\n  <p class="sub">${sub}</p>\n  <p>Body text ${n}</p>\n</section>\n`;
const deck = (o: { k1?: string; k2?: string; s1?: string; s2?: string; tail?: string } = {}) =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>\n${slide(1, o.k1 ?? 'Section summary', o.s1 ?? 'Same subtitle')}${slide(2, o.k2 ?? 'Section summary', o.s2 ?? 'Same subtitle')}${o.tail ?? ''}</body></html>\n`;

/** The two slides of a file, as text. */
function slides(src: string): [string, string] {
  const at = src.indexOf('<section id="s2">');
  return [src.slice(0, at), src.slice(at)];
}

function headingEdit(map: ReturnType<typeof mapOf>, which: 0 | 1): EditRequest {
  const run = map.runs.filter((r) => r.value === 'Key takeaways')[which];
  return { version: map.version, runId: run.id, beforeText: 'Key takeaways', afterText: 'Key takeaways two' };
}

function noted(out: WriteOutcome): string {
  return out.ok ? 'written' : out.code;
}

describe('a stale edit on duplicated text lands on the run the client edited, or is a note (E-1, finding 0)', () => {
  it('another program changed slide 2\'s subtitle: slide 2\'s heading edit is written into slide 2, never slide 1', async () => {
    const A = deck();
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const mA = await q.refresh();
    const changed = deck({ s2: 'Agent rewrote this subtitle' });
    io.external(changed);
    const out = await q.edit(headingEdit(mA, 1));
    expect(out).toMatchObject({ ok: true, merged: true });
    const [one, two] = slides(io.text);
    expect(one).not.toContain('Key takeaways two');
    expect(two).toContain('<h2 class="title">Key takeaways two</h2>');
    expect(two).toContain('Agent rewrote this subtitle');
  });

  it('the mirror: slide 1\'s heading, slide 1\'s subtitle changed, lands in slide 1', async () => {
    const io = new MemIO(deck());
    const q = createWriteQueue(io);
    const mA = await q.refresh();
    io.external(deck({ s1: 'Agent rewrote this subtitle' }));
    const out = await q.edit(headingEdit(mA, 0));
    expect(out.ok).toBe(true);
    const [one, two] = slides(io.text);
    expect(one).toContain('Key takeaways two');
    expect(two).not.toContain('Key takeaways two');
  });

  it('the author\'s own earlier write (\'Not \' at the start of slide 2\'s subtitle), then a request still on the old version', async () => {
    const io = new MemIO(deck());
    const q = createWriteQueue(io);
    const mA = await q.refresh();
    const sub2 = mA.runs.filter((r) => r.value === 'Same subtitle')[1];
    expect((await q.edit({ version: mA.version, runId: sub2.id, beforeText: 'Same subtitle', afterText: 'Not Same subtitle' })).ok).toBe(true);
    const out = await q.edit(headingEdit(mA, 1));
    expect(noted(out)).toBe('written');
    const [one, two] = slides(io.text);
    expect(one).not.toContain('Key takeaways two');
    expect(two).toContain('Key takeaways two');
    expect(two).toContain('Not Same subtitle');
  });

  it('the kicker of slide 2 changed (the context before the heading): still slide 2', async () => {
    const io = new MemIO(deck());
    const q = createWriteQueue(io);
    const mA = await q.refresh();
    io.external(deck({ k2: 'Section recap' }));
    const out = await q.edit(headingEdit(mA, 1));
    expect(out.ok).toBe(true);
    const [one, two] = slides(io.text);
    expect(one).not.toContain('Key takeaways two');
    expect(two).toContain('Key takeaways two');
  });

  it('a change far away still lands right', async () => {
    const A = deck();
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const mA = await q.refresh();
    io.external(A.replace('Body text 2', 'Body text 2 changed'));
    const out = await q.edit(headingEdit(mA, 1));
    expect(out.ok).toBe(true);
    expect(slides(io.text)[1]).toContain('Key takeaways two');
  });

  it('the copy being edited was rewritten: a verbatim note (ambiguous), the file is the other program\'s', async () => {
    const A = deck();
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const mA = await q.refresh();
    const two = A.lastIndexOf('Key takeaways');
    const changed = `${A.slice(0, two)}Key results${A.slice(two + 'Key takeaways'.length)}`;
    io.external(changed);
    const out = await q.edit(headingEdit(mA, 1));
    expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Key takeaways', after: 'Key takeaways two' } });
    expect(io.text).toBe(changed);
    expect(io.writes).toBe(0);
  });
});

describe('the versions a client holds are pinned; an unknown version is a note (E-1, findings 1 and 22)', () => {
  const agenda = (n: number, b: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>\n<h2 id="a">Agenda</h2>\n<p>save ${n}</p>\n<h2 id="b">${b}</h2>\n</body></html>\n`;

  async function evicted(n: number, pin: boolean) {
    const v0src = agenda(0, 'Agenda');
    const io = new MemIO(v0src);
    const q = createWriteQueue(io);
    const m0 = mapOf(v0src);
    q.know(m0.version, v0src, m0, { pin }); // main pins the version an open field holds
    const target = m0.runs.filter((r) => r.value === 'Agenda')[1]; // #b
    let last = v0src;
    for (let i = 1; i <= n; i++) {
      last = i === n ? agenda(i, 'Plan for today') : agenda(i, 'Agenda');
      io.external(last);
      const m = mapOf(last);
      q.know(m.version, last, m); // takeExternal
    }
    const out = await q.edit({ version: m0.version, runId: target.id, beforeText: 'Agenda', afterText: 'Agenda Monday' });
    return { out, io, last };
  }

  for (const n of [8, 9, 12]) {
    it(`a pinned version after ${n} newer versions: the edit of #b (rewritten by the ${n}th) is a note, #a untouched`, async () => {
      const { out, io, last } = await evicted(n, true);
      expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Agenda', after: 'Agenda Monday' } });
      expect(io.text).toBe(last);
      expect(io.writes).toBe(0);
    });
  }

  it('without a pin the evicted version is unknown: a stale note, never the other copy', async () => {
    const { out, io, last } = await evicted(9, false);
    expect(out).toMatchObject({ ok: false, code: 'stale' });
    expect(io.text).toBe(last);
  });

  it('a field held open across N external saves, the first renaming card one\'s role (finding 22)', async () => {
    const cards = (a: string, b: string, n: number) =>
      `<!doctype html><html><body><section><h2>Card one</h2><p class="role">${a}</p></section>` +
      `<section><h2>Card two</h2><p class="role">${b}</p></section><p>rev ${n}</p></body></html>`;
    for (const n of [1, 7, 8, 9]) {
      const v0src = cards('Owner', 'Owner', 0);
      const io = new MemIO(v0src);
      const v0 = mapOf(v0src);
      const q = createWriteQueue(io);
      q.know(v0.version, v0src, v0, { pin: true });
      const first = v0.runs.find((r) => r.value === 'Owner')!;
      for (let i = 1; i <= n; i++) {
        const s = cards('Owners', 'Owner', i);
        io.external(s);
        const m = mapOf(s);
        q.know(m.version, s, m);
      }
      const out = await q.edit({ version: v0.version, runId: first.id, beforeText: 'Owner', afterText: 'Owner/Lead' });
      expect(out, `n=${n}`).toMatchObject({ ok: false, code: 'ambiguous' });
      expect(io.text, `n=${n}`).toContain('Card two</h2><p class="role">Owner</p>');
    }
  });

  it('unpin lets the LRU evict it again; pins are counted', async () => {
    const v0src = agenda(0, 'Agenda');
    const io = new MemIO(v0src);
    const q = createWriteQueue(io, { keepVersions: 2 });
    const m0 = mapOf(v0src);
    q.know(m0.version, v0src, m0, { pin: true });
    q.know(m0.version, v0src, m0, { pin: true });
    const tell = (i: number) => {
      const s = agenda(i, 'Agenda');
      io.external(s);
      const m = mapOf(s);
      q.know(m.version, s, m);
    };
    const req = { version: m0.version, runId: m0.runs.filter((r) => r.value === 'Agenda')[1].id, beforeText: 'Agenda', afterText: 'Agenda Monday' };
    for (let i = 1; i <= 3; i++) tell(i);
    q.unpin(m0.version);
    for (let i = 4; i <= 6; i++) tell(i);
    // Still pinned once: placed by position.
    expect((await q.edit(req)).ok).toBe(true);
    q.unpin(m0.version);
    for (let i = 7; i <= 9; i++) tell(i);
    expect(await q.edit({ ...req, afterText: 'Agenda Tuesday' })).toMatchObject({ ok: false, code: 'stale' });
  });
});

describe('what cannot be placed by position is a note (E-1)', () => {
  it('a version the queue never saw is a stale note, even when the text is unique', async () => {
    const io = new MemIO('<!doctype html><html><body><p>Solo</p><p>Twin</p><p>Twin</p></body></html>');
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const run = map.runs.find((r) => r.value === 'Solo')!;
    const out = await q.edit({ version: 'f'.repeat(64), runId: run.id, beforeText: 'Solo', afterText: 'Solo!' });
    expect(out).toMatchObject({ ok: false, code: 'stale', verbatim: { before: 'Solo', after: 'Solo!' } });
    expect(io.writes).toBe(0);
  });

  it('a diff that reaches its time limit is a stale note, never a guess', async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `<p>line ${i} of the filler text</p>`).join('\n');
    const A = deck({ tail: filler });
    const io = new MemIO(A);
    const q = createWriteQueue(io, { diffTimeoutSec: 1e-9 });
    const mA = await q.refresh();
    const changed = deck({ s2: 'Agent rewrote this subtitle', tail: filler.replace(/of the/g, 'in the') });
    io.external(changed);
    const out = await q.edit(headingEdit(mA, 1));
    expect(out).toMatchObject({ ok: false, code: 'stale' });
    expect(io.text).toBe(changed);
    // The same request with the default limit is placed by position.
    const io2 = new MemIO(A);
    const q2 = createWriteQueue(io2);
    await q2.refresh();
    io2.external(changed);
    expect((await q2.edit(headingEdit(mA, 1))).ok).toBe(true);
    expect(slides(io2.text)[1]).toContain('Key takeaways two');
  });
});
