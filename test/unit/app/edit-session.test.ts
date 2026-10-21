// Edit in main (Phase 2; edit-session.ts): the pure parts (Edit availability, the trusted-input and commit rules of
// P2-7, the picker's candidates of P2-8, the undo patch of P2-10, the history list and Restore's plan of P2-11, the
// notes list and Copy of P2-13, toast tokens of P2-14, the serial lane of P2-3), and the window's session refusing
// what it must refuse BEFORE the queue: a forged or untimely message writes nothing, makes no note and saves nothing.
// No editor here (it runs in the reader-only suite too): the queue is a tripwire that fails the test if reached.
// The flows through the real write queue are edit-lane.edit.test.ts.
import { describe, expect, it } from 'vitest';
import type { EditorModule, WriteQueue } from '@blueline/core/capabilities';
import { buildMap } from '@blueline/core/mapper';
import type { EditCommit } from '@blueline/core/ipc-edit';
import type { DeckMap, LockedSpan, Note } from '@blueline/core/types';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { BlDocument } from '../../../packages/app/src/main/documents';
import {
  BEGIN_WINDOW_MS,
  CANT_UNDO,
  EDIT_PROTECTED,
  EDIT_UNAVAILABLE,
  EditLane,
  EditSession,
  FieldRegistry,
  NOTHING_TO_REDO,
  NOTHING_TO_UNDO,
  SerialLane,
  ToastBook,
  TrustedInput,
  VersionCache,
  editAvailability,
  findRun,
  gateCommit,
  lineDiff,
  noteCopyText,
  pickerCandidates,
  refusalText,
  restorePlan,
  savedToastText,
  shellHistory,
  shellNotes,
  sourceBefore,
  strategyOf,
  undoPatch,
  verbatimWhyText,
  type EditSessionDeps,
  type FieldRecord,
  type ToastSpec,
} from '../../../packages/app/src/main/edit-session';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';
import { REFUSAL_CODES, VERBATIM_WHYS } from '../../../packages/core/src/ipc-edit';

const enc = (s: string) => new TextEncoder().encode(s);

function mapOf(src: string): DeckMap {
  const version = sha256Hex(enc(src));
  return buildMap(src, { version, utf8: true, defer: false });
}

// ------------------------------------------------------------------------------------------- availability

describe('editAvailability (6.3, 6.10)', () => {
  const base = { capEdit: true, readOnlyReason: null, gone: false, fileName: 'deck.html', editingAllowed: true };
  it('is available with the capability and editing allowed', () => {
    expect(editAvailability(base)).toEqual({ available: true, reason: null, enable: false });
  });
  it('says why not, in the order the user can act on it; only Protected view can be enabled', () => {
    expect(editAvailability({ ...base, capEdit: false, editingAllowed: false })).toEqual({ available: false, reason: EDIT_UNAVAILABLE, enable: false });
    expect(editAvailability({ ...base, readOnlyReason: 'deck.html is not UTF-8; direct edits are off' })).toMatchObject({ available: false, reason: 'deck.html is not UTF-8; direct edits are off', enable: false });
    expect(editAvailability({ ...base, gone: true })).toMatchObject({ available: false, enable: false });
    expect(editAvailability({ ...base, gone: true }).reason).toContain('deck.html');
    expect(editAvailability({ ...base, editingAllowed: false })).toEqual({ available: false, reason: EDIT_PROTECTED, enable: true });
  });
});

// ------------------------------------------------------------------------------------------- trusted input

