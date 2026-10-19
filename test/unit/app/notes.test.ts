// Phase 0 notes (6.4, 6.6 author rows): ids, author, timestamps, draft → open, empty drafts discarded.
// Phase 2 system actions (6.6 Edit notes; 6.3 When a write fails; 9.2 Strategy 3 and Undo case 3; section 8 Locked
// spans): edit notes done with their lock, verbatim notes open with candidates, undo's delete with a tombstone, room.
import { describe, expect, it } from 'vitest';
import type { NoteOpMark, SlideState } from '@blueline/core/ipc';
import type { Session } from '@blueline/core/types';
import {
  MAX_NOTES,
  MAX_SESSION_NOTES,
  NotesStore,
  editSummary,
  formatLocalId,
  marksToNote,
  nextLocalId,
  nextPass,
  oneLine,
  slideRefFor,
  updatePersonIn,
  type EditNoteInput,
} from '../../../packages/app/src/main/notes';
import { emptySession, readSession } from '../../../packages/app/src/main/session-store';

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

// ------------------------------------------------------------------------------------------- Phase 2 system notes

const W = 'b'.repeat(64);
const edit = (over: Partial<EditNoteInput> = {}): EditNoteInput => ({
  before: 'Revenue grew 4%',
  after: 'Revenue grew 5%',
  runId: 'h:bl-12:0',
  version: W,
  line: 142,
  col: 9,
  target: { css: 'section:nth-of-type(2) > h1', text: 'Revenue grew 5%', role: 'heading', stamp: 'bl-12' },
  slide: 1,
  lock: { start: 3021, end: 3036, text: 'Revenue grew 5%' },
  ...over,
});

describe('helpers', () => {
  it('nextPass: one past the highest pass sent, else 1 (6.6 "the next pass to be sent")', () => {
    expect(nextPass([])).toBe(1);
    expect(nextPass([{ n: 1 }, { n: 3 }, { n: 2 }])).toBe(4);
    expect(nextPass([{ n: Number.NaN }, { n: -2 }])).toBe(1);
  });

  it('editSummary: "Edited: <before> → <after>", one line, each side at most 120 characters', () => {
    expect(editSummary('Q3', 'Q4')).toBe('Edited: Q3 → Q4');
    expect(editSummary('a\nb\tc', 'd\r\ne')).toBe('Edited: a b c → d e');
    const long = editSummary('x'.repeat(500), 'y');
    expect(long).toBe(`Edited: ${'x'.repeat(119)}… → y`);
    // A surrogate pair is never cut in half.
    const emoji = oneLine('a'.repeat(118) + '😀😀', 120);
    expect(emoji).toBe('a'.repeat(118) + '…');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji)).toBe(false);
  });

  it('updatePersonIn changes the entry of that person only', () => {
    const s = emptySession({ path: '/d.html', realpath: '/d.html', fileKey: '0123456789abcdef', sha256: VERSION, title: 'T' });
    s.people.push({ ...ME }, { id: 'anna-x7k2', name: 'Anna', color: '#123456' });
    expect(updatePersonIn(s, { ...ME, name: 'Joshua' })).toBe(true);
    expect(updatePersonIn(s, { ...ME, name: 'Joshua' })).toBe(false);
    expect(updatePersonIn(s, { id: 'nobody-0000', name: 'N', color: '#000000' })).toBe(false);
    expect(s.people).toEqual([{ ...ME, name: 'Joshua' }, { id: 'anna-x7k2', name: 'Anna', color: '#123456' }]);
  });
});

