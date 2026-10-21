// The last known content and the locks (lead decision E-7; review findings 17 and 18; P2-12, section 8 Locked
// spans), through main's real wiring: the editor's write queue, BlDocument, HistoryStore on disk, NotesStore,
// EditLane and EditSession, never calling setBase by hand. The content main knows advances after EVERY own write, in
// the lane, also for a write that lands after its window closed; it is persisted (session.json known, the history
// base) so a change made while the file is closed, or a reopen, moves the locks from the right content. A lock records
// the run's text and offsets in the version the write produced.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWriteQueue, editorVersion } from '@blueline/editor';
import type { EditorModule } from '@blueline/core/capabilities';
import type { EditResult } from '@blueline/core/ipc-edit';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { BlDocument } from '../../../packages/app/src/main/documents';
import { EditLane, EditSession, type EditSessionDeps } from '../../../packages/app/src/main/edit-session';
import { HistoryStore } from '../../../packages/app/src/main/history';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { emptySession, readSession, serializeSession } from '../../../packages/app/src/main/session-store';

const editor: EditorModule = { editorVersion, createWriteQueue };
type Sess = ReturnType<typeof emptySession>;

function window(file: string, history: HistoryStore, lane: EditLane, session: Sess, known: { version: string } | null) {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const doc = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes, trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const st = { known };
  const notes = new NotesStore(session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => doc.version, slides: () => null });
  const sent: { channel: string; payload: unknown }[] = [];
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: true, agent: true },
    notes,
    session: { session, known: () => st.known, noteVersion: (v) => (st.known = { version: v.version }) },
    reload: { showing: doc.version, noteOwnWrite: () => undefined, requestReload: () => undefined, setWriting: () => undefined, setEditBusy: () => undefined },
    mode: () => 'edit',
    sendDeck: (channel, payload) => void sent.push({ channel, payload }),
    toast: () => undefined,
    save: () => undefined,
    notesChanged: () => undefined,
    adopted: () => undefined,
    taken: () => undefined,
    clipboard: () => undefined,
    confirm: async () => true,
    log: () => undefined,
  };
  const s = new EditSession(deps);
  let fid = 1;
  const type = async (runText: string, after: string): Promise<EditResult | undefined> => {
    const run = doc.map.runs.find((x) => x.value === runText);
    if (!run) throw new Error(`no run ${runText}`);
    const id = fid++;
    s.onInput('mouseDown');
    s.onBegin({ fieldId: id, version: doc.version, runIds: [run.id] });
    const k = sent.length;
    await s.onCommit({ fieldId: id, version: doc.version, result: { kind: 'edit', runId: run.id, beforeText: runText, afterText: after }, target: { css: run.tagName, text: runText, role: 'element', stamp: run.stamp }, slide: 1, alsoPlaces: 0 });
    return sent.slice(k).find((x) => x.channel === 'bl:edit:result')?.payload as EditResult | undefined;
  };
  return { doc, s, st, notes, type, close: () => (s.dispose(), lane.detach(s), doc.release()) };
}

/** A relaunch: a new lane, history store and window from the persisted session.json. */
function relaunch(dir: string, file: string, session: Sess, known: { version: string } | null) {
  const json = JSON.parse(new TextDecoder().decode(serializeSession(session, known)));
  const probe = new BlDocument({ docId: 'abcdef0123456780', path: file, realpath: file, bytes: new Uint8Array(fs.readFileSync(file)), trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const rr = readSession(json, { path: file, realpath: file, fileKey: probe.fileKey, sha256: probe.contentHash, title: probe.title });
  const history = HistoryStore.at(path.join(dir, 'history'), { realpath: file });
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => history, log: () => undefined });
  return { w: window(file, history, lane, rr.session, rr.known), session: rr.session, lane, history };
}

const DECK = ['<!doctype html>', '<html><head><title>Plan</title></head><body>', '<p class="brand">Brand line</p>', '<h1>Analytics your whole team can read</h1>', '<p>Second line here</p>', '<p>Third line stays</p>', '</body></html>', ''].join('\n');

function fresh(src = DECK) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-known-')));
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, src);
  const history = HistoryStore.at(path.join(dir, 'history'), { realpath: file });
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => history, log: () => undefined });
  const doc0 = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes: new Uint8Array(fs.readFileSync(file)), trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const session = emptySession({ path: file, realpath: file, fileKey: doc0.fileKey, sha256: doc0.contentHash, title: doc0.title });
  return { dir, file, history, lane, session };
}

