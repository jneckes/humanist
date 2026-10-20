// The Chromium fuzz gate's pure parts (test/fuzz/harness/fuzz-core.ts): the seeded source, the edit field as the
// overlay records it, and the oracle every note and written edit must pass. The oracle must fail what it exists
// to catch, so each check is shown failing on a broken outcome as well as passing a correct one.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { commitField } from '@blueline/core/edit-commit';
import { buildMap } from '@blueline/core/mapper';
import { encodeDeck } from '@blueline/core/text';
import type { EditRequest, WriteOutcome, WriteRecord } from '@blueline/core/types';
import { boundaries, browserEdit, checkCommit, checkNote, checkWritten, externalComment, fieldRuns, rng, type CapturedField } from '../harness/fuzz-core';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const NBSP = String.fromCharCode(0xa0);

describe('the seeded source', () => {
  it('gives the same edits for the same seed', () => {
    const a = rng(42);
    const b = rng(42);
    const seq = (r: ReturnType<typeof rng>) => Array.from({ length: 20 }, () => browserEdit(r, 'Quarterly results'));
    expect(seq(a)).toEqual(seq(b));
    expect(seq(rng(43))).not.toEqual(seq(rng(42)));
  });

  it('never puts a caret inside a surrogate pair', () => {
    const s = 'a\u{1F680}b';
    expect(boundaries(s)).toEqual([0, 1, 3, 4]);
  });
});

describe('the edit field (9.2 Committing an edit step 1)', () => {
  // <p>Revenue <b>grew</b> fast</p>: three text nodes, the middle one in <b>.
  const field: CapturedField = {
    text: 'Revenue grew fast',
    parts: [
      { start: 0, end: 8, data: 'Revenue ', key: 'p0' },
      { start: 8, end: 12, data: 'grew', key: 'b0' },
      { start: 12, end: 17, data: ' fast', key: 'p1' },
    ],
  };
  const exact: Record<string, string> = { p0: 'h:bl-1:0', b0: 'h:bl-2:0' };

  it('records each exactly mapped node with its run; the rest is unmapped text', () => {
    const runs = fieldRuns(field, (k) => (exact[k] ? { runId: exact[k] } : null));
    expect(runs).toEqual([
      { runId: 'h:bl-1:0', start: 0, end: 8, value: 'Revenue ' },
      { runId: 'h:bl-2:0', start: 8, end: 12, value: 'grew' },
    ]);
  });

  it('gives the clicked node the run the author picked (P2-8)', () => {
    const runs = fieldRuns(field, (k) => (exact[k] ? { runId: exact[k] } : null), { key: 'p1', runId: 'l:3:0' });
    expect(runs?.[2]).toEqual({ runId: 'l:3:0', start: 12, end: 17, value: ' fast' });
  });

  it('refuses parts that do not fit the text', () => {
    expect(fieldRuns({ text: 'Revenue grew', parts: field.parts }, () => null)).toBeNull();
    expect(fieldRuns({ text: field.text, parts: [field.parts[0], field.parts[2]] }, () => null)).toBeNull();
  });
});