describe('addEdit (6.6 Edit notes)', () => {
  it('kind edit, status done, pass = the next pass, verbatim, summary, target with its SourceLoc, and its lock', () => {
    const { s, n } = store();
    s.passes.push({ n: 1, sentAt: 't', snapshot: 'passes/1/snapshot.html' }, { n: 2, sentAt: 't', snapshot: 'passes/2/snapshot.html' });
    const note = n.addEdit(edit());
    expect(note).toEqual({
      id: 'n-0001',
      kind: 'edit',
      status: 'done',
      author: ME.id,
      createdAt: note.createdAt,
      updatedAt: note.createdAt,
      pass: 3,
      slide: { index: 1, id: null, title: 'Plan', nav: { kind: 'reveal', value: [1, 0] } },
      targets: [
        {
          ref: 't1',
          selectors: [
            { type: 'blueline:Stamp', value: 'bl-12', sha256: W },
            { type: 'CssSelector', value: 'section:nth-of-type(2) > h1' },
          ],
          box: { x: 0, y: 0, w: 1, h: 1 },
          role: 'heading',
          text: 'Revenue grew 5%',
          source: { file: 'd.html', version: W, start: 3021, end: 3036, line: 142, col: 9, strategy: 'html-text', confidence: 'exact' },
        },
      ],
      marks: [],
      text: '',
      verbatim: { before: 'Revenue grew 4%', after: 'Revenue grew 5%' },
      recordings: [],
      thread: [],
      summary: 'Edited: Revenue grew 4% → Revenue grew 5%',
    });
    expect(s.notes).toEqual([note]);
    expect(s.locked).toEqual([{ start: 3021, end: 3036, text: 'Revenue grew 5%', noteId: 'n-0001', state: 'ok' }]);
    expect(s.people).toEqual([ME]);
  });

  it('strategy from the run id unless given; a literal run says json-literal when main passes it', () => {
    const { n } = store();
    expect(n.addEdit(edit({ runId: 'l:4:0' })).targets[0].source!.strategy).toBe('script-literal');
    expect(n.addEdit(edit({ runId: 'l:5:1', strategy: 'json-literal' })).targets[0].source!.strategy).toBe('json-literal');
    expect(n.addEdit(edit({ col: undefined })).targets[0].source!.col).toBe(1);
  });

  it('never refuses for room (an edit already written always gets its note); a bad lock just goes without', () => {
    const { s, n } = store();
    for (let i = 0; i < MAX_NOTES; i++) n.apply({ op: 'create', clientId: `c${i}`, text: 't', marks: [], slide: null });
    // Author notes stop at MAX_NOTES…
    expect(n.apply({ op: 'create', clientId: 'over', text: 't', marks: [], slide: null })).toMatchObject({ ok: false });
    // …system notes do not.
    const e = n.addEdit(edit({ lock: { start: 9, end: 3, text: 'x' } }));
    expect(e.id).toBe(formatLocalId(MAX_NOTES + 1));
    expect(e.targets[0].source).toBeUndefined();
    expect(s.locked).toEqual([]);
    const v = n.addVerbatim({ before: 'a', after: 'b', target: null, slide: null });
    expect(v.id).toBe(formatLocalId(MAX_NOTES + 2));
    expect(n.addEdit(edit({ target: null, lock: null })).targets).toEqual([]);
  });
});

describe('canRecordEdit (room, asked before the field opens and before the write)', () => {
  it(`false from ${MAX_SESSION_NOTES} notes, or when local ids run out`, () => {
    const { s, n } = store();
    expect(n.canRecordEdit()).toBe(true);
    const base = s.notes.length;
    for (let i = base; i < MAX_SESSION_NOTES - 1; i++) n.addVerbatim({ before: 'a', after: String(i), target: null, slide: null });
    expect(n.canRecordEdit()).toBe(true);
    n.addEdit(edit());
    expect(s.notes).toHaveLength(MAX_SESSION_NOTES);
    expect(n.canRecordEdit()).toBe(false);

    const t = store();
    t.s.tombstones.push('n-999850');
    expect(t.n.canRecordEdit()).toBe(true);
    t.s.tombstones.push('n-999950');
    expect(t.n.canRecordEdit()).toBe(false);
    t.s.tombstones.push('n-999999');
    expect(() => t.n.addEdit(edit())).toThrow(/no free note id/);
  });
});

