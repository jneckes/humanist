import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANT_UNDO, createWriteQueue, makeRecord, planUndo, swapRecord } from '@blueline/editor';
import { decodeDeck } from '@blueline/core/text';
import type { DeckMap, WriteRecord } from '@blueline/core/types';
import { bytesEqual, MemIO, requestFor } from './helpers';

const FIXTURES = join(__dirname, '../../../fixtures/decks');

describe('makeRecord (9.2 Undo and redo)', () => {
  it('stores the raw splice with 32 source characters on each side', () => {
    const src = 'a'.repeat(40) + 'OLD' + 'b'.repeat(40);
    const r = makeRecord(src, { start: 40, rawBefore: 'OLD', rawAfter: 'NEW' }, 'v1', 'v2');
    expect(r).toEqual({ versionBefore: 'v1', versionAfter: 'v2', start: 40, rawBefore: 'OLD', rawAfter: 'NEW', prefix: 'a'.repeat(32), suffix: 'b'.repeat(32) });
  });

  it('keeps shorter context at the ends of the file', () => {
    const r = makeRecord('xOLDy', { start: 1, rawBefore: 'OLD', rawAfter: '' }, 'v1', 'v2');
    expect(r.prefix).toBe('x');
    expect(r.suffix).toBe('y');
  });

  it('keeps a surrogate pair whole at the far end of the context', () => {
    const src = '\u{1F600}' + 'a'.repeat(31) + 'X' + 'b'.repeat(31) + '\u{1F600}';
    const r = makeRecord(src, { start: 33, rawBefore: 'X', rawAfter: 'Y' }, 'v1', 'v2');
    expect(r.prefix).toBe('\u{1F600}' + 'a'.repeat(31));
    expect(r.suffix).toBe('b'.repeat(31) + '\u{1F600}');
  });
});

describe('planUndo (9.2 Undo and redo cases 1-3)', () => {
  const before = 'x'.repeat(200) + '<p>Hello</p>' + 'y'.repeat(200);
  const at = before.indexOf('Hello') + 5;
  const after = before.slice(0, at) + ' world' + before.slice(at);
  const record = makeRecord(before, { start: at, rawBefore: '', rawAfter: ' world' }, 'v-before', 'v-after');

  it('case 1: the file is unchanged since the write: replace at start', () => {
    const p = planUndo(after, record, 'v-after');
    expect(p).toEqual({ ok: true, case: 1, start: at, rawBefore: ' world', rawAfter: '' });
  });

  it('case 2: the file changed elsewhere: find prefix + rawAfter + suffix once, at the write\'s place in the version it made', () => {
    const changed = 'INSERTED ' + after + ' TAIL';
    const p = planUndo(changed, record, 'v-other', after);
    expect(p).toEqual({ ok: true, case: 2, start: at + 9, rawBefore: ' world', rawAfter: '' });
  });

  it('case 2 needs the version the write made: without it, or with a change next to the write, it is case 3 (E-1)', () => {
    const changed = 'INSERTED ' + after + ' TAIL';
    expect(planUndo(changed, record, 'v-other')).toEqual({ ok: false, why: CANT_UNDO, canMakeNote: true, code: 'stale' });
    const near = after.replace('<p>Hello world</p>', '<p>Hello world</p><p>Inserted next to it</p>');
    expect(planUndo(near, record, 'v-other', after)).toEqual({ ok: false, why: CANT_UNDO, canMakeNote: true, code: 'stale' });
  });

  it('case 3: the text changed, or it occurs twice: refuse with Make a note', () => {
    const edited = after.replace('Hello world', 'Hello there');
    expect(planUndo(edited, record, 'v-other', after)).toEqual({ ok: false, why: CANT_UNDO, canMakeNote: true, code: 'stale' });
    const twice = after + after;
    expect(planUndo(twice, record, 'v-other', after)).toEqual({ ok: false, why: CANT_UNDO, canMakeNote: true, code: 'stale' });
  });

  it('counts overlapping occurrences as different places', () => {
    const src = 'aaaaa';
    const r: WriteRecord = { versionBefore: 'a', versionAfter: 'b', start: 1, rawBefore: 'x', rawAfter: 'a', prefix: 'a', suffix: 'a' };
    expect(planUndo(src, r, 'c').ok).toBe(false);
  });

  it('anchors a short context at the start or end of the file', () => {
    const r = makeRecord('Hi there', { start: 0, rawBefore: 'Hi', rawAfter: 'Hello' }, 'v1', 'v2');
    expect(r.prefix).toBe('');
    // Same text later in the file is not where the write was.
    expect(planUndo('Hello there', r, 'v3', 'Hello there')).toMatchObject({ ok: true, case: 2, start: 0 });
    expect(planUndo('Oh! Hello there', r, 'v3', 'Hello there')).toMatchObject({ ok: false });
  });

  it('refuses in case 1 when the text at start disagrees with the record', () => {
    expect(planUndo('nothing here', record, 'v-after')).toMatchObject({ ok: false, canMakeNote: true });
  });

  it('redo is the same operation with rawBefore and rawAfter swapped', () => {
    const redo = swapRecord(record);
    expect(redo).toMatchObject({ rawBefore: ' world', rawAfter: '', versionBefore: 'v-after', versionAfter: 'v-before' });
    expect(planUndo(before, redo, 'v-before')).toEqual({ ok: true, case: 1, start: at, rawBefore: '', rawAfter: ' world' });
  });

  it('rejects malformed records', () => {
    expect(planUndo(after, { ...record, start: -1 }, 'v-after')).toMatchObject({ ok: false, canMakeNote: false });
    expect(planUndo(after, { ...record, prefix: 'p'.repeat(40) }, 'v-after')).toMatchObject({ ok: false });
    expect(planUndo(after, null as unknown as WriteRecord, 'v-after')).toMatchObject({ ok: false });
  });
});