describe('TrustedInput (P2-7)', () => {
  it('a press opens one field, within the window, and only presses count', () => {
    let t = 1000;
    const ti = new TrustedInput(() => t);
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(false);
    ti.note('mouseMove');
    ti.note('char');
    ti.note('keyUp');
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(false);
    ti.note('mouseDown');
    t += BEGIN_WINDOW_MS;
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(true);
    // Taken: the same press opens nothing else.
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(false);
    expect(ti.recentPress(BEGIN_WINDOW_MS)).toBe(true);
    ti.note('rawKeyDown');
    t += BEGIN_WINDOW_MS + 1;
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(false);
    expect(ti.recentPress(BEGIN_WINDOW_MS)).toBe(false);
    ti.note('keyDown');
    ti.reset();
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(false);
  });

  it('a press made while a commit was unanswered counts from the answer (E-1: its field opens only then)', () => {
    let t = 1000;
    const ti = new TrustedInput(() => t);
    // The click that commits the open field: main sees the press, then takes the commit.
    ti.note('mouseDown');
    ti.commitTaken();
    // A large deck: the answer comes 5 s later; the field opens right after it.
    t += 5000;
    ti.answered();
    t += 100;
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(true);
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(false);
    // A press during a commit main already holds counts the same way.
    ti.note('mouseDown', true);
    t += 4000;
    ti.answered();
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(true);
    // But only within the window after the answer, and never for a press no commit was waiting on.
    ti.note('mouseDown', true);
    t += 1000;
    ti.answered();
    t += BEGIN_WINDOW_MS + 1;
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(false);
    ti.note('mouseDown');
    t += BEGIN_WINDOW_MS + 1;
    ti.answered();
    expect(ti.takePress(BEGIN_WINDOW_MS)).toBe(false);
  });
});

describe('the Saved toast text (6.3 Saving; P2-14; the shell shows it, E-5)', () => {
  it('"Saved \u00b7 file:line", with the other places the run feeds', () => {
    expect(savedToastText('deck.html', 142, 0)).toBe('Saved \u00b7 deck.html:142');
    expect(savedToastText('Board deck.html', 9, 1)).toBe('Saved \u00b7 Board deck.html:9 \u00b7 also changes 1 other place');
    expect(savedToastText('deck.html', 9, 3)).toBe('Saved \u00b7 deck.html:9 \u00b7 also changes 3 other places');
    expect(savedToastText('deck.html', 0, 0)).toBe('Saved \u00b7 deck.html');
  });
});

describe('FieldRegistry', () => {
  it('records fields by id and takes each once; a newer field, no open field and leaving Edit end the others (E-4)', () => {
    const dropped: number[] = [];
    const r = new FieldRegistry((f) => dropped.push(f.id));
    const v = 'a'.repeat(64);
    r.begin({ fieldId: 1, version: v, runIds: ['h:bl-1:0'] }, 5);
    expect(r.peek(1)).toMatchObject({ id: 1, version: v, openedAt: 5, pinned: false });
    expect(r.peek(1)!.runIds.has('h:bl-1:0')).toBe(true);
    expect(r.take(1)).not.toBeNull();
    expect(r.take(1)).toBeNull();
    expect(dropped).toEqual([]);
    // The deck has one open field: a newer begin ends every field whose commit was not sent.
    r.begin({ fieldId: 2, version: v, runIds: [] }, 6);
    r.begin({ fieldId: 3, version: v, runIds: [] }, 7);
    expect(dropped).toEqual([2]);
    expect(r.size).toBe(1);
    // Main's own request marks the open field.
    expect(r.request(100)?.id).toBe(3);
    expect(r.peek(3)!.requestedUntil).toBe(100);
    // Leaving Edit keeps only the field open then, with main's request on it.
    r.begin({ fieldId: 4, version: v, runIds: [] }, 8);
    r.leftEdit(200);
    expect(r.peek(4)).toMatchObject({ requestedUntil: 200, expiresAt: 200 });
    r.noneOpen();
    expect(dropped).toEqual([2, 3, 4]);
    r.begin({ fieldId: 5, version: v, runIds: [] }, 9);
    r.clear();
    expect(r.size).toBe(0);
    expect(dropped).toEqual([2, 3, 4, 5]);
  });
});

