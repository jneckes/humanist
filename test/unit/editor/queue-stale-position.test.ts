// A stale edit is placed by POSITION (lead decision E-1; review findings 0, 1 and 22): the client's run is mapped
// from its version to the current one through a diff, and only the run at that exact place, holding beforeText,
// with no change overlapping it, is written, and only when beforeText is in one place in both versions (F-1). Text and its 32 characters of context never pick a copy by
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
  // Finding 0's own cases: the 32-character context wrote them into slide 1. Placed by position they landed right,
  // but a change right next to the run cannot be told from the run being replaced and a copy put beside it (the
  // hardening round): they are notes now, and never written into the other slide.
  const cases: [string, Parameters<typeof deck>[0], 0 | 1][] = [
    ["slide 2's subtitle changed, slide 2's heading edited", { s2: 'Agent rewrote this subtitle' }, 1],
    ["the mirror: slide 1's subtitle changed, slide 1's heading edited", { s1: 'Agent rewrote this subtitle' }, 0],
    ["the kicker of slide 2 changed (the context before the heading), slide 2's heading edited", { k2: 'Section recap' }, 1],
  ];
  for (const [name, change, which] of cases) {
    it(`${name}: a note, never written into the other slide`, async () => {
      const io = new MemIO(deck());
      const q = createWriteQueue(io);
      const mA = await q.refresh();
      const changed = deck(change);
      io.external(changed);
      const out = await q.edit(headingEdit(mA, which));
      expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Key takeaways', after: 'Key takeaways two' } });
      expect(io.text).toBe(changed);
    });
  }

  it('the author\'s own earlier write (\'Not \' at the start of slide 2\'s subtitle), then a request still on the old version: placed exactly through that write, on slide 2', async () => {
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

  it('a change far away: a note on either copy, the text being in two places (F-1); a heading of its own lands right', async () => {
    const filler = Array.from({ length: 6 }, (_, i) => `<p>line ${i} of the filler text</p>`).join('\n');
    const A = deck({ tail: filler });
    for (const which of [0, 1] as const) {
      const io = new MemIO(A);
      const q = createWriteQueue(io);
      const mA = await q.refresh();
      const C = A.replace('line 5 of the filler', 'line 5 of the changed filler');
      io.external(C);
      const out = await q.edit(headingEdit(mA, which));
      expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Key takeaways', after: 'Key takeaways two' } });
      expect(io.text).toBe(C);
    }
    const U = A.replace('<h2 class="title">Key takeaways</h2>\n  <p class="sub">Same subtitle</p>\n  <p>Body text 2', '<h2 class="title">Key results</h2>\n  <p class="sub">Same subtitle</p>\n  <p>Body text 2');
    const io = new MemIO(U);
    const q = createWriteQueue(io);
    const mU = await q.refresh();
    io.external(U.replace('line 5 of the filler', 'line 5 of the changed filler'));
    const run = mU.runs.find((r) => r.value === 'Key results')!;
    expect((await q.edit({ version: mU.version, runId: run.id, beforeText: 'Key results', afterText: 'Key results two' })).ok).toBe(true);
    const [one, two] = slides(io.text);
    expect(one).toContain('Key takeaways</h2>');
    expect(two).toContain('Key results two');
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
  const pad = (k: string) => Array.from({ length: 4 }, (_, i) => `<p>Filler ${k} line ${i}: words that stay as they are.</p>`).join('\n');
  const agenda = (n: number, b: string) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>\n${pad('a')}\n<h2 id="a">Agenda</h2>\n<p>save ${n}</p>\n${pad('b')}\n<h2 id="b">${b}</h2>\n${pad('c')}\n</body></html>\n`;

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
    const v0src = agenda(0, 'Plan');
    const io = new MemIO(v0src);
    const q = createWriteQueue(io, { keepVersions: 2 });
    const m0 = mapOf(v0src);
    q.know(m0.version, v0src, m0, { pin: true });
    q.know(m0.version, v0src, m0, { pin: true });
    const tell = (i: number) => {
      const s = agenda(i, 'Plan');
      io.external(s);
      const m = mapOf(s);
      q.know(m.version, s, m);
    };
    // #b's heading in one place, so a known version is placed by position and written (F-1).
    const req = { version: m0.version, runId: m0.runs.find((r) => r.value === 'Plan')!.id, beforeText: 'Plan', afterText: 'Plan Monday' };
    for (let i = 1; i <= 3; i++) tell(i);
    q.unpin(m0.version);
    for (let i = 4; i <= 6; i++) tell(i);
    // Still pinned once: placed by position.
    expect((await q.edit(req)).ok).toBe(true);
    q.unpin(m0.version);
    for (let i = 7; i <= 9; i++) tell(i);
    expect(await q.edit({ ...req, afterText: 'Plan Tuesday' })).toMatchObject({ ok: false, code: 'stale', why: expect.stringMatching(/not known/) });
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
    // Slide 2's heading of its own, so the edit can be placed at all across another program's change (F-1).
    const own = (x: string) => x.replace('<h2 class="title">Key takeaways</h2>\n  <p class="sub">Same subtitle</p>\n  <p>Body text 2', '<h2 class="title">Key results</h2>\n  <p class="sub">Same subtitle</p>\n  <p>Body text 2');
    const A = own(deck({ tail: filler }));
    const io = new MemIO(A);
    const q = createWriteQueue(io, { diffTimeoutSec: 1e-9 });
    const mA = await q.refresh();
    const changed = own(deck({ k1: 'Section recap', tail: filler.replace(/(line [1-9]\d+ )of the/g, '$1in the') }));
    io.external(changed);
    const req = { version: mA.version, runId: mA.runs.find((r) => r.value === 'Key results')!.id, beforeText: 'Key results', afterText: 'Key results two' };
    const out = await q.edit(req);
    expect(out).toMatchObject({ ok: false, code: 'stale', why: expect.stringMatching(/too large/) });
    expect(io.text).toBe(changed);
    // The same request with the default limit is placed by position.
    const io2 = new MemIO(A);
    const q2 = createWriteQueue(io2);
    await q2.refresh();
    io2.external(changed);
    expect((await q2.edit(req)).ok).toBe(true);
    expect(slides(io2.text)[1]).toContain('Key results two');
  });
});
