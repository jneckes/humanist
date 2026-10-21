// The write queue's Phase 2 options and operations (P2-1 to P2-4, P2-8, P2-11; 9.2 Write protocol, Undo and
// redo): know (the versions pages hold), beforeWrite (history snapshots) and its ordering, afterWrite's `next`,
// merged writes, typed refusal codes, the read-back after the rename, restore, picked candidates, and undo in a
// changed file on the entity, BOM, CRLF and literal fixtures.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANT_UNDO, createWriteQueue } from '@blueline/editor';
import type { WriteKind, WrittenVersion } from '@blueline/core/capabilities';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { DeckMap, WriteRecord } from '@blueline/core/types';
import { bytesEqual, mapOf, MemIO, requestFor, sha256 } from './helpers';

const FIXTURES = join(__dirname, '../../../fixtures/decks');
const doc = (body: string): string => `<!doctype html><html><head></head><body>${body}</body></html>`;

/** A queue whose hooks log what they saw, in order, around the IO's atomic write. */
function logged(io: MemIO, extra: Parameters<typeof createWriteQueue>[1] = {}) {
  const events: string[] = [];
  const snapshots: { version: string; bytes: Uint8Array; next: { version: string; kind: WriteKind } }[] = [];
  const written: { map: DeckMap; record: WriteRecord; next: WrittenVersion }[] = [];
  const errors: unknown[] = [];
  const real = io.atomicWrite.bind(io);
  io.atomicWrite = async (bytes, hash) => {
    events.push('write');
    return real(bytes, hash);
  };
  const q = createWriteQueue(io, {
    beforeWrite: async (prev, next) => {
      events.push(`before:${next.kind}`);
      snapshots.push({ version: prev.version, bytes: prev.bytes.slice(), next });
    },
    afterWrite: (map, record, next) => {
      events.push(`after:${next.kind}`);
      written.push({ map, record, next });
    },
    onHookError: (e) => errors.push(e),
    ...extra,
  });
  return { q, events, snapshots, written, errors };
}

