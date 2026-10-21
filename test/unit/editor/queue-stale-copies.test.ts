// A stale edit on text that is in several places is written only where the text around every copy confirms the
// diff's placement (packages/editor/src/place.ts; E-1, review finding 0 re-verification). Placing by position
// alone wrote into ANOTHER copy when another program moved a templated slide, or inserted one and changed the
// edited slide's subtitle: a minimal diff aligns the edited heading with another slide's heading with no change
// overlapping it. Those cases are verbatim notes now; the model fuzz below moves, copies, deletes and changes
// templated slides and checks that nothing is ever written into a slide other than the one the author edited.
import { describe, expect, it } from 'vitest';
import { createWriteQueue } from '@blueline/editor';
import { MemIO } from './helpers';

interface Slide {
  uid: number;
  id: string;
  kicker: string;
  head: string;
  sub: string;
  body: string;
}

const one = (s: Slide): string =>
  `<section id="${s.id}">\n  <div class="kicker">${s.kicker}</div>\n  <h2 class="title">${s.head}</h2>\n  <p class="sub">${s.sub}</p>\n  <p>${s.body}</p>\n</section>\n`;
const render = (ss: Slide[]): string => `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>\n${ss.map(one).join('')}</body></html>\n`;
const slide = (uid: number, id: string, body: string, sub = 'Same subtitle'): Slide => ({ uid, id, kicker: 'Section summary', head: 'Key takeaways', sub, body });
const EDITED = 'Key takeaways two';

/** The edit of the `which`-th 'Key takeaways' heading of A, made on version A, sent after the file became C. */
async function staleHeadingEdit(A: string, C: string, which: number) {
  const io = new MemIO(A);
  const q = createWriteQueue(io);
  const mA = await q.refresh();
  const run = mA.runs.filter((r) => r.value === 'Key takeaways')[which];
  io.external(C);
  const out = await q.edit({ version: mA.version, runId: run.id, beforeText: 'Key takeaways', afterText: EDITED });
  return { out, io };
}

describe('moved and inserted templated slides (finding 0 re-verification, S-B and S-C)', () => {
  const intro = slide(0, 'intro', 'Revenue grew in every region');
  const next = slide(1, 'next', 'Costs fell in two regions');
  const A = render([intro, next]);

  it('S-B: another program moves slide 1 to the end; the edit of slide 2\'s heading is a note, never written into slide 1', async () => {
    const C = render([next, intro]);
    const { out, io } = await staleHeadingEdit(A, C, 1);
    expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Key takeaways', after: EDITED } });
    expect(io.text).toBe(C);
    expect(io.writes).toBe(0);
  });

  it('S-C: another program inserts a templated slide at the top and rewrites the edited slide\'s subtitle: a note, never written into the new slide', async () => {
    const C = render([slide(2, 'new', 'Headcount stayed flat'), { ...intro, sub: 'Agent rewrote this subtitle' }, next]);
    const { out, io } = await staleHeadingEdit(A, C, 0);
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(C);
    expect(io.writes).toBe(0);
  });

  it('a templated copy of another slide inserted next to the edited one: a note or the right slide, never another', async () => {
    const cases: [Slide[], number][] = [
      [[intro, { ...intro, uid: 5, id: 'intro-copy' }, next], 1],
      [[intro, slide(6, 'mid', 'Headcount stayed flat'), next], 1],
      [[intro, next, { ...next, uid: 7, id: 'next-2', body: 'Margins rose' }], 1],
      [[intro, { ...next, uid: 8, id: 'next-0', body: 'Margins rose' }, next], 1],
    ];
    for (const [cur, target] of cases) {
      const C = render(cur);
      const { out, io } = await staleHeadingEdit(A, C, target);
      const right = render(cur.map((s) => (s.uid === [intro, next][target].uid ? { ...s, head: EDITED } : s)));
      if (out.ok) expect(io.text).toBe(right);
      else expect(io.text).toBe(C);
    }
  });

  it('the changes finding 0 was about still land on the slide the author typed on', async () => {
    const s1 = slide(0, 's1', 'Body text 1');
    const s2 = slide(1, 's2', 'Body text 2');
    const A2 = render([s1, s2]);
    for (const changed of [{ ...s2, sub: 'Agent rewrote this subtitle' }, { ...s2, kicker: 'Section recap' }, { ...s2, sub: 'Not Same subtitle' }]) {
      const C = render([s1, changed]);
      const { out, io } = await staleHeadingEdit(A2, C, 1);
      expect(out.ok).toBe(true);
      expect(io.text).toBe(render([s1, { ...changed, head: EDITED }]));
    }
  });
});

