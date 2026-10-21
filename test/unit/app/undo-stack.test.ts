// The app's undo and redo of own writes (9.2 Undo and redo 1–4; decisions P2-10, P2-14): one stack per document,
// tokens main mints, the original record kept for redo, one operation at a time, and a toast's token honoured only
// while it is the newest undoable write.
import { describe, expect, it } from 'vitest';
import type { WriteRecord } from '@blueline/core/types';
import { MAX_UNDO_ENTRIES, UNDO_TOKEN, UndoStack, isUndoRecord, newUndoToken, type NewUndoEntry } from '../../../packages/app/src/main/undo-stack';

const V = (c: string) => c.repeat(64);
const record = (over: Partial<WriteRecord> = {}): WriteRecord => ({
  versionBefore: V('a'),
  versionAfter: V('b'),
  start: 120,
  rawBefore: 'Old &amp; tired',
  rawAfter: 'New &amp; shiny',
  prefix: '<h1 class="title">',
  suffix: '</h1>\n<p>Second</p>',
  ...over,
});
const entry = (n: number, over: Partial<NewUndoEntry> = {}): NewUndoEntry => ({
  record: record({ start: n }),
  runId: `h:bl-${n}:0`,
  strategy: 'html-text',
  beforeText: `before ${n}`,
  afterText: `after ${n}`,
  noteId: `n-${String(n).padStart(4, '0')}`,
  line: n,
  ...over,
});

