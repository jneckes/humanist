// The clean-up oracle both fuzz halves judge commits with (test/fuzz/harness/cleanup-oracle.ts; SPEC 9.2 Committing
// an edit step 3, 6.3; review finding 24). It re-derives the clean-up from the spec and shares no code with
// core/edit-cleanup, so it must fail what it exists to catch: a commit that loses the deck's own NBSP (both of the
// fuzzes' former oracles took their expectation from cleanupCommit and accepted it), a clean-up that turns every
// NBSP into a space, a curled quote the deck had straight, a pasted NBSP kept. And it must pass the real commit
// path. Every case is judged with the author's record and without it: the record only names units in the message.

import { describe, expect, it } from 'vitest';
import { commitField, type FieldRun } from '@blueline/core/edit-commit';
import { judgeCleanup, type CleanupCase } from '../harness/cleanup-oracle';
import { boundaries, rng, TOKENS, type Rng } from '../harness/fuzz-core';

const NB = '\u00A0';
const ZW = '\u200B';

/** A record from marks: '+' for each inserted unit of raw, '.' for the field's own. */
const rec = (marks: string): boolean[] => [...marks].map((x) => x === '+');

/** Judged with the record (the Node fuzz) and without it (the Chromium half). */
function both(c: CleanupCase): [string | null, string | null] {
  return [judgeCleanup(c), judgeCleanup({ ...c, inserted: undefined })];
}

const rejected = (c: CleanupCase) => both(c).every((x) => x !== null);