describe('gateCommit (P2-7)', () => {
  const v = 'b'.repeat(64);
  const field: FieldRecord = { id: 3, version: v, runIds: new Set(['h:bl-2:0']), openedAt: 0, pinned: false, requestedUntil: Number.NEGATIVE_INFINITY, expiresAt: Number.POSITIVE_INFINITY };
  const commit = (over: Partial<EditCommit> = {}): EditCommit => ({
    fieldId: 3,
    version: v,
    result: { kind: 'edit', runId: 'h:bl-2:0', beforeText: 'a', afterText: 'b' },
    target: { css: 'h1', text: 'a', role: 'heading', stamp: 'bl-2' },
    slide: null,
    alsoPlaces: 0,
    ...over,
  });
  const ok = { mode: 'edit' as const, capEdit: true, editable: true, now: 1000, idle: false };

  it('takes the commit of a field main accepted, for its version and one of its runs', () => {
    expect(gateCommit(commit(), field, ok)).toEqual({ ok: true, field });
  });

  it("drops without a word what is not the preload's own field (a forgery)", () => {
    expect(gateCommit(commit(), null, ok)).toMatchObject({ ok: false, reply: false });
    expect(gateCommit(commit({ version: 'c'.repeat(64) }), field, ok)).toMatchObject({ ok: false, reply: false });
    expect(gateCommit(commit({ result: { kind: 'edit', runId: 'h:bl-9:0', beforeText: 'a', afterText: 'b' } }), field, ok)).toMatchObject({ ok: false, reply: false });
  });

  it('outside Edit, or after 10 minutes without trusted input, a commit main did not ask for is dropped without a word (E-4)', () => {
    expect(gateCommit(commit(), field, { ...ok, mode: 'review' })).toMatchObject({ ok: false, reply: false });
    expect(gateCommit(commit(), field, { ...ok, idle: true })).toMatchObject({ ok: false, reply: false });
    // main's request ended before this commit came.
    expect(gateCommit(commit(), { ...field, requestedUntil: 999 }, { ...ok, mode: 'read' })).toMatchObject({ ok: false, reply: false, ended: true });
    // A field open when Edit was left: its authorisation ended with the request, in Edit too.
    expect(gateCommit(commit(), { ...field, requestedUntil: 999, expiresAt: 999 }, ok)).toMatchObject({ ok: false, reply: false, ended: true });
  });

  it('the capability off is told to the field; a file that cannot be edited now keeps the text as a note (E-2)', () => {
    expect(gateCommit(commit(), field, { ...ok, capEdit: false })).toMatchObject({ ok: false, reply: true });
    expect((gateCommit(commit(), field, { ...ok, capEdit: false }) as { keep?: unknown }).keep).toBeUndefined();
    expect(gateCommit(commit(), field, { ...ok, editable: false })).toMatchObject({ ok: false, reply: true, keep: field });
  });

  it('a commit main asked for (the deck left Edit, the window closes) is taken within the request\'s window (E-2, E-4)', () => {
    const asked = { ...field, requestedUntil: 2000 };
    expect(gateCommit(commit(), asked, { ...ok, mode: 'read' })).toMatchObject({ ok: true });
    expect(gateCommit(commit(), asked, { ...ok, idle: true })).toMatchObject({ ok: true });
    expect(gateCommit(commit(), asked, { ...ok, mode: 'read', editable: false })).toMatchObject({ ok: false, reply: true, keep: asked });
  });

  it('a verbatim or noop commit is held to the same field rules (it makes a note)', () => {
    const verbatim = commit({ result: { kind: 'verbatim', before: 'a', after: 'b', why: 'across-runs' } });
    expect(gateCommit(verbatim, null, ok)).toMatchObject({ ok: false, reply: false });
    expect(gateCommit(verbatim, field, ok)).toMatchObject({ ok: true });
    expect(gateCommit(commit({ result: { kind: 'noop' } }), field, { ...ok, mode: 'read' })).toMatchObject({ ok: false });
  });
});

// ------------------------------------------------------------------------------------------- maps and runs

const DECK = [
  '<!doctype html><html><head><title>T</title></head><body>',
  '<h1 id="t">Quarterly <b>revenue</b> report</h1>',
  '<p>Second line here</p>',
  '<script>const s = {"intro": "Hello world", "intro2": "Hello world"}; const k = { title: 1 }; const u = "title"; const tpl = `a ${1} b`;</script>',
  '</body></html>',
].join('\n');

