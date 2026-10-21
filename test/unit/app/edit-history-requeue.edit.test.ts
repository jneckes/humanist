// One history entry per write that LANDED (lead decision E-11; review finding 21; P2-11, 9.2 Undo and redo 4),
// through main's real wiring: EditLane, EditSession, the editor's write queue, BlDocument's DeckIO on a real file and
// a HistoryStore on disk. A write that another program's save requeues snapshots before each attempt, but only the
// attempt that landed is listed, the content main knew is listed once, and a Restore whose write conflicts adds
// nothing, so Restore's counts are exact.
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createWriteQueue, editorVersion } from '@blueline/editor';
import type { EditorModule } from '@blueline/core/capabilities';
import type { EditResult } from '@blueline/core/ipc-edit';
import { BlDocument } from '../../../packages/app/src/main/documents';
import { EditLane, EditSession, restorePlan, type EditSessionDeps, type ToastSpec } from '../../../packages/app/src/main/edit-session';
import { HistoryStore } from '../../../packages/app/src/main/history';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';

const editor: EditorModule = { editorVersion, createWriteQueue };
const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-history-requeue-')));
const sha = (s: string) => createHash('sha256').update(Buffer.from(s)).digest('hex');
// The filler keeps the other program's change (before </body>) away from the edited run: a stale edit is written
// only where the text on both sides of it is unchanged (packages/editor/src/anchors.ts, E-1).
const FILLER = Array.from({ length: 4 }, (_, i) => `<p>Filler line ${i}: words that stay as they are.</p>`);
const DECK = ['<!doctype html>', '<html><head><title>Plan</title></head><body>', '<h1>Research &amp; Development</h1>', '<p>Second line here</p>', '<p>Third line stays</p>', ...FILLER, '</body></html>', ''].join('\n');
let n = 0;
const testEnv = process.env.BLUELINE_TEST;
afterEach(() => {
  if (testEnv === undefined) delete process.env.BLUELINE_TEST;
  else process.env.BLUELINE_TEST = testEnv;
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
  const toasts: ToastSpec[] = [];
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: true, agent: true },
    notes,
    session: { session, known: () => null, noteVersion: () => undefined },
    reload: { showing: doc.version, noteOwnWrite: () => undefined, requestReload: () => undefined, setWriting: () => undefined, setEditBusy: () => undefined },
    mode: () => 'edit',
    sendDeck: (channel, payload) => void sent.push({ channel, payload }),
    toast: (t) => void toasts.push(t),
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
  let fid = 1;
  const type = async (runText: string, after: string): Promise<EditResult> => {
    const run = doc.map.runs.find((x) => x.value === runText)!;
    const id = fid++;
    s.onInput('mouseDown');
    s.onBegin({ fieldId: id, version: doc.version, runIds: [run.id] });
    const k = sent.length;
    await s.onCommit({ fieldId: id, version: doc.version, result: { kind: 'edit', runId: run.id, beforeText: runText, afterText: after }, target: { css: 'p', text: runText, role: 'paragraph', stamp: run.stamp }, slide: 0, alsoPlaces: 0 });
    return sent.slice(k).find((x) => x.channel === 'bl:edit:result')!.payload as EditResult;
  };
  const external = (text: string) => {
    const tmp = path.join(dir, `.ext-${n++}.tmp`);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  };
  const rows = (names: Record<string, string>) =>
    history
      .list()
      .reverse()
      .map((e) => [e.cause, names[e.sha256] ?? e.sha256.slice(0, 8)]);
  return { dir, file, doc, s, history, toasts, type, external, rows };
}

