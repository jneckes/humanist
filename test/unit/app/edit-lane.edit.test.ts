// Edit in main through the real write queue (Phase 2; edit-session.ts with packages/editor's createWriteQueue, the
// app's BlDocument and its DeckIO on real files, and a real HistoryStore). Named *.edit.test.ts: the reader-only
// suite leaves it out (it needs the editor).
//
//   - a typed edit: the file holds exactly the run's new bytes, the document adopts them (P2-2: version, map,
//     knownHash), the new map reaches the window before the result (9.2 step 6), an edit note with its lock, an undo
//     token, a history snapshot of the bytes replaced (P2-11);
//   - app undo and redo (P2-10): bytes restored exactly, the note deleted and a new one made, the page patched;
//     case 3 offers Make a note, which keeps the stored texts as a verbatim note;
//   - an external change the write absorbed (P2-4): the locks moved from the content main knew to what the queue
//     read, the external snapshot first, a reload; and a stale take of that change is dropped (P2-3);
//   - external takes: locks transformed (section 8), never a version back; takes and own writes serialized;
//   - the picker's candidates and a picked substring (P2-8); Restore deck to <time> (P2-11); the locks of a deck that
//     changed while no window showed it (P2-12).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWriteQueue, editorVersion } from '@blueline/editor';
import type { EditorModule } from '@blueline/core/capabilities';
import type { EditApplied, EditCandidatesReply, EditCommit, EditResult } from '@blueline/core/ipc-edit';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { BlDocument } from '../../../packages/app/src/main/documents';
import { CANT_UNDO, EditLane, EditSession, type Adopted, type EditSessionDeps, type Taken, type ToastSpec } from '../../../packages/app/src/main/edit-session';
import { HistoryStore } from '../../../packages/app/src/main/history';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';

const editor: EditorModule = { editorVersion, createWriteQueue };
const enc = (s: string) => new TextEncoder().encode(s);
let root: string;
let n = 0;
beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-edit-lane-')));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// The filler keeps the changes some tests make away from the edited runs: a stale edit is written only where the
// text on both sides of it is unchanged (packages/editor/src/anchors.ts, E-1).
// It stays on the lines it follows, so the runs keep their line numbers.
const filler = (k: string) => Array.from({ length: 4 }, (_, i) => `<p>Filler ${k} line ${i}: words that stay as they are.</p>`).join('');
const DECK = [
  '<!doctype html>',
  '<html><head><title>Plan</title></head><body>',
  `<h1>Research &amp; Development</h1>${filler('a')}`,
  '<p>Second line here</p>',
  `<p>Third line stays</p>${filler('b')}`,
  '<ul><li>alpha beta gamma delta</li><li>alpha beta gamma delta</li></ul>',
  '</body></html>',
  '',
].join('\n');

interface Rig {
  file: string;
  doc: BlDocument;
  s: EditSession;
  lane: EditLane;
  notes: NotesStore;
  session: ReturnType<typeof emptySession>;
  history: HistoryStore;
  events: string[];
  sent: { channel: string; payload: unknown }[];
  toasts: ToastSpec[];
  adopted: Adopted[];
  taken: Taken[];
  known: { version: string } | null;
  reload: { showing: string; requested: string[] };
  setMode(m: 'read' | 'review' | 'edit'): void;
  confirm: boolean;
  /** A commit of `runText`'s run, as the overlay sends it after a trusted press. */
  type(runText: string, after: string, o?: Partial<EditCommit>): Promise<EditResult>;
  /** Another program saves the file. */
  external(src: string): Uint8Array;
}