describe('a copy another program adds (rule 3)', () => {
  const deck = (pre: string, sub = 'Hire two engineers') =>
    `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>\n${pre}<section id="s1">\n  <h2 class="title">Agenda</h2>\n  <p class="sub">${sub}</p>\n</section>\n<section id="s2">\n  <h2 class="title">Next steps</h2>\n</section>\n</body></html>\n`;
  async function edit(C: string) {
    const A = deck('');
    const io = new MemIO(A);
    const q = createWriteQueue(io);
    const mA = await q.refresh();
    const run = mA.runs.find((r) => r.value === 'Agenda')!;
    io.external(C);
    return { out: await q.edit({ version: mA.version, runId: run.id, beforeText: 'Agenda', afterText: 'Agenda today' }), io };
  }

  it('the same words pasted into a new paragraph elsewhere: the edit is written on the heading', async () => {
    const C = deck('<p>Agenda</p>\n');
    const { out, io } = await edit(C);
    expect(out.ok).toBe(true);
    expect(io.text).toBe(C.replace('<h2 class="title">Agenda</h2>', '<h2 class="title">Agenda today</h2>'));
  });

  it('a templated slide with the same heading added beside it: a note', async () => {
    const C = deck('<section id="s0">\n  <h2 class="title">Agenda</h2>\n  <p class="sub">Hire two engineers</p>\n</section>\n');
    const { out, io } = await edit(C);
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(C);
  });

  it('a templated slide added and the edited slide\'s subtitle rewritten: a note', async () => {
    const C = deck('<section id="s0">\n  <h2 class="title">Agenda</h2>\n  <p class="sub">Hire two engineers</p>\n</section>\n', 'Agent rewrote this subtitle');
    const { out, io } = await edit(C);
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(C);
  });
});

