// Main holds the versions its clients hold (SPEC 9.2 Write protocol step 1; lead decision E-1; review findings 1
// and 22), through main's real wiring: a BlDocument on a real file, EditLane (attach, takeExternal as window.ts
// takeExternalChange calls it), EditSession (onBegin, onCommit) and packages/editor's real write queue. A field held
// open across many external saves keeps its version in the lane's cache and in the queue, so its commit is placed
// by position: written where the author typed, or a verbatim note, never into another copy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { emptySession } from '../../../packages/app/src/main/session-store';

const editor: EditorModule = { editorVersion, createWriteQueue };
let root: string;
let n = 0;
beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-pins-')));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Two cards, each with a role line "Owner".
const deck = (one: string, rev: number) =>
  [
    '<!doctype html>',
    '<html><head><title>Team</title></head><body>',
    `<section class="card"><h2>Alice Anderson</h2><p class="role">${one}</p></section>`,
    '<section class="card"><h2>Bob Brown-Baker</h2><p class="role">Owner</p></section>',
    `<p>rev ${rev}</p>`,
    '</body></html>',
    '',
  ].join('\n');

async function rig() {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, deck('Owner', 0));
  const bytes = new Uint8Array(fs.readFileSync(file));
  const doc = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes, trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const session = emptySession({ path: file, realpath: file, fileKey: doc.fileKey, sha256: doc.contentHash, title: doc.title });
  const notes = new NotesStore(session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => doc.version, slides: () => null });
  const history = HistoryStore.at(path.join(dir, 'history'), { realpath: file });
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => history, log: () => undefined });
  const sent: { channel: string; payload: unknown }[] = [];
  let known: { version: string } | null = null;
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: true, agent: true },
    notes,
    session: { session, known: () => known, noteVersion: (v) => (known = { version: v.version }) },
    reload: { showing: 'x', noteOwnWrite: () => undefined, requestReload: () => undefined, setWriting: () => undefined, setEditBusy: () => undefined },
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
  await s.attach();
  const save = async (text: string) => {
    const tmp = path.join(dir, `.ext-${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    const b = new Uint8Array(fs.readFileSync(file));
    const v = sha256Hex(b);
    doc.knownHash = v; // the watcher saw it
    expect(await lane.takeExternal(s, b, v)).toBe('taken');
  };
  const roles = () => [...fs.readFileSync(file, 'utf8').matchAll(/<p class="role">([^<]*)<\/p>/g)].map((m) => m[1]);
  const result = () => sent.filter((x) => x.channel === 'bl:edit:result').at(-1)?.payload as EditResult | undefined;
  return { s, doc, lane, notes, file, save, roles, result };
}

const target = (stamp: string) => ({ css: 'p', text: 'Owner', role: 'element', stamp });

describe('a field open across many external versions (findings 1 and 22)', () => {
  for (const k of [8, 9, 12]) {
    it(`${k} external saves, the first renaming card one's role: a verbatim note, card two untouched`, async () => {
      const r = await rig();
      const v0 = r.doc.version;
      const cardOne = r.doc.map.runs.filter((x) => x.value === 'Owner')[0];
      r.s.onInput('mouseDown');
      r.s.onBegin({ fieldId: 1, version: v0, runIds: [cardOne.id] });
      for (let i = 1; i <= k; i++) await r.save(deck('Owners', i));
      r.s.onInput('keyDown');
      await r.s.onCommit({ fieldId: 1, version: v0, result: { kind: 'edit', runId: cardOne.id, beforeText: 'Owner', afterText: 'Owner/Lead' }, target: target(cardOne.stamp), slide: 0, alsoPlaces: 0 });
      expect(r.result()).toMatchObject({ outcome: 'verbatim' });
      expect(r.roles()).toEqual(['Owners', 'Owner']);
      expect(r.notes.notes.map((x) => [x.kind, x.verbatim])).toEqual([['verbatim', { before: 'Owner', after: 'Owner/Lead' }]]);
    });
  }

  it('9 external saves elsewhere: the field\'s version is still held, so the edit lands on card one by position', async () => {
    const r = await rig();
    const v0 = r.doc.version;
    const cardOne = r.doc.map.runs.filter((x) => x.value === 'Owner')[0];
    r.s.onInput('mouseDown');
    r.s.onBegin({ fieldId: 1, version: v0, runIds: [cardOne.id] });
    expect(r.lane.versions.pinned(v0)).toBe(1);
    for (let i = 1; i <= 9; i++) await r.save(deck('Owner', i));
    expect(r.lane.versions.get(v0)).not.toBeNull();
    r.s.onInput('keyDown');
    await r.s.onCommit({ fieldId: 1, version: v0, result: { kind: 'edit', runId: cardOne.id, beforeText: 'Owner', afterText: 'Owner/Lead' }, target: target(cardOne.stamp), slide: 0, alsoPlaces: 0 });
    expect(r.result()).toMatchObject({ outcome: 'written' });
    expect(r.roles()).toEqual(['Owner/Lead', 'Owner']);
    // Answered: the field's hold ends.
    expect(r.lane.versions.pinned(v0)).toBe(0);
  });

  it('a field dropped without a commit (no field open, a page load) lets go of its version; the page\'s version is held while shown', async () => {
    const r = await rig();
    const v0 = r.doc.version;
    r.s.onPageInit(v0);
    expect(r.s.pinnedPage).toBe(v0);
    expect(r.lane.versions.pinned(v0)).toBe(1);
    r.s.onInput('mouseDown');
    r.s.onBegin({ fieldId: 1, version: v0, runIds: [r.doc.map.runs[0].id] });
    expect(r.lane.versions.pinned(v0)).toBe(2);
    r.s.onBusy({ edit: true, committing: false });
    expect(r.lane.versions.pinned(v0)).toBe(2);
    // Esc: the deck reports no open field.
    r.s.onBusy({ edit: false, committing: false });
    expect(r.lane.versions.pinned(v0)).toBe(1);
    r.s.onInput('mouseDown');
    r.s.onBegin({ fieldId: 2, version: v0, runIds: [r.doc.map.runs[0].id] });
    // A new page: its fields are gone, and the page it shows is held instead.
    r.s.onPageInit();
    expect(r.lane.versions.pinned(v0)).toBe(0);
    expect(r.s.pinnedPage).toBeNull();
    r.s.onPageInit(v0);
    r.s.dispose();
    expect(r.lane.versions.pinned(v0)).toBe(0);
  });
});