describe('findRun, strategyOf, sourceBefore, undoPatch', () => {
  const map = mapOf(DECK);
  it('finds html-text runs and literals with their ranges and lines', () => {
    const h1 = map.runs.find((r) => r.value === 'Quarterly ')!;
    expect(findRun(map, h1.id)).toMatchObject({ strategy: 'html-text', start: h1.start, end: h1.end, line: 2, value: 'Quarterly ', literal: false });
    const lit = map.literals.find((l) => l.value === 'title')!;
    expect(findRun(map, lit.id)).toMatchObject({ strategy: 'script-literal', literal: true, value: 'title' });
    expect(findRun(map, 'h:bl-999:0')).toBeNull();
    expect(strategyOf('h:bl-1:0')).toBe('html-text');
    expect(strategyOf('l:9:9')).toBe('script-literal');
    expect(strategyOf(lit.id, map)).toBe('script-literal');
  });

  it('sourceBefore rebuilds what a write replaced (P2-4: the source whose sha256 is basedOn)', () => {
    const before = 'abc HELLO def';
    const rec = { start: 4, rawBefore: 'HELLO', rawAfter: 'Hi' };
    const after = before.slice(0, 4) + 'Hi' + before.slice(9);
    expect(sourceBefore(after, rec)).toBe(before);
    expect(sourceBefore('abXc', { start: 2, rawBefore: '', rawAfter: 'X' })).toBe('abc');
  });

  it('undoPatch names the html-text run that holds the whole splice, else null (the page reloads)', () => {
    const r = map.runs.find((x) => x.value === 'Second line here')!;
    const p = undoPatch(map, { start: r.start + 2, rawAfter: 'con' });
    expect(p).toMatchObject({ stamp: r.stamp, textIndex: r.textIndex, text: 'Second line here' });
    const lit = map.literals.find((l) => l.value === 'title')!;
    expect(undoPatch(map, { start: lit.start, rawAfter: 'ti' })).toBeNull();
  });
});

describe('pickerCandidates (P2-8)', () => {
  const map = mapOf(DECK);
  const src = DECK;
  it('±40 characters of source context on one line, the line, and the key warning for a literal used as a key', () => {
    const hello = map.literals.filter((l) => l.value === 'Hello world');
    expect(hello.length).toBe(2);
    const c = pickerCandidates(map, src, hello.map((l) => l.id), 'deck.html');
    expect(c.map((x) => x.runId)).toEqual(hello.map((l) => l.id));
    for (const x of c) {
      expect(x.line).toBe(4);
      expect(x.context).toContain('Hello world');
      expect(x.context.length).toBeLessThanOrEqual(2 * 40 + 'Hello world'.length + 2);
      expect(x.context).not.toMatch(/[\r\n\t]/);
      expect(x.keyWarning).toBeUndefined();
    }
    const title = map.literals.find((l) => l.value === 'title')!;
    const [t] = pickerCandidates(map, src, [title.id], 'deck.html');
    expect(t.keyWarning).toMatch(/^This text is also used as a key at deck\.html:4$/);
  });

  it('leaves out runs the version does not have, cannot be written (placeholder) and repeats; at most 50', () => {
    const tpl = map.literals.find((l) => l.placeholder);
    const ids = ['h:bl-999:0', 'l:999:0', ...(tpl ? [tpl.id] : []), map.runs[0].id, map.runs[0].id];
    expect(pickerCandidates(map, src, ids, 'deck.html').map((c) => c.runId)).toEqual([map.runs[0].id]);
    const many = Array.from({ length: 80 }, () => map.runs[0].id);
    expect(pickerCandidates(map, src, many, 'deck.html')).toHaveLength(1);
  });

  it('the context never reaches into the notes block (the page is never served it)', () => {
    const secret = 'SECRET-NOTE-TEXT';
    const withBlock = `<!doctype html><html><body><p>Tail text</p><script type="application/vnd.blueline+json" id="blueline-notes" data-version="1">{"x":"${secret}"}</script></body></html>`;
    const m = mapOf(withBlock);
    expect(m.notesBlock).not.toBeNull();
    const run = m.runs.find((r) => r.value === 'Tail text')!;
    const [c] = pickerCandidates(m, withBlock, [run.id], 'deck.html');
    expect(c.context).toContain('Tail text');
    expect(c.context).not.toContain('SECRET');
    expect(c.context).not.toContain('blueline-notes');
  });
});

// ------------------------------------------------------------------------------------------- notes, history

