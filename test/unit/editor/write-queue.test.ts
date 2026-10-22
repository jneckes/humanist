import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWriteQueue } from '@blueline/editor';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { DeckMap, WriteRecord } from '@blueline/core/types';
import { bytesEqual, MemIO, requestFor, sha256 } from './helpers';

const FIXTURES = join(__dirname, '../../../fixtures/decks');
const doc = (body: string): string => `<!doctype html><html><head></head><body>${body}</body></html>`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Unchanged text between a run and another program's change: a stale edit is written only where the text on both
 * sides of it, at least ANCHOR_FLOOR (128) characters, is as it was (packages/editor/src/anchors.ts, E-1).
 */
const far = (k: string): string => Array.from({ length: 4 }, (_, i) => `<p>Filler ${k} line ${i}: words that stay as they are.</p>`).join('');

describe('write queue: the write protocol (9.2)', () => {
  it('writes an edit, returns the record, the new version, the run and its line, and runs afterWrite first', async () => {
    const io = new MemIO(doc('<h1>Title</h1>\n<p>Hello</p>'));
    const seen: { map: DeckMap; record: WriteRecord }[] = [];
    const q = createWriteQueue(io, { afterWrite: (map, record) => void seen.push({ map, record }) });
    const map = await q.refresh();
    const out = await q.edit(requestFor(map, 'Hello', 'Hello there'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(io.text).toBe(doc('<h1>Title</h1>\n<p>Hello there</p>'));
    expect(out.version).toBe(sha256(io.bytes));
    expect(out.line).toBe(2);
    expect(out.runId).toBe(requestFor(map, 'Hello', '').runId);
    expect(out.record).toMatchObject({ versionBefore: map.version, versionAfter: out.version, rawBefore: '', rawAfter: ' there' });
    expect(seen).toHaveLength(1);
    expect(seen[0].map.version).toBe(out.version);
    expect((await q.currentMap()).version).toBe(out.version);
  });

  it('never writes a deck that is not UTF-8', async () => {
    const bytes = readFileSync(join(FIXTURES, 'windows-1252.html'));
    const io = new MemIO(bytes);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    expect(map.utf8).toBe(false);
    const out = await q.edit({ version: map.version, runId: 'h:bl-1:0', beforeText: 'x', afterText: 'y' });
    expect(out).toMatchObject({ ok: false, why: expect.stringMatching(/not-utf8/) });
    expect(io.writes).toBe(0);
    expect(bytesEqual(io.bytes, bytes)).toBe(true);
  });

  it('turns a refused edit into a verbatim note with the exact before and after text', async () => {
    const io = new MemIO(doc('<p>Before <b>bold</b> after</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const req = requestFor(map, 'bold', '');
    const out = await q.edit(req);
    expect(out).toEqual({ ok: false, verbatim: { before: 'bold', after: '' }, why: expect.stringMatching(/structural/), code: 'structural' });
    expect(io.writes).toBe(0);
  });

  it('checks canWrite at the moment of the write', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    let allowed = true;
    const q = createWriteQueue(io, { canWrite: () => allowed });
    const map = await q.refresh();
    allowed = false;
    expect(await q.edit(requestFor(map, 'Hello', 'Hi'))).toMatchObject({ ok: false, why: expect.stringMatching(/not allowed/) });
    expect(io.writes).toBe(0);
  });

  it('keeps the outcome ok when afterWrite throws, and reports the error', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const errors: unknown[] = [];
    const q = createWriteQueue(io, {
      afterWrite: () => {
        throw new Error('push failed');
      },
      onHookError: (e) => errors.push(e),
    });
    const map = await q.refresh();
    expect((await q.edit(requestFor(map, 'Hello', 'Hi'))).ok).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('never rejects on an unexpected exception: the edit becomes verbatim and the file is untouched', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    let calls = 0;
    const real = io.sha256.bind(io);
    io.sha256 = (b: Uint8Array) => {
      if (++calls === 2) throw new Error('boom');
      return real(b);
    };
    const out = await q.edit(requestFor(map, 'Hello', 'Hi'));
    expect(out).toEqual({ ok: false, verbatim: { before: 'Hello', after: 'Hi' }, why: 'internal error: boom', code: 'internal' });
    expect(io.writes).toBe(0);
    // The queue keeps working afterwards.
    expect((await q.edit(requestFor(map, 'Hello', 'Hi'))).ok).toBe(true);
  });

  it('runs operations one at a time, in order (per-deck serial queue)', async () => {
    const io = new MemIO(doc(`<p>One</p>${far('a')}<p>Two</p>${far('b')}<p>Three</p>`));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    // All three were made against the same version; the 2nd and 3rd are placed by position.
    const outs = await Promise.all([
      q.edit(requestFor(map, 'One', 'One!')),
      q.edit(requestFor(map, 'Two', 'Two!')),
      q.edit(requestFor(map, 'Three', 'Three!')),
    ]);
    expect(outs.map((o) => o.ok)).toEqual([true, true, true]);
    expect(io.text).toBe(doc(`<p>One!</p>${far('a')}<p>Two!</p>${far('b')}<p>Three!</p>`));
    expect(io.writes).toBe(3);
  });
});

describe('write queue: the version check (9.2 Write protocol step 2)', () => {
  it('a stale version with a unique beforeText is applied at the right place', async () => {
    const io = new MemIO(doc(`<p>Alpha</p>${far('a')}<p>Beta</p>`));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    // An external change shifts every offset after it.
    io.external(doc(`<h1>New heading</h1><p>Alpha</p>${far('a')}<p>Beta</p>`));
    const out = await q.edit(requestFor(map, 'Beta', 'Beta two'));
    expect(out.ok).toBe(true);
    expect(io.text).toBe(doc(`<h1>New heading</h1><p>Alpha</p>${far('a')}<p>Beta two</p>`));
  });

  it('the same text, unique, with a change next to it: a note, because a change there cannot be told from the run being replaced and a copy put beside it (E-1, the hardening round)', async () => {
    const A = doc(`<p>Alpha</p>${far('a')}<p>Beta</p>${far('b')}`);
    for (const C of [A.replace('<p>Beta</p>', '<h1>New heading</h1><p>Beta</p>'), A.replace('<p>Beta</p>', '<p>Beta</p><p>Gamma</p>')]) {
      const io = new MemIO(A);
      const q = createWriteQueue(io);
      const map = await q.refresh();
      io.external(C);
      // The text is in one place, so the note is `stale`, not `ambiguous` (F-1).
      expect(await q.edit(requestFor(map, 'Beta', 'Beta two'))).toMatchObject({ ok: false, code: 'stale', verbatim: { before: 'Beta', after: 'Beta two' } });
      expect(io.text).toBe(C);
    }
  });

  it('duplicates are never told apart across another program\'s change, by position or by context: a note on either copy (F-1)', async () => {
    // A change a little after the second copy, past both runs' 32-character context. Before F-1 the place was
    // written (the text on both sides of each copy was unchanged); now text in two places is never placed across
    // another program's change, however far the change is.
    const base = doc(`<p>Owner</p>${far('a')}<p>Owner</p>${far('b')}`);
    const changed = base.replace('</body>', '<div>An agent added this</div></body>');
    for (const which of [1, 0]) {
      const io = new MemIO(base);
      const q = createWriteQueue(io);
      const map = await q.refresh();
      const run = map.runs.filter((r) => r.value === 'Owner')[which];
      io.external(changed);
      expect(await q.edit({ version: map.version, runId: run.id, beforeText: 'Owner', afterText: 'Owner X' })).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Owner', after: 'Owner X' } });
      expect(io.text).toBe(changed);
      expect(io.writes).toBe(0);
    }
  });

  it('a change right beside one of two copies: both are notes, never the other copy (E-1, the hardening round)', async () => {
    const changed = doc('<p>Owner</p><p>Owner</p><div>An agent added this</div>');
    for (const which of [1, 0]) {
      const io = new MemIO(doc('<p>Owner</p><p>Owner</p>'));
      const q = createWriteQueue(io);
      const map = await q.refresh();
      const run = map.runs.filter((r) => r.value === 'Owner')[which];
      io.external(changed);
      expect(await q.edit({ version: map.version, runId: run.id, beforeText: 'Owner', afterText: 'Owner X' })).toMatchObject({ ok: false, code: 'ambiguous' });
      expect(io.text).toBe(changed);
    }
  });

  it('two adjacent copies, one wrapped by another program: a note, because nothing unchanged around them tells a wrap from a move (E-1, finding 0 re-verification)', async () => {
    const io = new MemIO(doc('<p>Owner</p><p>Owner</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const [first, second] = map.runs.filter((r) => r.value === 'Owner');
    const changed = doc('<p>Owner</p><div><p>Owner</p></div>').replace('<body>', '<body>\n');
    io.external(changed);
    for (const run of [second, first]) {
      expect(await q.edit({ version: map.version, runId: run.id, beforeText: 'Owner', afterText: 'Owner X' })).toMatchObject({
        ok: false,
        code: 'ambiguous',
        verbatim: { before: 'Owner', after: 'Owner X' },
      });
    }
    expect(io.text).toBe(changed);
    expect(io.writes).toBe(0);
  });

  it('duplicates with different context: a note across another program\'s change; unique text is written there (F-1)', async () => {
    const filler = 'x'.repeat(80);
    const base = doc(`<p>Owner</p><i>${filler} first ${filler}</i><p>Owner</p><i>${filler} second ${filler}</i>`);
    const io = new MemIO(base);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const second = map.runs.filter((r) => r.value === 'Owner')[1];
    const changed = base.replace('<body>', '<body><h1>Inserted far away</h1>');
    io.external(changed);
    const out = await q.edit({ version: map.version, runId: second.id, beforeText: 'Owner', afterText: 'Owner B' });
    expect(out).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(io.text).toBe(changed);
    // The same with the second copy's text unique: placed by position and written.
    const base2 = base.replace(`<p>Owner</p><i>${filler} second`, `<p>Owners</p><i>${filler} second`);
    const io2 = new MemIO(base2);
    const q2 = createWriteQueue(io2);
    const map2 = await q2.refresh();
    io2.external(base2.replace('<body>', '<body><h1>Inserted far away</h1>'));
    expect((await q2.edit(requestFor(map2, 'Owners', 'Owners B'))).ok).toBe(true);
    expect(io2.text).toBe(
      doc(`<h1>Inserted far away</h1><p>Owner</p><i>${filler} first ${filler}</i><p>Owners B</p><i>${filler} second ${filler}</i>`),
    );
  });

  it('a text that was duplicated in the client\'s version needs the context even when one copy is left', async () => {
    const filler = 'y'.repeat(40);
    const base = doc(`<p>Owner</p><i>${filler}</i><p>Owner</p><i>${filler} two</i>`);
    const io = new MemIO(base);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const first = map.runs.filter((r) => r.value === 'Owner')[0];
    // The agent rewrote the copy the user is editing; the other copy is now the only "Owner".
    io.external(base.replace('<p>Owner</p>', '<p>Lead</p>'));
    const out = await q.edit({ version: map.version, runId: first.id, beforeText: 'Owner', afterText: 'Owner A' });
    expect(out).toMatchObject({ ok: false, verbatim: { before: 'Owner', after: 'Owner A' } });
    expect(io.text).toBe(base.replace('<p>Owner</p>', '<p>Lead</p>'));
  });

  it('a version the queue never saw is a stale note, unique text or not (E-1: text alone never picks a run)', async () => {
    const io = new MemIO(doc('<p>Solo</p><p>Twin</p><p>Twin</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const unknown = 'f'.repeat(64);
    expect(await q.edit({ ...requestFor(map, 'Solo', 'Solo!'), version: unknown })).toMatchObject({ ok: false, code: 'stale' });
    const m2 = await q.currentMap();
    expect(await q.edit({ ...requestFor(m2, 'Twin', 'Twin!'), version: unknown })).toMatchObject({ ok: false, code: 'stale' });
    expect(io.writes).toBe(0);
  });

  it('never moves an edit between parsed text and a script literal', async () => {
    const io = new MemIO(doc('<p>Shared</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    io.external(doc("<script>var s = 'Shared';</script>"));
    const out = await q.edit(requestFor(map, 'Shared', 'Shared!'));
    expect(out.ok).toBe(false);
    expect(io.text).toBe(doc("<script>var s = 'Shared';</script>"));
  });

  it('refuses a request whose beforeText disagrees with the version it names', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    io.external(doc('<p>Hello</p><p>x</p>'));
    const out = await q.edit({ ...requestFor(map, 'Hello', 'Hi'), beforeText: 'x' });
    expect(out.ok).toBe(false);
  });
});

describe('write queue: findings 5 and 0 through the real queue', () => {
  it("a textContent literal 'Latency <5 ms': an edit that adds & or < is a verbatim note and the file is untouched (finding 5)", async () => {
    const base = doc("<p id=\"x\"></p><p id=\"y\"></p><script>document.getElementById('x').textContent = 'Latency <5 ms';\ndocument.getElementById('y').innerHTML = '<b>x</b> &amp; y';</script>");
    const io = new MemIO(base);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    for (const after of ['Latency <5 ms & falling', 'Latency <5 ms, <3 ms soon']) {
      const out = await q.edit(requestFor(map, 'Latency <5 ms', after));
      expect(out).toMatchObject({ ok: false, verbatim: { before: 'Latency <5 ms', after }, why: expect.stringMatching(/5\.1/) });
    }
    expect(io.writes).toBe(0);
    expect(io.text).toBe(base);
    // A real HTML literal still encodes what is typed (9.2 Strategy 2 step 5.1).
    const out = await q.edit(requestFor(map, ' & y', ' & y & z'));
    expect(out.ok).toBe(true);
    expect(io.text).toBe(base.replace("'<b>x</b> &amp; y'", "'<b>x</b> &amp; y &amp; z'"));
  });

  it('a stale version: a beforeText that is also a shadow value counts as a copy, so it is a note; never placed by its text (D-a, E-1, F-1)', async () => {
    const filler = 'z'.repeat(160);
    const base = doc(`<p>${filler}</p><script>var s = 'Revenue';</script><p>${filler}</p>`);
    const io = new MemIO(base);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    // The deck changes: a <template> now shows "Revenue" too (a shadow value; never a run).
    const changed = base.replace('<body>', '<body><template><h3>Revenue</h3></template>');
    io.external(changed);
    // A version the queue never saw: nothing places the edit, so it is a verbatim note.
    const unknown = { ...requestFor(map, 'Revenue', 'Net revenue'), version: 'e'.repeat(64) };
    expect(await q.edit(unknown)).toMatchObject({ ok: false, verbatim: { before: 'Revenue', after: 'Net revenue' } });
    expect(io.text).toBe(changed);
    // The client's own version is known, but the template's text is a second place that shows "Revenue" now: the
    // shadow value counts as a copy (F-1 a), so the edit is a note too.
    const out = await q.edit(requestFor(map, 'Revenue', 'Net revenue'));
    expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Revenue', after: 'Net revenue' } });
    expect(io.text).toBe(changed);
    // Without the template (a queue that never saw it), the literal's place in the client's version maps to the
    // current file.
    const io2 = new MemIO(base);
    const q2 = createWriteQueue(io2);
    const map2 = await q2.refresh();
    const far2 = base.replace('<body>', '<body><h3>Added far away</h3>');
    io2.external(far2);
    expect((await q2.edit(requestFor(map2, 'Revenue', 'Net revenue'))).ok).toBe(true);
    expect(io2.text).toBe(far2.replace("'Revenue'", "'Net revenue'"));
  });
});

describe('write queue: atomic write conflicts (9.2 Atomic write step 3)', () => {
  it('a write that lands between the read and the rename aborts and requeues; the edit lands on the right text', async () => {
    const io = new MemIO(doc(`<p>Alpha</p>${far('a')}<p>Beta</p>`));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    io.beforeWrite = () => io.external(doc(`<p>Alpha</p><p>Gamma</p>${far('a')}<p>Beta</p>`));
    const out = await q.edit(requestFor(map, 'Beta', 'Beta!'));
    expect(out.ok).toBe(true);
    expect(io.text).toBe(doc(`<p>Alpha</p><p>Gamma</p>${far('a')}<p>Beta!</p>`));
  });

  it('a conflicting write that changes the target text becomes verbatim and survives', async () => {
    const io = new MemIO(doc('<p>Alpha</p><p>Beta</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    io.beforeWrite = () => io.external(doc('<p>Alpha</p><p>Beta (agent)</p>'));
    const out = await q.edit(requestFor(map, 'Beta', 'Beta!'));
    expect(out).toMatchObject({ ok: false, verbatim: { before: 'Beta', after: 'Beta!' } });
    expect(io.text).toBe(doc('<p>Alpha</p><p>Beta (agent)</p>'));
  });

  it('gives up after maxRetries conflicts', async () => {
    const io = new MemIO(doc(`<p>Alpha</p>${far('a')}`));
    const q = createWriteQueue(io, { maxRetries: 2 });
    const map = await q.refresh();
    let n = 0;
    const realWrite = io.atomicWrite.bind(io);
    io.atomicWrite = async (bytes, hash) => {
      n++;
      io.external(doc(`<p>Alpha</p>${far('a')}<!-- ${n} -->`));
      return realWrite(bytes, hash);
    };
    const out = await q.edit(requestFor(map, 'Alpha', 'Alpha!'));
    expect(out).toMatchObject({ ok: false, why: expect.stringMatching(/conflict/) });
    expect(n).toBe(3);
  });

  it('a failing write (not a conflict) keeps the text as a verbatim note', async () => {
    const io = new MemIO(doc('<p>Alpha</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    io.atomicWrite = async () => {
      throw new Error('disk full');
    };
    expect(await q.edit(requestFor(map, 'Alpha', 'Alpha!'))).toMatchObject({ ok: false, why: 'write failed: disk full' });
  });
});

describe('concurrency gate (section 10, Phase 2): an external write lands 50 ms before the edit commits', () => {
  const base = doc(`<h1>Quarterly plan</h1>\n<p>Revenue grew in every region.</p>\n${far('a')}\n<p>Next steps follow.</p>`);

  async function race(external: string, before: string, after: string) {
    const io = new MemIO(base);
    const q = createWriteQueue(io);
    const map = await q.refresh(); // the overlay holds this version
    const req = requestFor(map, before, after);
    const ext = sleep(10).then(() => io.external(external));
    await sleep(60); // the edit commits 50 ms after the external write
    await ext;
    const out = await q.edit(req);
    return { io, out };
  }

  it('an unrelated external change: the edit lands on the right text and the change survives', async () => {
    const external = base.replace('<h1>', '<p>Agent note.</p>\n<h1>');
    const { io, out } = await race(external, 'Next steps follow.', 'Next steps follow below.');
    expect(out.ok).toBe(true);
    expect(io.text).toBe(external.replace('Next steps follow.', 'Next steps follow below.'));
  });

  it('an external change to the same text: the edit becomes verbatim and the change survives', async () => {
    const external = base.replace('Next steps follow.', 'Next steps are below.');
    const { io, out } = await race(external, 'Next steps follow.', 'Next steps follow below.');
    expect(out).toMatchObject({ ok: false, verbatim: { before: 'Next steps follow.', after: 'Next steps follow below.' } });
    expect(io.text).toBe(external);
  });

  it('an external change that duplicates the text right beside it: verbatim, and the change survives (E-1: the copy has the same surroundings, so neither place is sure)', async () => {
    const external = base.replace('<p>Next steps follow.</p>', '<p>Next steps follow.</p><p>Next steps follow.</p>');
    const { io, out } = await race(external, 'Next steps follow.', 'Next steps follow below.');
    expect(out).toMatchObject({ ok: false, code: 'ambiguous', verbatim: { before: 'Next steps follow.', after: 'Next steps follow below.' } });
    expect(io.text).toBe(external);
  });

  it('an external change that rewrites the run and leaves a copy elsewhere: verbatim, and the change survives', async () => {
    const external = base.replace('<p>Next steps follow.</p>', '<p>Next steps, later.</p>').replace('<p>Revenue grew in every region.</p>', '<p>Next steps follow.</p>');
    const { io, out } = await race(external, 'Next steps follow.', 'Next steps follow below.');
    // One place holds the text on each side, and the run does not map there: `stale` (F-1).
    expect(out).toMatchObject({ ok: false, code: 'stale' });
    expect(io.text).toBe(external);
  });

  it('a real file system: an external rename-replace 50 ms before the commit', async () => {
    const { mkdtempSync, writeFileSync, readFileSync: rf, renameSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'bl-queue-'));
    const path = join(dir, 'deck.html');
    writeFileSync(path, base);
    let n = 0;
    const io = {
      realpath: path,
      read: async () => new Uint8Array(rf(path)),
      sha256,
      async atomicWrite(bytes: Uint8Array, expectHash: string) {
        const tmp = join(dir, `.deck.html.${++n}.tmp`);
        writeFileSync(tmp, bytes);
        if (sha256(new Uint8Array(rf(path))) !== expectHash) {
          rmSync(tmp);
          const e = new Error('conflict');
          e.name = 'WriteConflictError';
          throw e;
        }
        renameSync(tmp, path);
      },
    };
    try {
      const q = createWriteQueue(io);
      const map = await q.refresh();
      const req = requestFor(map, 'Next steps follow.', 'Next steps follow below.');
      const external = base.replace('</h1>', '</h1>\n<p>Inserted by the agent.</p>');
      setTimeout(() => {
        writeFileSync(join(dir, 'ext.tmp'), external);
        renameSync(join(dir, 'ext.tmp'), path);
      }, 10);
      await sleep(60);
      const out = await q.edit(req);
      expect(out.ok).toBe(true);
      expect(decodeDeck(new Uint8Array(rf(path))).src).toBe(external.replace('Next steps follow.', 'Next steps follow below.'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('write queue: undo and redo', () => {
  it('undo(W) then redo(W) toggles the exact bytes; both take the original record', async () => {
    const src = doc('<p>Caf&eacute; &amp; bar</p>');
    const io = new MemIO(src);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const out = await q.edit(requestFor(map, 'Café & bar', 'Café & bar & grill'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const edited = io.bytes.slice();
    expect(io.text).toBe(doc('<p>Caf&eacute; &amp; bar &amp; grill</p>'));
    const u = await q.undo(out.record);
    expect(u.ok).toBe(true);
    expect(bytesEqual(io.bytes, encodeDeck(src))).toBe(true);
    if (u.ok) expect(u.record).toMatchObject({ rawBefore: ' &amp; grill', rawAfter: '' });
    const r = await q.redo(out.record);
    expect(r.ok).toBe(true);
    expect(bytesEqual(io.bytes, edited)).toBe(true);
    // Undo again after the redo: case 1 again.
    expect((await q.undo(out.record)).ok).toBe(true);
    expect(io.text).toBe(src);
  });

  it('refuses a malformed record without touching the file', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const q = createWriteQueue(io);
    await q.refresh();
    expect(await q.undo({} as WriteRecord)).toMatchObject({ ok: false, canMakeNote: false });
    expect(io.writes).toBe(0);
  });
});