describe('records (the editor isWriteRecord checks, main side)', () => {
  it('accepts the queue’s records and rejects malformed ones', () => {
    expect(isUndoRecord(record())).toBe(true);
    // A surrogate pair kept whole at the context edge: 33 code units.
    expect(isUndoRecord(record({ prefix: 'x'.repeat(31) + '😀' }))).toBe(true);
    for (const bad of [
      null,
      [],
      'r',
      record({ versionBefore: 'abc' }),
      record({ versionAfter: V('G') }),
      record({ start: -1 }),
      record({ start: 1.5 }),
      record({ start: Number.MAX_SAFE_INTEGER + 2 }),
      record({ prefix: 'x'.repeat(34) }),
      record({ suffix: 'x'.repeat(34) }),
      { ...record(), rawAfter: 5 },
      (() => {
        const r: Record<string, unknown> = { ...record() };
        delete r.suffix;
        return r;
      })(),
      Object.create(record()),
    ]) {
      expect(isUndoRecord(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('tokens are 128 random bits in hex', () => {
    const a = newUndoToken();
    expect(a).toMatch(UNDO_TOKEN);
    expect(newUndoToken()).not.toBe(a);
  });
});

describe('UndoStack', () => {
  it('push mints a token and copies the entry; a malformed entry throws (a bug in main, never a deck)', () => {
    const s = new UndoStack();
    const original = entry(1);
    const e = s.push(original);
    expect(e.token).toMatch(UNDO_TOKEN);
    expect(e).toMatchObject({ runId: 'h:bl-1:0', noteId: 'n-0001', line: 1, beforeText: 'before 1', afterText: 'after 1' });
    // The stack keeps its own copy: changing the caller's record changes nothing.
    original.record.rawBefore = 'tampered';
    expect(s.latest(e.token)!.record.rawBefore).toBe('Old &amp; tired');
    for (const bad of [
      entry(2, { record: record({ versionAfter: 'x' }) }),
      entry(2, { runId: '../x' }),
      entry(2, { runId: 'h:bl-1' }),
      entry(2, { strategy: 'agent' }),
      entry(2, { noteId: 'n-1' }),
      entry(2, { line: -1 }),
      entry(2, { token: 'short' }),
      entry(2, { beforeText: 5 as never }),
    ]) {
      expect(() => s.push(bad), JSON.stringify(bad)).toThrow();
    }
    expect(s.size).toEqual({ undo: 1, redo: 0 });
    // A token main minted itself is kept, but never twice.
    const t = newUndoToken();
    expect(s.push(entry(3, { token: t })).token).toBe(t);
    expect(() => s.push(entry(4, { token: t }))).toThrow(/token/);
  });

  it('undo and redo are LIFO, keep the ORIGINAL record, and redo’s new note id replaces the old one', () => {
    const s = new UndoStack();
    const a = s.push(entry(1));
    const b = s.push(entry(2));
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);

    const u1 = s.undo()!;
    expect(u1.token).toBe(b.token);
    expect(u1.record).toEqual(record({ start: 2 }));
    expect(s.settle(u1.token, { ok: true })).toBe(true);
    const u2 = s.undo()!;
    expect(u2.token).toBe(a.token);
    s.settle(u2.token, { ok: true });
    expect(s.undo()).toBeNull();
    expect(s.size).toEqual({ undo: 0, redo: 2 });

    // Redo comes back in the opposite order, with the very record the write made (the queue swaps it).
    const r1 = s.redo()!;
    expect(r1.token).toBe(a.token);
    expect(r1.record).toEqual(record({ start: 1 }));
    s.settle(r1.token, { ok: true, noteId: 'n-0007' });
    expect(s.latest(a.token)!.noteId).toBe('n-0007');
    expect(s.latest(a.token)!.record).toEqual(record({ start: 1 }));
    const r2 = s.redo()!;
    expect(r2.token).toBe(b.token);
    s.settle(r2.token, { ok: true, noteId: 'n-0008' });
    expect(s.size).toEqual({ undo: 2, redo: 0 });
    expect(s.latest(b.token)!.noteId).toBe('n-0008');
    expect(() => {
      const u = s.undo()!;
      s.settle(u.token, { ok: true, noteId: 'bad' });
    }).toThrow(/note id/);
  });

  it('one operation at a time: a second Cmd+Z while the first is written gets nothing', () => {
    const s = new UndoStack();
    s.push(entry(1));
    s.push(entry(2));
    const u = s.undo()!;
    expect(s.busy).toBe(true);
    expect(s.canUndo).toBe(false);
    expect(s.undo()).toBeNull();
    expect(s.redo()).toBeNull();
    expect(s.latest(u.token)).toBeNull();
    // Settling another token does nothing.
    expect(s.settle(newUndoToken(), { ok: true })).toBe(false);
    s.settle(u.token, { ok: true });
    expect(s.busy).toBe(false);
    expect(s.settle(u.token, { ok: true })).toBe(false);
  });

  it('a failed undo (case 3) leaves the entry on top: Cmd+Z tries it again, never skips to an older write', () => {
    const s = new UndoStack();
    const a = s.push(entry(1));
    const b = s.push(entry(2));
    const u = s.undo()!;
    s.settle(u.token, { ok: false });
    expect(s.latest(b.token)).not.toBeNull();
    expect(s.undo()!.token).toBe(b.token);
    s.settle(b.token, { ok: false });
    // Make a note keeps it as a verbatim note and drops it; the older write is next.
    expect(s.get(b.token)).toMatchObject({ beforeText: 'before 2', afterText: 'after 2' });
    expect(s.drop(b.token)!.token).toBe(b.token);
    expect(s.get(b.token)).toBeNull();
    expect(s.latest(a.token)).not.toBeNull();
    // A failed redo stays redoable.
    const u2 = s.undo()!;
    s.settle(u2.token, { ok: true });
    const r = s.redo()!;
    s.settle(r.token, { ok: false });
    expect(s.size).toEqual({ undo: 0, redo: 1 });
    expect(s.get(a.token)).not.toBeNull();
  });

  it('a new write clears redo, also when it lands while an undo is being written', () => {
    const s = new UndoStack();
    s.push(entry(1));
    const b = s.push(entry(2));
    const u = s.undo()!;
    s.settle(u.token, { ok: true });
    expect(s.canRedo).toBe(true);
    s.push(entry(3));
    expect(s.canRedo).toBe(false);
    expect(s.get(b.token)).toBeNull();

    // Undo of 3 in flight, then write 4 lands: 3's undo still happened, but redo was forked away.
    const u3 = s.undo()!;
    const d = s.push(entry(4));
    s.settle(u3.token, { ok: true });
    expect(s.size).toEqual({ undo: 2, redo: 0 });
    expect(s.latest(d.token)).not.toBeNull();
  });

  it('latest(token): only the newest undoable write, for the toast’s Undo (P2-14)', () => {
    const s = new UndoStack();
    const a = s.push(entry(1));
    expect(s.latest(a.token)!.token).toBe(a.token);
    const b = s.push(entry(2));
    // An older toast's Undo no longer applies.
    expect(s.latest(a.token)).toBeNull();
    expect(s.latest(b.token)!.token).toBe(b.token);
    for (const junk of ['', 'x', b.token.toUpperCase(), `${b.token} `, 5 as never, null as never]) expect(s.latest(junk)).toBeNull();
    // An undone write is not "latest" either.
    const u = s.undo()!;
    s.settle(u.token, { ok: true });
    expect(s.latest(b.token)).toBeNull();
  });

  it('clear() drops everything (a D-1 reopen); an operation in flight then settles to nothing', () => {
    const s = new UndoStack();
    const a = s.push(entry(1));
    const u = s.undo()!;
    s.clear();
    expect(s.settle(u.token, { ok: false })).toBe(false);
    expect(s.size).toEqual({ undo: 0, redo: 0 });
    expect(s.latest(a.token)).toBeNull();
    expect(s.canUndo).toBe(false);
  });

  it(`keeps at most ${MAX_UNDO_ENTRIES} entries per stack, dropping the oldest`, () => {
    const s = new UndoStack(3);
    const tokens = [1, 2, 3, 4].map((n) => s.push(entry(n)).token);
    expect(s.size.undo).toBe(3);
    expect(s.get(tokens[0])).toBeNull();
    expect(s.get(tokens[3])).not.toBeNull();
    expect(new UndoStack().size).toEqual({ undo: 0, redo: 0 });
  });

  it('E-3: an entry exists from the moment its commit is accepted; undo takes the newest that landed (finding 14)', () => {
    const s = new UndoStack();
    const a = s.push(entry(1));
    // E2 accepted, its write in flight: Cmd+Z queued behind it would see it once it lands.
    const t2 = s.reserve();
    expect(s.pending).toBe(1);
    expect(s.size).toEqual({ undo: 1, redo: 0 });
    // The toast's Undo of E1 no longer names the latest write (E2 is newer, even while pending).
    expect(s.latest(a.token)).toBeNull();
    const e2 = s.fill(t2, entry(2))!;
    expect(e2.token).toBe(t2);
    expect(s.pending).toBe(0);
    const u = s.undo()!;
    expect(u.token).toBe(t2);
    s.settle(u.token, { ok: true });
    // Redo after such an undo works.
    const r = s.redo()!;
    expect(r.token).toBe(t2);
    s.settle(r.token, { ok: true, noteId: 'n-0009' });
    expect(s.latest(t2)!.noteId).toBe('n-0009');
  });

  it('E-3: a pending entry on top is skipped by undo (it is newer than the press); a cancelled one goes', () => {
    const s = new UndoStack();
    const a = s.push(entry(1));
    const t2 = s.reserve();
    const u = s.undo()!;
    expect(u.token).toBe(a.token);
    s.settle(u.token, { ok: true });
    expect(s.canRedo).toBe(true);
    // E2 became a note: its slot goes, and redo is still there (nothing new was written).
    expect(s.cancel(t2)).toBe(true);
    expect(s.cancel(t2)).toBe(false);
    expect(s.canRedo).toBe(true);
    expect(s.fill(t2, entry(2))).toBeNull();
  });

  it('E-3: a failed undo goes back below every write accepted since, never above it', () => {
    const s = new UndoStack();
    s.push(entry(1));
    const b = s.push(entry(2));
    const u = s.undo()!;
    expect(u.token).toBe(b.token);
    // A commit accepted while the undo of 2 is written, and filled.
    const t3 = s.reserve();
    s.settle(u.token, { ok: false });
    s.fill(t3, entry(3));
    expect(s.latest(t3)).not.toBeNull();
    const next = s.undo()!;
    expect(next.token).toBe(t3);
    s.settle(next.token, { ok: true });
    expect(s.undo()!.token).toBe(b.token);
  });
});
