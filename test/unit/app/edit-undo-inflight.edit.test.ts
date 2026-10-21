// Cmd+Z while the newest commit is still being written (lead decision E-3; review finding 14), through main's real
// wiring: EditSession, EditLane, packages/editor's write queue, BlDocument's DeckIO on a real file, NotesStore and
// HistoryStore. The only instrumentation: a history snapshot can run a callback, so Cmd+Z is "pressed" while the
// second edit's write is in progress inside the lane. App undo is queued in the lane behind that write and undoes
// it (the newest write that landed), never the edit before it; redo then brings it back.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWriteQueue, editorVersion } from '@blueline/editor';
import type { EditorModule } from '@blueline/core/capabilities';
import type { EditResult } from '@blueline/core/ipc-edit';
import { BlDocument } from '../../../packages/app/src/main/documents';
import { EditLane, EditSession, type EditSessionDeps, type ToastSpec } from '../../../packages/app/src/main/edit-session';
import { HistoryStore } from '../../../packages/app/src/main/history';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';

const editor: EditorModule = { editorVersion, createWriteQueue };
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-undo-inflight-')));
let n = 0;

function deck(layout: 'far' | 'near'): string {
  if (layout === 'near') return ['<!doctype html>', '<html><head><title>T</title></head><body>', '<h1>Alpha heading text</h1><p class="lede">Beta paragraph text</p>', '</body></html>', ''].join('\n');
  return ['<!doctype html>', '<html><head><title>T</title></head><body>', '<h1>Alpha heading text</h1>', `<p>${'padding words here '.repeat(6)}</p>`, '<p class="lede">Beta paragraph text</p>', '</body></html>', ''].join('\n');
}

async function setup(src: string) {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, src);
  const doc = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes: new Uint8Array(fs.readFileSync(file)), trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const session = emptySession({ path: file, realpath: file, fileKey: doc.fileKey, sha256: doc.contentHash, title: doc.title });
  const notes = new NotesStore(session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => doc.version, slides: () => null });
  const history = HistoryStore.at(path.join(dir, 'history'), { realpath: file });
  let onSnap: (() => Promise<void>) | null = null;
  const snap = history.snapshot.bind(history);
  history.snapshot = async (...args: Parameters<HistoryStore['snapshot']>) => {
    const id = await snap(...args);
    const f = onSnap;
    onSnap = null;
    if (f) await f();
    return id;
  };
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => history, log: () => undefined });
  const toasts: ToastSpec[] = [];
  const sent: { channel: string; payload: unknown }[] = [];
  let known: { version: string } | null = null;
  const reload = { showing: doc.version };
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: true, agent: true },
    notes,
    session: { session, known: () => known, noteVersion: (v) => (known = { version: v.version }) },
    reload: {
      get showing() {
        return reload.showing;
      },
      noteOwnWrite: (x) => {
        if (!x.reload && reload.showing === x.basedOn) reload.showing = x.version;
      },
      requestReload: () => undefined,
      setWriting: () => undefined,
      setEditBusy: () => undefined,
    },
    mode: () => 'edit',
    sendDeck: (channel, payload) => void sent.push({ channel, payload }),
    toast: (t) => void toasts.push(t),
    save: () => undefined,
    notesChanged: () => undefined,
    adopted: (e) => {
      const r = e.kind === 'edit' ? e.absorbed || e.strategy !== 'html-text' : e.absorbed || e.patch === null;
      deps.reload.noteOwnWrite({ basedOn: e.basedOn, version: e.version, reload: r });
    },
    taken: () => undefined,
    clipboard: () => undefined,
    confirm: async () => true,
    log: () => undefined,
  };
  const s = new EditSession(deps);
  await s.attach();
  let fid = 1;
  const commit = async (runText: string, after: string): Promise<EditResult> => {
    const run = doc.map.runs.find((x) => x.value === runText);
    if (!run) throw new Error(`no run ${runText}`);
    const id = fid++;
    s.onInput('mouseDown');
    s.onBegin({ fieldId: id, version: doc.version, runIds: [run.id] });
    const k = sent.length;
    await s.onCommit({ fieldId: id, version: doc.version, result: { kind: 'edit', runId: run.id, beforeText: runText, afterText: after }, target: { css: run.tagName, text: runText, role: 'element', stamp: run.stamp }, slide: 1, alsoPlaces: 0 });
    return sent.slice(k).find((x) => x.channel === 'bl:edit:result')!.payload as EditResult;
  };
  const read = () => fs.readFileSync(file, 'utf8');
  return { s, notes, session, toasts, commit, read, file, setSnap: (f: () => Promise<void>) => (onSnap = f) };
}

