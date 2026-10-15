// Phase 0 notes (6.4, 6.6 author rows): ids, author, timestamps, draft → open, empty drafts discarded.
import { describe, expect, it } from 'vitest';
import type { NoteOpMark, SlideState } from '@blueline/core/ipc';
import type { Session } from '@blueline/core/types';
import { MAX_NOTES, NotesStore, formatLocalId, marksToNote, nextLocalId, slideRefFor } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';

const ME = { id: 'josh-ab12', name: 'Josh', color: '#2563eb' };
const VERSION = 'a'.repeat(64);
const slides: SlideState = {
  kind: 'reveal',
  count: 3,
  current: 1,
  titles: ['Intro', 'Plan', 'Ask'],
  navKind: 'reveal',
  revealIndices: [
    [0, 0],
    [1, 0],
    [1, 1],
  ],
  ids: ['intro', null, 'ask'],
};
const mark = (over: Partial<NoteOpMark> = {}): NoteOpMark => ({
  tool: 'pen',
  shape: 'ellipse',
  path: 'M0 0L10 10',
  targets: [{ css: '#h', text: 'Heading', role: 'heading', stamp: 'bl-3' }],
  ...over,
});

function store(session?: Session) {
  const s = session ?? emptySession({ path: '/d.html', realpath: '/d.html', fileKey: '0123456789abcdef', sha256: VERSION, title: 'T' });
  let t = 0;
  const n = new NotesStore(s, {
    me: () => ME,
    now: () => `2026-10-15T10:00:0${t++}.000Z`,
    version: () => VERSION,
    slides: () => slides,
  });
  return { s, n };
}

describe('ids', () => {
  it('n-0001… past every local id and tombstone; prefixed ids do not count', () => {
    expect(formatLocalId(7)).toBe('n-0007');
    expect(formatLocalId(12345)).toBe('n-12345');
    expect(nextLocalId([], [])).toBe('n-0001');
    expect(nextLocalId([{ id: 'n-0004' }, { id: 'anna-x7k2:n-0099' }], ['n-0010'])).toBe('n-0011');
    expect(nextLocalId([{ id: 'n-999999' }], [])).toBeNull();
  });
});