describe('the content main knew is kept after the first edit (finding 17)', () => {
  it('one edit, quit, a change far away while closed: the lock is ok and shifted', async () => {
    const f = fresh();
    const w = window(f.file, f.history, f.lane, f.session, null);
    await w.s.attach();
    expect((await w.type('Analytics your whole team can read', 'Analytics your whole team can use'))?.outcome).toBe('written');
    await f.lane.lane.idle();
    await f.history.idle();
    const disk = fs.readFileSync(f.file, 'utf8');
    expect(f.history.base()?.sha256).toBe(sha256Hex(new Uint8Array(fs.readFileSync(f.file))));
    expect(w.st.known?.version).toBe(f.history.base()?.sha256);
    const before = { ...f.session.locked[0] };
    w.close();
    fs.writeFileSync(f.file, disk.replace('Brand line', 'Brand line, new'));
    const b = relaunch(f.dir, f.file, f.session, w.st.known);
    await b.w.s.attach();
    await b.lane.lane.idle();
    const now = fs.readFileSync(f.file, 'utf8');
    expect(b.session.locked.map((l) => [l.state, l.start - before.start, now.slice(l.start, l.end)])).toEqual([['ok', 5, 'Analytics your whole team can use']]);
  });

  it('edit, undo, edit (no lock before the last write): the lock still transforms', async () => {
    const f = fresh();
    const w = window(f.file, f.history, f.lane, f.session, null);
    await w.s.attach();
    await w.type('Third line stays', 'Third line X');
    await w.s.appUndo('undo');
    await w.type('Analytics your whole team can read', 'Analytics your whole team can use');
    await f.lane.lane.idle();
    await f.history.idle();
    w.close();
    fs.writeFileSync(f.file, fs.readFileSync(f.file, 'utf8').replace('Brand line', 'Brand line, new'));
    const b = relaunch(f.dir, f.file, f.session, w.st.known);
    await b.w.s.attach();
    await b.lane.lane.idle();
    const now = fs.readFileSync(f.file, 'utf8');
    expect(b.session.locked.map((l) => [l.state, now.slice(l.start, l.end)])).toEqual([['ok', 'Analytics your whole team can use']]);
  });
});

describe('a write that lands after its window closed (finding 18)', () => {
  const DECK2 = ['<!doctype html>', '<html><head><title>Plan</title></head><body>', '<h1>Analytics your whole team can read</h1>', '<p class="lede">Northwind turns warehouse data into answers.</p>', '<p>Third line stays</p>', '</body></html>', ''].join('\n');

  it('known is the written version, the new lock holds what was written, a reopen transforms once, an agent change is flagged', async () => {
    const f = fresh(DECK2);
    const w = window(f.file, f.history, f.lane, f.session, null);
    await w.s.attach();
    expect((await w.type('Northwind turns warehouse data into answers.', 'Northwind turns warehouse data into answers. one'))?.outcome).toBe('written');
    // E2 on the h1 above it; the window closes (window.ts onClosed) right after the atomic write's rename.
    const realIo = w.doc.io.bind(w.doc);
    let closed = false;
    (w.doc as unknown as { io: typeof realIo }).io = (cap) => {
      const io = realIo(cap);
      return {
        ...io,
        atomicWrite: async (b: Uint8Array, h: string) => {
          await io.atomicWrite(b, h);
          w.close();
          closed = true;
        },
      };
    };
    await w.type('Analytics your whole team can read', 'Analytics your whole team can read two');
    await f.lane.lane.idle();
    await f.history.idle();
    expect(closed).toBe(true);
    const disk = fs.readFileSync(f.file, 'utf8');
    const diskVersion = sha256Hex(new Uint8Array(fs.readFileSync(f.file)));
    expect(disk).toContain('can read two</h1>');
    expect(w.st.known?.version).toBe(diskVersion);
    const byNote = (id: string) => f.session.locked.find((l) => l.noteId === id)!;
    expect(byNote('n-0002').text).toBe('Analytics your whole team can read two');
    expect(disk.slice(byNote('n-0002').start, byNote('n-0002').end)).toBe('Analytics your whole team can read two');
    expect(disk.slice(byNote('n-0001').start, byNote('n-0001').end)).toBe('Northwind turns warehouse data into answers. one');
    // A reopen (the same lane, D-1 within 30 s): nothing changed on disk, nothing is transformed again.
    const json = JSON.parse(new TextDecoder().decode(serializeSession(f.session, w.st.known)));
    const doc1 = new BlDocument({ docId: 'abcdef0123456780', path: f.file, realpath: f.file, bytes: new Uint8Array(fs.readFileSync(f.file)), trust: { trust: 'trusted', reason: null, marker: null }, received: false });
    const rr = readSession(json, { path: f.file, realpath: f.file, fileKey: doc1.fileKey, sha256: doc1.contentHash, title: doc1.title });
    const w2 = window(f.file, f.history, f.lane, rr.session, rr.known);
    await w2.s.attach();
    await f.lane.lane.idle();
    expect(rr.session.locked.map((l) => l.state)).toEqual(['ok', 'ok']);
    // An agent changes what the user wrote: the lock reports it (section 8 rule 3: never hidden).
    const ext = disk.replace('can read two</h1>', 'can read three</h1>');
    const tmp = path.join(f.dir, '.ext.tmp');
    fs.writeFileSync(tmp, ext);
    fs.renameSync(tmp, f.file);
    const extBytes = new Uint8Array(fs.readFileSync(f.file));
    w2.doc.knownHash = sha256Hex(extBytes);
    expect(await f.lane.takeExternal(w2.s, extBytes, sha256Hex(extBytes))).toBe('taken');
    const n2 = rr.session.locked.find((l) => l.noteId === 'n-0002')!;
    expect(n2.state).toBe('violated');
    expect(rr.session.locked.find((l) => l.noteId === 'n-0001')!.state).toBe('ok');
  });
});