describe('repeated markup around copies the diff left unchanged (rule 2)', () => {
  // The same item in two lists whose markup repeats: what tells the copies apart ('class="a"' or 'class="b"' right
  // before the text) is also found further out around the other copy. Another program changes only the end of the
  // file, so the text around both copies is as it was: each is written where the author typed, not a note.
  const L1 = '<ul><li class="a">Item</li><li class="b">Other</li></ul>\n';
  const L2 = '<ul><li class="a">Other</li><li class="b">Item</li></ul>\n';
  const lists = (tail = '', first = L1, second = L2) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>\n` +
    `${first}${second}<ul><li class="b">Other</li></ul>\n${tail}</body></html>\n`;
  for (const which of [0, 1]) {
    it(`an unrelated change at the end of the file: copy ${which + 1} of two is written where the author typed`, async () => {
      const io = new MemIO(lists());
      const q = createWriteQueue(io);
      const m = await q.refresh();
      const run = m.runs.filter((r) => r.value === 'Item')[which];
      const C = lists('<!-- another program -->\n');
      io.external(C);
      const out = await q.edit({ version: m.version, runId: run.id, beforeText: 'Item', afterText: 'Item two' });
      expect(out.ok).toBe(true);
      const at = C.split('Item');
      expect(io.text).toBe(which === 0 ? `${at[0]}Item two${at[1]}Item${at[2]}` : `${at[0]}Item${at[1]}Item two${at[2]}`);
    });
  }

  it('the two lists swapped by another program: a note, never written into the other list', async () => {
    for (const which of [0, 1]) {
      const io = new MemIO(lists());
      const q = createWriteQueue(io);
      const m = await q.refresh();
      const run = m.runs.filter((r) => r.value === 'Item')[which];
      const C = lists('', L2, L1);
      io.external(C);
      const out = await q.edit({ version: m.version, runId: run.id, beforeText: 'Item', afterText: 'Item two' });
      expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Item', after: 'Item two' } });
      expect(io.text).toBe(C);
    }
  });
});

/** A seeded generator (LCG): the same cases on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * One case of the model fuzz: templated slides (unique ids or all the same id; bodies distinct, or 1 in 5 left
 * bare), then 1 to 4 operations by another program (copy a slide anywhere, delete one, move one, change a
 * subtitle, kicker, body or id, the edited slide's included). The true place of the edited heading is its slide's
 * uid. `twin`: the edited slide was byte-identical to another in A, so which one it was cannot be seen once slides
 * move (any outcome is accepted then).
 */
function makeCase(seed: number, uniqueIds: boolean) {
  const r = rng(seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)];
  let uid = 0;
  const n = 2 + Math.floor(r() * 4);
  const slides: Slide[] = [];
  for (let i = 0; i < n; i++) slides.push(slide(uid++, uniqueIds ? `s${i + 1}` : 'slide', r() < 0.2 ? 'Body text' : `Body text ${i + 1}`));
  const ti = Math.floor(r() * n);
  const target = slides[ti];
  const cur = slides.map((s) => ({ ...s }));
  const ops = 1 + Math.floor(r() * 4);
  for (let k = 0; k < ops; k++) {
    const x = r();
    if (x < 0.25) {
      const src = pick(cur);
      const copy = { ...src, uid: uid++, id: uniqueIds ? `s${100 + uid}` : src.id, body: r() < 0.5 ? src.body : `Body text ${100 + uid}` };
      cur.splice(Math.floor(r() * (cur.length + 1)), 0, copy);
    } else if (x < 0.35 && cur.length > 2) {
      const d = pick(cur.filter((s) => s.uid !== target.uid));
      cur.splice(cur.indexOf(d), 1);
    } else if (x < 0.5) {
      const s = pick(cur);
      cur.splice(cur.indexOf(s), 1);
      cur.splice(Math.floor(r() * (cur.length + 1)), 0, s);
    } else if (x < 0.7) pick(cur).sub = pick(['Agent rewrote this subtitle', 'Not Same subtitle', 'Same subtitle!']);
    else if (x < 0.8) pick(cur).kicker = pick(['Section recap', 'Summary']);
    else if (x < 0.9) pick(cur).body += ' x';
    else pick(cur).id += 'b';
  }
  const A = render(slides);
  const C = render(cur);
  const right = render(cur.map((s) => (s.uid === target.uid ? { ...s, head: EDITED } : s)));
  const t = cur.find((s) => s.uid === target.uid)!;
  // Also right: a slide that is byte-identical to the edited one now (nothing tells them apart).
  const same = cur.filter((s) => s.uid !== target.uid && one(s) === one(t)).map((alt) => render(cur.map((s) => (s.uid === alt.uid ? { ...s, head: EDITED } : s))));
  const twin = slides.some((s) => s.uid !== target.uid && one(s) === one(target));
  return { A, C, ti, right, same, twin };
}

describe('model fuzz: another program moves, copies, deletes and changes templated slides (E-1)', () => {
  for (const uniqueIds of [true, false]) {
    it(`${uniqueIds ? 'unique' : 'identical'} section ids, 1500 seeds: never written into another slide`, async () => {
      const counts = { note: 0, right: 0, twin: 0 };
      const wrong: number[] = [];
      for (let seed = 1; seed <= 1500; seed++) {
        const c = makeCase(seed, uniqueIds);
        if (c.A === c.C) continue;
        const { out, io } = await staleHeadingEdit(c.A, c.C, c.ti);
        if (!out.ok) {
          counts.note++;
          expect(io.text).toBe(c.C);
        } else if (io.text === c.right || c.same.includes(io.text)) counts.right++;
        else if (c.twin) counts.twin++;
        else wrong.push(seed);
      }
      expect(wrong, `wrong-place writes (seeds); counts ${JSON.stringify(counts)}`).toEqual([]);
      // Some stale edits are still written by position (the gate's concurrency rule: right place or a note).
      expect(counts.right).toBeGreaterThan(100);
    }, 120_000);
  }
});