describe('beforeWrite and afterWrite (P2-11, 9.2 Write protocol step 6)', () => {
  it('beforeWrite gets the exact bytes being replaced right before the atomic write; afterWrite gets the new version', async () => {
    const io = new MemIO(doc('<p>Hello</p><script>var s = "Line";</script>'));
    const original = io.bytes.slice();
    const { q, events, snapshots, written } = logged(io);
    const map = await q.refresh();
    const out = await q.edit(requestFor(map, 'Hello', 'Hello there'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(events).toEqual(['before:edit', 'write', 'after:edit']);
    expect(snapshots[0]).toMatchObject({ version: map.version, next: { version: out.version, kind: 'edit' } });
    expect(bytesEqual(snapshots[0].bytes, original)).toBe(true);
    const next = written[0].next;
    expect(next).toMatchObject({ version: out.version, basedOn: map.version, kind: 'edit', runId: out.runId, strategy: 'html-text' });
    expect(bytesEqual(next.bytes, io.bytes)).toBe(true);
    expect(next.src).toBe(io.text);
    expect(written[0].map.version).toBe(out.version);
    expect(written[0].record).toEqual(out.record);
    // A literal write says so (the page reloads once the field closes, 9.2 Strategy 2 step 5.5).
    const m2 = await q.currentMap();
    const lit = await q.edit(requestFor(m2, 'Line', 'Line two'));
    expect(lit.ok).toBe(true);
    expect(written[1].next).toMatchObject({ kind: 'edit', strategy: 'script-literal' });
  });

  it('undo, redo and restore take snapshots too, each of the bytes it replaces', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const original = io.bytes.slice();
    const { q, events, snapshots, written } = logged(io);
    const map = await q.refresh();
    const out = await q.edit(requestFor(map, 'Hello', 'Hi'));
    if (!out.ok) throw new Error(out.why);
    const edited = io.bytes.slice();
    expect((await q.undo(out.record)).ok).toBe(true);
    expect((await q.redo(out.record)).ok).toBe(true);
    expect((await q.restore(original, out.version)).ok).toBe(true);
    expect(events).toEqual(['before:edit', 'write', 'after:edit', 'before:undo', 'write', 'after:undo', 'before:redo', 'write', 'after:redo', 'before:restore', 'write', 'after:restore']);
    expect(bytesEqual(snapshots[1].bytes, edited)).toBe(true);
    expect(bytesEqual(snapshots[2].bytes, original)).toBe(true);
    expect(bytesEqual(snapshots[3].bytes, edited)).toBe(true);
    expect(written.map((w) => w.next.kind)).toEqual(['edit', 'undo', 'redo', 'restore']);
    expect(written[1].next.runId).toBeUndefined();
    expect(bytesEqual(io.bytes, original)).toBe(true);
  });

  it('nothing is snapshotted or written for a refusal or a no-op', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const { q, events } = logged(io);
    const map = await q.refresh();
    expect(await q.edit(requestFor(map, 'Hello', 'Hello'))).toMatchObject({ ok: false, code: 'noop' });
    expect(await q.edit(requestFor(map, 'Hello', ''))).toMatchObject({ ok: false, code: 'structural' });
    expect(events).toEqual([]);
    expect(io.writes).toBe(0);
  });

  it('a failed snapshot refuses the write: the file is untouched and the edit is a note (code internal)', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const errors: unknown[] = [];
    const q = createWriteQueue(io, {
      beforeWrite: async () => {
        throw new Error('disk full');
      },
      onHookError: (e) => errors.push(e),
    });
    const map = await q.refresh();
    expect(await q.edit(requestFor(map, 'Hello', 'Hi'))).toEqual({
      ok: false,
      verbatim: { before: 'Hello', after: 'Hi' },
      why: 'snapshot failed: disk full',
      code: 'internal',
    });
    expect(io.writes).toBe(0);
    expect(errors).toHaveLength(1);
  });

  it('canWrite is checked again at the moment of the write, after the snapshot', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    let allowed = true;
    const q = createWriteQueue(io, {
      canWrite: () => allowed,
      beforeWrite: async () => {
        allowed = false; // editing turned off while the snapshot was taken
      },
    });
    const map = await q.refresh();
    expect(await q.edit(requestFor(map, 'Hello', 'Hi'))).toMatchObject({ ok: false, code: 'refused' });
    expect(io.writes).toBe(0);
  });

  it('a conflict requeues: the next attempt snapshots the bytes it then replaces', async () => {
    const io = new MemIO(doc('<p>Alpha</p><p>Beta</p>'));
    const { q, snapshots, written } = logged(io);
    const map = await q.refresh();
    const external = doc('<p>Alpha</p><p>Gamma</p><p>Beta</p>');
    io.beforeWrite = () => io.external(external);
    const out = await q.edit(requestFor(map, 'Beta', 'Beta!'));
    expect(out).toMatchObject({ ok: true, merged: true });
    expect(io.text).toBe(doc('<p>Alpha</p><p>Gamma</p><p>Beta!</p>'));
    expect(snapshots).toHaveLength(2);
    expect(decodeDeck(snapshots[1].bytes).src).toBe(external);
    // P2-4: the write absorbed an external change main never saw; basedOn says which version it replaced.
    expect(written[0].next.basedOn).toBe(sha256(encodeDeck(external)));
    expect(written[0].next.basedOn).not.toBe(map.version);
  });

  it('afterWrite errors and onHookError errors never undo a write', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const q = createWriteQueue(io, {
      afterWrite: () => {
        throw new Error('push failed');
      },
      onHookError: () => {
        throw new Error('the logger failed too');
      },
    });
    const map = await q.refresh();
    expect(await q.edit(requestFor(map, 'Hello', 'Hi'))).toMatchObject({ ok: true });
    expect(io.text).toBe(doc('<p>Hi</p>'));
  });
});

