// When main takes a commit, and what happens to the user's text when it cannot be written (lead decisions E-2 and
// E-4; review findings 4, 7, 16 and 20), through main's real wiring: EditSession, EditLane, packages/editor's write
// queue, BlDocument on a real file, NotesStore and HistoryStore. The mode is checked when main ACCEPTS a commit, not
// when it is written (9.1 checks editing allowed and the capability then); a field's authorisation ends when it
// closes, when the deck leaves Edit (but for the field open then, whose commit main asked for) and after 10 minutes
// without trusted input; a commit from a field still authorised that meets a file which cannot be edited now keeps
// the user's exact words as a verbatim note.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWriteQueue, editorVersion } from '@blueline/editor';
import type { EditorModule } from '@blueline/core/capabilities';
import type { AppMode } from '@blueline/core/ipc';
import type { EditResult } from '@blueline/core/ipc-edit';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { BlDocument } from '../../../packages/app/src/main/documents';
import { COMMIT_REQUEST_WINDOW_MS, EditLane, EditSession, FIELD_IDLE_MS, type EditSessionDeps } from '../../../packages/app/src/main/edit-session';
import { HistoryStore } from '../../../packages/app/src/main/history';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';

const editor: EditorModule = { editorVersion, createWriteQueue };
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-commit-rules-')));
let n = 0;

function deckSrc(filler: number): string {
  let f = '';
  for (let i = 0; i < filler; i++) f += `<p class="f">Filler paragraph number ${i} with some words to make the deck larger than usual.</p>\n`;
  return `<!doctype html>\n<html><head><title>Plan</title></head><body>\n<h1>Analytics your whole team can read</h1>\n<p>Second line here</p>\n${f}</body></html>\n`;
}

async function rig(src = deckSrc(10), o: { fieldIdleMs?: number } = {}) {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, src);
  const doc = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes: new Uint8Array(fs.readFileSync(file)), trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const session = emptySession({ path: file, realpath: file, fileKey: doc.fileKey, sha256: doc.contentHash, title: doc.title });
  const notes = new NotesStore(session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => doc.version, slides: () => null });
  const history = HistoryStore.at(path.join(dir, 'history'), { realpath: file });
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => history, log: () => undefined });
  const sent: { channel: string; payload: unknown }[] = [];
  let known: { version: string } | null = null;
  const w = { mode: 'edit' as AppMode, t: 1_000_000 };
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: true, agent: true },
    notes,
    session: { session, known: () => known, noteVersion: (v) => (known = { version: v.version }) },
    reload: { showing: doc.version, noteOwnWrite: () => undefined, requestReload: () => undefined, setWriting: () => undefined, setEditBusy: () => undefined },
    mode: () => w.mode,
    sendDeck: (channel, payload) => void sent.push({ channel, payload }),
    toast: () => undefined,
    save: () => undefined,
    notesChanged: () => undefined,
    adopted: () => undefined,
    taken: () => undefined,
    clipboard: () => undefined,
    confirm: async () => true,
    log: () => undefined,
    now: () => w.t,
    ...(o.fieldIdleMs !== undefined ? { fieldIdleMs: o.fieldIdleMs } : {}),
  };
  const s = new EditSession(deps);
  await s.attach();
  const v0 = doc.version;
  // window.ts setMode, the part that matters to Edit.
  const setMode = (m: AppMode) => {
    if (m === w.mode) return;
    const from = w.mode;
    w.mode = m;
    s.onModeChange(from, m);
  };
  const h1 = doc.map.runs.find((r) => r.value === 'Analytics your whole team can read')!;
  const open = (id: number) => {
    s.onInput('mouseDown');
    s.onBegin({ fieldId: id, version: v0, runIds: [h1.id] });
  };
  const commit = (id: number, after: string) =>
    s.onCommit({ fieldId: id, version: v0, result: { kind: 'edit', runId: h1.id, beforeText: h1.value, afterText: after }, target: { css: 'h1', text: h1.value, role: 'heading', stamp: h1.stamp }, slide: 0, alsoPlaces: 0 });
  const results = () => sent.filter((x) => x.channel === 'bl:edit:result').map((x) => x.payload as EditResult);
  const text = () => fs.readFileSync(file, 'utf8');
  return { s, doc, lane, notes, file, dir, setMode, open, commit, results, text, sent, tick: (ms: number) => (w.t += ms), src, v0 };
}

