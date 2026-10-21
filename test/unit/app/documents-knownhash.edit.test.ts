// knownHash never moves backwards (P2-2; lead decision E-8; review findings 3 and 15). The real DeckWatcher with its
// default timing and fs.watch, BlDocument and its DeckIO (the atomic writer), EditLane, EditSession and the editor's
// write queue on a real file. The deck folder's directory fsync (atomic-write.ts fsyncDir, right after Blueline's
// rename) is slowed as on a slow or network volume, and another program rename-replaces the deck 30 ms after that
// rename: the watcher decides that change while Blueline's write is still finishing. It must be taken (the document
// and knownHash end on it, and a reload is asked for), never dropped as stale.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWriteQueue, editorVersion } from '@blueline/editor';
import type { EditorModule } from '@blueline/core/capabilities';
import type { EditResult } from '@blueline/core/ipc-edit';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { BlDocument } from '../../../packages/app/src/main/documents';
import { EditLane, EditSession, type Adopted, type EditSessionDeps, type Taken } from '../../../packages/app/src/main/edit-session';
import { HistoryStore } from '../../../packages/app/src/main/history';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';
import { DeckWatcher } from '../../../packages/app/src/main/watcher';

const editor: EditorModule = { editorVersion, createWriteQueue };
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-knownhash-')));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DECK = ['<!doctype html>', '<html><head><title>Plan</title></head><body>', '<h1>Research &amp; Development</h1>', '<p>Second line here</p>', '<p>Third line stays</p>', '</body></html>', ''].join('\n');
let n = 0;
const realOpen = fs.promises.open;
afterEach(() => {
  (fs.promises as { open: typeof realOpen }).open = realOpen;
});

async function rig() {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, DECK);
  const doc = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes: new Uint8Array(fs.readFileSync(file)), trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const session = emptySession({ path: file, realpath: file, fileKey: doc.fileKey, sha256: doc.contentHash, title: doc.title });
  const notes = new NotesStore(session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => doc.version, slides: () => null });
  const history = HistoryStore.at(path.join(dir, 'history'), { realpath: file });
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => history, log: () => undefined });
  const sent: { channel: string; payload: unknown }[] = [];
  const reload = { showing: doc.version, requested: [] as string[] };
  const taken: Taken[] = [];
  let watcher: DeckWatcher | null = null;
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: true, agent: true },
    notes,
    session: { session, known: () => null, noteVersion: () => undefined },
    reload: {
      get showing() {
        return reload.showing;
      },
      noteOwnWrite: (x) => {
        if (!x.reload && reload.showing === x.basedOn) reload.showing = x.version;
        else reload.requested.push(x.version);
      },
      requestReload: (v) => void reload.requested.push(v),
      setWriting: () => undefined,
      setEditBusy: () => undefined,
    },
    mode: () => 'edit',
    sendDeck: (channel, payload) => void sent.push({ channel, payload }),
    toast: () => undefined,
    save: () => undefined,
    notesChanged: () => undefined,
    adopted: (e: Adopted) => deps.reload.noteOwnWrite({ basedOn: e.basedOn, version: e.version, reload: e.absorbed || e.strategy !== 'html-text' }),
    // window.ts onTaken: the map, then a reload to the new version.
    taken: (e) => {
      taken.push(e);
      deps.reload.requestReload(e.version);
    },
    recheck: () => watcher?.recheck(),
    clipboard: () => undefined,
    confirm: async () => true,
    log: () => undefined,
  };
  const s = new EditSession(deps);
  await s.attach();
  watcher = new DeckWatcher({
    realpath: file,
    holder: doc,
    // window.ts takeExternalChange (the D-1 path only adds an asynchronous decideTrust before it).
    onExternalChange: (bytes, version) => void lane.takeExternal(s, bytes, version),
  }).start();
  await sleep(300); // the watcher's start-up check
  const type = async (runText: string, after: string): Promise<EditResult> => {
    const run = doc.map.runs.find((x) => x.value === runText)!;
    s.onInput('mouseDown');
    s.onBegin({ fieldId: 1, version: doc.version, runIds: [run.id] });
    const k = sent.length;
    await s.onCommit({ fieldId: 1, version: doc.version, result: { kind: 'edit', runId: run.id, beforeText: runText, afterText: after }, target: { css: 'p', text: runText, role: 'paragraph', stamp: run.stamp }, slide: 0, alsoPlaces: 0 });
    return sent.slice(k).find((x) => x.channel === 'bl:edit:result')!.payload as EditResult;
  };
  const external = (text: string) => {
    const tmp = path.join(dir, `.agent-${n++}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  };
  return { dir, file, doc, lane, s, watcher, taken, reload, type, external, close: () => watcher?.close() };
}

async function scenario(fsyncMs: number) {
  const r = await rig();
  let armed = true;
  (fs.promises as { open: typeof realOpen }).open = (async (p: fs.PathLike, flags?: unknown, mode?: unknown) => {
    if (armed && p === r.dir && flags === fs.constants.O_RDONLY) {
      armed = false;
      // atomic-write.ts fsyncDir: Blueline's write is renamed in. Another program saves on top of it soon after.
      setTimeout(() => r.external(fs.readFileSync(r.file, 'utf8').replace('<p>Third line stays</p>', '<p>Third line stays</p>\n<p>Agent added this</p>')), 30);
      await sleep(fsyncMs);
    }
    return realOpen.call(fs.promises, p, flags as never, mode as never);
  }) as typeof realOpen;
  expect((await r.type('Second line here', 'Second line now')).outcome).toBe('written');
  await r.lane.lane.idle();
  // The watcher's settle, its 1 s poll, and the lane's take.
  for (let i = 0; i < 40 && !r.doc.decoded.src.includes('Agent added this'); i++) await sleep(100);
  await r.lane.lane.idle();
  const disk = new Uint8Array(fs.readFileSync(r.file));
  r.close();
  return { r, diskVersion: sha256Hex(disk), diskText: new TextDecoder().decode(disk) };
}

describe('an external change decided between an own write\'s rename and its adoption', () => {
  it('control: a fast directory fsync, the change is taken', async () => {
    const { r, diskVersion, diskText } = await scenario(0);
    expect(diskText).toContain('Agent added this');
    expect(diskText).toContain('Second line now');
    expect(r.doc.version).toBe(diskVersion);
    expect(r.doc.knownHash).toBe(diskVersion);
    expect(r.reload.requested).toContain(diskVersion);
  });

  for (const ms of [400, 500]) {
    it(`a ${ms} ms directory fsync: the change is still taken, knownHash and the version are the external one, a reload is asked for`, async () => {
      const { r, diskVersion, diskText } = await scenario(ms);
      expect(diskText).toContain('Agent added this');
      expect(r.doc.version).toBe(diskVersion);
      expect(r.doc.knownHash).toBe(diskVersion);
      expect(r.doc.decoded.src).toContain('Agent added this');
      expect(r.taken.map((t) => t.version)).toContain(diskVersion);
      expect(r.reload.requested).toContain(diskVersion);
    });
  }
});