describe('the deck\'s own characters stay; what was inserted is cleaned (9.2 step 3)', () => {
  // 'Delivery' -> 'Deliveries', ' soon' and an NBSP at the end: two changes, the run's own NBSP between them.
  const before = `Delivery in 10${NB}km`;
  const raw = `Deliveries in 10${NB}km soon${NB}`;
  const inserted = rec('.......+++.........++++++');

  it('passes the right clean-up, with the record and without', () => {
    expect(both({ before, raw, inserted, result: `Deliveries in 10${NB}km soon ` })).toEqual([null, null]);
  });

  it("fails a commit that loses the run's own NBSP (the one both former oracles accepted)", () => {
    const [a, b] = both({ before, raw, inserted, result: 'Deliveries in 10 km soon ' });
    expect(a).toMatch(/offset 16 of the field: U\+00A0 \(the field's own\); the commit has U\+0020/);
    expect(b).toMatch('[clean-up]');
  });

  it('fails a commit that keeps the NBSP the author added', () => {
    expect(rejected({ before, raw, inserted, result: `Deliveries in 10${NB}km soon${NB}` })).toBe(true);
  });

  it('judges the opposite case: the NBSP pasted where the deck\'s was replaced becomes a space', () => {
    const c = { before: `Price 10${NB}km away`, raw: `Price 10 km away${NB}now`, inserted: rec('........+.......++++') };
    expect(both({ ...c, result: 'Price 10 km away now' })).toEqual([null, null]);
    expect(rejected({ ...c, result: `Price 10 km away${NB}now` })).toBe(true);
  });

  it('keeps the line break a <pre> run had between two changes, and makes a pasted one a space', () => {
    const c = { before: 'one\ntwo', raw: 'one!\ntw\no!', inserted: rec('...+...+.+') };
    expect(both({ ...c, result: 'one!\ntw o!' })).toEqual([null, null]);
    expect(rejected({ ...c, result: 'one! tw o!' })).toBe(true);
    expect(rejected({ ...c, result: 'one!\ntw\no!' })).toBe(true);
  });

  it('makes an inserted CRLF one space, and a CR typed before the run\'s own LF a space of its own', () => {
    expect(both({ before: 'Hello', raw: 'Hello\r\nworld', inserted: rec('.....+++++++'), result: 'Hello world' })).toEqual([null, null]);
    expect(judgeCleanup({ before: 'Hello', raw: 'Hello\r\nworld', result: 'Hello  world' })).not.toBeNull();
    expect(judgeCleanup({ before: 'Hello', raw: 'Hello\r\nworld', result: 'Hello\r\nworld' })).not.toBeNull();
    expect(both({ before: 'a\nb', raw: 'a\r\nb', inserted: rec('.+..'), result: 'a \nb' })).toEqual([null, null]);
    expect(judgeCleanup({ before: 'a\nb', raw: 'a\r\nb', result: 'a b' })).not.toBeNull();
  });

  it('drops an inserted zero-width space and keeps the run\'s own', () => {
    const c = { before: `long${ZW}word here`, raw: `longer${ZW}word here${ZW}!`, inserted: rec('....++..........++') };
    expect(both({ ...c, result: `longer${ZW}word here!` })).toEqual([null, null]);
    expect(judgeCleanup({ ...c, result: 'longerword here!' })).not.toBeNull();
    expect(judgeCleanup({ ...c, result: `longer${ZW}word here${ZW}!` })).not.toBeNull();
  });

  it('keeps the unchanged prefix and suffix, and an NBSP at the same position (the position rule)', () => {
    expect(judgeCleanup({ before: `x 1${NB}000 y`, raw: `x 2${NB}500 y`, result: `x 2${NB}500 y` })).toBeNull();
    expect(judgeCleanup({ before: `x 1${NB}000 y`, raw: `x 2${NB}500 y`, result: 'x 2 500 y' })).not.toBeNull();
    expect(judgeCleanup({ before: `10${NB}km`, raw: `10${NB}km away`, result: '10 km away' })).not.toBeNull();
  });

  it('takes the unchanged prefix first when the author typed an NBSP right after the deck\'s own', () => {
    // The author typed the first one; 9.2 step 3 measures from the unchanged prefix, which holds it.
    const c = { before: `a${NB}b`, raw: `a${NB}${NB}b`, inserted: rec('.+..') };
    expect(both({ ...c, result: `a${NB} b` })).toEqual([null, null]);
    expect(rejected({ ...c, result: `a ${NB}b` })).toBe(true);
    expect(rejected({ ...c, result: 'a  b' })).toBe(true);
    expect(rejected({ ...c, result: `a${NB}${NB}b` })).toBe(true);
  });

  it('accepts either NBSP as the deck\'s own inside the changed region, but not both, and not neither', () => {
    // Both ends changed and an NBSP typed next to the deck's own: a diff pairs either one with it.
    const c = { before: `X${NB}Y`, raw: `ZZ${NB}${NB}WW`, inserted: rec('++.+++') };
    expect(both({ ...c, result: `ZZ${NB} WW` })).toEqual([null, null]);
    expect(both({ ...c, result: `ZZ ${NB}WW` })).toEqual([null, null]);
    expect(rejected({ ...c, result: `ZZ${NB}${NB}WW` })).toBe(true);
    expect(rejected({ ...c, result: 'ZZ  WW' })).toBe(true);
  });

  it('judges a long field (the readings are walked without recursion)', () => {
    const body = `word${NB}`.repeat(10_000);
    expect(judgeCleanup({ before: `Start ${body}end`, raw: `Go ${body}end${NB}`, result: `Go ${body}end ` })).toBeNull();
    expect(judgeCleanup({ before: `Start ${body}end`, raw: `Go ${body}end${NB}`, result: `Go ${body.replace(NB, ' ')}end ` })).not.toBeNull();
  });

  it('fails any change the clean-up does not make', () => {
    expect(judgeCleanup({ before: 'Revenue grew fast', raw: 'Revenue rose fast', result: 'Revenue rise fast' })).toMatch('[clean-up] the commit is not');
    expect(judgeCleanup({ before: 'ab', raw: 'abc', result: 'ab' })).not.toBeNull();
    expect(judgeCleanup({ before: 'ab', raw: 'abc', result: 'abcd' })).not.toBeNull();
  });
});

describe('smart punctuation curls only what was typed (6.3)', () => {
  // A run with curly quotes and a straight "b": A -> AA and ' "c"' typed at the end; the run's own "b" stays straight.
  const c = { before: '\u201CA\u201D and "b" end', raw: '\u201CAA\u201D and "b" end "c"', inserted: rec('..+...............++++'), curly: { double: true, single: false } };

  it('curls the typed quotes and leaves the run\'s own straight', () => {
    expect(both({ ...c, smart: true, result: '\u201CAA\u201D and "b" end \u201Cc\u201D' })).toEqual([null, null]);
    expect(rejected({ ...c, smart: true, result: '\u201CAA\u201D and \u201Cb\u201D end \u201Cc\u201D' })).toBe(true);
  });

  it('must curl the typed quotes when the setting is on and the run uses curly ones; never when it is off', () => {
    expect(rejected({ ...c, smart: true, result: '\u201CAA\u201D and "b" end "c"' })).toBe(true);
    expect(both({ ...c, smart: false, result: '\u201CAA\u201D and "b" end "c"' })).toEqual([null, null]);
    expect(rejected({ ...c, smart: false, result: '\u201CAA\u201D and "b" end \u201Cc\u201D' })).toBe(true);
    // Unknown setting (the Chromium half): either.
    expect(judgeCleanup({ ...c, result: '\u201CAA\u201D and "b" end "c"' })).toBeNull();
    expect(judgeCleanup({ ...c, result: '\u201CAA\u201D and "b" end \u201Cc\u201D' })).toBeNull();
  });

  it('never curls a kind the run does not use', () => {
    expect(judgeCleanup({ ...c, smart: true, curly: { double: false, single: false }, result: '\u201CAA\u201D and "b" end \u201Cc\u201D' })).not.toBeNull();
    expect(judgeCleanup({ ...c, smart: true, curly: { double: true, single: false }, raw: "\u201CA\u201D and 'b'", before: '\u201CA\u201D and', result: "\u201CA\u201D and \u2018b\u2019" })).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------- the real commit path

function randomText(r: Rng): string {
  let s = '';
  const n = 1 + r.int(4);
  for (let i = 0; i < n; i++) s += r.pick(TOKENS);
  return s;
}

/** One or two changes to s, with the record of what was inserted. */
function change(r: Rng, before: string): { text: string; inserted: boolean[] } {
  let s = before;
  let inserted: boolean[] = new Array<boolean>(before.length).fill(false);
  const put = (i: number, j: number, t: string) => {
    s = s.slice(0, i) + t + s.slice(j);
    inserted = [...inserted.slice(0, i), ...new Array<boolean>(t.length).fill(true), ...inserted.slice(j)];
  };
  for (let k = 0, ops = 1 + (r.chance(0.3) ? 1 : 0); k < ops; k++) {
    const b = boundaries(s);
    const i = r.pick(b);
    const j = r.pick(b.filter((x) => x >= i));
    const op = r.int(5);
    if (op === 0) put(i, i, randomText(r));
    else if (op === 1) put(i, j, '');
    else if (op === 2) put(i, j, randomText(r));
    else if (op === 3) put(s.length, s.length, r.chance(0.5) ? ' ' + randomText(r) : NB);
    else put(i, i, 'Dictated text\r\nwith a break');
  }
  return { text: s, inserted };
}

const PIECES = ['Revenue', 'grew', 'across', 'a', '"q"', "it's", '\u201Cx\u201D', '\u2019s', NB, '\n', '\r\n', ZW, ' ', `10${NB}km`];

interface Commit {
  c: CleanupCase;
  /** The changed region of the field (the clean-up's span), where a broken clean-up would act. */
  pre: number;
  suf: number;
}

/** Random fields of one to three runs, edited and committed through commitField: the overlay's own path. */
function commits(seed: number, count: number): Commit[] {
  const r = rng(seed);
  const out: Commit[] = [];
  while (out.length < count) {
    let field = '';
    const runs: FieldRun[] = [];
    for (let k = 0, nr = 1 + r.int(3); k < nr; k++) {
      let v = '';
      for (let i = 0, w = 1 + r.int(5); i < w; i++) v += r.pick(PIECES) + (r.chance(0.5) ? ' ' : '');
      runs.push({ runId: `h:bl-${k}:0`, start: field.length, end: field.length + v.length, value: v || 'x' });
      field += v || 'x';
    }
    const target = r.pick(runs);
    const inner = change(r, target.value);
    const raw = field.slice(0, target.start) + inner.text + field.slice(target.end);
    const inserted = [...new Array<boolean>(target.start).fill(false), ...inner.inserted, ...new Array<boolean>(field.length - target.end).fill(false)];
    const smart = r.chance(0.7);
    const commit = commitField({ before: field, after: raw, runs, caretRunId: target.runId }, { smartPunctuation: smart });
    const curly = (s: string) => ({ double: /[\u201C\u201D]/.test(s), single: /[\u2018\u2019]/.test(s) });
    let pre = 0;
    while (pre < Math.min(field.length, raw.length) && field[pre] === raw[pre]) pre++;
    let suf = 0;
    while (suf < Math.min(field.length, raw.length) - pre && field[field.length - 1 - suf] === raw[raw.length - 1 - suf]) suf++;
    if (commit.kind === 'edit') {
      const o = runs.find((x) => x.runId === commit.runId)!;
      out.push({ c: { before: field, raw, inserted, smart, curly: curly(o.value), result: field.slice(0, o.start) + commit.afterText + field.slice(o.end) }, pre, suf });
    } else if (commit.kind === 'verbatim' && commit.why !== 'invalid') {
      out.push({ c: { before: field, raw, inserted, smart, curly: curly(field), result: commit.after }, pre, suf });
    }
  }
  return out;
}

describe('the real commit path passes; a clean-up that drops the deck\'s NBSPs does not', () => {
  const all = commits(20261020, 3000);

  it('passes every commit commitField makes, with the record and without', () => {
    const failed = all.map((x) => both(x.c)).filter(([a, b]) => a !== null || b !== null);
    expect(failed).toEqual([]);
  });

  it('fails most commits of a clean-up that turns every NBSP of the changed region into a space', () => {
    let differ = 0;
    let caught = 0;
    for (const { c, pre, suf } of all) {
      const end = c.result.length - suf;
      if (end < pre) continue;
      const broken = c.result.slice(0, pre) + c.result.slice(pre, end).replace(/\u00A0/g, ' ') + c.result.slice(end);
      if (broken === c.result) continue;
      differ++;
      if (rejected({ ...c, result: broken })) caught++;
    }
    expect(differ).toBeGreaterThan(50);
    // The rest are NBSPs no diff can tell from inserted ones (one retyped where one was deleted, or one typed next
    // to the deck's own): turning those into spaces is a reading the clean-up could also have made.
    expect(caught / differ).toBeGreaterThan(0.85);
  });
});