describe('the mode is checked when main accepts a commit, not when it is written (E-2, finding 16)', () => {
  it('Enter, then Read as the next macrotask: the edit is written', async () => {
    const r = await rig();
    r.open(1);
    const p = r.commit(1, 'Analytics your whole team can read one');
    setImmediate(() => r.setMode('read'));
    await p;
    expect(r.results().at(-1)).toMatchObject({ outcome: 'written' });
    expect(r.text()).toContain('<h1>Analytics your whole team can read one</h1>');
    expect(r.notes.notes.map((x) => x.kind)).toEqual(['edit']);
  });

  it('a 500 KB deck: Enter, then Read 40 ms later, while the write is still queued: written', async () => {
    const r = await rig(deckSrc(5200));
    r.open(1);
    const p = r.commit(1, 'Analytics your whole team can read one');
    setTimeout(() => r.setMode('read'), 40);
    await p;
    expect(r.results().at(-1)).toMatchObject({ outcome: 'written' });
    expect(r.text()).toContain('can read one</h1>');
  });

  it('Enter, then Review at once (the commit was accepted in Edit): written', async () => {
    const r = await rig();
    r.open(1);
    const p = r.commit(1, 'Analytics your whole team can read one');
    r.setMode('review');
    await p;
    expect(r.results().at(-1)).toMatchObject({ outcome: 'written' });
  });
});

describe('a commit that meets a file which cannot be edited now keeps the exact words (E-2, findings 7 and 20)', () => {
  it('the file went away while the field was open: a verbatim note with the exact before and after, the deck untouched', async () => {
    const r = await rig();
    r.open(1);
    fs.renameSync(r.file, path.join(r.dir, 'moved-away.html'));
    r.doc.setGone(true);
    // window.ts onFileGone: Read, which asks the deck for the field's commit.
    r.setMode('read');
    await r.commit(1, 'Analytics your whole team can read GONEWORD');
    expect(r.results().at(-1)).toMatchObject({ outcome: 'verbatim' });
    expect(r.notes.notes.map((x) => [x.kind, x.status, x.verbatim])).toEqual([['verbatim', 'open', { before: 'Analytics your whole team can read', after: 'Analytics your whole team can read GONEWORD' }]]);
    expect(fs.readFileSync(path.join(r.dir, 'moved-away.html'), 'utf8')).toBe(r.src);
  });

  it('another program made the file non-UTF-8 while the field was open: Enter keeps a verbatim note', async () => {
    const r = await rig();
    r.open(1);
    const bad = new Uint8Array([...new TextEncoder().encode(r.src.replace('</body>', '<!--')), 0xe9, ...new TextEncoder().encode('--></body></html>\n')]);
    fs.writeFileSync(r.file, bad);
    const v = sha256Hex(bad);
    r.doc.knownHash = v;
    expect(await r.lane.takeExternal(r.s, bad, v)).toBe('taken');
    expect(r.doc.editable()).toBe(false);
    r.s.onInput('keyDown');
    await r.commit(1, 'Analytics your whole team can read BADWORD');
    expect(r.results().at(-1)).toMatchObject({ outcome: 'verbatim' });
    expect(r.notes.notes.map((x) => x.verbatim)).toEqual([{ before: 'Analytics your whole team can read', after: 'Analytics your whole team can read BADWORD' }]);
    expect(Buffer.compare(fs.readFileSync(r.file), Buffer.from(bad))).toBe(0);
  });

  it('a field main never accepted stays silent: no note, no answer', async () => {
    const r = await rig();
    r.doc.setGone(true);
    await r.commit(99, 'Analytics your whole team can read FORGED');
    expect(r.results()).toEqual([]);
    expect(r.notes.notes).toEqual([]);
  });
});