async function rig(src = DECK, o: { known?: { version: string } | null; locked?: ReturnType<typeof emptySession>['locked']; history?: HistoryStore } = {}): Promise<Rig> {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, src);
  const bytes = new Uint8Array(fs.readFileSync(file));
  const doc = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes, trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const session = emptySession({ path: file, realpath: file, fileKey: doc.fileKey, sha256: doc.contentHash, title: doc.title });
  if (o.locked) session.locked.push(...o.locked);
  const notes = new NotesStore(session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => doc.version, slides: () => null });
  const history = o.history ?? HistoryStore.at(path.join(dir, 'history'), { realpath: file });
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => history, log: () => undefined });
  const r = {} as Rig;
  let mode: 'read' | 'review' | 'edit' = 'edit';
  const reload = { showing: doc.version, requested: [] as string[] };
  Object.assign(r, { file, doc, lane, notes, session, history, events: [], sent: [], toasts: [], adopted: [], taken: [], known: o.known ?? null, reload, confirm: true });
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: true, agent: true },
    notes,
    session: {
      session,
      known: () => r.known,
      noteVersion: (v) => {
        r.known = { version: v.version };
      },
    },
    reload: {
      get showing() {
        return reload.showing;
      },
      noteOwnWrite: (x) => {
        if (!x.reload && reload.showing === x.basedOn) reload.showing = x.version;
        else reload.requested.push(x.version);
      },
      requestReload: (v) => {
        reload.requested.push(v);
      },
      setWriting: () => undefined,
      setEditBusy: () => undefined,
    },
    mode: () => mode,
    sendDeck: (channel, payload) => {
      r.sent.push({ channel, payload });
      r.events.push(channel);
    },
    toast: (t) => r.toasts.push(t),
    save: () => r.events.push('save'),
    notesChanged: () => undefined,
    adopted: (e) => {
      r.adopted.push(e);
      r.events.push('adopted');
      // The window's rule (window.ts onOwnWrite).
      const reloadIt = e.kind === 'edit' ? e.absorbed || e.strategy !== 'html-text' : e.kind === 'restore' ? true : e.absorbed || e.patch === null;
      deps.reload.noteOwnWrite({ basedOn: e.basedOn, version: e.version, reload: reloadIt });
    },
    taken: (e) => {
      r.taken.push(e);
      r.events.push('taken');
    },
    clipboard: () => undefined,
    confirm: async () => r.confirm,
    log: () => undefined,
  };
  const s = new EditSession(deps);
  r.s = s;
  r.setMode = (m) => (mode = m);
  let fieldId = 1;
  r.type = async (runText, after, over = {}) => {
    const run = doc.map.runs.find((x) => x.value === runText);
    if (!run) throw new Error(`no run ${runText}`);
    const id = fieldId++;
    s.onInput('mouseDown');
    s.onBegin({ fieldId: id, version: over.version ?? doc.version, runIds: [run.id] });
    const before = r.sent.length;
    await s.onCommit({
      fieldId: id,
      version: doc.version,
      result: { kind: 'edit', runId: run.id, beforeText: runText, afterText: after },
      target: { css: run.tagName, text: runText, role: 'element', stamp: run.stamp },
      slide: 1,
      alsoPlaces: 0,
      ...over,
    });
    const res = r.sent.slice(before).find((x) => x.channel === 'bl:edit:result');
    if (!res) throw new Error('no result');
    return res.payload as EditResult;
  };
  r.external = (text) => {
    const tmp = path.join(dir, `.ext-${n++}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return new Uint8Array(fs.readFileSync(file));
  };
  await s.attach();
  return r;
}

const read = (file: string) => fs.readFileSync(file, 'utf8');

describe('a typed edit through the write queue', () => {
  it('writes exactly the run, adopts the bytes, pushes the map before the result, notes, locks and snapshots', async () => {
    const r = await rig();
    const v1 = r.doc.version;
    const res = await r.type('Second line here', 'Second line & more');
    const want = DECK.replace('<p>Second line here</p>', '<p>Second line &amp; more</p>');
    expect(read(r.file)).toBe(want);
    const v2 = sha256Hex(enc(want));
    expect(res).toMatchObject({ fieldId: 1, outcome: 'written', reload: false, text: 'Second line & more', line: 4, strategy: 'html-text', noteId: 'n-0001' });
    expect(res.token).toMatch(/^[0-9a-f]{32}$/);
    // P2-2: the document is the written version, without another read.
    expect(r.doc.version).toBe(v2);
    expect(r.doc.knownHash).toBe(v2);
    expect(r.doc.map.runs.some((x) => x.value === 'Second line & more')).toBe(true);
    expect(new TextDecoder().decode((await r.doc.documentBody()).body)).toContain('Second line &amp; more');
    // 9.2 step 6: the map (the window's adopted) before the result.
    expect(r.events.indexOf('adopted')).toBeLessThan(r.events.indexOf('bl:edit:result'));
    expect(r.adopted[0]).toMatchObject({ kind: 'edit', basedOn: v1, previous: v1, absorbed: false, version: v2, strategy: 'html-text' });
    // The page showed v1 and typed the change: it shows v2 now without a reload.
    expect(r.reload.showing).toBe(v2);
    // 6.6 Edit notes: done, verbatim before/after, the summary, the SourceLoc; section 8: its lock, raw.
    const note = r.notes.find('n-0001')!;
    expect(note).toMatchObject({ kind: 'edit', status: 'done', verbatim: { before: 'Second line here', after: 'Second line & more' }, summary: 'Edited: Second line here → Second line & more' });
    expect(note.targets[0].source).toMatchObject({ version: v2, line: 4, strategy: 'html-text', confidence: 'exact' });
    expect(r.session.locked).toEqual([{ start: want.indexOf('Second line &amp; more'), end: want.indexOf('Second line &amp; more') + 'Second line &amp; more'.length, text: 'Second line &amp; more', noteId: 'n-0001', state: 'ok' }]);
    // P2-11: the bytes replaced, before the write; P2-12: known follows.
    const h = r.history.list();
    expect(h.map((e) => [e.cause, e.sha256])).toEqual([['edit', v1]]);
    expect(Buffer.from(await r.history.read(h[0].id)).toString('utf8')).toBe(DECK);
    expect(r.known).toEqual({ version: v2 });
    expect(r.s.undo.size).toEqual({ undo: 1, redo: 0 });
  });

  it('a later edit shifts the earlier lock; a picked run is lifted; a noop answers noop with no note', async () => {
    const r = await rig();
    await r.type('Third line stays', 'Third line stays put');
    await r.type('Second line here', 'Second line, much longer now');
    const src = read(r.file);
    for (const l of r.session.locked) expect(src.slice(l.start, l.end)).toBe(l.text);
    expect(r.session.locked.map((l) => l.state)).toEqual(['ok', 'ok']);
    const noop = await r.type('Third line stays put', 'Third line stays put');
    expect(noop.outcome).toBe('noop');
    expect(r.notes.notes).toHaveLength(2);
  });
});

describe('app undo and redo (P2-10)', () => {
  it('restore the bytes exactly, delete the note, then make a new one; the page gets the run text', async () => {
    const r = await rig();
    await r.type('Research & Development', 'Research & Development 2026');
    const edited = read(r.file);
    expect(edited).toContain('<h1>Research &amp; Development 2026</h1>');
    await r.s.appUndo('undo');
    expect(read(r.file)).toBe(DECK);
    expect(r.notes.notes).toHaveLength(0);
    expect(r.session.tombstones).toEqual(['n-0001']);
    expect(r.session.locked).toEqual([]);
    const applied = r.sent.filter((x) => x.channel === 'bl:edit:applied').map((x) => x.payload as EditApplied);
    expect(applied[0]).toMatchObject({ text: 'Research & Development' });
    expect(r.toasts.at(-1)?.text).toBe('Undone · deck.html:3');
    await r.s.appUndo('redo');
    expect(read(r.file)).toBe(edited);
    expect(r.notes.notes.map((x) => [x.id, x.kind, x.verbatim?.after])).toEqual([['n-0002', 'edit', 'Research & Development 2026']]);
    expect(r.session.locked.map((l) => [l.noteId, l.text])).toEqual([['n-0002', 'Research &amp; Development 2026']]);
    expect(r.history.list().map((e) => e.cause)).toEqual(['redo', 'undo', 'edit']);
    expect(r.s.undo.size).toEqual({ undo: 1, redo: 0 });
  });

  it('case 3: the deck changed since, so Make a note keeps the stored texts; the toast names a token', async () => {
    const r = await rig();
    await r.type('Second line here', 'Second line edited');
    const ext = read(r.file).replace('<p>Second line edited</p>', '<p>Rewritten by the agent</p>');
    const bytes = r.external(ext);
    r.doc.knownHash = sha256Hex(bytes);
    expect(await r.lane.takeExternal(r.s, bytes, sha256Hex(bytes))).toBe('taken');
    await r.s.appUndo('undo');
    expect(read(r.file)).toBe(ext);
    const t = r.toasts.at(-1)!;
    expect(t.text).toBe(CANT_UNDO);
    expect(t.actions?.map((a) => a.id)).toEqual(['make-note']);
    t.actions![0].run();
    const v = r.notes.notes.find((x) => x.kind === 'verbatim')!;
    expect(v.verbatim).toEqual({ before: 'Second line edited', after: 'Second line here' });
    expect(v.status).toBe('open');
    expect(r.s.undo.size).toEqual({ undo: 0, redo: 0 });
  });

  it("the toast's Undo acts only on the latest write, right after a click", async () => {
    const r = await rig();
    const a = await r.type('Second line here', 'Second line A');
    const b = await r.type('Third line stays', 'Third line B');
    r.s.onInput('mouseDown');
    r.s.onUndoToken({ token: a.token! });
    await r.lane.lane.idle();
    expect(read(r.file)).toContain('Second line A');
    expect(read(r.file)).toContain('Third line B');
    r.s.onInput('mouseDown');
    r.s.onUndoToken({ token: b.token! });
    await new Promise((res) => setTimeout(res, 20));
    await r.lane.lane.idle();
    expect(read(r.file)).toContain('Third line stays');
    expect(read(r.file)).toContain('Second line A');
  });
});

describe('external changes (9.2 Watcher; P2-3, P2-4; section 8)', () => {
  it('an edit made on the old version absorbs an unseen change: locks follow it, external snapshot first, reload', async () => {
    const r = await rig();
    await r.type('Third line stays', 'Third line locked');
    const v1 = r.doc.version;
    const lockBefore = r.session.locked[0];
    // Another program inserts a paragraph above; the watcher has not decided yet.
    const ext = read(r.file).replace('<h1>', '<p>Inserted above</p>\n<h1>');
    const extBytes = r.external(ext);
    const res = await r.type('Second line here', 'Second line merged', { version: v1 });
    expect(res).toMatchObject({ outcome: 'written', reload: true });
    const now = read(r.file);
    expect(now).toBe(ext.replace('<p>Second line here</p>', '<p>Second line merged</p>'));
    const a = r.adopted.at(-1)!;
    expect(a).toMatchObject({ absorbed: true, basedOn: sha256Hex(extBytes), previous: v1 });
    // Section 8: the lock moved by the inserted text (a diff), then by the own write above it (rule 6).
    const lock = r.session.locked.find((l) => l.noteId === lockBefore.noteId)!;
    expect(lock.state).toBe('ok');
    expect(lock.start).toBe(lockBefore.start + '<p>Inserted above</p>\n'.length + 'merged'.length - 'here'.length);
    expect(now.slice(lock.start, lock.end)).toBe(lock.text);
    // P2-11: what main knew (external), then what the queue read (edit).
    expect(r.history.list().map((e) => [e.cause, e.sha256])).toEqual([
      ['edit', sha256Hex(extBytes)],
      ['external', v1],
      ['edit', r.history.list()[2].sha256],
    ]);
    expect(r.reload.requested).toContain(r.doc.version);
    // The watcher now reports the change it saw: an own write already took it, so it is dropped (P2-3).
    expect(await r.lane.takeExternal(r.s, extBytes, sha256Hex(extBytes))).toBe('stale');
    expect(r.doc.version).toBe(sha256Hex(enc(now)));
  });

  it('a take moves the locks by diff: one the change touches is violated, one before it stays', async () => {
    const r = await rig();
    await r.type('Second line here', 'Second line mine');
    await r.type('Third line stays', 'Third line mine');
    const ext = read(r.file).replace('<p>Third line mine</p>', '<p>Third line theirs</p>');
    const bytes = r.external(ext);
    const v = sha256Hex(bytes);
    r.doc.knownHash = v; // as the watcher sets it when it reports the change
    expect(await r.lane.takeExternal(r.s, bytes, v)).toBe('taken');
    expect(r.doc.version).toBe(v);
    expect(r.taken).toEqual([{ previous: expect.any(String), version: v }]);
    const [second, third] = r.session.locked;
    expect(second).toMatchObject({ noteId: 'n-0001', state: 'ok' });
    expect(ext.slice(second.start, second.end)).toBe('Second line mine');
    expect(third).toMatchObject({ noteId: 'n-0002', state: 'violated', change: { before: 'Third line mine' } });
    expect(third.change!.after).toContain('theirs');
    await r.history.idle();
    expect(r.history.list()[0].cause).toBe('external');
  });

  it('never takes a version back, and serializes takes with own writes', async () => {
    const r = await rig();
    const ext2 = DECK.replace('Filler b line 3', 'Filler b line v2');
    const b2 = r.external(ext2);
    const ext3 = DECK.replace('Filler b line 3', 'Filler b line v3');
    const b3 = r.external(ext3);
    // The watcher saw v3 last: a late take of v2 is stale.
    r.doc.knownHash = sha256Hex(b3);
    expect(await r.lane.takeExternal(r.s, b2, sha256Hex(b2))).toBe('stale');
    const take = r.lane.takeExternal(r.s, b3, sha256Hex(b3));
    const edit = r.type('Second line here', 'Second line after');
    expect(await take).toBe('taken');
    const res = await edit;
    expect(res.outcome).toBe('written');
    expect(r.events.indexOf('taken')).toBeLessThan(r.events.indexOf('adopted'));
    expect(read(r.file)).toBe(ext3.replace('Second line here', 'Second line after'));
  });
});

describe('the picker (P2-8)', () => {
  it('answers candidates from the field version, and lifts a picked substring to its run', async () => {
    const r = await rig();
    const items = r.doc.map.runs.filter((x) => x.value === 'alpha beta gamma delta');
    expect(items).toHaveLength(2);
    r.s.onInput('mouseDown');
    r.s.onCandidates({ fieldId: 9, version: r.doc.version, runIds: items.map((x) => x.id) });
    const reply = r.sent.at(-1)!.payload as EditCandidatesReply;
    expect(reply.fieldId).toBe(9);
    expect(reply.candidates.map((c) => [c.runId, c.line])).toEqual(items.map((x) => [x.id, 6]));
    expect(reply.candidates[0].context).toContain('alpha beta gamma delta');
    // The author picked the second item for the node "beta gamma" (a substring), and typed in it.
    const run = items[1];
    r.s.onInput('mouseDown');
    r.s.onBegin({ fieldId: 10, version: r.doc.version, runIds: [run.id] });
    await r.s.onCommit({
      fieldId: 10,
      version: r.doc.version,
      result: { kind: 'edit', runId: run.id, beforeText: 'beta gamma', afterText: 'beta GAMMA' },
      pick: { kind: 'substring', nodeBefore: 'beta gamma', nodeAfter: 'beta GAMMA' },
      target: { css: 'li', text: 'beta gamma', role: 'list-item', stamp: run.stamp },
      slide: null,
      alsoPlaces: 0,
    });
    expect(read(r.file)).toContain('<li>alpha beta gamma delta</li><li>alpha beta GAMMA delta</li>');
    // A pick that cannot be lifted is a verbatim note with the node's texts; the file is untouched.
    const before = read(r.file);
    r.s.onInput('mouseDown');
    r.s.onBegin({ fieldId: 11, version: r.doc.version, runIds: [items[0].id] });
    await r.s.onCommit({
      fieldId: 11,
      version: r.doc.version,
      result: { kind: 'edit', runId: items[0].id, beforeText: 'not in the run', afterText: 'x' },
      pick: { kind: 'substring', nodeBefore: 'not in the run', nodeAfter: 'x' },
      target: { css: 'li', text: 'x', role: 'list-item', stamp: items[0].stamp },
      slide: null,
      alsoPlaces: 0,
    });
    expect(read(r.file)).toBe(before);
    expect(r.notes.notes.at(-1)).toMatchObject({ kind: 'verbatim', verbatim: { before: 'not in the run', after: 'x' } });
  });
});

describe('a picked run (P2-8, P2-10)', () => {
  it('reloads the page after the write and after its undo, wherever the run is; an exact edit\'s undo patches the node', async () => {
    const r = await rig();
    const items = r.doc.map.runs.filter((x) => x.value === 'alpha beta gamma delta');
    const commit = async (fieldId: number, runId: string, stamp: string | null, after: string) => {
      r.s.onInput('mouseDown');
      r.s.onBegin({ fieldId, version: r.doc.version, runIds: [runId] });
      await r.s.onCommit({
        fieldId,
        version: r.doc.version,
        result: { kind: 'edit', runId, beforeText: 'alpha beta gamma delta', afterText: after },
        pick: { kind: 'equal', nodeBefore: 'alpha beta gamma delta', nodeAfter: after },
        target: { css: 'li', text: 'alpha beta gamma delta', role: 'list-item', stamp },
        slide: null,
        alsoPlaces: 0,
      });
      return r.sent.filter((x) => x.channel === 'bl:edit:result').at(-1)!.payload as { outcome: string; reload: boolean };
    };
    // The author edited the first item's node and picked the second item's run: the file changes the second item.
    const elsewhere = await commit(20, items[1].id, items[0].stamp, 'alpha beta gamma delta!');
    expect(elsewhere).toMatchObject({ outcome: 'written', reload: true });
    expect(read(r.file)).toContain('<li>alpha beta gamma delta</li><li>alpha beta gamma delta!</li>');
    // Main reloads the page itself (the window counted an html-text write as shown).
    expect(r.reload.requested.at(-1)).toBe(r.doc.version);
    await r.s.appUndo('undo');
    expect(read(r.file)).toBe(DECK);
    expect(r.sent.filter((x) => x.channel === 'bl:edit:applied').at(-1)!.payload).toEqual({ reload: true });
    expect(r.reload.requested.at(-1)).toBe(r.doc.version);
    // Picked for the run of its own element: the node may still be one a script drew, so the same.
    const own = await commit(21, items[0].id, items[0].stamp, 'alpha beta gamma delta?');
    expect(own).toMatchObject({ outcome: 'written', reload: true });
    await r.s.appUndo('undo');
    expect(read(r.file)).toBe(DECK);
    expect(r.sent.filter((x) => x.channel === 'bl:edit:applied').at(-1)!.payload).toEqual({ reload: true });
    // An exact edit (no pick): the undo patches the run's own node.
    await r.type('Second line here', 'Second line there');
    await r.s.appUndo('undo');
    expect(r.sent.filter((x) => x.channel === 'bl:edit:applied').at(-1)!.payload).toMatchObject({ text: 'Second line here' });
  });
});

describe('Restore deck to <time> (P2-11)', () => {
  it('writes the snapshot byte for byte after a confirmation, through the queue, and moves the locks', async () => {
    const r = await rig();
    await r.type('Second line here', 'Second line one');
    await r.type('Third line stays', 'Third line two');
    const first = r.history.list().at(-1)!;
    expect(first.sha256).toBe(sha256Hex(enc(DECK)));
    r.confirm = false;
    await r.s.restore(first.id);
    expect(read(r.file)).not.toBe(DECK);
    r.confirm = true;
    await r.s.restore(first.id);
    expect(read(r.file)).toBe(DECK);
    expect(r.toasts.at(-1)?.text).toMatch(/^Restored deck\.html to /);
    expect(r.history.list()[0].cause).toBe('restore');
    expect(r.doc.version).toBe(sha256Hex(enc(DECK)));
    // The edits it discarded are flagged on their locks.
    expect(r.session.locked.every((l) => l.state === 'violated')).toBe(true);
    // Already that version.
    await r.s.restore(r.history.list().at(-1)!.id);
    expect(r.toasts.at(-1)?.text).toBe('deck.html already is that version');
  });
});

describe('locks across a restart (P2-12)', () => {
  it('are transformed from the base when the deck changed while closed, and flagged when its content is not kept', async () => {
    const dir = path.join(root, `base${n++}`);
    const history = HistoryStore.at(path.join(dir, 'history'), { realpath: path.join(dir, 'x.html') });
    const oldSrc = DECK.replace('Second line here', 'Second line locked');
    const oldBytes = enc(oldSrc);
    const oldVersion = sha256Hex(oldBytes);
    await history.setBase(oldBytes, { sha256: oldVersion, contentHash: oldVersion, at: '2026-10-19T10:00:00.000Z' });
    const start = oldSrc.indexOf('Second line locked');
    const lock = { start, end: start + 'Second line locked'.length, text: 'Second line locked', noteId: 'n-0001', state: 'ok' as const };
    // Since then, a line was added above, outside Blueline.
    const now = oldSrc.replace('<h1>', '<p>Added while closed</p>\n<h1>');
    const r = await rig(now, { known: { version: oldVersion }, locked: [lock], history });
    expect(r.session.locked[0]).toMatchObject({ state: 'ok', start: start + '<p>Added while closed</p>\n'.length, text: 'Second line locked' });
    expect(r.known).toEqual({ version: r.doc.version });
    const r2 = await rig(now, { known: { version: 'e'.repeat(64) }, locked: [lock] });
    expect(r2.session.locked[0]).toMatchObject({ state: 'violated', change: { before: 'Second line locked' } });
  });
});

describe('a closed window (finding 21; D-1 reopen, P2-3)', () => {
  it('the lane keeps no content once no window shows the file, and a window that shows it again writes through it', async () => {
    const r = await rig();
    expect(r.lane.versions.get(r.doc.version)).not.toBeNull();
    // The window closes: its session goes, then the lane is told nobody shows the file.
    r.s.dispose();
    await r.lane.forget();
    expect(r.lane.attached).toBeNull();
    expect(r.lane.versions.get(r.doc.version)).toBeNull();
    // A reopen's window attaches to the same lane: a new queue knows its version and the edit is written exactly.
    const notes = new NotesStore(r.session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => r.doc.version, slides: () => null });
    const sent: { channel: string; payload: unknown }[] = [];
    const s2 = new EditSession({
      doc: r.doc,
      lane: r.lane,
      capabilities: { edit: true, agent: true },
      notes,
      session: { session: r.session, known: () => null, noteVersion: () => undefined },
      reload: { showing: r.doc.version, noteOwnWrite: () => undefined, requestReload: () => undefined, setWriting: () => undefined, setEditBusy: () => undefined },
      mode: () => 'edit',
      sendDeck: (channel, payload) => sent.push({ channel, payload }),
      toast: () => undefined,
      save: () => undefined,
      notesChanged: () => undefined,
      adopted: () => undefined,
      taken: () => undefined,
      clipboard: () => undefined,
      confirm: async () => true,
      log: () => undefined,
    });
    await s2.attach();
    expect(r.lane.attached).toBe(s2);
    expect(r.lane.versions.get(r.doc.version)).not.toBeNull();
    const run = r.doc.map.runs.find((x) => x.value === 'Second line here')!;
    s2.onInput('mouseDown');
    s2.onBegin({ fieldId: 1, version: r.doc.version, runIds: [run.id] });
    await s2.onCommit({ fieldId: 1, version: r.doc.version, result: { kind: 'edit', runId: run.id, beforeText: 'Second line here', afterText: 'Second line now' }, target: { css: 'p', text: 'Second line here', role: 'paragraph', stamp: run.stamp }, slide: null, alsoPlaces: 0 });
    expect(read(r.file)).toBe(DECK.replace('Second line here', 'Second line now'));
    expect(sent.find((m) => m.channel === 'bl:edit:result')?.payload).toMatchObject({ outcome: 'written' });
  });
});