describe('checkCommit: the commit path oracle', () => {
  const runs = [
    { runId: 'h:bl-1:0', start: 0, end: 8, value: 'Revenue ' },
    { runId: 'h:bl-2:0', start: 8, end: 12, value: 'grew' },
  ];
  const text = 'Revenue grew fast';

  it('passes commitField\'s own results', () => {
    for (const raw of ['Revenue grew fast!', 'Revenue rose fast', 'X', '', `Revenue grew${NBSP}fast`, 'Revenue "grew" fast']) {
      const commit = commitField({ before: text, after: raw, runs, caretRunId: 'h:bl-2:0' }, { smartPunctuation: true });
      expect(checkCommit({ commit, fieldText: text, raw, runs, inTarget: false, caret: 'h:bl-2:0', targetRunId: 'h:bl-2:0' }), raw).toBeNull();
    }
  });

  it('fails an edit that names a run outside the field, or text the run does not hold', () => {
    const raw = 'Revenue rose fast';
    expect(checkCommit({ commit: { kind: 'edit', runId: 'h:bl-9:0', beforeText: 'grew', afterText: 'rose' }, fieldText: text, raw, runs, inTarget: true, caret: null, targetRunId: 'h:bl-2:0' })).toMatch('[unknown run]');
    expect(checkCommit({ commit: { kind: 'edit', runId: 'h:bl-2:0', beforeText: 'grow', afterText: 'rose' }, fieldText: text, raw, runs, inTarget: true, caret: null, targetRunId: 'h:bl-2:0' })).toMatch('[beforeText]');
    expect(checkCommit({ commit: { kind: 'edit', runId: 'h:bl-2:0', beforeText: 'grew', afterText: 'rise' }, fieldText: text, raw, runs, inTarget: true, caret: null, targetRunId: 'h:bl-2:0' })).toMatch('[rebuilt field]');
  });

  it('fails an edit inside the caret\'s run that went elsewhere, and a note that lost the text', () => {
    const raw = 'Revenue grows fast';
    expect(checkCommit({ commit: { kind: 'edit', runId: 'h:bl-1:0', beforeText: 'Revenue ', afterText: 'Revenue ' }, fieldText: text, raw, runs, inTarget: true, caret: 'h:bl-2:0', targetRunId: 'h:bl-2:0' })).toMatch('[caret run]');
    expect(checkCommit({ commit: { kind: 'verbatim', before: text, after: 'other', why: 'across-runs' }, fieldText: text, raw, runs, inTarget: false, caret: null, targetRunId: 'h:bl-2:0' })).toMatch('[verbatim after]');
    expect(checkCommit({ commit: { kind: 'verbatim', before: text, after: raw, why: 'boundary' }, fieldText: text, raw, runs, inTarget: true, caret: 'h:bl-2:0', targetRunId: 'h:bl-2:0' })).toMatch('[in-run verbatim]');
  });
});