describe("a field's authorisation ends (E-4, finding 4)", () => {
  it('a forged begin banked within 2 s of a press, then Read, then its commit 11 s later: refused, file and notes unchanged', async () => {
    const r = await rig();
    // A real press on a blank area; within 2 s the page forges a begin for the h1 (no real field opened).
    r.open(9001);
    r.tick(500);
    r.setMode('read');
    r.tick(11_000);
    await r.commit(9001, 'Analytics your whole team can read FORGED-LATE');
    expect(r.results()).toEqual([]);
    expect(r.text()).toBe(r.src);
    expect(r.notes.notes).toEqual([]);
    // Back in Edit: still refused (leaving Edit ended it).
    r.setMode('edit');
    await r.commit(9001, 'Analytics your whole team can read FORGED-LATE');
    expect(r.text()).toBe(r.src);
  });

  it('two banked begins: the newer replaces the older (one open field)', async () => {
    const r = await rig();
    r.open(9001);
    r.open(9002);
    await r.commit(9001, 'Analytics your whole team can read OLD');
    expect(r.results()).toEqual([]);
    expect(r.text()).toBe(r.src);
  });

  it('10 minutes without trusted input of any kind: the commit is refused silently; input keeps a field alive', async () => {
    const r = await rig();
    r.open(1);
    r.tick(FIELD_IDLE_MS + 1);
    await r.commit(1, 'Analytics your whole team can read IDLE');
    expect(r.results()).toEqual([]);
    expect(r.text()).toBe(r.src);
    // Typing (key events) keeps it authorised.
    r.open(2);
    for (let i = 0; i < 4; i++) {
      r.tick(FIELD_IDLE_MS / 2);
      r.s.onInput('char');
    }
    await r.commit(2, 'Analytics your whole team can read typed');
    expect(r.results().at(-1)).toMatchObject({ outcome: 'written' });
  });

  it('the idle limit is injectable', async () => {
    const r = await rig(deckSrc(10), { fieldIdleMs: 1000 });
    r.open(1);
    r.tick(1001);
    await r.commit(1, 'Analytics your whole team can read late');
    expect(r.results()).toEqual([]);
  });

  it('the field open when Edit is left commits (main asked for it), within the request window only', async () => {
    const r = await rig();
    r.open(1);
    r.setMode('read');
    await r.commit(1, 'Analytics your whole team can read one');
    expect(r.results().at(-1)).toMatchObject({ outcome: 'written' });
    const r2 = await rig();
    r2.open(1);
    r2.setMode('read');
    r2.tick(COMMIT_REQUEST_WINDOW_MS + 1);
    await r2.commit(1, 'Analytics your whole team can read one');
    expect(r2.results()).toEqual([]);
  });
});

describe('main asks the deck to commit (E-2, findings 5 and 19)', () => {
  it('requestCommit sends commitNow and resolves once the deck holds nothing; that commit is taken after 10 idle minutes', async () => {
    const r = await rig();
    r.open(1);
    r.s.onBusy({ edit: true, committing: false });
    r.tick(FIELD_IDLE_MS + 1);
    expect(r.s.holdsTyping).toBe(true);
    let settled: boolean | null = null;
    const req = r.s.requestCommit(5000).then((ok) => (settled = ok));
    expect(r.sent.map((x) => x.channel)).toContain('bl:edit:commit-now');
    // The deck commits (the commit arrives, then its busy report).
    const p = r.commit(1, 'Analytics your whole team can read closing');
    r.s.onBusy({ edit: false, committing: true });
    await p;
    expect(settled).toBeNull();
    r.s.onBusy({ edit: false, committing: false });
    await req;
    expect(settled).toBe(true);
    expect(r.text()).toContain('can read closing</h1>');
    expect(r.s.holdsTyping).toBe(false);
  });

  it('a deck that cannot answer: requestCommit gives up after its timeout, nothing written', async () => {
    const r = await rig();
    r.open(1);
    r.s.onBusy({ edit: true, committing: false });
    expect(await r.s.requestCommit(50)).toBe(false);
    expect(r.text()).toBe(r.src);
    expect(r.notes.notes).toEqual([]);
  });

  it('nothing open: requestCommit resolves at once and sends nothing', async () => {
    const r = await rig();
    expect(await r.s.requestCommit(50)).toBe(true);
    expect(r.sent).toEqual([]);
  });
});