function note(over: Partial<Note>): Note {
  return {
    id: 'n-0001',
    kind: 'edit',
    status: 'done',
    author: 'me-abcd',
    createdAt: '2026-10-19T10:00:00.000Z',
    updatedAt: '2026-10-19T10:00:00.000Z',
    pass: 1,
    slide: { index: 2, id: null, title: null, nav: { kind: 'index', value: 2 } },
    targets: [
      {
        ref: 't1',
        selectors: [],
        box: { x: 0, y: 0, w: 1, h: 1 },
        role: 'heading',
        source: { file: 'deck.html', version: 'a'.repeat(64), start: 1, end: 5, line: 42, col: 3, strategy: 'html-text', confidence: 'exact' },
      },
    ],
    marks: [],
    text: '',
    verbatim: { before: 'Old words', after: 'New words' },
    recordings: [],
    thread: [],
    summary: 'Edited: Old words → New words',
    ...over,
  };
}

describe('shellNotes and noteCopyText (P2-13)', () => {
  it('lists status, before → after, slide, line and a violated lock', () => {
    const locked: LockedSpan[] = [
      { start: 1, end: 5, text: 'x', noteId: 'n-0001', state: 'ok' },
      { start: 9, end: 12, text: 'y', noteId: 'n-0001', state: 'violated', change: { before: 'y', after: 'z' } },
    ];
    const [n] = shellNotes([note({})], locked, 500);
    expect(n).toMatchObject({ id: 'n-0001', status: 'done', kind: 'edit', before: 'Old words', after: 'New words', slide: 2, line: 42, locked: 'violated' });
    const [m] = shellNotes([note({ id: 'n-0002', kind: 'markup', status: 'open', verbatim: undefined, targets: [], text: 'x'.repeat(900), summary: undefined })], [], 500);
    expect(m).toMatchObject({ slide: 2, line: null, locked: null });
    expect(m.text.length).toBe(500);
    expect(m.before).toBeUndefined();
  });

  it('Copy holds the exact texts, whole', () => {
    const long = 'é'.repeat(800);
    const t = noteCopyText(note({ kind: 'verbatim', status: 'open', verbatim: { before: long, after: 'B' }, summary: 'Not written: the deck changed meanwhile' }), 'deck.html');
    expect(t.split('\n')[0]).toBe('n-0001 · verbatim · open · deck.html:42 · slide 3');
    expect(t).toContain(`Before: ${long}`);
    expect(t).toContain('After: B');
    expect(t).toContain('Not written: the deck changed meanwhile');
    expect(noteCopyText(note({ kind: 'markup', verbatim: undefined, targets: [], slide: { index: null, id: null, title: null, nav: { kind: 'none', value: 0 } }, text: 'start the axis at zero' }), 'd.html')).toBe(
      'n-0001 · markup · done · d.html\nEdited: Old words → New words\nstart the axis at zero',
    );
  });
});

describe('the history list and Restore (P2-11)', () => {
  it('lists entries as the store gives them, with whether Restore is possible', () => {
    const h = shellHistory([{ id: 'h-2', sha256: 'a'.repeat(64), contentHash: 'a'.repeat(64), cause: 'edit', at: '2026-10-19T10:00:00.000Z', size: 10, noteId: 'n-0001' }], false, 'why');
    expect(h).toEqual({ entries: [{ id: 'h-2', at: '2026-10-19T10:00:00.000Z', cause: 'edit', size: 10 }], canRestore: false, reason: 'why' });
  });

  it('lineDiff shows the lines that go and come back, shortened, at most N', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
    const d = lineDiff('<h1>New title</h1>\n<p>same</p>\n', '<h1>Old title</h1>\n<p>same</p>\n');
    expect(d).toEqual(['− <h1>New title</h1>', '+ <h1>Old title</h1>']);
    const many = lineDiff(Array.from({ length: 40 }, (_, i) => `x${i}`).join('\n'), Array.from({ length: 40 }, (_, i) => `y${i}`).join('\n'), 5);
    expect(many).toHaveLength(6);
    expect(many[5]).toMatch(/^… and 75 more lines$/);
    expect(lineDiff('a\n' + 'z'.repeat(500) + '\n', 'a\n')[0].length).toBeLessThanOrEqual(122);
  });

  it('restorePlan says what it discards and shows the diff', () => {
    const p = restorePlan({ fileName: 'deck.html', time: '14:03', counts: { direct: 3, external: 1 }, diff: ['− a', '+ b'] });
    expect(p.message).toBe('Restore deck.html to 14:03?');
    expect(p.detail).toContain('3 direct edits and 1 change made outside Blueline');
    expect(p.detail).toContain('− a\n+ b');
    expect(restorePlan({ fileName: 'd', time: 't', counts: { direct: 1, external: 0 }, diff: [] }).detail).toContain('1 direct edit since');
  });
});