for (const layout of ['far', 'near'] as const) {
  describe(`Cmd+Z while the newest commit is written (runs ${layout === 'far' ? 'far apart' : 'within 32 characters'})`, () => {
    it('undoes that commit, not the edit before it; redo brings it back', async () => {
      const r = await setup(deck(layout));
      expect((await r.commit('Alpha heading text', 'Alpha heading EDIT1')).outcome).toBe('written');
      let undo: Promise<void> | null = null;
      // E2's write is in progress (its snapshot was just taken): Cmd+Z goes now.
      r.setSnap(async () => {
        undo = r.s.appUndo('undo');
        await new Promise((res) => setTimeout(res, 5));
      });
      expect((await r.commit('Beta paragraph text', 'Beta paragraph EDIT2')).outcome).toBe('written');
      await undo;
      expect(r.read()).toContain('Alpha heading EDIT1');
      expect(r.read()).not.toContain('Beta paragraph EDIT2');
      expect(r.s.undo.size).toEqual({ undo: 1, redo: 1 });
      expect(r.notes.notes.map((x) => x.id)).toEqual(['n-0001']);
      expect(r.toasts.at(-1)?.text).toMatch(/^Undone · deck\.html:/);
      await r.s.appUndo('redo');
      expect(r.read()).toContain('Beta paragraph EDIT2');
      expect(r.read()).toContain('Alpha heading EDIT1');
      expect(r.s.undo.size).toEqual({ undo: 2, redo: 0 });
      // A second Cmd+Z undoes E2 again (the stack order is right).
      await r.s.appUndo('undo');
      expect(r.read()).not.toContain('Beta paragraph EDIT2');
      expect(r.read()).toContain('Alpha heading EDIT1');
    });
  });
}

describe('control: Cmd+Z after the commit landed', () => {
  it('undoes it, redo restores it', async () => {
    const r = await setup(deck('far'));
    await r.commit('Alpha heading text', 'Alpha heading EDIT1');
    await r.commit('Beta paragraph text', 'Beta paragraph EDIT2');
    await r.s.appUndo('undo');
    expect(r.read()).not.toContain('EDIT2');
    expect(r.read()).toContain('EDIT1');
    await r.s.appUndo('redo');
    expect(r.read()).toContain('EDIT2');
  });
});

describe('Cmd+Z while the newest commit is written, and that commit becomes a note (the hardening round, E-3 as amended)', () => {
  it('nothing is undone: the author\'s previous edit stays, and the toast says the edit was kept as a note', async () => {
    const r = await setup(deck('far'));
    expect((await r.commit('Alpha heading text', 'Alpha heading EDIT1')).outcome).toBe('written');
    let undo: Promise<void> | null = null;
    // E2's write is in progress: another program rewrites E2's paragraph (the write conflicts and requeues onto the
    // new bytes, where its text is gone: a verbatim note), and Cmd+Z is pressed now.
    r.setSnap(async () => {
      fs.writeFileSync(r.file, r.read().replace('Beta paragraph text', 'Beta paragraph rewritten by the agent'));
      undo = r.s.appUndo('undo');
      await new Promise((res) => setTimeout(res, 5));
    });
    expect((await r.commit('Beta paragraph text', 'Beta paragraph EDIT2')).outcome).toBe('verbatim');
    await undo;
    expect(r.read()).toContain('Alpha heading EDIT1');
    expect(r.read()).toContain('Beta paragraph rewritten by the agent');
    expect(r.toasts.map((t) => t.text)).toContain('Nothing undone: your last edit was kept as a note');
    expect(r.toasts.some((t) => /^Undone/.test(t.text))).toBe(false);
    expect(r.s.undo.size).toEqual({ undo: 1, redo: 0 });
    // The next Cmd+Z, pressed with nothing in flight, is for the edit before it.
    await r.s.appUndo('undo');
    expect(r.read()).not.toContain('EDIT1');
  });
});