describe('history of a requeued write (finding 21)', () => {
  it('control: a plain edit is one entry', async () => {
    const r = await rig();
    const v0 = r.doc.version;
    expect((await r.type('Second line here', 'Second line now')).outcome).toBe('written');
    await r.history.idle();
    expect(r.rows({ [v0]: 'V0' })).toEqual([['edit', 'V0']]);
    expect(r.history.countSince(r.history.list().at(-1)!.id)).toEqual({ direct: 1, external: 0 });
  });

  it('control: an external save before the edit (absorbed, no conflict): [external V0, edit V1]', async () => {
    const r = await rig();
    const v0 = r.doc.version;
    const ext = DECK.replace('</body>', '<!-- agent -->\n</body>');
    r.external(ext);
    expect((await r.type('Second line here', 'Second line now')).outcome).toBe('written');
    await r.history.idle();
    expect(r.rows({ [v0]: 'V0', [sha(ext)]: 'V1' })).toEqual([
      ['external', 'V0'],
      ['edit', 'V1'],
    ]);
  });

  it('an external save inside the atomic write requeues the edit: [external V0, edit V1] and counts {direct 1, external 1}', async () => {
    process.env.BLUELINE_TEST = '1';
    const r = await rig();
    const v0 = r.doc.version;
    const ext = DECK.replace('</body>', '<!-- agent -->\n</body>');
    expect(r.doc.armTestWriteInside(new TextEncoder().encode(ext))).toBe(true);
    expect((await r.type('Second line here', 'Second line now')).outcome).toBe('written');
    await r.history.idle();
    const disk = fs.readFileSync(r.file, 'utf8');
    expect(disk).toContain('Second line now');
    expect(disk).toContain('<!-- agent -->');
    expect(r.rows({ [v0]: 'V0', [sha(ext)]: 'V1' })).toEqual([
      ['external', 'V0'],
      ['edit', 'V1'],
    ]);
    const oldest = r.history.list().at(-1)!;
    const counts = r.history.countSince(oldest.id)!;
    expect(counts).toEqual({ direct: 1, external: 1 });
    expect(restorePlan({ fileName: 'deck.html', time: '10:00', counts, diff: [] }).detail).toMatch(/^This discards 1 direct edit and 1 change made outside Blueline since then\./);
    // The snapshot files on disk are only those the list and the base (P2-12: the version written) refer to.
    const files = fs.readdirSync(path.join(r.dir, 'history')).filter((f) => f.endsWith('.html'));
    expect(files.sort()).toEqual([v0, sha(ext), r.doc.version].map((v) => `${v}.html`).sort());
  });

  it('a Restore whose write conflicts adds nothing', async () => {
    process.env.BLUELINE_TEST = '1';
    const r = await rig();
    await r.type('Second line here', 'Second line now');
    await r.history.idle();
    const before = r.history.list().map((e) => [e.id, e.cause]);
    const ext = fs.readFileSync(r.file, 'utf8').replace('</body>', '<!-- agent -->\n</body>');
    expect(r.doc.armTestWriteInside(new TextEncoder().encode(ext))).toBe(true);
    await r.s.restore(r.history.list()[0].id);
    await r.history.idle();
    expect(fs.readFileSync(r.file, 'utf8')).toBe(ext);
    expect(r.toasts.at(-1)?.text).toMatch(/changed since you chose/);
    expect(r.history.list().map((e) => [e.id, e.cause])).toEqual(before);
  });
});

describe('HistoryStore: pending snapshots and de-duplication (E-11)', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const meta = (s: string, cause: 'edit' | 'external' | 'restore' = 'edit') => ({ sha256: sha(s), contentHash: sha(s), cause, at: new Date().toISOString() });

  it('a pending entry is listed once its write landed, removed when it did not; the newest bytes are not listed twice', async () => {
    const dir = fs.mkdtempSync(path.join(root, 'h-'));
    const h = HistoryStore.at(path.join(dir, 'history'), { realpath: path.join(dir, 'deck.html') });
    const a = await h.snapshot(bytes('A'), meta('A'), { pending: true });
    expect(h.list()).toEqual([]);
    expect(h.entry(a)).toBeNull();
    await h.settle(a, true);
    expect(h.list().map((e) => e.id)).toEqual([a]);
    const b = await h.snapshot(bytes('B'), meta('B'), { pending: true });
    await h.settle(b, false);
    expect(h.list().map((e) => e.id)).toEqual([a]);
    expect(fs.existsSync(path.join(dir, 'history', `${sha('B')}.html`))).toBe(false);
    // The same bytes as the newest entry: no second entry.
    expect(await h.snapshot(bytes('A'), meta('A', 'external'))).toBe(a);
    expect(h.list()).toHaveLength(1);
    // A crash before settle keeps the entry (the write may have landed): a new store lists it.
    const c = await h.snapshot(bytes('C'), meta('C'), { pending: true });
    const again = HistoryStore.at(path.join(dir, 'history'), { realpath: path.join(dir, 'deck.html') });
    expect(again.list().map((e) => e.id)).toEqual([c, a]);
  });
});