describe('texts', () => {
  it('every verbatim reason and refusal code has a sentence', () => {
    for (const w of VERBATIM_WHYS) expect(verbatimWhyText(w).length).toBeGreaterThan(5);
    for (const c of REFUSAL_CODES) expect(refusalText(c).length).toBeGreaterThan(5);
    expect(CANT_UNDO).toBe("Can't undo in place: the deck changed since this edit");
  });
});

// ------------------------------------------------------------------------------------------- toasts, lanes

describe('ToastBook (P2-14)', () => {
  it('a button acts once, only for the toast shown last, and only with its own action', () => {
    let n = 0;
    const book = new ToastBook(() => (++n).toString(16).padStart(32, '0'));
    let made = 0;
    const t = book.show({ text: CANT_UNDO, kind: 'warn', actions: [{ id: 'make-note', label: 'Make a note', run: () => made++ }] });
    expect(t).toEqual({ text: CANT_UNDO, kind: 'warn', token: '1'.padStart(32, '0'), actions: [{ id: 'make-note', label: 'Make a note' }] });
    expect(book.take(t.token!, 'other')).toBeNull();
    expect(book.take('f'.repeat(32), 'make-note')).toBeNull();
    book.take(t.token!, 'make-note')!();
    expect(made).toBe(1);
    expect(book.take(t.token!, 'make-note')).toBeNull();
    const t2 = book.show({ text: 'x', kind: 'warn', actions: [{ id: 'make-note', label: 'Make a note', run: () => made++ }] });
    expect(book.show({ text: 'Copied', kind: 'info' })).toEqual({ text: 'Copied', kind: 'info' });
    expect(book.take(t2.token!, 'make-note')).toBeNull();
    expect(made).toBe(1);
  });
});

describe('SerialLane and VersionCache (P2-3)', () => {
  it('runs jobs one at a time in order, a failure does not stop the next, and idle waits for jobs queued meanwhile', async () => {
    const lane = new SerialLane();
    const seen: string[] = [];
    const slow = (name: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => (seen.push(name), r()), ms));
    const a = lane.run(slow('a', 30));
    const b = lane.run(async () => {
      seen.push('b');
      throw new Error('b');
    });
    const c = lane.run(slow('c', 1));
    expect(lane.busy).toBe(true);
    await expect(b).rejects.toThrow('b');
    await Promise.all([a, c]);
    expect(seen).toEqual(['a', 'b', 'c']);
    const d = lane.run(async () => {
      void lane.run(slow('e', 5));
      seen.push('d');
    });
    await d;
    await lane.idle();
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(lane.busy).toBe(false);
  });

  it('keeps the newest versions', () => {
    const c = new VersionCache(2);
    const m = mapOf('<p>a</p>');
    c.put('1', 'a', m);
    c.put('2', 'b', m);
    c.get('1');
    c.put('3', 'c', m);
    expect(c.get('1')).toBeNull();
    expect(c.get('2')?.src).toBe('b');
    expect(c.get('3')?.src).toBe('c');
  });
});

// ------------------------------------------------------------------------------------------- the session refuses

/** An editor whose queue fails the test when any operation reaches it (P2-7: refusals happen before the queue). */
function tripwireEditor(hits: string[]): EditorModule {
  const trip = (op: string) => () => {
    hits.push(op);
    throw new Error(`the queue was reached: ${op}`);
  };
  return {
    editorVersion: 'tripwire',
    createWriteQueue: () =>
      ({
        edit: trip('edit'),
        undo: trip('undo'),
        redo: trip('redo'),
        restore: trip('restore'),
        know: () => undefined,
        currentMap: trip('currentMap'),
        refresh: trip('refresh'),
      }) as unknown as WriteQueue,
  };
}