describe('merged (P2-4) and know (P2-3)', () => {
  const filler = 'x'.repeat(40);
  const base = doc(`<p>Owner</p><i>${filler} first ${filler}</i><p>Owner</p><i>${filler} second ${filler}</i>`);

  it('merged is false on the version the client holds, true when the edit was re-resolved on another', async () => {
    const io = new MemIO(doc('<p>Alpha</p><p>Beta</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    expect(await q.edit(requestFor(map, 'Alpha', 'Alpha!'))).toMatchObject({ ok: true, merged: false });
    io.external(doc('<h1>New</h1><p>Alpha!</p><p>Beta</p>'));
    expect(await q.edit(requestFor(map, 'Beta', 'Beta!'))).toMatchObject({ ok: true, merged: true });
  });

  it('a version the queue never read, told with know, places a stale edit by position (E-1)', async () => {
    const map = mapOf(base);
    const second = map.runs.filter((r) => r.value === 'Owner')[1];
    const changed = base.replace('<body>', '<body><h1>Inserted far away</h1>');
    // Without know: the queue cannot tell where the client's run is now (a stale note, never a guess).
    const io1 = new MemIO(changed);
    const q1 = createWriteQueue(io1);
    expect(await q1.edit({ version: map.version, runId: second.id, beforeText: 'Owner', afterText: 'Owner B' })).toMatchObject({ ok: false, code: 'stale' });
    // With know (main calls it at open and after every external change).
    const io2 = new MemIO(changed);
    const q2 = createWriteQueue(io2);
    q2.know(map.version, base, map);
    const out = await q2.edit({ version: map.version, runId: second.id, beforeText: 'Owner', afterText: 'Owner B' });
    expect(out).toMatchObject({ ok: true, merged: true });
    expect(io2.text).toBe(changed.replace(`<p>Owner</p><i>${filler} second`, `<p>Owner B</p><i>${filler} second`));
  });

  it('know of the current file is reused without a new parse', async () => {
    const io = new MemIO(base);
    const map = mapOf(base);
    const q = createWriteQueue(io);
    q.know(map.version, base, map);
    expect(await q.refresh()).toBe(map);
    expect(await q.currentMap()).toBe(map);
  });

  it('know ignores what does not hash to its version', async () => {
    const map = mapOf(base);
    const lie = base.replace('first', 'FIRST'); // same length, other text: never taken as the client's source
    const changed = base.replace('<body>', '<body><h1>Inserted far away</h1>');
    const io = new MemIO(changed);
    const q = createWriteQueue(io);
    q.know(map.version, lie, { ...map });
    q.know('not a hash', base, map);
    q.know(map.version, base, { ...map, version: 'f'.repeat(64) });
    const second = map.runs.filter((r) => r.value === 'Owner')[1];
    // None of these was taken, so the client's version is unknown: a stale note.
    expect(await q.edit({ version: map.version, runId: second.id, beforeText: 'Owner', afterText: 'Owner B' })).toMatchObject({ ok: false, code: 'stale' });
    expect(io.writes).toBe(0);
  });

  it('currentMap waits for the operations queued before it, and loads the file when nothing has yet', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const q = createWriteQueue(io);
    expect((await q.currentMap()).version).toBe(sha256(io.bytes));
    const map = await q.refresh();
    const pending = q.edit(requestFor(map, 'Hello', 'Hi'));
    const cur = await q.currentMap();
    const out = await pending;
    expect(out.ok && cur.version === out.version).toBe(true);
  });
});

describe('typed refusal codes (only noop is not a note)', () => {
  const codeOf = async (src: string, before: string, after: string): Promise<string> => {
    const io = new MemIO(src);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const out = await q.edit(requestFor(map, before, after));
    expect(io.writes).toBe(0);
    if (out.ok) throw new Error('written');
    expect(out.verbatim).toEqual({ before, after });
    return out.code;
  };

  it('rule codes', async () => {
    expect(await codeOf(doc('<p>Hello</p>'), 'Hello', 'Hello')).toBe('noop');
    expect(await codeOf(doc('<p>Hello</p>'), 'Hello', '   ')).toBe('structural');
    expect(await codeOf(doc("<p id=x></p><script>x.textContent = 'Plain';</script>"), 'Plain', 'Plain & simple')).toBe('markup');
    expect(await codeOf(doc('<script>var t = `Hi ${name} there`;</script>'), `Hi \uE000 there`, 'Hi \uE000 here')).toBe('placeholder');
    expect(await codeOf(doc('<script>var t = `Total`;</script>'), 'Total', 'Total \uE000')).toBe('placeholder');
    expect(await codeOf(doc('<p>Hello</p>'), 'Hello', 'Hel\u0000lo')).toBe('escape');
    expect(await codeOf(doc('<p>Hello</p>'), 'Hello', 'Hel\u0007lo')).toBe('escape');
    expect(await codeOf(doc('<p>Hello</p>'), 'Hello', 'Hel\uD800lo')).toBe('escape');
  });

  it('stale and ambiguous, after the deck changed', async () => {
    const io = new MemIO(doc('<p>Alpha</p><p>Beta</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    io.external(doc('<p>Alpha</p><p>Gamma</p>'));
    expect(await q.edit(requestFor(map, 'Beta', 'Beta!'))).toMatchObject({ ok: false, code: 'stale' });
    // The run the client edited was rewritten, and its text is now somewhere else (E-1: never written there).
    io.external(doc('<p>Beta</p><p>Gamma</p>'));
    expect(await q.edit(requestFor(map, 'Beta', 'Beta!'))).toMatchObject({ ok: false, code: 'ambiguous' });
  });

  it('not-utf8, refused, conflict and internal', async () => {
    const io1 = new MemIO(readFileSync(join(FIXTURES, 'windows-1252.html')));
    const q1 = createWriteQueue(io1);
    const m1 = await q1.refresh();
    expect(await q1.edit({ version: m1.version, runId: 'h:bl-1:0', beforeText: 'x', afterText: 'y' })).toMatchObject({ code: 'not-utf8' });

    const io2 = new MemIO(doc('<p>Hello</p>'));
    const q2 = createWriteQueue(io2, { canWrite: () => false });
    const m2 = await q2.refresh();
    expect(await q2.edit(requestFor(m2, 'Hello', 'Hi'))).toMatchObject({ code: 'refused' });
    // A request that does not fit its own version.
    const q3 = createWriteQueue(new MemIO(doc('<p>Hello</p>')));
    const m3 = await q3.refresh();
    expect(await q3.edit({ ...requestFor(m3, 'Hello', 'Hi'), beforeText: 'Bye' })).toMatchObject({ code: 'refused' });
    expect(await q3.edit({ ...requestFor(m3, 'Hello', 'Hi'), runId: 'h:bl-77:0' })).toMatchObject({ code: 'refused' });
    expect(await q3.edit({ version: 1 } as never)).toMatchObject({ ok: false, code: 'refused', verbatim: { before: '', after: '' } });

    const io4 = new MemIO(doc('<p>Alpha</p>'));
    const q4 = createWriteQueue(io4, { maxRetries: 1 });
    const m4 = await q4.refresh();
    let n = 0;
    const realWrite = io4.atomicWrite.bind(io4);
    io4.atomicWrite = async (bytes, hash) => {
      io4.external(doc(`<p>Alpha</p><!-- ${++n} -->`));
      return realWrite(bytes, hash);
    };
    expect(await q4.edit(requestFor(m4, 'Alpha', 'Alpha!'))).toMatchObject({ ok: false, code: 'conflict' });

    const io5 = new MemIO(doc('<p>Alpha</p>'));
    const q5 = createWriteQueue(io5);
    const m5 = await q5.refresh();
    io5.read = async () => {
      throw new Error('EIO');
    };
    expect(await q5.edit(requestFor(m5, 'Alpha', 'Alpha!'))).toMatchObject({ ok: false, code: 'internal', why: 'read failed: EIO' });
  });

  it('verify: a re-parse that disagrees is refused before anything is written', async () => {
    const src = doc('<p>Hello</p><p>Other</p>');
    const io = new MemIO(src);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    // Seed the queue with a wrong map for the exact bytes the edit would write: verify must refuse.
    const newSrc = doc('<p>Hello there</p><p>Other</p>');
    const real = mapOf(newSrc);
    q.know(real.version, newSrc, { ...real, runs: real.runs.slice(0, 1) });
    const out = await q.edit(requestFor(map, 'Hello', 'Hello there'));
    expect(out).toMatchObject({ ok: false, code: 'verify', why: expect.stringMatching(/^verify: /) });
    expect(io.text).toBe(src);
  });

  it('undo refusals are typed too', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const out = await q.edit(requestFor(map, 'Hello', 'Hello world'));
    if (!out.ok) throw new Error(out.why);
    io.external(doc('<p>Hello there</p>'));
    expect(await q.undo(out.record)).toEqual({ ok: false, why: CANT_UNDO, canMakeNote: true, code: 'stale' });
    expect(await q.undo({} as WriteRecord)).toMatchObject({ ok: false, canMakeNote: false, code: 'refused' });
  });
});

describe('after the rename (P2-1): nothing may turn a landed write into a note', () => {
  it('an atomic write that rejects after the file landed is a written edit, reported', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const real = io.atomicWrite.bind(io);
    io.atomicWrite = async (bytes, hash) => {
      await real(bytes, hash);
      throw new Error('rebind failed after the rename');
    };
    const { q, written, errors } = logged(io);
    const map = await q.refresh();
    const out = await q.edit(requestFor(map, 'Hello', 'Hi'));
    expect(out).toMatchObject({ ok: true, version: sha256(io.bytes) });
    expect(written).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('one that rejects before anything landed is a note with the file untouched', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const before = io.bytes.slice();
    io.atomicWrite = async () => {
      throw new Error('EACCES');
    };
    const q = createWriteQueue(io);
    const map = await q.refresh();
    expect(await q.edit(requestFor(map, 'Hello', 'Hi'))).toMatchObject({ ok: false, code: 'internal', why: 'write failed: EACCES' });
    expect(bytesEqual(io.bytes, before)).toBe(true);
  });

  it('a read-back that finds another writer\'s bytes keeps both: no restore, the change is reported', async () => {
    const io = new MemIO(doc('<p>Hello</p>'));
    const real = io.atomicWrite.bind(io);
    const later = doc('<p>Hi</p><p>Agent wrote right after</p>');
    io.atomicWrite = async (bytes, hash) => {
      await real(bytes, hash);
      io.external(later); // lands between the rename and the read-back
    };
    const { q, errors } = logged(io);
    const map = await q.refresh();
    expect(await q.edit(requestFor(map, 'Hello', 'Hi'))).toMatchObject({ ok: true });
    expect(io.text).toBe(later);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).name).toBe('ReadBackMismatch');
  });
});

