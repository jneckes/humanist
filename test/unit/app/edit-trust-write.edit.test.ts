// D-1 at the moment of a write (the hardening round; timing finding: a commit made while a D-1 reopen waited was
// written into the marked download that replaced the deck). Through main's real wiring: EditSession, EditLane,
// packages/editor's write queue, BlDocument's DeckIO on a real file. The window's D-1 decision is the deps'
// writeTrust/trustPending (window.ts supplies them): a write that would replace bytes the window's trust does not
// hold for is refused, so the commit is a verbatim note and the other program's file is left exactly as it is.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWriteQueue, editorVersion } from '@blueline/editor';
import type { EditorModule } from '@blueline/core/capabilities';
import type { EditResult } from '@blueline/core/ipc-edit';
import { BlDocument } from '../../../packages/app/src/main/documents';
import { EditLane, EditSession, type EditSessionDeps } from '../../../packages/app/src/main/edit-session';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';

const editor: EditorModule = { editorVersion, createWriteQueue };
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-trust-write-')));
let n = 0;
const pad = (k: string) => Array.from({ length: 4 }, (_, i) => `<p>Filler ${k} line ${i}: words that stay as they are.</p>`).join('\n');
const SRC = ['<!doctype html>', '<html><head><title>T</title></head><body>', '<h1>Alpha heading text</h1>', pad('a'), '<p class="lede">Beta paragraph text</p>', pad('b'), '</body></html>', ''].join('\n');

async function setup(o: { writeTrust?: (version: string, doc: BlDocument) => Promise<boolean>; trustPending?: () => boolean }) {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, SRC);
  const doc = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes: new Uint8Array(fs.readFileSync(file)), trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const session = emptySession({ path: file, realpath: file, fileKey: doc.fileKey, sha256: doc.contentHash, title: doc.title });
  const notes = new NotesStore(session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => doc.version, slides: () => null });
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => null, log: () => undefined });
  const sent: { channel: string; payload: unknown }[] = [];
  let known: { version: string } | null = null;
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: true, agent: true },
    notes,
    session: { session, known: () => known, noteVersion: (v) => (known = { version: v.version }) },
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
  if (o.writeTrust) deps.writeTrust = (v) => o.writeTrust!(v, doc);
  if (o.trustPending) deps.trustPending = o.trustPending;
  const s = new EditSession(deps);
  await s.attach();
  const commit = async (runText: string, after: string): Promise<EditResult> => {
    const run = doc.map.runs.find((x) => x.value === runText)!;
    s.onInput('mouseDown');
    s.onBegin({ fieldId: 1, version: doc.version, runIds: [run.id] });
    const k = sent.length;
    await s.onCommit({ fieldId: 1, version: doc.version, result: { kind: 'edit', runId: run.id, beforeText: runText, afterText: after }, target: { css: run.tagName, text: runText, role: 'element', stamp: run.stamp }, slide: 1, alsoPlaces: 0 });
    return sent.slice(k).find((x) => x.channel === 'bl:edit:result')!.payload as EditResult;
  };
  return { s, file, commit, read: () => fs.readFileSync(file, 'utf8') };
}

describe('D-1 at the moment of the write', () => {
  // A download (the same deck, its first paragraph changed) saved over the file while the field was open.
  const download = SRC.replace('Filler a line 0', 'Filler a line 0 (downloaded)');

  it('a commit that would be written into bytes whose trust differs is a verbatim note; the download stays as it is', async () => {
    const r = await setup({ writeTrust: async (v, doc) => v === doc.version });
    fs.writeFileSync(r.file, download);
    expect((await r.commit('Beta paragraph text', 'Beta paragraph EDIT')).outcome).toBe('verbatim');
    expect(r.read()).toBe(download);
  });

  it('a commit while a trust change waits for its reopen is a verbatim note, even on the window\'s own version', async () => {
    const r = await setup({ trustPending: () => true });
    expect((await r.commit('Beta paragraph text', 'Beta paragraph EDIT')).outcome).toBe('verbatim');
    expect(r.read()).toBe(SRC);
  });

  it('control: the same trust: the external change is absorbed and the edit written', async () => {
    const r = await setup({ writeTrust: async () => true, trustPending: () => false });
    fs.writeFileSync(r.file, download);
    expect((await r.commit('Beta paragraph text', 'Beta paragraph EDIT')).outcome).toBe('written');
    expect(r.read()).toBe(download.replace('Beta paragraph text', 'Beta paragraph EDIT'));
  });
});