function rig(o: { mode?: 'read' | 'review' | 'edit'; trust?: 'trusted' | 'protected'; capEdit?: boolean } = {}) {
  const src = DECK;
  const bytes = enc(src);
  const doc = new BlDocument({
    docId: 'abcdef0123456789',
    path: '/nowhere/deck.html',
    realpath: '/nowhere/deck.html',
    bytes,
    trust: { trust: o.trust ?? 'trusted', reason: o.trust === 'protected' ? 'Came from the internet' : null, marker: null },
    received: false,
  });
  const session = emptySession({ path: doc.path, realpath: doc.realpath, fileKey: doc.fileKey, sha256: doc.contentHash, title: doc.title });
  const notes = new NotesStore(session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => doc.version, slides: () => null });
  const hits: string[] = [];
  const lane = new EditLane(doc.realpath, { editor: tripwireEditor(hits), capEdit: () => o.capEdit !== false, history: () => null, log: () => undefined });
  const sent: { channel: string; payload: unknown }[] = [];
  const toasts: ToastSpec[] = [];
  let saves = 0;
  let mode = o.mode ?? 'edit';
  let t = 10_000;
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: o.capEdit !== false, agent: o.capEdit !== false },
    notes,
    session: { session, known: () => null, noteVersion: () => undefined },
    reload: { showing: doc.version, noteOwnWrite: () => undefined, requestReload: () => undefined, setWriting: () => undefined, setEditBusy: () => undefined },
    mode: () => mode,
    sendDeck: (channel, payload) => sent.push({ channel, payload }),
    toast: (x) => toasts.push(x),
    save: () => saves++,
    notesChanged: () => undefined,
    adopted: () => undefined,
    taken: () => undefined,
    clipboard: () => undefined,
    confirm: async () => true,
    log: () => undefined,
    now: () => t,
  };
  const s = new EditSession(deps);
  const map = doc.map;
  const run = map.runs.find((r) => r.value === 'Second line here')!;
  return {
    s,
    doc,
    notes,
    hits,
    sent,
    toasts,
    saves: () => saves,
    run,
    setMode: (m: 'read' | 'review' | 'edit') => (mode = m),
    tick: (ms: number) => (t += ms),
    commit: (fieldId: number, over: Partial<EditCommit> = {}): EditCommit => ({
      fieldId,
      version: doc.version,
      result: { kind: 'edit', runId: run.id, beforeText: 'Second line here', afterText: 'Second line there' },
      target: { css: 'p', text: 'Second line here', role: 'paragraph', stamp: run.stamp },
      slide: null,
      alsoPlaces: 0,
      ...over,
    }),
  };
}

