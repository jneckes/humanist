// core/locked-spans (section 8 "Locked spans are transformed, not searched"; P2-12; section 11: locked-span
// transforms and violations).
import DiffMatchPatch from 'diff-match-patch';
import { describe, expect, it } from 'vitest';
import { applyOwnWrite, lockForRun, transformLockedSpans, xIndexBefore } from '@blueline/core/locked-spans';
import type { LockedSpan } from '@blueline/core/types';

/** A lock on the first occurrence of `text` in `src`. */
function lock(src: string, text: string, noteId = 'n-0001'): LockedSpan {
  const start = src.indexOf(text);
  if (start < 0) throw new Error(`no ${text}`);
  return { start, end: start + text.length, text, noteId, state: 'ok' };
}

const prev = '<h1>Plan</h1>\n<p>Revenue grew in every region.</p>\n<p>Next steps follow.</p>';

describe('transformLockedSpans: external changes (rules 2–3)', () => {
  const span = lock(prev, 'Revenue grew in every region.');

  it('an insertion or deletion before the span moves it, and it stays ok', () => {
    const note = '<p>Agent note.</p>\n';
    const ins = prev.replace('<h1>', note + '<h1>');
    const [a] = transformLockedSpans(prev, ins, [span]);
    expect(a).toEqual({ ...span, start: span.start + note.length, end: span.end + note.length });
    expect(ins.slice(a.start, a.end)).toBe(span.text);
    const del = prev.replace('<h1>Plan</h1>\n', '');
    const [b] = transformLockedSpans(prev, del, [span]);
    expect(del.slice(b.start, b.end)).toBe(span.text);
    expect(b.state).toBe('ok');
  });

  it('a change after the span leaves it as it is', () => {
    const cur = prev.replace('Next steps follow.', 'Next steps are below.');
    expect(transformLockedSpans(prev, cur, [span])).toEqual([span]);
  });

  it('an insertion inside the span violates it and records {before, after}; the text is not updated', () => {
    const cur = prev.replace('every region', 'every single region');
    const [a] = transformLockedSpans(prev, cur, [span]);
    expect(a.state).toBe('violated');
    expect(a.text).toBe(span.text);
    expect(a.change).toEqual({ before: 'Revenue grew in every region.', after: 'Revenue grew in every single region.' });
    expect(cur.slice(a.start, a.end)).toBe(a.change!.after);
  });

  it('a deletion inside, or one that overlaps an edge, violates it', () => {
    const inside = prev.replace(' in every region', '');
    expect(transformLockedSpans(prev, inside, [span])[0]).toMatchObject({ state: 'violated', change: { after: 'Revenue grew.' } });
    const edge = prev.replace('<p>Revenue', '<p>');
    const [b] = transformLockedSpans(prev, edge, [span]);
    expect(b).toMatchObject({ state: 'violated', change: { before: span.text, after: ' grew in every region.' } });
    const tail = prev.replace('region.</p>\n<p>Next', 'Next');
    expect(transformLockedSpans(prev, tail, [span])[0].state).toBe('violated');
  });

  it('an insertion exactly at the start or the end does not overlap it (and is not taken in)', () => {
    const atStart = prev.replace('<p>Revenue', '<p>NEW Revenue');
    const [a] = transformLockedSpans(prev, atStart, [span]);
    expect(a.state).toBe('ok');
    expect(atStart.slice(a.start, a.end)).toBe(span.text);
    const atEnd = prev.replace('region.</p>', 'region. NEW</p>');
    const [b] = transformLockedSpans(prev, atEnd, [span]);
    expect(b.state).toBe('ok');
    expect(atEnd.slice(b.start, b.end)).toBe(span.text);
  });

  it('a deletion right before or right after the span does not overlap it', () => {
    const before = prev.replace('<p>Revenue', 'Revenue');
    expect(transformLockedSpans(prev, before, [span])[0].state).toBe('ok');
    const after = prev.replace('region.</p>', 'region.');
    expect(transformLockedSpans(prev, after, [span])[0].state).toBe('ok');
  });

  it('text that replaced the whole span is what `after` shows', () => {
    const cur = prev.replace('Revenue grew in every region.', 'Sales fell.');
    const [a] = transformLockedSpans(prev, cur, [span]);
    expect(a).toMatchObject({ state: 'violated', text: span.text, change: { before: span.text, after: 'Sales fell.' } });
    expect(cur.slice(a.start, a.end)).toBe('Sales fell.');
    const gone = prev.replace('<p>Revenue grew in every region.</p>\n', '');
    expect(transformLockedSpans(prev, gone, [span])[0]).toMatchObject({ state: 'violated', change: { after: '' } });
  });

  it('a span whose text does not fit the previous content is reported, never trusted', () => {
    const wrong: LockedSpan = { ...span, text: 'Something else entirely' };
    const cur = prev.replace('<h1>', '<p>x</p><h1>');
    expect(transformLockedSpans(prev, cur, [wrong])[0]).toMatchObject({ state: 'violated', change: { before: 'Something else entirely' } });
    const outside: LockedSpan = { ...span, start: prev.length + 10, end: prev.length + 20 };
    expect(transformLockedSpans(prev, cur, [outside])[0].state).toBe('violated');
  });

  it('an already violated span keeps its first `before`; a later change updates `after`', () => {
    const v1 = prev.replace('every region', 'most regions');
    const [a] = transformLockedSpans(prev, v1, [span]);
    expect(a.change).toEqual({ before: span.text, after: 'Revenue grew in most regions.' });
    // An unrelated change: still violated, `after` as it was, offsets moved.
    const v2 = v1.replace('<h1>', '<p>Agent</p><h1>');
    const [b] = transformLockedSpans(v1, v2, [a]);
    expect(b).toEqual({ ...a, start: a.start + 12, end: a.end + 12 });
    // Another change inside it.
    const v3 = v2.replace('most regions', 'some regions');
    const [c] = transformLockedSpans(v2, v3, [b]);
    expect(c.change).toEqual({ before: span.text, after: 'Revenue grew in some regions.' });
  });

  it('several spans, an unchanged text, no spans; the input is never changed', () => {
    const s2 = lock(prev, 'Next steps follow.', 'n-0002');
    const input = [span, s2];
    const frozen = JSON.parse(JSON.stringify(input));
    const cur = prev.replace('every region', 'each region').replace('<h1>', '<hr><h1>');
    const [a, b] = transformLockedSpans(prev, cur, input);
    expect(a.state).toBe('violated');
    expect(b).toMatchObject({ state: 'ok', noteId: 'n-0002' });
    expect(cur.slice(b.start, b.end)).toBe(s2.text);
    expect(input).toEqual(frozen);
    expect(transformLockedSpans(prev, prev, input)).toEqual(input);
    expect(transformLockedSpans(prev, prev, input)[0]).not.toBe(input[0]);
    expect(transformLockedSpans(prev, cur, [])).toEqual([]);
  });

  it('UTF-16 offsets with astral characters, and no lone surrogate in a change', () => {
    const p = 'x \u{1F600} <p>Locked text</p> y';
    const s = lock(p, 'Locked text');
    const shifted = p.replace('x ', 'x \u{1F680}\u{1F680} ');
    const [a] = transformLockedSpans(p, shifted, [s]);
    expect(a).toMatchObject({ state: 'ok', start: s.start + 5, end: s.end + 5 });
    // A pair that differs only in its low half, right before the span, and the span's first letter changed: the
    // diff splits the pair, and the change's region is widened to keep it whole.
    const q = 'A\u{1F600}B tail';
    const sb: LockedSpan = { start: 3, end: 4, text: 'B', noteId: 'n-0003', state: 'ok' };
    const cur = 'A\u{1F601}C tail';
    const [b] = transformLockedSpans(q, cur, [sb]);
    expect(b.state).toBe('violated');
    expect(b.change!.after).toMatch(/^\u{1F601}?C$/u);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(b.change!.after)).toBe(false);
  });

  it('a timed-out diff can only over-report a violation, never hide one', () => {
    // Many scattered changes on both sides of a span, so the coarse diff a timeout gives covers it.
    const words = Array.from({ length: 4000 }, (_, i) => `w${(i * 7919) % 10007}`);
    const big = words.join(' ');
    const mid = big.indexOf(words[2000]);
    const p = big.slice(0, mid) + 'LOCKED SPAN TEXT ' + big.slice(mid);
    const s = lock(p, 'LOCKED SPAN TEXT');
    const scramble = (t: string) => t.replace(/w(\d+)/g, (m, n) => (Number(n) % 3 === 0 ? `v${n}` : m));
    const cur = scramble(p.slice(0, s.start)) + p.slice(s.start, s.end) + scramble(p.slice(s.end));
    const exact = transformLockedSpans(p, cur, [s], { timeoutSec: 0 });
    expect(exact[0].state).toBe('ok');
    expect(cur.slice(exact[0].start, exact[0].end)).toBe(s.text);
    const rushed = transformLockedSpans(p, cur, [s], { timeoutSec: 1e-9 });
    expect(rushed[0].state).toBe('violated'); // over-reported
    // A real change inside the span is reported either way.
    const cur2 = cur.replace('LOCKED SPAN TEXT', 'LOCKED SPAM TEXT');
    expect(transformLockedSpans(p, cur2, [s], { timeoutSec: 0 })[0].state).toBe('violated');
    expect(transformLockedSpans(p, cur2, [s], { timeoutSec: 1e-9 })[0].state).toBe('violated');
  });
});