describe('checkNote and checkWritten: the write oracle', () => {
  const src = '<!doctype html><html><body><p>Hello</p><p>World</p></body></html>';
  const bytes = encodeDeck(src);
  const version = sha256(bytes);
  const map = buildMap(src, { version, utf8: true, defer: false });
  const run = map.runs.find((r) => r.value === 'Hello')!;
  const req: EditRequest = { version, runId: run.id, beforeText: 'Hello', afterText: 'Hello & bye' };
  // What a correct patcher writes: the run's raw range only, with & encoded.
  const at = src.indexOf('Hello') + 5;
  const goodSrc = src.slice(0, at) + ' &amp; bye' + src.slice(at);
  const record = (after: string, rawAfter: string, start = at): WriteRecord => ({ versionBefore: version, versionAfter: sha256(encodeDeck(after)), start, rawBefore: '', rawAfter, prefix: src.slice(Math.max(0, start - 32), start), suffix: src.slice(start, start + 32) });
  const ok = (after: string, rawAfter: string, extra: Partial<Extract<WriteOutcome, { ok: true }>> = {}): Extract<WriteOutcome, { ok: true }> => ({
    ok: true,
    record: record(after, rawAfter),
    version: sha256(encodeDeck(after)),
    runId: run.id,
    line: 1,
    merged: false,
    ...extra,
  });

  it('passes a correct write', () => {
    const now = encodeDeck(goodSrc);
    const r = checkWritten({ out: ok(goodSrc, ' &amp; bye'), req, before: bytes, now, raced: false, marker: null, sha256 });
    expect(r.failures).toEqual([]);
    expect(r.base).toBe(src);
  });

  it('fails a write whose text renders otherwise, lands in another run, or leaves a parse error', () => {
    // & left raw: decodes to the same text here, but "&lt" would not: use a reference that changes the text.
    const literal = src.slice(0, at) + ' &amp;amp; bye' + src.slice(at);
    expect(checkWritten({ out: ok(literal, ' &amp;amp; bye'), req, before: bytes, now: encodeDeck(literal), raced: false, marker: null, sha256 }).failures.join()).toMatch('[remap]');
    const w = src.indexOf('World') + 5;
    const elsewhere = src.slice(0, w) + ' &amp; bye' + src.slice(w);
    const out = { ...ok(elsewhere, ' &amp; bye'), record: record(elsewhere, ' &amp; bye', w) };
    const f = checkWritten({ out, req, before: bytes, now: encodeDeck(elsewhere), raced: false, marker: null, sha256 }).failures.join();
    expect(f).toMatch('[range]');
    expect(f).toMatch('[others]');
    const broken = src.slice(0, at) + ' <x' + src.slice(at);
    expect(checkWritten({ out: ok(broken, ' <x'), req, before: bytes, now: encodeDeck(broken), raced: false, marker: null, sha256 }).failures.length).toBeGreaterThan(0);
  });

  it('fails a write whose record does not describe the file, a wrong merged flag, or a lost external change', () => {
    const now = encodeDeck(goodSrc);
    expect(checkWritten({ out: ok(goodSrc, ' &amp; byE'), req, before: bytes, now, raced: false, marker: null, sha256 }).failures.join()).toMatch('[splice]');
    expect(checkWritten({ out: ok(goodSrc, ' &amp; bye!'), req, before: bytes, now, raced: false, marker: null, sha256 }).failures.join()).toMatch('[record]');
    expect(checkWritten({ out: ok(goodSrc, ' &amp; bye', { merged: true }), req, before: bytes, now, raced: false, marker: null, sha256 }).failures.join()).toMatch('[merged]');
    expect(checkWritten({ out: ok(goodSrc, ' &amp; bye'), req, before: bytes, now, raced: false, marker: '<!-- external 1 -->', sha256 }).failures.join()).toMatch('[external]');
  });

  it('passes a note only by rule, with the exact texts and the same bytes', () => {
    const note = (code: Extract<WriteOutcome, { ok: false }>['code'], v = { before: req.beforeText, after: req.afterText }): Extract<WriteOutcome, { ok: false }> => ({ ok: false, verbatim: v, why: 'x', code });
    expect(checkNote({ out: note('markup'), req, before: bytes, now: bytes, external: null })).toBeNull();
    expect(checkNote({ out: note('noop'), req, before: bytes, now: bytes, external: null })).toBeNull();
    for (const code of ['internal', 'conflict', 'verify', 'refused'] as const) expect(checkNote({ out: note(code), req, before: bytes, now: bytes, external: null })).toMatch('not a note by rule');
    expect(checkNote({ out: note('stale', { before: 'Hello', after: 'other' }), req, before: bytes, now: bytes, external: null })).toMatch('[note text]');
    expect(checkNote({ out: note('stale'), req, before: bytes, now: encodeDeck(goodSrc), external: null })).toMatch('not byte-identical');
    // An external write raced it: the file must be exactly what that write left.
    const ext = encodeDeck(externalComment(src, '1').text);
    expect(checkNote({ out: note('stale'), req, before: bytes, now: ext, external: ext })).toBeNull();
  });
});

describe('externalComment: an external change that moves no stamp', () => {
  it('goes at the end of the body, or at the end of the file when the notes block ends the body', () => {
    expect(externalComment('<body><p>x</p></body>', 'a').text).toBe('<body><p>x</p><!-- external a --></body>');
    const withNotes = '<body><p>x</p><script type="application/vnd.blueline+json" id="blueline-notes">{}</script></body></html>';
    const r = externalComment(withNotes, 'b');
    expect(r.text.startsWith(withNotes)).toBe(true);
    expect(r.text.endsWith('<!-- external b -->')).toBe(true);
  });
});