/** Every editable run of a map whose edit should be written (not refused by rule). */
function editableRuns(map: DeckMap): { id: string; value: string }[] {
  return [
    ...map.runs.filter((r) => r.aligned),
    ...map.literals.filter((l) => l.aligned !== false && !l.placeholder && !(l.html && !map.units[l.unit].html)),
  ];
}

describe('undo through the write queue restores the bytes exactly', () => {
  for (const name of ['entities.html', 'bom.html', 'crlf.html', 'js-templates.html', 'json-data.html', 'unicode-edit-points.html']) {
    it(`${name}: edit, undo (case 1), redo, external change, undo (case 2)`, async () => {
      const original = readFileSync(join(FIXTURES, name));
      const io = new MemIO(original);
      const q = createWriteQueue(io);
      const map = await q.refresh();
      const runs = editableRuns(map);
      expect(runs.length).toBeGreaterThan(0);
      let written = 0;
      for (const run of runs) {
        const before = io.bytes.slice();
        const cur = await q.currentMap();
        // The mutation probe's edit: append the sentinel to the run (section 10, Phase 0).
        const out = await q.edit(requestFor(cur, run.id, run.value + '⟦bl⟧'));
        if (!out.ok) {
          // Plain literals that also read as HTML may refuse; the file must then be untouched.
          expect(bytesEqual(io.bytes, before)).toBe(true);
          continue;
        }
        written++;
        const edited = io.bytes.slice();
        const u = await q.undo(out.record);
        expect(u.ok).toBe(true);
        expect(bytesEqual(io.bytes, before)).toBe(true);
        const r = await q.redo(out.record);
        expect(r.ok).toBe(true);
        expect(bytesEqual(io.bytes, edited)).toBe(true);
        // Case 2: an external change elsewhere in the file, then undo by context.
        const text = decodeDeck(io.bytes).src;
        const i = text.lastIndexOf('</html>') >= 0 ? text.lastIndexOf('</html>') : text.length;
        io.external(text.slice(0, i) + '<!-- external -->' + text.slice(i));
        const externalBytes = io.bytes.slice();
        const u2 = await q.undo(out.record);
        if (u2.ok) {
          const expected = decodeDeck(before).src;
          const j = expected.lastIndexOf('</html>') >= 0 ? expected.lastIndexOf('</html>') : expected.length;
          expect(decodeDeck(io.bytes).src).toBe(expected.slice(0, j) + '<!-- external -->' + expected.slice(j));
        } else {
          expect(bytesEqual(io.bytes, externalBytes)).toBe(true);
        }
        // Back to the original for the next run.
        io.external(before);
      }
      expect(written).toBeGreaterThan(0);
      expect(bytesEqual(io.bytes, original)).toBe(true);
    });
  }

  it('case 3 leaves the file untouched and offers a note', async () => {
    const io = new MemIO('<!doctype html><body><p>Hello</p></body>');
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const out = await q.edit(requestFor(map, 'Hello', 'Hello world'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    io.external('<!doctype html><body><p>Hello there world</p></body>');
    const snapshot = io.bytes.slice();
    const u = await q.undo(out.record);
    expect(u).toEqual({ ok: false, why: CANT_UNDO, canMakeNote: true, code: 'stale' });
    expect(bytesEqual(io.bytes, snapshot)).toBe(true);
  });

  it('the BOM survives an undo byte for byte', async () => {
    const src = '\uFEFF<!doctype html><body><p>Hello</p></body>';
    const io = new MemIO(src);
    const q = createWriteQueue(io);
    const map = await q.refresh();
    const out = await q.edit(requestFor(map, 'Hello', 'Hello there'));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Array.from(io.bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    await q.undo(out.record);
    expect(decodeDeck(io.bytes).src).toBe(src);
  });
});