describe('NotesStore', () => {
  it('create: a draft by the user, with id, timestamps, slide, marks and targets', () => {
    const { s, n } = store();
    const r = n.apply({ op: 'create', clientId: 'c1', text: '', marks: [mark()], slide: 2 });
    expect(r).toEqual({ ok: true, created: { clientId: 'c1', id: 'n-0001' } });
    const note = s.notes[0];
    expect(note).toMatchObject({ id: 'n-0001', kind: 'markup', status: 'draft', author: ME.id, pass: null, text: '', recordings: [], thread: [] });
    expect(note.createdAt).toBe(note.updatedAt);
    expect(note.slide).toEqual({ index: 2, id: 'ask', title: 'Ask', nav: { kind: 'reveal', value: [1, 1] } });
    expect(note.marks).toEqual([{ n: 1, tool: 'pen', shape: 'ellipse', path: 'M0 0L10 10', targets: ['t1'] }]);
    expect(note.targets[0]).toEqual({
      ref: 't1',
      selectors: [
        { type: 'blueline:Stamp', value: 'bl-3', sha256: VERSION },
        { type: 'CssSelector', value: '#h' },
      ],
      box: { x: 0, y: 0, w: 1, h: 1 },
      role: 'heading',
      text: 'Heading',
    });
    expect(s.people).toEqual([ME]);
  });

  it('a repeated create from the same card returns the same note', () => {
    const { s, n } = store();
    n.apply({ op: 'create', clientId: 'c1', text: 'a', marks: [], slide: null });
    expect(n.apply({ op: 'create', clientId: 'c1', text: 'a', marks: [], slide: null })).toEqual({ ok: true, created: { clientId: 'c1', id: 'n-0001' } });
    expect(s.notes).toHaveLength(1);
  });

  it('update: text and the full mark list; marks share targets by ref (① ② on one note)', () => {
    const { s, n } = store();
    n.apply({ op: 'create', clientId: 'c', text: '', marks: [mark()], slide: 0 });
    const before = s.notes[0].updatedAt;
    expect(n.apply({ op: 'update', id: 'n-0001', text: 'make ① match ②', marks: [mark(), mark({ shape: 'freehand', targets: [{ css: '#p', text: 'P', role: 'paragraph', stamp: null }, { css: '#h', text: 'Heading', role: 'heading', stamp: 'bl-3' }] })] })).toEqual({ ok: true });
    const note = s.notes[0];
    expect(note.text).toBe('make ① match ②');
    expect(note.marks.map((m) => [m.n, m.targets])).toEqual([
      [1, ['t1']],
      [2, ['t2', 't1']],
    ]);
    expect(note.targets.map((t) => t.ref)).toEqual(['t1', 't2']);
    expect(note.targets[1].selectors).toEqual([{ type: 'CssSelector', value: '#p' }]);
    expect(note.updatedAt).not.toBe(before);
  });

  it('close: draft with text or marks → open; empty draft → deleted without a tombstone (6.4, 6.6)', () => {
    const { s, n } = store();
    n.apply({ op: 'create', clientId: 'a', text: 'hello', marks: [], slide: null });
    n.apply({ op: 'create', clientId: 'b', text: '  ', marks: [], slide: null });
    n.apply({ op: 'create', clientId: 'c', text: '', marks: [mark()], slide: null });
    n.apply({ op: 'close', id: 'n-0001' });
    n.apply({ op: 'close', id: 'n-0002' });
    n.apply({ op: 'close', id: 'n-0003' });
    expect(s.notes.map((x) => [x.id, x.status])).toEqual([
      ['n-0001', 'open'],
      ['n-0003', 'open'],
    ]);
    expect(s.tombstones).toEqual([]);
    // Closing an open note changes nothing.
    expect(n.apply({ op: 'close', id: 'n-0001' })).toEqual({ ok: true });
    expect(s.notes[0].status).toBe('open');
  });

  it('delete: open, reopened and question become tombstones; drafts are discarded; others are refused', () => {
    const { s, n } = store();
    for (const c of ['a', 'b', 'c', 'd']) n.apply({ op: 'create', clientId: c, text: c, marks: [], slide: null });
    n.apply({ op: 'close', id: 'n-0001' });
    s.notes[2].status = 'sent';
    s.notes[3].status = 'question';
    expect(n.apply({ op: 'delete', id: 'n-0001' })).toEqual({ ok: true });
    expect(n.apply({ op: 'delete', id: 'n-0002' })).toEqual({ ok: true }); // draft
    expect(n.apply({ op: 'delete', id: 'n-0003' })).toMatchObject({ ok: false });
    expect(n.apply({ op: 'delete', id: 'n-0004' })).toEqual({ ok: true });
    expect(s.notes.map((x) => x.id)).toEqual(['n-0003']);
    expect(s.tombstones).toEqual(['n-0001', 'n-0004']);
    // The next id never reuses a tombstoned one.
    expect(n.apply({ op: 'create', clientId: 'e', text: '', marks: [], slide: null })).toMatchObject({ created: { id: 'n-0005' } });
  });

  it("refuses to edit someone else's note, or a note past open (Phase 4 adds threads)", () => {
    const { s, n } = store();
    n.apply({ op: 'create', clientId: 'a', text: 'x', marks: [], slide: null });
    s.notes.push({ ...s.notes[0], id: 'anna-x7k2:n-0003', author: 'anna-x7k2', status: 'open' });
    expect(n.apply({ op: 'update', id: 'anna-x7k2:n-0003', text: 'hijack' })).toMatchObject({ ok: false });
    for (const st of ['sent', 'working', 'done', 'accepted', 'question'] as const) {
      s.notes[0].status = st;
      expect(n.apply({ op: 'update', id: 'n-0001', text: 'y' })).toMatchObject({ ok: false });
    }
    expect(s.notes[0].text).toBe('x');
    expect(n.apply({ op: 'update', id: 'n-9999', text: 'y' })).toMatchObject({ ok: false });
    expect(n.apply({ op: 'close', id: 'n-9999' })).toMatchObject({ ok: false });
  });

  it(`never holds more than ${MAX_NOTES} notes`, () => {
    const { s, n } = store();
    for (let i = 0; i < MAX_NOTES; i++) n.apply({ op: 'create', clientId: `c${i}`, text: 't', marks: [], slide: null });
    expect(n.apply({ op: 'create', clientId: 'over', text: 't', marks: [], slide: null })).toMatchObject({ ok: false });
    expect(s.notes).toHaveLength(MAX_NOTES);
  });
});

describe('slideRefFor', () => {
  it('builds a SlideRef from the slide report (9.4)', () => {
    expect(slideRefFor(null, slides)).toEqual({ index: null, id: null, title: null, nav: { kind: 'none', value: 0 } });
    expect(slideRefFor(9, slides)).toMatchObject({ index: 9, title: null });
    expect(slideRefFor(0, null)).toMatchObject({ index: 0, nav: { kind: 'none' } });
    const hash: SlideState = { kind: 'generic', count: 2, current: 0, titles: ['A'.repeat(100), 'B'], navKind: 'hash', hashes: ['#a', '#b'] };
    expect(slideRefFor(0, hash)).toEqual({ index: 0, id: 'a', title: 'A'.repeat(80), nav: { kind: 'hash', value: '#a' } });
    const index: SlideState = { kind: 'generic', count: 2, current: 0, titles: ['A', 'B'], navKind: 'index' };
    expect(slideRefFor(1, index)).toEqual({ index: 1, id: null, title: 'B', nav: { kind: 'index', value: 1 } });
  });

  it('marksToNote trims target text to 300 characters', () => {
    const { targets } = marksToNote([mark({ targets: [{ css: '', text: 'x'.repeat(500), role: 'paragraph', stamp: null }] })], VERSION);
    expect(targets[0].text).toHaveLength(300);
    expect(targets[0].selectors).toEqual([]);
  });
});