describe('xIndexBefore: diff_xIndex, placed before an insertion at the point', () => {
  it('agrees with diff_xIndex everywhere except where text was inserted', () => {
    const dmp = new DiffMatchPatch();
    const a = 'The cat sat on the mat.';
    const b = 'The big cat sat on a mat!';
    const diffs = dmp.diff_main(a, b) as [number, string][];
    for (let loc = 0; loc <= a.length; loc++) {
      const after = dmp.diff_xIndex(diffs, loc);
      const before = xIndexBefore(diffs, loc);
      expect(before).toBeLessThanOrEqual(after);
    }
    expect(dmp.diff_xIndex(diffs, 4)).toBe(8); // after "big "
    expect(xIndexBefore(diffs, 4)).toBe(4); // before it
    // "!" was inserted at the very end (after "." was deleted): the end maps before it.
    expect(xIndexBefore(diffs, a.length)).toBe(dmp.diff_xIndex(diffs, a.length) - 1);
    const tail = dmp.diff_main('abc', 'xabc') as [number, string][];
    expect(xIndexBefore(tail, 3)).toBe(4);
    expect(xIndexBefore(tail, 0)).toBe(0);
    expect(dmp.diff_xIndex(tail, 0)).toBe(1);
  });
});

describe('applyOwnWrite: Blueline\'s own writes (rule 6)', () => {
  const src = '<p>Alpha</p><p>Hello world</p><p>Omega</p>';
  const span = lock(src, 'Hello world');
  const before = lock(src, 'Alpha', 'n-0010');
  const after = lock(src, 'Omega', 'n-0011');
  const write = (old: string, now: string) => {
    const at = src.indexOf(old);
    return { start: at, rawBefore: old, rawAfter: now };
  };

  it('shifts every span after the write and leaves the ones before it', () => {
    const out = applyOwnWrite([before, span, after], write('Alpha', 'Alpha one'));
    const cur = src.replace('Alpha', 'Alpha one');
    expect(out[0]).toEqual({ ...before, text: 'Alpha one', end: before.end + 4 }); // the write fell inside it
    expect(cur.slice(out[1].start, out[1].end)).toBe('Hello world');
    expect(cur.slice(out[2].start, out[2].end)).toBe('Omega');
    const out2 = applyOwnWrite([before, span, after], write('Omega', 'Omega!'));
    expect(out2[0]).toEqual(before);
    expect(out2[1]).toEqual(span);
  });

  it('a write inside a span updates its text and offsets directly', () => {
    const at = src.indexOf('world');
    const [a] = applyOwnWrite([span], { start: at, rawBefore: 'world', rawAfter: 'there, world' });
    expect(a).toEqual({ ...span, end: span.end + 7, text: 'Hello there, world' });
    const [b] = applyOwnWrite([span], { start: at - 1, rawBefore: ' ', rawAfter: '' });
    expect(b).toEqual({ ...span, end: span.end - 1, text: 'Helloworld' });
    const [c] = applyOwnWrite([span], { start: at, rawBefore: '', rawAfter: 'big ' });
    expect(c.text).toBe('Hello big world');
  });

  it('an insertion exactly at the start shifts the span; exactly at the end leaves it', () => {
    const [a] = applyOwnWrite([span], { start: span.start, rawBefore: '', rawAfter: 'Oh, ' });
    expect(a).toEqual({ ...span, start: span.start + 4, end: span.end + 4 });
    const [b] = applyOwnWrite([span], { start: span.end, rawBefore: '', rawAfter: '!' });
    expect(b).toEqual(span);
  });

  it('a write that overlaps a span takes in the union of both', () => {
    // Replaces "<p>Hello" (an edge) with "<p>Hi": the span becomes "Hi world".
    const at = src.indexOf('<p>Hello');
    const [a] = applyOwnWrite([span], { start: at, rawBefore: '<p>Hello', rawAfter: '<p>Hi' });
    const cur = src.replace('<p>Hello', '<p>Hi');
    expect(cur.slice(a.start, a.end)).toBe('<p>Hi world');
    expect(a.text).toBe('<p>Hi world');
  });

  it('a violated span keeps its locked text; the change\'s `after` follows the write', () => {
    const v: LockedSpan = { ...span, state: 'violated', change: { before: 'Hello there', after: 'Hello world' } };
    const at = src.indexOf('world');
    const [a] = applyOwnWrite([v], { start: at, rawBefore: 'world', rawAfter: 'globe' });
    expect(a).toEqual({ ...v, change: { before: 'Hello there', after: 'Hello globe' } });
  });

  it('drops the span of the note an undo removes (opts.noteId)', () => {
    const out = applyOwnWrite([before, span, after], write('Hello world', 'Hello'), { noteId: span.noteId });
    expect(out.map((s) => s.noteId)).toEqual(['n-0010', 'n-0011']);
  });

  it('a span whose text does not fit its range is flagged when a write falls inside it; a malformed one is left alone', () => {
    const odd: LockedSpan = { ...span, text: 'short' };
    const at = src.indexOf('world');
    expect(applyOwnWrite([odd], { start: at, rawBefore: 'w', rawAfter: 'W' })[0]).toMatchObject({ state: 'violated', change: { before: 'short' } });
    const bad = { ...span, start: 9, end: 3 };
    expect(applyOwnWrite([bad], { start: 0, rawBefore: '', rawAfter: 'xx' })).toEqual([bad]);
  });

  it('astral characters: offsets in UTF-16 units', () => {
    const s = 'x \u{1F600} <p>Hi</p>';
    const sp = lock(s, 'Hi');
    const [a] = applyOwnWrite([sp], { start: 2, rawBefore: '\u{1F600}', rawAfter: '\u{1F680}\u{1F680}' });
    const cur = 'x \u{1F680}\u{1F680} <p>Hi</p>';
    expect(cur.slice(a.start, a.end)).toBe('Hi');
    expect(a.start - sp.start).toBe(2);
  });

  it('undo, redo and lock: the own-write path keeps the locked text byte-exact', () => {
    // Edit "Hello world" → "Hello there world", lock it, then undo that write: the lock of an earlier note in the
    // same run follows both writes exactly.
    const n1 = lockForRun('n-0001', { start: span.start, end: span.end, value: 'x' }, src);
    const w = { start: src.indexOf('world'), rawBefore: '', rawAfter: 'there ' };
    const edited = src.slice(0, w.start) + w.rawAfter + src.slice(w.start);
    const [moved] = applyOwnWrite([n1], w);
    expect(edited.slice(moved.start, moved.end)).toBe(moved.text);
    const [back] = applyOwnWrite([moved], { start: w.start, rawBefore: w.rawAfter, rawAfter: '' });
    expect(back).toEqual(n1);
  });
});

describe('lockForRun', () => {
  const src = '<p>Caf&eacute; &amp; bar</p>';
  const start = src.indexOf('Caf');
  const end = src.indexOf('</p>');

  it('takes the source text from src, or a value that is already the source slice', () => {
    expect(lockForRun('n-0001', { start, end, value: 'Café & bar' }, src)).toEqual({
      start,
      end,
      text: 'Caf&eacute; &amp; bar',
      noteId: 'n-0001',
      state: 'ok',
    });
    expect(lockForRun('n-0002', { start, end, value: 'Caf&eacute; &amp; bar' }).text).toBe('Caf&eacute; &amp; bar');
  });

  it('refuses a decoded value whose length shows it, and bad ranges', () => {
    expect(() => lockForRun('n-0001', { start, end, value: 'Café & bar' })).toThrow(RangeError);
    expect(() => lockForRun('n-0001', { start: 5, end: 2, value: '' })).toThrow(RangeError);
    expect(() => lockForRun('n-0001', { start: 0, end: 999, value: '' }, src)).toThrow(RangeError);
  });
});