describe('addVerbatim (6.3 When a write fails; 9.2 Strategy 3)', () => {
  it('kind verbatim, status open, the exact texts, the target selectors, and why as its one-line summary', () => {
    const { s, n } = store();
    const v = n.addVerbatim({
      before: 'Café  au\u00a0lait',
      after: 'Café au lait — “now”',
      target: { css: '#p', text: 'Café  au\u00a0lait', role: 'paragraph', stamp: null },
      slide: 0,
      why: 'the text is in several places\nnow',
    });
    expect(v).toMatchObject({ id: 'n-0001', kind: 'verbatim', status: 'open', pass: null, author: ME.id, text: '', marks: [], verbatim: { before: 'Café  au\u00a0lait', after: 'Café au lait — “now”' } });
    expect(v.summary).toBe('Not written: the text is in several places now');
    expect(v.targets).toEqual([{ ref: 't1', selectors: [{ type: 'CssSelector', value: '#p' }], box: { x: 0, y: 0, w: 1, h: 1 }, role: 'paragraph', text: 'Café  au\u00a0lait' }]);
    expect(s.locked).toEqual([]);
    expect(n.addVerbatim({ before: 'a', after: 'b', target: null, slide: null, why: '  ' }).summary).toBeUndefined();
  });

  it('keeps the candidate locations: in the source main gives, or from the candidates and their version', () => {
    const { n } = store();
    const cands = [
      { start: 10, end: 20, line: 3, context: '…Revenue…' },
      { start: 400, end: 410, line: 40, context: '…Revenue…', keyWarning: 'This text is also used as a key at d.html:41' },
      { start: 9, end: 2, line: 1, context: 'bad: end before start' },
    ];
    const a = n.addVerbatim({ before: 'Revenue', after: 'Sales', target: null, slide: null, candidates: cands, version: W });
    expect(a.targets[0].source).toEqual({ file: 'd.html', version: W, start: 10, end: 20, line: 3, col: 1, strategy: 'agent', confidence: 'ambiguous', candidates: cands.slice(0, 2) });
    const b = n.addVerbatim({
      before: 'Revenue',
      after: 'Sales',
      target: { css: '#h', text: 'Revenue', role: 'heading', stamp: 'bl-2' },
      slide: null,
      source: { file: 'ignored.html', version: W, start: 5, end: 12, line: 2, col: 7, strategy: 'html-text', confidence: 'exact' },
      candidates: cands,
    });
    expect(b.targets[0].source).toEqual({ file: 'd.html', version: W, start: 5, end: 12, line: 2, col: 7, strategy: 'agent', confidence: 'exact', candidates: cands.slice(0, 2) });
    expect(b.targets[0].selectors[0]).toEqual({ type: 'blueline:Stamp', value: 'bl-2', sha256: W });
    // Candidates without the version they index are not kept (an offset is meaningless without it).
    expect(n.addVerbatim({ before: 'a', after: 'b', target: null, slide: null, candidates: cands }).targets).toEqual([]);
  });

  it('undo’s Make a note (case 3): the stored texts, written back the other way', () => {
    const { n } = store();
    const v = n.addVerbatim({ before: 'after the edit', after: 'before the edit', target: null, slide: 2, why: "Can't undo in place: the deck changed since this edit" });
    expect(v.verbatim).toEqual({ before: 'after the edit', after: 'before the edit' });
    expect(v.slide.index).toBe(2);
  });
});

describe('removeEdit (6.6: undoing the edit deletes its note)', () => {
  it('removes the edit note and its lock, tombstones the id, and redo gets a new id', () => {
    const { s, n } = store();
    const a = n.addEdit(edit());
    const b = n.addEdit(edit({ lock: { start: 5000, end: 5010, text: 'Other text' } }));
    s.locked.push({ start: 1, end: 2, text: 'x', noteId: a.id, state: 'violated', change: { before: 'x', after: 'y' } });
    expect(n.removeEdit(a.id)).toBe(true);
    expect(s.notes.map((x) => x.id)).toEqual([b.id]);
    expect(s.locked.map((l) => l.noteId)).toEqual([b.id]);
    expect(s.tombstones).toEqual([a.id]);
    expect(n.removeEdit(a.id)).toBe(false);
    // The highest id undone is not handed out again.
    expect(n.removeEdit(b.id)).toBe(true);
    expect(n.addEdit(edit()).id).toBe('n-0003');
    expect(s.tombstones).toEqual(['n-0001', 'n-0002']);
  });

  it('only edit notes; without a tombstone when asked', () => {
    const { s, n } = store();
    const v = n.addVerbatim({ before: 'a', after: 'b', target: null, slide: null });
    n.apply({ op: 'create', clientId: 'm', text: 'markup', marks: [], slide: null });
    expect(n.removeEdit(v.id)).toBe(false);
    expect(n.removeEdit('n-0002')).toBe(false);
    const e = n.addEdit(edit());
    expect(n.removeEdit(e.id, { tombstone: false })).toBe(true);
    expect(s.tombstones).toEqual([]);
  });

  it('notes and locks round-trip through session.json, SourceLoc included', () => {
    const { s, n } = store();
    n.addEdit(edit());
    n.addVerbatim({ before: 'Revenue', after: 'Sales', target: null, slide: null, candidates: [{ start: 1, end: 8, line: 1, context: 'c' }], version: W, why: 'two places' });
    const r = readSession(JSON.parse(JSON.stringify(s)), s.deck);
    expect(r.lossy).toBe(false);
    expect(r.session).toEqual(s);
  });
});

describe('the name on notes (6.8)', () => {
  it('a new note updates the user’s people entry to the current name; updatePerson does it at once', () => {
    let me = { ...ME };
    const s = emptySession({ path: '/d.html', realpath: '/d.html', fileKey: '0123456789abcdef', sha256: VERSION, title: 'T' });
    const n = new NotesStore(s, { me: () => me, now: () => 't', version: () => VERSION, slides: () => null });
    n.addEdit(edit());
    expect(s.people).toEqual([ME]);
    me = { ...ME, name: 'Josh N.' };
    expect(n.updatePerson(me)).toBe(true);
    expect(s.people).toEqual([me]);
    me = { ...ME, name: 'J' };
    n.addVerbatim({ before: 'a', after: 'b', target: null, slide: null });
    expect(s.people).toEqual([me]);
    // The author id never changes.
    expect(s.notes.every((x) => x.author === ME.id)).toBe(true);
  });
});