describe('EditSession refuses before the queue (P2-7)', () => {
  it('a commit with no field begun with trusted input writes nothing, makes no note, saves nothing, answers nothing', async () => {
    const r = rig();
    // A page that sends begin and commit without any trusted press.
    r.s.onBegin({ fieldId: 1, version: r.doc.version, runIds: [r.run.id] });
    await r.s.onCommit(r.commit(1));
    await r.s.onCommit(r.commit(2, { result: { kind: 'verbatim', before: 'a', after: 'b', why: 'across-runs' } }));
    expect(r.hits).toEqual([]);
    expect(r.notes.notes).toHaveLength(0);
    expect(r.saves()).toBe(0);
    expect(r.sent).toEqual([]);
  });

  it('a field begun outside Edit, in Protected view without Enable editing, or without the capability is not taken', async () => {
    for (const o of [{ mode: 'review' as const }, { trust: 'protected' as const }, { capEdit: false }]) {
      const r = rig(o);
      r.s.onInput('mouseDown');
      r.s.onBegin({ fieldId: 1, version: r.doc.version, runIds: [r.run.id] });
      r.setMode('edit');
      await r.s.onCommit(r.commit(1));
      expect(r.hits).toEqual([]);
      expect(r.notes.notes).toHaveLength(0);
      expect(r.sent).toEqual([]);
    }
  });

  it('a press too long ago, or one another field took, opens nothing', async () => {
    const r = rig();
    r.s.onInput('mouseDown');
    r.tick(BEGIN_WINDOW_MS + 1);
    r.s.onBegin({ fieldId: 1, version: r.doc.version, runIds: [r.run.id] });
    r.s.onInput('mouseDown');
    r.s.onBegin({ fieldId: 2, version: r.doc.version, runIds: [r.run.id] });
    r.s.onBegin({ fieldId: 3, version: r.doc.version, runIds: [r.run.id] });
    await r.s.onCommit(r.commit(1, { result: { kind: 'verbatim', before: 'a', after: 'b', why: 'across-runs' } }));
    await r.s.onCommit(r.commit(3, { result: { kind: 'verbatim', before: 'a', after: 'b', why: 'across-runs' } }));
    expect(r.notes.notes).toHaveLength(0);
    // Field 2 is the press's: its verbatim commit makes the note.
    await r.s.onCommit(r.commit(2, { result: { kind: 'verbatim', before: 'a', after: 'b', why: 'across-runs' } }));
    expect(r.notes.notes.map((n) => n.kind)).toEqual(['verbatim']);
    expect(r.hits).toEqual([]);
  });

  it('a commit for another version or a run its field does not hold is dropped, and so is one outside Edit that main did not ask for', async () => {
    const r = rig();
    r.s.onInput('mouseDown');
    r.s.onBegin({ fieldId: 1, version: r.doc.version, runIds: [r.run.id] });
    await r.s.onCommit(r.commit(1, { version: 'f'.repeat(64) }));
    await r.s.onCommit(r.commit(1, { result: { kind: 'edit', runId: r.doc.map.runs[0].id, beforeText: 'x', afterText: 'y' } }));
    expect(r.sent).toEqual([]);
    // Edit turned off without main asking for this field's commit (no mode change through onModeChange): it is not
    // the user's commit, so it is dropped without a word (E-4).
    r.setMode('read');
    await r.s.onCommit(r.commit(1));
    expect(r.sent).toEqual([]);
    expect(r.hits).toEqual([]);
    expect(r.notes.notes).toHaveLength(0);
  });

  it("the toast's Undo names a token: unknown tokens, no click, or outside Edit do nothing", () => {
    const r = rig();
    r.s.onUndoToken({ token: '0'.repeat(32) });
    r.s.onInput('mouseDown');
    r.s.onUndoToken({ token: '0'.repeat(32) });
    r.setMode('review');
    r.s.onUndoToken({ token: '0'.repeat(32) });
    expect(r.hits).toEqual([]);
    expect(r.toasts).toEqual([]);
  });

  it("candidates: answered in Edit after a press, from the field's version only; nothing otherwise", () => {
    const r = rig();
    r.s.onCandidates({ fieldId: 7, version: r.doc.version, runIds: [r.run.id] });
    expect(r.sent).toEqual([]);
    r.s.onInput('mouseDown');
    r.s.onCandidates({ fieldId: 7, version: r.doc.version, runIds: [r.run.id] });
    // The lane learns the open version when the window attaches; before that it knows none.
    expect(r.sent).toEqual([{ channel: 'bl:edit:candidates', payload: { fieldId: 7, candidates: [] } }]);
  });

  it('app undo with nothing to undo says so and writes nothing', async () => {
    const r = rig();
    await r.s.appUndo('undo');
    await r.s.appUndo('redo');
    expect(r.toasts.map((t) => t.text)).toEqual([NOTHING_TO_UNDO, NOTHING_TO_REDO]);
    const ro = rig({ capEdit: false });
    await ro.s.appUndo('undo');
    expect(ro.toasts.map((t) => t.text)).toEqual([NOTHING_TO_UNDO]);
    expect(r.hits).toEqual([]);
  });
});

describe('commit requests before close and quit (E-2)', () => {
  it('a build without the Edit capability never waits: nothing is held and nothing is asked of the deck', async () => {
    const r = rig({ capEdit: false });
    r.s.onBusy({ edit: true, committing: true });
    expect(r.s.holdsTyping).toBe(false);
    const t0 = Date.now();
    expect(await r.s.requestCommit(5_000)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.sent.map((x) => x.channel)).toEqual([]);
  });

  it('control: with the capability, an open field is held, the deck is asked to commit, and a deck that never answers is given up on', async () => {
    const r = rig();
    r.s.onBusy({ edit: true, committing: false });
    expect(r.s.holdsTyping).toBe(true);
    expect(await r.s.requestCommit(30)).toBe(false);
    expect(r.sent.map((x) => x.channel)).toEqual(['bl:edit:commit-now']);
    // The deck closes its field: nothing is held any more, and a new request resolves at once.
    r.s.onBusy({ edit: false, committing: false });
    expect(r.s.holdsTyping).toBe(false);
    expect(await r.s.requestCommit(5_000)).toBe(true);
  });
});