describe('restore (9.2 Undo and redo step 4, P2-11)', () => {
  it('writes the snapshot\'s bytes as they are, only on the version it was confirmed against', async () => {
    for (const name of ['entities.html', 'bom.html', 'crlf.html', 'js-templates.html']) {
      const original = new Uint8Array(readFileSync(join(FIXTURES, name)));
      const io = new MemIO(original);
      const { q, written } = logged(io);
      const map = await q.refresh();
      const run = map.runs.find((r) => r.aligned)!;
      const out = await q.edit(requestFor(map, run.id, run.value + ' (edited)'));
      if (!out.ok) throw new Error(`${name}: ${out.why}`);
      const r = await q.restore(original, out.version);
      expect(r).toEqual({ ok: true, version: sha256(original) });
      expect(bytesEqual(io.bytes, original)).toBe(true);
      // The record afterWrite gets is the one splice from the edited file back to the snapshot.
      const rec = written[1].record;
      const edited = written[0].next.src;
      expect(edited.slice(0, rec.start) + rec.rawAfter + edited.slice(rec.start + rec.rawBefore.length)).toBe(decodeDeck(original).src);
      expect(rec).toMatchObject({ versionBefore: out.version, versionAfter: sha256(original) });
    }
  });

  it('refuses on another version, and a change that lands during the restore survives', async () => {
    const io = new MemIO(doc('<p>Now</p>'));
    const snapshot = encodeDeck(doc('<p>Then</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    expect(await q.restore(snapshot, 'a'.repeat(64))).toMatchObject({ ok: false, code: 'conflict' });
    const external = doc('<p>Now</p><p>Agent</p>');
    io.beforeWrite = () => io.external(external);
    expect(await q.restore(snapshot, map.version)).toMatchObject({ ok: false, code: 'conflict' });
    expect(io.text).toBe(external);
  });

  it('is serialized with edits: an edit queued first makes the restore refuse', async () => {
    const io = new MemIO(doc('<p>Now</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const [e, r] = await Promise.all([q.edit(requestFor(map, 'Now', 'Now!')), q.restore(encodeDeck(doc('<p>Then</p>')), map.version)]);
    expect(e.ok).toBe(true);
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    expect(io.text).toBe(doc('<p>Now!</p>'));
  });

  it('refuses what it must not write: not UTF-8, the same bytes, bad arguments, editing off', async () => {
    const io = new MemIO(doc('<p>Now</p>'));
    const q = createWriteQueue(io);
    const map = await q.refresh();
    expect(await q.restore(new Uint8Array([0x3c, 0xff, 0xfe]), map.version)).toMatchObject({ ok: false, code: 'not-utf8' });
    expect(await q.restore(io.bytes.slice(), map.version)).toMatchObject({ ok: false, code: 'noop' });
    expect(await q.restore('x' as unknown as Uint8Array, map.version)).toMatchObject({ ok: false, code: 'refused' });
    expect(await q.restore(encodeDeck('x'), 'nope')).toMatchObject({ ok: false, code: 'refused' });
    const off = createWriteQueue(io, { canWrite: () => false });
    expect(await off.restore(encodeDeck(doc('<p>Then</p>')), map.version)).toMatchObject({ ok: false, code: 'refused' });
    const latin = new MemIO(readFileSync(join(FIXTURES, 'windows-1252.html')));
    const lq = createWriteQueue(latin);
    const lm = await lq.refresh();
    expect(await lq.restore(encodeDeck(doc('<p>x</p>')), lm.version)).toMatchObject({ ok: false, code: 'not-utf8' });
    expect(io.writes).toBe(0);
  });
});

describe('picked candidates (P2-8): the request is the node\'s edit lifted to its run', () => {
  it('equal, substring and normalized picks that lift exactly are written', async () => {
    const src = doc("<p>Owner</p><p>Owner</p><script>var s = 'Revenue grew 12% in Q3'; var t = 'Hello\\n    world';</script>");
    const io = new MemIO(src);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const second = map.runs.filter((r) => r.value === 'Owner')[1];
    const eq = await q.edit({ version: map.version, runId: second.id, beforeText: 'Owner', afterText: 'Owners', pick: { kind: 'equal', nodeBefore: 'Owner', nodeAfter: 'Owners' } });
    expect(eq.ok).toBe(true);
    const m2 = await q.currentMap();
    const sub = await q.edit({
      ...requestFor(m2, 'Revenue grew 12% in Q3', 'Revenue grew 14% in Q3'),
      pick: { kind: 'substring', nodeBefore: 'grew 12%', nodeAfter: 'grew 14%' },
    });
    expect(sub.ok).toBe(true);
    const m3 = await q.currentMap();
    const norm = await q.edit({
      ...requestFor(m3, 'Hello\n    world', 'Hello\n    big world'),
      pick: { kind: 'normalized', nodeBefore: 'Hello world', nodeAfter: 'Hello big world' },
    });
    expect(norm.ok).toBe(true);
    expect(io.text).toBe(doc("<p>Owner</p><p>Owners</p><script>var s = 'Revenue grew 14% in Q3'; var t = 'Hello\\n    big world';</script>"));
  });

  it('a pick that cannot be lifted is ambiguous; one the request does not match is refused', async () => {
    const src = doc("<script>var s = 'to be or not to be';</script>");
    const io = new MemIO(src);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const req = requestFor(map, 'to be or not to be', 'to see or not to be');
    expect(await q.edit({ ...req, pick: { kind: 'substring', nodeBefore: 'to be', nodeAfter: 'to see' } })).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(await q.edit({ ...req, pick: { kind: 'substring', nodeBefore: 'or not', nodeAfter: 'and not' } })).toMatchObject({ ok: false, code: 'refused' });
    expect(await q.edit({ ...req, pick: { kind: 'equal', nodeBefore: 'to be', nodeAfter: 'to see' } })).toMatchObject({ ok: false, code: 'ambiguous' });
    expect(await q.edit({ ...req, pick: { kind: 'other', nodeBefore: 'a', nodeAfter: 'b' } as never })).toMatchObject({ ok: false, code: 'refused' });
    expect(io.writes).toBe(0);
  });
});

describe('undo in a changed file (9.2 Undo and redo cases 1–3) on the entity, BOM, CRLF and literal fixtures', () => {
  for (const name of ['entities.html', 'bom.html', 'crlf.html', 'js-templates.html', 'json-data.html']) {
    it(`${name}: case 2 restores exactly; case 3 leaves the file byte-identical and offers a note`, async () => {
      const original = new Uint8Array(readFileSync(join(FIXTURES, name)));
      const io = new MemIO(original);
      const { q, snapshots } = logged(io);
      const map = await q.refresh();
      const runs = [...map.runs.filter((r) => r.aligned), ...map.literals.filter((l) => l.aligned !== false && !l.placeholder && !(l.html && !map.units[l.unit].html))];
      let tried = 0;
      let case3 = 0;
      for (const run of runs.slice(0, 6)) {
        const base = io.bytes.slice();
        const cur = await q.currentMap();
        const live = [...cur.runs, ...cur.literals].find((r) => r.id === run.id);
        if (!live) continue;
        const out = await q.edit(requestFor(cur, live.id, live.value + ' edited'));
        if (!out.ok) {
          expect(bytesEqual(io.bytes, base)).toBe(true);
          continue;
        }
        tried++;
        expect(bytesEqual(snapshots[snapshots.length - 1].bytes, base)).toBe(true);
        // Case 2: a change far from the edit; undo by context, byte for byte.
        const text = decodeDeck(io.bytes).src;
        const at = text.lastIndexOf('</html>') >= 0 ? text.lastIndexOf('</html>') : text.length;
        const ins = '<!-- agent -->';
        io.external(text.slice(0, at) + ins + text.slice(at));
        const u = await q.undo(out.record);
        expect(u.ok, `${name} ${live.id} ${u.ok ? '' : u.why}`).toBe(true);
        const baseSrc = decodeDeck(base).src;
        const bat = baseSrc.lastIndexOf('</html>') >= 0 ? baseSrc.lastIndexOf('</html>') : baseSrc.length;
        expect(bytesEqual(io.bytes, encodeDeck(baseSrc.slice(0, bat) + ins + baseSrc.slice(bat)))).toBe(true);
        // Case 3: redo, then the agent rewrites the edited text: undo is refused and nothing changes.
        expect((await q.redo(out.record)).ok).toBe(true);
        const redone = decodeDeck(io.bytes).src;
        const raw = out.record.rawAfter;
        const where = redone.indexOf(out.record.prefix + raw + out.record.suffix);
        if (where >= 0 && raw.length > 0) {
          const rewritten = redone.slice(0, where + out.record.prefix.length) + raw.toUpperCase() + 'X' + redone.slice(where + out.record.prefix.length + raw.length);
          io.external(rewritten);
          const frozen = io.bytes.slice();
          expect(await q.undo(out.record)).toMatchObject({ ok: false, why: CANT_UNDO, canMakeNote: true, code: 'stale' });
          expect(bytesEqual(io.bytes, frozen)).toBe(true);
          case3++;
        }
        io.external(base);
      }
      expect(tried).toBeGreaterThan(0);
      expect(case3).toBe(tried);
    });
  }
});
